import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../../db/queries.js'
import type { MiniCodeGraphNode, ConfigPropertyBinding, TransactionalInfo } from '../../types.js'

// ── Types ─────────────────────────────────────────────────────

export interface ConditionalConfig {
  configClass: string; filePath: string
  conditions: { type: string; value: string; matchIfMissing: boolean }[]
  autoConfigureAfter: string[]; autoConfigureBefore: string[]
  order: number; moduleId: string
}

// ── Transaction ───────────────────────────────────────────────

const PROPAGATION_LEVELS: string[] = ['REQUIRED', 'SUPPORTS', 'MANDATORY', 'REQUIRES_NEW', 'NOT_SUPPORTED', 'NEVER', 'NESTED']
const ISOLATION_LEVELS: string[] = ['DEFAULT', 'READ_UNCOMMITTED', 'READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE']

function splitAnnotationArgs(input: string): string[] {
  const args: string[] = []; let depth = 0; let current = ''
  for (const ch of input) {
    if (ch === '(' || ch === '{') { depth++; current += ch }
    else if (ch === ')' || ch === '}') { depth--; current += ch }
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = '' }
    else current += ch
  }
  if (current.trim()) args.push(current.trim())
  return args
}

export function parseTransactionalValue(value: string): Partial<TransactionalInfo> {
  const info: Partial<TransactionalInfo> = { propagation: 'REQUIRED', isolation: 'DEFAULT', timeout: -1, readOnly: false, rollbackFor: [], noRollbackFor: [] }
  if (!value || value === '') return info
  const cleanValue = value.replace(/^@Transactional\(|\)$/g, '')
  const parts = splitAnnotationArgs(cleanValue)
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === 'readOnly = true' || trimmed === 'readOnly=true') info.readOnly = true
    else if (trimmed.startsWith('propagation')) { const match = trimmed.match(/propagation\s*=\s*(Propagation\.)?(\w+)/); if (match && PROPAGATION_LEVELS.includes(match[2])) info.propagation = match[2] }
    else if (trimmed.startsWith('isolation')) { const match = trimmed.match(/isolation\s*=\s*(Isolation\.)?(\w+)/); if (match && ISOLATION_LEVELS.includes(match[2])) info.isolation = match[2] }
    else if (trimmed.startsWith('timeout')) { const match = trimmed.match(/timeout\s*=\s*(\d+)/); if (match) info.timeout = parseInt(match[1]) }
    else if (trimmed.startsWith('rollbackFor')) { const match = trimmed.match(/rollbackFor\s*=\s*\{?([^}]+)\}?/); if (match) info.rollbackFor = match[1].split(',').map(s => s.trim().replace(/\.class/g, '')) }
    else if (trimmed.startsWith('noRollbackFor')) { const match = trimmed.match(/noRollbackFor\s*=\s*\{?([^}]+)\}?/); if (match) info.noRollbackFor = match[1].split(',').map(s => s.trim().replace(/\.class/g, '')) }
  }
  return info
}

export function indexTransactionalAnnotations(queries: QueryManager, moduleId: string, nodeAnnCache?: Map<string, { annotationName: string; value: string }[]>): TransactionalInfo[] {
  const results: TransactionalInfo[] = []; const allNodes = queries.getAllNodes()
  if (!nodeAnnCache) nodeAnnCache = queries.getAllAnnotations()
  const nodeCache = new Map<string, { name: string }>()
  for (const node of allNodes) nodeCache.set(node.id, node)
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id)
    if (!anns) continue
    for (const ann of anns) {
      if (ann.annotationName === 'Transactional') {
        const parsed = parseTransactionalValue(ann.value)
        const parentNode = node.parentId ? nodeCache.get(node.parentId) : null
        const info: TransactionalInfo = { nodeId: node.id, methodName: node.name, className: parentNode?.name ?? '', propagation: parsed.propagation ?? 'REQUIRED', isolation: parsed.isolation ?? 'DEFAULT', timeout: parsed.timeout ?? -1, readOnly: parsed.readOnly ?? false, rollbackFor: parsed.rollbackFor ?? [], noRollbackFor: parsed.noRollbackFor ?? [], filePath: node.filePath, line: node.startLine }
        results.push(info)
        queries.insertEdge(node.id, `tx:${moduleId}:${node.id}`, 'transactional', JSON.stringify(info), node.startLine, 0)
      }
    }
  }
  const propagateEdges: { fromId: string; toId: string; txInfo: string }[] = []
  for (const info of results) {
    const callerEdges = queries.getCallers(info.nodeId)
    for (const caller of callerEdges) {
      const callerAnns = nodeAnnCache.get(caller.id) ?? []
      if (callerAnns.some(a => a.annotationName !== 'Transactional')) propagateEdges.push({ fromId: caller.id, toId: info.nodeId, txInfo: JSON.stringify({ callerPropagation: 'REQUIRED', calleePropagation: info.propagation }) })
    }
  }
  for (const pe of propagateEdges) queries.insertEdge(pe.fromId, pe.toId, 'tx_propagate', pe.txInfo, 0, 0)
  return results
}

