import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { GatewayRouteInfo } from '../../types.js'

// ── Types ─────────────────────────────────────────────────────

export interface CloudConfigBinding {
  className: string; filePath: string; hasRefreshScope: boolean
  configKey?: string; configValue?: string; line: number; moduleId: string
}

export interface LoadBalancerClient {
  className: string; filePath: string; fieldName: string
  serviceName?: string; hasLoadBalanced: boolean; line: number; moduleId: string
}

export interface StreamFunctionBinding {
  beanMethod: string; className: string
  functionType: 'Function' | 'Consumer' | 'Supplier' | 'Function<Flux' | 'Consumer<Flux' | 'Supplier<Flux'
  inputType: string; outputType: string; bindingName: string; destination: string
  filePath: string; line: number; moduleId: string
}

export interface ObservationPoint {
  classFile: string; methodName: string
  kind: 'observed' | 'timed' | 'counted' | 'span_tag'
  name?: string; description?: string; line: number; moduleId: string
}

export interface IntegrationEndpoint {
  annotation: string; className: string; methodName: string
  inputChannel?: string; outputChannel?: string; expression?: string
  payloadType?: string; filePath: string; line: number; moduleId: string
}

// ── Cloud Config ──────────────────────────────────────────────

export function indexCloudConfigBindings(queries: QueryManager, moduleId: string): CloudConfigBinding[] {
  const results: CloudConfigBinding[] = []
  const refreshNodes = queries.getNodesByAnnotation('RefreshScope')
  const configPropNodes = queries.getNodesByAnnotation('ConfigurationProperties').filter(n => n.moduleId === moduleId)
  const seen = new Set<string>()
  for (const node of refreshNodes) {
    if (node.moduleId !== moduleId || seen.has(node.id)) continue
    seen.add(node.id)
    const b: CloudConfigBinding = { className: node.name, filePath: node.filePath, hasRefreshScope: true, line: node.startLine, moduleId }
    const match = configPropNodes.find(c => c.id === node.id)
    if (match) {
      const anns = queries.getAnnotationsByNode(match.id)
      const prefixAnn = anns.find(a => a.annotationName === 'ConfigurationProperties')
      if (prefixAnn) b.configKey = prefixAnn.value
    }
    results.push(b)
    queries.insertAnnotation(node.id, 'CloudConfigRef', JSON.stringify({ refreshScope: true, configKey: b.configKey }), node.startLine, moduleId)
  }
  return results
}

export function detectBootstrapConfig(projectRoot: string): { configServerUri?: string; configLabel?: string; enabled: boolean } {
  const candidates = [join(projectRoot, 'bootstrap.yml'), join(projectRoot, 'bootstrap.yaml'), join(projectRoot, 'bootstrap.properties')]
  for (const bp of candidates) {
    if (existsSync(bp)) {
      const content = readFileSync(bp, 'utf-8')
      const seps = content.includes(':') ? ':' : '='
      const uriRe = new RegExp(`spring\\.cloud\\.config\\.uri\\s*${seps}\\s*["']?([^"'\\s]+)["']?`)
      const labelRe = new RegExp(`spring\\.cloud\\.config\\.label\\s*${seps}\\s*["']?([^"'\\s]+)["']?`)
      const uriMatch = uriRe.exec(content); const labelMatch = labelRe.exec(content)
      const enabled = content.includes('spring.cloud.config')
      return { configServerUri: uriMatch?.[1], configLabel: labelMatch?.[1], enabled }
    }
  }
  const appYml = join(projectRoot, 'application.yml')
  if (existsSync(appYml)) {
    const content = readFileSync(appYml, 'utf-8')
    if (content.includes('spring.cloud.config')) {
      const uriRe = /spring\.cloud\.config\.uri\s*:\s*["']?([^"'\s]+)["']?/
      const uriMatch = uriRe.exec(content)
      return { configServerUri: uriMatch?.[1], enabled: true }
    }
  }
  return { enabled: false }
}

// ── LoadBalancer ──────────────────────────────────────────────