export function findTxBoundaryConflicts(queries: QueryManager, _moduleId: string, annCache?: Map<string, { annotationName: string; value: string }[]>): { outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string }[] {
  const conflicts: { outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string }[] = []
  const txEdges = queries.getAllEdges().filter(e => e.kind === 'tx_propagate')
  for (const edge of txEdges) {
    try {
      const meta = JSON.parse(edge.metadata ?? '{}')
      const outerNode = queries.getNode(edge.sourceId); const innerNode = queries.getNode(edge.targetId)
      if (outerNode && innerNode) {
        const outerOuter = queries.getCallers(edge.sourceId).map(c => queries.getNode(c.id)).filter(Boolean).map(n => { const aa = annCache?.get(n!.id) ?? queries.getAnnotationsByNode(n!.id); return aa.find(a => a.annotationName === 'Transactional')?.value ?? '' }).filter(v => v !== '')
        const innerAnns = annCache?.get(edge.targetId) ?? queries.getAnnotationsByNode(edge.targetId)
        const innerTx = innerAnns.find(a => a.annotationName === 'Transactional')
        const innerProp = innerTx ? parseTransactionalValue(innerTx.value).propagation ?? 'REQUIRED' : 'REQUIRED'
        if (innerProp === 'REQUIRES_NEW' && outerOuter.length > 0) conflicts.push({ outerMethod: outerNode.name, innerMethod: innerNode.name, outerPropagation: meta.callerPropagation ?? 'REQUIRED', innerPropagation: innerProp!, warning: 'REQUIRES_NEW inside existing transaction: outer transaction will be suspended' })
      }
    } catch { /* silent */ }
  }
  return conflicts
}

// ── Config ────────────────────────────────────────────────────

export function parseApplicationYml(content: string): { key: string; value: string; line: number }[] {
  const props: { key: string; value: string; line: number }[] = []; const lines = content.split('\n'); const prefixStack: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; const indentMatch = line.match(/^(\s*)([\w.-]+):\s*(.*)/)
    if (indentMatch) {
      const indent = indentMatch[1].length; const key = indentMatch[2]; const value = indentMatch[3].trim()
      while (prefixStack.length > 0 && prefixStack.length * 2 >= indent) prefixStack.pop()
      prefixStack.push(key); const fullKey = prefixStack.join('.')
      if (value && !value.startsWith('|') && !value.startsWith('>')) props.push({ key: fullKey, value, line: i + 1 })
    } else {
      const dashMatch = line.match(/^\s*-\s+([\w.-]+):\s*(.*)/)
      if (dashMatch) { const key = dashMatch[1]; const value = dashMatch[2].trim(); if (value) props.push({ key: [...prefixStack, key].join('.'), value, line: i + 1 }) }
    }
  }
  return props
}

export function parsePropertiesFile(content: string): { key: string; value: string; line: number }[] {
  const props: { key: string; value: string; line: number }[] = []; const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line && !line.startsWith('#') && line.includes('=')) { const eqIdx = line.indexOf('='); const key = line.substring(0, eqIdx).trim(); const value = line.substring(eqIdx + 1).trim(); props.push({ key, value, line: i + 1 }) }
  }
  return props
}

export function extractConfigProperties(projectRoot: string): { key: string; value: string; sourceFile: string; sourceLine: number }[] {
  const result: { key: string; value: string; sourceFile: string; sourceLine: number }[] = []
  const candidates = ['application.yml', 'application.yaml', 'application.properties', 'application-dev.yml', 'application-prod.yml', 'application-test.yml', 'bootstrap.yml', 'bootstrap.properties']
  for (const candidate of candidates) {
    const filePath = join(projectRoot, 'src', 'main', 'resources', candidate)
    if (!existsSync(filePath)) continue
    try {
      const content = readFileSync(filePath, 'utf-8'); const ext = candidate.endsWith('.properties') ? 'properties' : 'yml'
      const parsed = ext === 'properties' ? parsePropertiesFile(content) : parseApplicationYml(content)
      for (const p of parsed) result.push({ key: p.key, value: p.value, sourceFile: filePath, sourceLine: p.line })
    } catch { /* silent */ }
  }
  return result
}