export function indexLoadBalancerClients(queries: QueryManager, moduleId: string): LoadBalancerClient[] {
  const results: LoadBalancerClient[] = []; const allNodes = queries.getAllNodes(); const nodeAnnCache = queries.getAllAnnotations()
  for (const node of allNodes) {
    if (node.moduleId !== moduleId) continue
    if (node.kind !== 'field' && node.kind !== 'parameter') continue
    const anns = nodeAnnCache.get(node.id) ?? []
    if (!anns.some(a => a.annotationName === 'LoadBalanced')) continue
    let serviceName: string | undefined
    const typeName = node.qualifiedName.split('.').pop() || node.name
    if (typeName.includes('RestTemplate') || typeName.includes('WebClient') || typeName.includes('DiscoveryClient')) serviceName = node.name
    results.push({ className: node.parentId ? (queries.getNode(node.parentId)?.name || '') : '', filePath: node.filePath, fieldName: node.name, serviceName, hasLoadBalanced: true, line: node.startLine, moduleId })
    queries.insertAnnotation(node.id, 'LoadBalancedClient', JSON.stringify({ serviceName, fieldName: node.name }), node.startLine, moduleId)
  }
  return results
}

export function resolveLbUris(queries: QueryManager, moduleId: string): { uri: string; targetService: string }[] {
  const results: { uri: string; targetService: string }[] = []; const allEdges = queries.getAllEdges(); const gatewayEdges = allEdges.filter(e => e.kind === 'gateway_route')
  for (const ge of gatewayEdges) {
    try {
      const meta = JSON.parse(ge.metadata || '{}'); const uri: string = meta.uri || ''
      const lbMatch = uri.match(/lb:\/\/(\w[\w-]*)/)
      if (lbMatch) results.push({ uri, targetService: lbMatch[1] })
    } catch { /* silent */ }
  }
  const feignClients = queries.getNodesByAnnotation('FeignClient'); const nodeAnnCache = queries.getAllAnnotations()
  for (const fc of feignClients) {
    if (fc.moduleId !== moduleId) continue
    const anns = nodeAnnCache.get(fc.id) ?? []
    const nameAnn = anns.find(a => a.annotationName === 'FeignClient')
    if (nameAnn && !nameAnn.value.includes('url=')) {
      const nameMatch = nameAnn.value.match(/name\s*=\s*["'](\w[\w-]*)["']/)
      if (nameMatch) results.push({ uri: `lb://${nameMatch[1]}`, targetService: nameMatch[1] })
    }
  }
  return results
}

// ── Stream Function ───────────────────────────────────────────

function stripGeneric(input: string): string { return input.replace(/<[^>]*>/g, '').trim() }

function detectDestination(beanName: string, bindingName: string, projectRoot: string): string {
  const configFiles = ['application.yml', 'application.yaml', 'application.properties']
  for (const cf of configFiles) {
    const fp = join(projectRoot, 'src', 'main', 'resources', cf)
    if (!existsSync(fp)) continue
    try {
      const content = readFileSync(fp, 'utf-8')
      const patterns = [new RegExp(`spring\\.cloud\\.stream\\.bindings\\.${bindingName}\\.destination\\s*[:=]\\s*(\\S+)`), new RegExp(`spring\\.cloud\\.stream\\.bindings\\.${beanName}\\.destination\\s*[:=]\\s*(\\S+)`)]
      for (const p of patterns) { const m = content.match(p); if (m) return m[1].replace(/["']/g, '') }
    } catch { /* silent */ }
  }
  return ''
}

function streamBridgeUsage(queries: QueryManager, source: string, filePath: string, moduleId: string): void {
  const bridgePattern = /streamBridge\.send\s*\(\s*["']([^"']+)["']\s*,\s*([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = bridgePattern.exec(source)) !== null) {
    const destination = m[1]; const payload = m[2].trim()
    const nodeId = `${filePath}:StreamBridge.${destination}`
    queries.insertAnnotation(nodeId, 'StreamBridge', JSON.stringify({ destination, payloadType: stripGeneric(payload) }), 0, moduleId)
  }
}

function storeStreamBinding(queries: QueryManager, sb: StreamFunctionBinding, line: number, moduleId: string): void {
  const nodeId = `${sb.filePath}:${sb.beanMethod}`
  queries.insertAnnotation(nodeId, 'StreamFunction', JSON.stringify({ type: sb.functionType, input: sb.inputType, output: sb.outputType, binding: sb.bindingName, destination: sb.destination }), line, moduleId)
  const parentNodes = queries.searchNodes(sb.className, 3).filter(n => n.moduleId === moduleId && n.filePath === sb.filePath)
  for (const pn of parentNodes) queries.insertEdge(pn.id, nodeId, 'stream_function', JSON.stringify({ type: sb.functionType, input: sb.inputType, output: sb.outputType, binding: sb.bindingName, destination: sb.destination }), line, 0)
  if (sb.inputType) {
    const inputNodes = queries.searchNodes(sb.inputType.split('.').pop() || '', 5)
    for (const inn of inputNodes) { if (inn.moduleId === moduleId && inn.kind === 'class') queries.insertEdge(inn.id, nodeId, 'stream_function_input', JSON.stringify({ binding: sb.bindingName }), line, 0) }
  }
  if (sb.outputType) {
    const outputNodes = queries.searchNodes(sb.outputType.split('.').pop() || '', 5)
    for (const on of outputNodes) { if (on.moduleId === moduleId && on.kind === 'class') queries.insertEdge(nodeId, on.id, 'stream_function_output', JSON.stringify({ binding: sb.bindingName }), line, 0) }
  }
}

export function indexStreamFunctions(queries: QueryManager, source: string, filePath: string, moduleId: string, projectRoot?: string): StreamFunctionBinding[] {
  const results: StreamFunctionBinding[] = []
  streamBridgeUsage(queries, source, filePath, moduleId)
  const hasFunctional = source.includes('java.util.function.Function') || source.includes('java.util.function.Consumer') || source.includes('java.util.function.Supplier') || source.includes('@Bean')
  if (!hasFunctional) return results
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('@Bean') && !line.includes('@Bean(')) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith('public') && !lines[j].trim().startsWith('@Bean')) j++
    const methodLine = lines[j] || ''
    const funcMatch = methodLine.match(/(?:public\s+)?(Function|Consumer|Supplier)(?:\s*<([^>]+(?:\s*,\s*[^>]+)*)>)+\s+(\w+)\s*\(/)
    if (!funcMatch) {
      const fluxMatch = methodLine.match(/(?:public\s+)?(Function|Consumer|Supplier)\s*<Flux\s*<\s*([^>]+)\s*>(?:\s*,\s*Flux\s*<\s*([^>]+)\s*>)?>\s+(\w+)\s*\(/)
      if (!fluxMatch) continue
      const fluxType = `${fluxMatch[1]}<Flux` as StreamFunctionBinding['functionType']
      const inputType = fluxMatch[2]; const outputType = fluxMatch[3] || ''; const beanName = fluxMatch[4]
      let bindingName = beanName
      for (let k = i - 1; k <= i + 1; k++) { if (k >= 0 && k < lines.length) { const bnMatch = lines[k].match(/@Bean\s*\(\s*["']([^"']+)["']/); if (bnMatch) bindingName = bnMatch[1] } }
      const destination = projectRoot ? detectDestination(beanName, bindingName, projectRoot) : ''
      const sb: StreamFunctionBinding = { beanMethod: beanName, className: filePath.split('/').pop()?.replace('.java', '') || '', functionType: fluxType, inputType, outputType, bindingName, destination, filePath, line: i + 1, moduleId }
      results.push(sb); storeStreamBinding(queries, sb, i + 1, moduleId)
      continue
    }
    const functionType = funcMatch[1] as StreamFunctionBinding['functionType']
    const typeParams = funcMatch[2]; const beanName = funcMatch[3]
    let inputType = ''; let outputType = ''
    if (functionType === 'Function') { const parts = typeParams.split(',').map(s => s.trim()); inputType = stripGeneric(parts[0] || ''); outputType = stripGeneric(parts[1] || '') }
    else if (functionType === 'Consumer') inputType = stripGeneric(typeParams.trim())
    else if (functionType === 'Supplier') outputType = stripGeneric(typeParams.trim())
    let bindingName = beanName
    for (let k = i - 1; k <= i + 1; k++) { if (k >= 0 && k < lines.length) { const bnMatch = lines[k].match(/@Bean\s*\(\s*["']([^"']+)["']/); if (bnMatch) bindingName = bnMatch[1] } }
    const destination = projectRoot ? detectDestination(beanName, bindingName, projectRoot) : ''
    const sb: StreamFunctionBinding = { beanMethod: beanName, className: filePath.split('/').pop()?.replace('.java', '') || '', functionType, inputType, outputType, bindingName, destination, filePath, line: i + 1, moduleId }
    results.push(sb); storeStreamBinding(queries, sb, i + 1, moduleId)
  }
  return results
}

// ── Observation ───────────────────────────────────────────────

export function indexObservationAnnotations(queries: QueryManager, source: string, filePath: string, moduleId: string): ObservationPoint[] {
  const results: ObservationPoint[] = []; const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let kind: ObservationPoint['kind'] | null = null; let name: string | undefined; let description: string | undefined
    if (line.startsWith('@Observed') || line.startsWith('@Observation')) {
      kind = 'observed'; const nameMatch = line.match(/name\s*=\s*["']([^"']+)["']/); if (nameMatch) name = nameMatch[1]
    } else if (line.startsWith('@Timed')) { kind = 'timed'; const nameMatch = line.match(/value\s*=\s*["']([^"']+)["']/); if (nameMatch) name = nameMatch[1] }
    else if (line.startsWith('@Counted')) { kind = 'counted'; const nameMatch = line.match(/value\s*=\s*["']([^"']+)["']/); if (nameMatch) name = nameMatch[1] }
    else if (line.startsWith('@SpanTag')) kind = 'span_tag'
    if (!kind) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim().includes('(') && !lines[j].trim().includes('{')) j++
    const methodLine = lines[j] || lines[i]; const methodMatch = methodLine.match(/(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
    if (!methodMatch) continue
    const methodName = methodMatch[1]
    const obs: ObservationPoint = { classFile: filePath, methodName, kind, name, description, line: i + 1, moduleId }
    results.push(obs)
    const nodeId = `${filePath}:${methodName}`
    const parentNodes = queries.searchNodes(filePath.split('/').pop()?.replace('.java', '') || '', 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) {
      queries.insertAnnotation(nodeId, kind === 'observed' ? 'Observed' : kind === 'timed' ? 'Timed' : 'Counted', JSON.stringify({ name, description }), i + 1, moduleId)
      queries.insertEdge(pn.id, nodeId, 'observation_point', JSON.stringify({ kind, name, description }), i + 1, 0)
    }
    if (source.includes('management.tracing') || source.includes('micrometer-tracing') || source.includes('ObservationRegistry')) queries.insertAnnotation(nodeId, 'TracingEnabled', '{}', i + 1, moduleId)
  }
  return results
}

// ── Spring Integration ────────────────────────────────────────

const INTEGRATION_ANNOTATIONS = ['@MessageEndpoint', '@ServiceActivator', '@Router', '@Splitter', '@Aggregator', '@Transformer', '@Filter', '@InboundChannelAdapter', '@OutboundChannelAdapter', '@BridgeFrom', '@BridgeTo', '@Publisher']

export function indexSpringIntegration(queries: QueryManager, source: string, filePath: string, moduleId: string): IntegrationEndpoint[] {
  const results: IntegrationEndpoint[] = []; const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trim = lines[i].trim()
    const ann = INTEGRATION_ANNOTATIONS.find(a => trim.startsWith(a))
    if (!ann) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim().startsWith('public') && !lines[j].trim().startsWith('private') && !lines[j].trim().startsWith('protected') && !lines[j].trim().startsWith('@')) j++
    const methodLine = lines[j] || ''
    const methodMatch = methodLine.match(/(?:public\s+)?(\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/)
    const methodName = methodMatch ? methodMatch[2] : ''
    const fullAnnSrc = lines.slice(i, j + 1).join(' ')
    const inputChannel = fullAnnSrc.match(/inputChannel\s*=\s*["']([^"']+)["']/)?.[1]
    const outputChannel = fullAnnSrc.match(/outputChannel\s*=\s*["']([^"']+)["']/)?.[1]
    const expression = fullAnnSrc.match(/expression\s*=\s*["']([^"']+)["']/)?.[1]
    const payloadType = fullAnnSrc.match(/payloadType\s*=\s*["']([^"']+)["']/)?.[1]
    const ep: IntegrationEndpoint = { annotation: ann, className: filePath.split('/').pop()?.replace('.java', '') || '', methodName, inputChannel, outputChannel, expression, payloadType, filePath, line: i + 1, moduleId }
    results.push(ep)
    const nodeId = `${filePath}:${methodName || ann}`
    queries.insertAnnotation(nodeId, ann, JSON.stringify({ inputChannel, outputChannel, expression, payloadType }), i + 1, moduleId)
    const parentNodes = queries.searchNodes(ep.className, 3).filter(n => n.moduleId === moduleId && n.filePath === filePath)
    for (const pn of parentNodes) queries.insertEdge(pn.id, nodeId, 'integration_endpoint', JSON.stringify({ annotation: ann, inputChannel, outputChannel, expression, payloadType }), i + 1, 0)
    if (inputChannel) {
      const channelNodeId = `channel:${inputChannel}`
      queries.insertAnnotation(channelNodeId, 'MessageChannel', JSON.stringify({ channel: inputChannel }), 0, moduleId)
      queries.insertEdge(nodeId, channelNodeId, 'integration_channel_input', JSON.stringify({ channel: inputChannel }), i + 1, 0)
    }
    if (outputChannel) {
      const channelNodeId = `channel:${outputChannel}`
      queries.insertEdge(channelNodeId, nodeId, 'integration_channel_output', JSON.stringify({ channel: outputChannel }), i + 1, 0)
    }
  }
  return results
}

// ── Gateway ───────────────────────────────────────────────────

export function parseGatewayYaml(content: string): GatewayRouteInfo[] {
  const routes: GatewayRouteInfo[] = []; const routeBlocks = content.split(/(?=^\s+- id:)/m)
  for (const block of routeBlocks) {
    const idMatch = block.match(/id:\s*["']?(\S+)["']?/)
    if (!idMatch) continue
    const uriMatch = block.match(/uri:\s*["']?(lb:[^\s'"]+)[^'"]?["']?/)
    const orderMatch = block.match(/order:\s*(\d+)/)
    const predMatch = content.match(/predicates:\n((?:\s+- .*\n?)*)/)
    const predicates = predMatch ? [...predMatch[1].matchAll(/- \s*(.+)/g)].map(m => m[1].trim()) : []
    const filtMatch = content.match(/filters:\n((?:\s+- .*\n?)*)/)
    const filters = filtMatch ? [...filtMatch[1].matchAll(/- \s*(.+)/g)].map(m => m[1].trim()) : []
    routes.push({ id: idMatch[1], uri: uriMatch?.[1] ?? '', predicates, filters, order: orderMatch ? parseInt(orderMatch[1]) : 0, metadata: {} })
  }
  return routes
}

export function parseGatewayConfig(projectRoot: string): GatewayRouteInfo[] {
  const candidates = [join(projectRoot, 'src', 'main', 'resources', 'application.yml'), join(projectRoot, 'src', 'main', 'resources', 'application.yaml'), join(projectRoot, 'src', 'main', 'resources', 'application-gateway.yml'), join(projectRoot, 'src', 'main', 'resources', 'bootstrap.yml')]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    try {
      const content = readFileSync(f, 'utf-8')
      const yamlSection = content.match(/spring:\s*\n\s+cloud:\s*\n\s+gateway:\s*\n((?:\s+.*\n?)*)/)
      if (yamlSection) {
        const routeSection = yamlSection[1].match(/routes:\n((?:\s+.*\n?)*)/)
        if (routeSection) return parseGatewayYaml(routeSection[0])
      }
    } catch { /* silent */ }
  }
  return []
}

export function indexGatewayRoutes(queries: QueryManager, projectRoot: string, moduleId: string): GatewayRouteInfo[] {
  const routes = parseGatewayConfig(projectRoot)
  if (routes.length === 0) return routes
  for (const route of routes) {
    const routeId = `gateway:${route.id}`
    const targetService = route.uri.replace(/^lb:\/\//, '').replace(/^http:\/\//, '').split(/[:/]/)[0]
    const targetNodes = queries.searchNodes(targetService, 20).filter(n => n.moduleId !== moduleId)
    for (const tn of targetNodes) queries.insertEdge(routeId, tn.id, 'routes_to', JSON.stringify({ gatewayRoute: route.id, uri: route.uri, predicates: route.predicates }), 0, 0)
    for (const pred of route.predicates) {
      const pathMatch = pred.match(/Path=\/([\w/-]+)/)
      if (pathMatch) {
        const urlPath = pathMatch[1]; const allNodes = queries.getAllNodes(); const nodeAnnCache = queries.getAllAnnotations()
        for (const n of allNodes) {
          const anns = nodeAnnCache.get(n.id) ?? []
          for (const a of anns) {
            if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'].includes(a.annotationName)) {
              const routeVal = a.value.replace(/"/g, '')
              if (urlPath.includes(routeVal.replace(/^\//, '')) || routeVal.includes(urlPath)) queries.insertEdge(routeId, n.id, 'gateway_to_endpoint', JSON.stringify({ predicate: pred, endpoint: routeVal }), 0, 0)
            }
          }
        }
      }
    }
  }
  return routes
}