const SENSITIVE_KEYS = /password|secret|token|key|credential|certificate|private_key|api_key|access_key/i

function maskSensitiveValue(key: string, value: string): string {
  return SENSITIVE_KEYS.test(key) ? '***' : value
}

export function indexConfigProperties(queries: QueryManager, projectRoot: string, moduleId: string): ConfigPropertyBinding[] {
  const bindings: ConfigPropertyBinding[] = []; const configProps = extractConfigProperties(projectRoot)
  if (configProps.length === 0) return bindings
  const allNodes = queries.getAllNodes(); const nodeAnnCache = queries.getAllAnnotations()
  const configClassNodes = allNodes.filter(n => { const anns = nodeAnnCache.get(n.id) ?? []; return anns.some(a => a.annotationName === 'ConfigurationProperties') })
  for (const node of configClassNodes) {
    const anns = nodeAnnCache.get(node.id) ?? []; const configPropAnn = anns.find(a => a.annotationName === 'ConfigurationProperties')
    if (!configPropAnn) continue
    const prefix = configPropAnn.value.replace(/"/g, '').replace(/^prefix\s*=\s*/, '')
    const nodeProps = configProps.filter(p => p.key.startsWith(prefix))
    const binding: ConfigPropertyBinding = { configClass: node.name, prefix, filePath: node.filePath, properties: nodeProps.map(p => ({ key: p.key, value: maskSensitiveValue(p.key, p.value), sourceFile: p.sourceFile, sourceLine: p.sourceLine })), moduleId }
    const bindingId = `config:${moduleId}:${prefix}`
    for (const np of nodeProps) queries.insertEdge(bindingId, node.id, 'config_binding', JSON.stringify({ prefix, key: np.key, value: maskSensitiveValue(np.key, np.value) }), 0, 0)
    bindings.push(binding)
  }
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id) ?? []; const valueAnn = anns.find(a => a.annotationName === 'Value')
    if (valueAnn) {
      const placeholder = valueAnn.value.replace(/"/g, ''); const match = placeholder.match(/\$\{([^}]+)}/)
      if (match) { const propKey = match[1].split(':')[0]; const matchedProp = configProps.find(p => p.key === propKey); if (matchedProp) queries.insertEdge(node.id, `config:${moduleId}:${propKey}`, 'value_inject', JSON.stringify({ key: propKey, value: matchedProp.value }), 0, 0) }
    }
  }
  return bindings
}

export function indexActuatorEndpoints(queries: QueryManager, projectRoot: string, moduleId: string): number {
  let count = 0; const configDirs = [join(projectRoot, 'src', 'main', 'resources'), projectRoot]
  for (const dir of configDirs) {
    for (const fileName of ['application.yml', 'application.yaml', 'application.properties']) {
      const fp = join(dir, fileName)
      if (!existsSync(fp)) continue
      try {
        const content = readFileSync(fp, 'utf-8'); let includeAll = false; let exposedEndpoints: string[] = []
        if (fileName.endsWith('.properties')) {
          const exposeMatch = content.match(/management\.endpoints\.web\.exposure\.include\s*[=:]\s*(.+)/)
          if (exposeMatch) { exposedEndpoints = exposeMatch[1].split(',').map(s => s.trim().replace(/"/g, '')); includeAll = exposedEndpoints.includes('*') }
        } else {
          const yamlMatch = content.match(/management:\s*\n\s+endpoints:\s*\n\s+web:\s*\n\s+exposure:\s*\n\s+include:\s*(.+)/)
          if (yamlMatch) { exposedEndpoints = yamlMatch[1].split(',').map(s => s.trim().replace(/["']/g, '')); includeAll = exposedEndpoints.includes('*') }
        }
        if (includeAll) exposedEndpoints = ['health', 'info', 'metrics', 'env', 'beans', 'configprops', 'logfile', 'loggers', 'mappings', 'threaddump', 'heapdump', 'scheduledtasks', 'caches', 'conditions']
        for (const ep of exposedEndpoints) { queries.insertExternalSymbol(`actuator.${moduleId}.${ep}`, ep, 'actuator_endpoint', moduleId, fp, `GET /actuator/${ep}`, '{}'); count++ }
      } catch { /* silent */ }
    }
  }
  return count
}

// ── Spring Beans ──────────────────────────────────────────────

const STEREOTYPE_ANNOTATIONS = ['Service', 'Component', 'Repository', 'Controller', 'RestController']
const LAYER_ORDER: Record<string, number> = { controller: 1, rest_controller: 1, service: 2, repository: 3, component: 4 }

function resolveLayer(annotation: string): string {
  switch (annotation) { case 'Controller': return 'controller'; case 'RestController': return 'rest_controller'; case 'Service': return 'service'; case 'Repository': return 'repository'; case 'Component': return 'component'; default: return '' }
}

function resolveInjectedType(node: MiniCodeGraphNode, _allNodes: MiniCodeGraphNode[]): string | null {
  const anns = node.signature || ''
  if (anns) {
    const javaTypeMatch = anns.match(/(\w+(?:\.\w+)*)\s+\w+\s*(?:,|\)|$)/)
    if (javaTypeMatch) return javaTypeMatch[1]
    const qualName = node.qualifiedName; const lastDot = qualName.lastIndexOf('.')
    if (lastDot > 0) return qualName.substring(0, lastDot)
  }
  return node.name
}

function findMatchingBeans(typeName: string, allNodes: MiniCodeGraphNode[], _beanLayers: Map<string, string>, queries: QueryManager): MiniCodeGraphNode[] {
  const results: MiniCodeGraphNode[] = []
  const byQName = queries.getNodesByQualifiedName(typeName)
  for (const n of byQName) { if (n.kind === 'class' || n.kind === 'interface') results.push(n) }
  const simpleName = typeName.includes('.') ? typeName.split('.').pop()! : typeName; const implName = `${simpleName}Impl`
  for (const node of allNodes) {
    if (results.some(r => r.id === node.id)) continue
    if (node.kind !== 'class' && node.kind !== 'interface') continue
    if (node.name === simpleName || node.name === implName) results.push(node)
  }
  return results.slice(0, 5)
}

function findQualifier(anns: { annotationName: string; value: string }[]): string {
  const qual = anns.find(a => a.annotationName === 'Qualifier')
  return qual ? qual.value.replace(/["']/g, '') : ''
}

export function indexSpringBeans(queries: QueryManager, moduleId: string): { beans: number; injections: number } {
  let beans = 0; let injections = 0
  const allNodes = queries.getAllNodes(); const nodeAnnCache = queries.getAllAnnotations()
  const nodeCache = new Map<string, MiniCodeGraphNode>()
  for (const node of allNodes) nodeCache.set(node.id, node)
  const beanLayers = new Map<string, string>()
  for (const annName of STEREOTYPE_ANNOTATIONS) {
    const nodes = queries.getNodesByAnnotation(annName)
    for (const node of nodes) { const layer = resolveLayer(annName); if (layer) { beanLayers.set(node.id, layer); queries.insertAnnotation(node.id, `stereotype:${layer}`, annName, node.startLine, moduleId); beans++ } }
  }
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id); if (!anns) continue
    let bestLayer = ''; let bestOrder = 999
    for (const a of anns) { const layer = resolveLayer(a.annotationName); if (layer) { const order = LAYER_ORDER[layer] ?? 999; if (order < bestOrder) { bestOrder = order; bestLayer = layer } } }
    if (bestLayer) beanLayers.set(node.id, bestLayer)
  }
  for (const node of allNodes) {
    const anns = nodeAnnCache.get(node.id)
    if (!anns) continue
    const autowired = anns.find(a => a.annotationName === 'Autowired' || a.annotationName === 'Inject' || a.annotationName === 'Resource')
    if (!autowired) continue
    if (node.kind !== 'field' && node.kind !== 'parameter' && node.kind !== 'method') continue
    const parent = node.parentId ? nodeCache.get(node.parentId) : undefined
    if (!parent) continue
    const typeName = resolveInjectedType(node, allNodes)
    if (!typeName) continue
    const candidates = findMatchingBeans(typeName, allNodes, beanLayers, queries)
    for (const candidate of candidates) { queries.insertEdge(parent.id, candidate.id, 'injects', JSON.stringify({ injectedField: node.name, injectedType: typeName, autowired: autowired.annotationName, qualifier: findQualifier(anns) }), node.startLine, node.startColumn); injections++ }
  }
  return { beans, injections }
}

// ── Auto Configuration ───────────────────────────────────────

function scanSourceForAnnotations(source: string): { annName: string; annBody: string; lineNum: number }[] {
  const results: { annName: string; annBody: string; lineNum: number }[] = []; const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const annMatch = line.match(/^@(ConditionalOnProperty|ConditionalOnClass|ConditionalOnMissingBean|ConditionalOnBean|ConditionalOnExpression|ConditionalOnMissingClass|ConditionalOnWebApplication|ConditionalOnNotWebApplication|AutoConfigureAfter|AutoConfigureBefore|AutoConfigureOrder|Configuration|AutoConfiguration)\s*(?:\(([^)]*)\))?/)
    if (annMatch) results.push({ annName: annMatch[1], annBody: annMatch[2]?.trim() ?? '', lineNum: i + 1 })
  }
  return results
}

export function indexSpringAutoConfiguration(queries: QueryManager, moduleId: string, projectRoot?: string): ConditionalConfig[] {
  const results: ConditionalConfig[] = []; const allNodes = queries.getAllNodes(); const seen = new Set<string>()
  for (const node of allNodes) {
    if (node.moduleId !== moduleId || node.kind !== 'class') continue
    if (seen.has(node.id)) continue
    seen.add(node.id)
    if (!node.filePath) continue
    const filePath = projectRoot ? join(projectRoot, node.filePath) : node.filePath
    let source: string
    try { source = readFileSync(filePath, 'utf-8') } catch { continue }
    const anns = scanSourceForAnnotations(source)
    const hasConfig = anns.some(a => a.annName === 'Configuration' || a.annName === 'AutoConfiguration')
    if (!hasConfig && anns.length === 0) continue
    const config: ConditionalConfig = { configClass: node.name, filePath: node.filePath, conditions: [], autoConfigureAfter: [], autoConfigureBefore: [], order: 0, moduleId }
    for (const ann of anns) {
      switch (ann.annName) {
        case 'ConditionalOnProperty': { const match = ann.annBody.match(/name\s*=\s*["']([^"']+)["']/); const matchIfMissing = ann.annBody.includes('matchIfMissing = true'); config.conditions.push({ type: 'property', value: match?.[1] ?? ann.annBody, matchIfMissing }); break }
        case 'ConditionalOnClass': config.conditions.push({ type: 'class', value: ann.annBody, matchIfMissing: false }); break
        case 'ConditionalOnMissingBean': config.conditions.push({ type: 'missingBean', value: ann.annBody, matchIfMissing: false }); break
        case 'ConditionalOnBean': config.conditions.push({ type: 'bean', value: ann.annBody, matchIfMissing: false }); break
        case 'ConditionalOnExpression': config.conditions.push({ type: 'expression', value: ann.annBody, matchIfMissing: false }); break
        case 'ConditionalOnMissingClass': config.conditions.push({ type: 'missingClass', value: ann.annBody, matchIfMissing: false }); break
        case 'ConditionalOnWebApplication': config.conditions.push({ type: 'webApplication', value: ann.annBody, matchIfMissing: false }); break
        case 'ConditionalOnNotWebApplication': config.conditions.push({ type: 'notWebApplication', value: ann.annBody, matchIfMissing: false }); break
        case 'AutoConfigureAfter': { const afterClass = ann.annBody.match(/["']([^"']+)["']/)?.[1] || ann.annBody; config.autoConfigureAfter.push(afterClass); break }
        case 'AutoConfigureBefore': { const beforeClass = ann.annBody.match(/["']([^"']+)["']/)?.[1] || ann.annBody; config.autoConfigureBefore.push(beforeClass); break }
        case 'AutoConfigureOrder': config.order = parseInt(ann.annBody, 10) || 0; break
      }
    }
    if (config.conditions.length > 0 || config.autoConfigureAfter.length > 0 || config.autoConfigureBefore.length > 0) {
      queries.insertAnnotation(node.id, 'ConditionalConfig', JSON.stringify(config.conditions), node.startLine, moduleId)
      for (const after of config.autoConfigureAfter) { const afterNodes = queries.searchNodes(after, 5); for (const an of afterNodes) { if (an.moduleId === moduleId && an.kind === 'class') queries.insertEdge(node.id, an.id, 'auto_configure_after', JSON.stringify({ order: config.order }), node.startLine, 0) } }
      for (const before of config.autoConfigureBefore) { const beforeNodes = queries.searchNodes(before, 5); for (const bn of beforeNodes) { if (bn.moduleId === moduleId && bn.kind === 'class') queries.insertEdge(node.id, bn.id, 'auto_configure_before', JSON.stringify({ order: config.order }), node.startLine, 0) } }
      results.push(config)
    }
  }
  return results
}
