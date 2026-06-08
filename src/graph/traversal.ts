import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QueryManager } from '../db/queries.js'
import type { MiniCodeGraphNode, PageFanoutTrace, PageFanoutBranch, FanoutHop, BacktraceResult, BacktracePath, BacktraceHop } from '../types.js'
import { isGeneratedFile, findSpringImplName } from '../generated.js'

function srcName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath.split('\\').pop() ?? filePath
}

export interface PathHop {
  node: MiniCodeGraphNode
  edgeKind: string
  detail?: string
}

export interface BfsResult {
  paths: PathHop[][]
  truncated: boolean
  exploredNodes: number
}

export class GraphTraverser {
  constructor(private queries: QueryManager) {}

  findPath(fromId: string, toId: string, maxDepth = 12, maxNodes = 500): BfsResult {
    const paths: PathHop[][] = []
    const visited = new Set<string>()
    let explored = 0
    let truncated = false

    const bfs = (current: string, target: string, depth: number, path: PathHop[]): void => {
      if (truncated) return
      if (depth > maxDepth || visited.has(current)) return
      visited.add(current)
      explored++
      if (explored > maxNodes) { truncated = true; return }

      const node = this.queries.getNode(current)
      if (!node) { visited.delete(current); return }

      const newPath = [...path, { node, edgeKind: '' }]

      if (current === target) {
        paths.push(newPath)
        visited.delete(current)
        return
      }

      // 1. Direct callee edges
      for (const callee of this.queries.getCallees(current)) {
        bfs(callee.id, target, depth + 1, [...newPath, { node: callee, edgeKind: 'calls' }])
      }

      // 2. Caller edges (reverse direction)
      for (const caller of this.queries.getCallers(current)) {
        bfs(caller.id, target, depth + 1, [...newPath, { node: caller, edgeKind: 'called_by' }])
      }

      // 3. Interface→Implementation (Spring + standard patterns)
      if (node) {
        const implCallers = this.findInterfaceCallers(node)
        for (const ic of implCallers) {
          bfs(ic.id, target, depth + 1, [...newPath, { node: ic, edgeKind: 'implements', detail: `implements ${node.name}` }])
        }
      }

      // 4. Implementation→Interface (find callers via interface)
      if (['class', 'method'].includes(node.kind)) {
        const ifaces = this.findInterfaceForImpl(node)
        for (const iface of ifaces) {
          const ifaceCallers = this.queries.getCallers(iface.id)
          for (const caller of ifaceCallers) {
            bfs(caller.id, target, depth + 1, [...newPath, { node: caller, edgeKind: 'dispatch', detail: `via ${iface.name}` }])
          }
        }
      }

      // 5. Cross-service tracing: follow imports → FeignClient → RestTemplate etc.
      if (node) {
        const crossServiceCallees = this.findCrossServiceCallees(node)
        for (const cs of crossServiceCallees) {
          bfs(cs.node.id, target, depth + 1, [...newPath, { node: cs.node, edgeKind: 'cross_service', detail: cs.detail }])
        }
      }

      // 6. Callback pattern: trace from callback definition to invocation site
      if (node) {
        const callbackTargets = this.findCallbackTargets(node)
        for (const ct of callbackTargets) {
          bfs(ct.node.id, target, depth + 1, [...newPath, { node: ct.node, edgeKind: 'callback', detail: ct.detail }])
        }
      }

      // 7. React pattern: setState → re-render, hooks → component
      if (node) {
        const reactTargets = this.findReactTargets(node)
        for (const rt of reactTargets) {
          bfs(rt.node.id, target, depth + 1, [...newPath, { node: rt.node, edgeKind: 'react', detail: rt.detail }])
        }
      }

      visited.delete(current)
    }

    bfs(fromId, toId, 0, [])
    return { paths, truncated, exploredNodes: explored }
  }

  findCrossServiceCallees(node: MiniCodeGraphNode): { node: MiniCodeGraphNode; detail: string }[] {
    const results: { node: MiniCodeGraphNode; detail: string }[] = []

    // Follow imports edges from this node's file
    const callees = this.queries.getCallees(node.id)
    for (const callee of callees) {
      if (callee.kind === 'imports') continue
    }

    // Check if this node has any imports as edges
    // Find the file-level node and check its imports
    const fileNodes = this.queries.getNodesByFile(node.filePath)
    let fileModule = fileNodes.find(n => n.name === 'module' || n.name === node.filePath.split('/').pop()?.replace('.java', '').replace('.ts', ''))
    if (!fileModule) fileModule = fileNodes[0]

    if (fileModule) {
      // Get the import edges from this file
      const edges = this.queries.getCallees(fileModule.id).filter(e =>
        e.name.includes('.')
      )

      for (const edge of edges) {
        if (edge.kind === 'class' || edge.kind === 'interface') {
          // This might be a FeignClient / RestTemplate call
          const impls = this.queries.searchNodes(edge.name, 10)
          for (const impl of impls) {
            if (impl.filePath !== node.filePath && !isGeneratedFile(impl.filePath)) {
              if (!results.find(r => r.node.id === impl.id)) {
                results.push({ node: impl, detail: `import → ${edge.name}` })
              }
            }
          }
        }
      }

      // Detect FeignClient pattern: @FeignClient("service-name") interface XxxClient
      const feignCandidates = this.queries.searchNodes('Client', 50).filter(n =>
        n.kind === 'interface' && n.name.endsWith('Client')
      )
      for (const fc of feignCandidates) {
        if (fc.filePath !== node.filePath) {
          const feignMethods = this.queries.getChildren(fc.id)
          for (const fm of feignMethods) {
            if (!results.find(r => r.node.id === fm.id)) {
              results.push({ node: fm, detail: `feign: ${fc.name}.${fm.name}()` })
            }
          }
        }
      }

      // Detect RestTemplate/WebClient pattern: restTemplate.getForObject(...)
      const restCallees = this.queries.getCallees(node.id)
      for (const rc of restCallees) {
        if (['getForObject', 'postForObject', 'exchange', 'get', 'post', 'put', 'delete', 'patch'].includes(rc.name)) {
          // Find the matching Spring controller endpoints
          const controllers = this.queries.searchNodes('Controller', 50).filter(n =>
            n.kind === 'class' || n.kind === 'interface'
          )
          for (const ctrl of controllers) {
            const ctrlMethods = this.queries.getChildren(ctrl.id)
            for (const cm of ctrlMethods) {
              if (!results.find(r => r.node.id === cm.id)) {
                results.push({ node: cm, detail: `rest: ${ctrl.name}.${cm.name}()` })
              }
            }
          }
        }
      }
    }

    return results
  }

  findImpactedNodes(nodeId: string, depth = 3): Map<string, MiniCodeGraphNode> {
    const impacted = new Map<string, MiniCodeGraphNode>()
    const visited = new Set<string>()

    const dfs = (currentId: string, remainingDepth: number): void => {
      if (remainingDepth < 0 || visited.has(currentId)) return
      visited.add(currentId)

      const node = this.queries.getNode(currentId)
      if (node) impacted.set(currentId, node)

      // Internal callers
      for (const caller of this.queries.getCallers(currentId)) {
        dfs(caller.id, remainingDepth - 1)
      }

      // Children (containment hierarchy)
      for (const child of this.queries.getChildren(currentId)) {
        dfs(child.id, remainingDepth - 1)
      }

      // Interface → Implementation dispatch
      if (node) {
        const impls = this.findImplementations(node)
        for (const impl of impls) {
          dfs(impl.id, remainingDepth - 1)
        }
      }

      // External references (cross-service callers that reference this symbol)
      if (node) {
        const extRefs = this.queries.getExternalReferencesByTarget(node.name)
        for (const ref of extRefs) {
          const pseudoId = `ext:${ref.id}`
          if (!visited.has(pseudoId)) {
            visited.add(pseudoId)
            const pseudoNode: MiniCodeGraphNode = {
              id: pseudoId,
              kind: 'external_reference',
              name: `[${ref.serviceName ?? 'ext'}] ${node.name}`,
              qualifiedName: `${ref.serviceName ?? 'unknown'}.${ref.symbolName}`,
              filePath: ref.detail ?? `external://${ref.serviceName ?? 'unknown'}`,
              startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
              language: '', docstring: '', signature: ref.detail ?? '',
              visibility: 'public', isExported: true, parentId: null,
            }
            impacted.set(pseudoId, pseudoNode)
          }
        }

        // Also: external symbols consumed by this node (RestTemplate/WebClient calls)
        const extConsumer = this.queries.getExternalReferencesBySource(node.name)
        for (const ref of extConsumer) {
          const pseudoId = `ext:consume:${ref.id}`
          if (!visited.has(pseudoId)) {
            visited.add(pseudoId)
            const pseudoNode: MiniCodeGraphNode = {
              id: pseudoId,
              kind: 'external_reference',
              name: `consumes:${ref.symbolName}`,
              qualifiedName: `${ref.serviceName ?? 'unknown'}.${ref.symbolName}`,
              filePath: ref.detail ?? `external://${ref.serviceName ?? 'unknown'}`,
              startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
              language: '', docstring: '', signature: ref.detail ?? '',
              visibility: 'public', isExported: true, parentId: null,
            }
            impacted.set(pseudoId, pseudoNode)
          }
        }
      }
    }

    dfs(nodeId, depth)
    impacted.delete(nodeId)
    return impacted
  }

  isEntryPointNode(nodeId: string): { kind: string; method?: string; path?: string; queueName?: string } | undefined {
    const node = this.queries.getNode(nodeId)
    if (!node) return
    if (node.kind === 'entry_point') return { kind: node.kind, path: node.name }
    const anns = this.queries.getAnnotationsByNode(nodeId)
    for (const a of anns) {
      const ann = a.annotationName
      if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'].includes(ann)) {
        return { kind: 'rest_endpoint', method: ann.replace('Mapping', '').toUpperCase(), path: a.value }
      }
      if (ann === 'RabbitListener' || ann === 'KafkaListener' || ann === 'JmsListener') {
        return { kind: 'mq_listener', queueName: a.value }
      }
      if (ann === 'Scheduled' || ann === 'SchedulingConfigurer') {
        return { kind: 'scheduled_task', method: ann }
      }
      if (ann === 'VueRoute' || ann === 'Route') {
        return { kind: 'page_entry', method: ann, path: a.value }
      }
    }
    if (node.name === 'main' && (node.filePath?.endsWith('.java') || node.filePath?.endsWith('.kt'))) {
      return { kind: 'main_method' }
    }
    return undefined
  }

  backtraceToEntry(nodeOrId: string | MiniCodeGraphNode, maxDepth = 15, maxPaths = 10): BacktraceResult {
    const visited = new Set<string>()
    const paths: BacktracePath[] = []
    const node = typeof nodeOrId === 'string' ? this.queries.getNode(nodeOrId) : nodeOrId
    if (!node) return { paths: [], foundEntry: false, rootNodeId: '', rootNodeName: '' }

    const rootId = node.id
    interface BfsEntry { currentId: string; hops: BacktraceHop[]; depth: number }
    const queue: BfsEntry[] = [{ currentId: rootId, hops: [], depth: 0 }]

    while (queue.length > 0 && paths.length < maxPaths) {
      const { currentId, hops, depth } = queue.shift()!
      if (depth > maxDepth) continue
      const stateKey = `${currentId}:${hops.length}`
      if (visited.has(stateKey)) continue
      visited.add(stateKey)

      const entryPoint = this.isEntryPointNode(currentId)
      if (entryPoint) {
        paths.push({ hops: [...hops], entryPointKind: entryPoint.kind, entryPointPath: entryPoint.path })
        continue
      }

      // Expand callers (reverse direction)
      for (const caller of this.queries.getCallers(currentId)) {
        queue.push({
          currentId: caller.id,
          hops: [...hops, { id: caller.id, name: caller.name, kind: 'calls', filePath: caller.filePath ?? '', detail: `caller → ${caller.name}` }],
          depth: depth + 1,
        })
      }

      // Expand interface/implementation dispatch
      const current = this.queries.getNode(currentId)
      if (current) {
        const impls = this.findImplementations(current)
        for (const impl of impls) {
          queue.push({
            currentId: impl.id,
            hops: [...hops, { id: impl.id, name: impl.name, kind: 'dispatch', filePath: impl.filePath ?? '', detail: `impl → ${impl.name}` }],
            depth: depth + 1,
          })
        }
      }

      // Cross-service external references
      if (current) {
        const extRefs = this.queries.getExternalReferencesByTarget(current.name)
        for (const ref of extRefs) {
          const pseudoId = `ext:${ref.id}`
          if (!visited.has(pseudoId)) {
            queue.push({
              currentId: pseudoId,
              hops: [...hops, { id: pseudoId, name: `[${ref.serviceName ?? 'ext'}]`, kind: 'cross_service', filePath: `external://${ref.serviceName ?? 'unknown'}`, detail: ref.detail ?? '' }],
              depth: depth + 1,
            })
          }
        }
      }

      // Check callers that have dispatch annotation (feign/dispatch)
      const callers = this.queries.getCallers(currentId)
      for (const caller of callers) {
        const callerAnns = this.queries.getAnnotationsByNode(caller.id)
        for (const ca of callerAnns) {
          if (ca.annotationName === 'FeignClient' || ca.annotationName === 'RabbitListener' || ca.annotationName === 'Scheduled') {
            if (!visited.has(caller.id)) {
              queue.push({
                currentId: caller.id,
                hops: [...hops, { id: caller.id, name: caller.name, kind: 'dispatch', filePath: caller.filePath ?? '', detail: `${ca.annotationName}: ${caller.name}` }],
                depth: depth + 1,
              })
            }
          }
        }
      }

      // Containing module's API endpoints
      if (current?.moduleId) {
        const modEntries = this.queries.searchNodes(current.moduleId, 20)
        for (const me of modEntries) {
          if (me.kind === 'class' && me.id !== currentId) {
            const meAnns = this.queries.getAnnotationsByNode(me.id)
            for (const ma of meAnns) {
              if (['RestController', 'Controller'].includes(ma.annotationName)) {
                const children = this.queries.getChildren(me.id)
                for (const c of children) {
                  const ep = this.isEntryPointNode(c.id)
                  if (ep && !visited.has(c.id)) {
                    queue.push({
                      currentId: c.id,
                      hops: [...hops, { id: c.id, name: c.name, kind: 'dispatch', filePath: c.filePath ?? '', detail: `endpoint: ${ep.method ?? 'GET'} ${ep.path ?? ''}` }],
                      depth: depth + 1,
                    })
                  }
                }
              }
            }
          }
        }
      }
    }

    return {
      paths,
      foundEntry: paths.length > 0,
      rootNodeId: rootId,
      rootNodeName: node.name,
    }
  }

  /**
   * Fan-out trace: from a Vue page component, BFS component tree → aggregate all API calls → resolve each into full trace
   */
  fanoutTrace(pageFile: string, _maxDepth = 3, projectRoot?: string): PageFanoutTrace {
    const allEdges = this.queries.getAllEdges()
    const allNodes = this.queries.getAllNodes()

    // Normalize path separators
    const normalizedPageFile = pageFile.replace(/\\/g, '/')

    // Step 1: BFS component tree to find all component files
    const componentFiles = new Set<string>()
    const visited = new Set<string>()
    const queue: string[] = [normalizedPageFile]

    while (queue.length > 0 && componentFiles.size < 200) {
      const cf = queue.shift()!
      const key = cf.toLowerCase()
      if (visited.has(key)) continue
      visited.add(key)
      componentFiles.add(cf)

      // Try to read this file and parse imported child components
      let fileContent: string | undefined
      try {
        const fileRecord = allNodes.find(n => n.filePath && n.filePath.replace(/\\/g, '/') === cf)
        if (fileRecord && existsSync(fileRecord.filePath!)) {
          fileContent = readFileSync(fileRecord.filePath!, 'utf-8')
        } else if (projectRoot) {
          const candidate = join(projectRoot, cf)
          if (existsSync(candidate)) {
            fileContent = readFileSync(candidate, 'utf-8')
          }
        }
      } catch { /* silent */ }

      if (fileContent && visited.size < 200) {
        // Match imports like `import Xxx from './Xxx.vue'` or `import Xxx from '@/components/Xxx.vue'`
        const importRe = /from\s+['"](\.\/.+?\.vue)['"]/g
        let m: RegExpExecArray | null
        while ((m = importRe.exec(fileContent)) !== null) {
          const relativePath = m[1]
          const dir = cf.includes('/') ? cf.substring(0, cf.lastIndexOf('/')) : ''
          const resolved = dir ? `${dir}/${relativePath.replace(/^\.\//, '')}` : relativePath.replace(/^\.\//, '')
          const normalized = resolved.replace(/\\/g, '/')
          if (!visited.has(normalized.toLowerCase())) {
            queue.push(normalized)
          }
        }
        // Match `@/` imports
        const atImportRe = /from\s+['"]@\/(.+?\.vue)['"]/g
        while ((m = atImportRe.exec(fileContent)) !== null) {
          const resolved = m[1].replace(/\\/g, '/')
          if (!visited.has(resolved.toLowerCase())) {
            // Try full path resolution later
            queue.push(resolved)
          }
        }
      }
    }

    // Step 2: Collect all api_mapping edges from these component files
    const componentApiEdges = new Map<string, typeof allEdges[0] & { meta: { path: string; method: string } }>()
    for (const ae of allEdges) {
      if (ae.kind === 'api_mapping') {
        const srcNormalized = ae.sourceId.replace(/\\/g, '/')
        // Direct match or partial path match
        const isMatch = componentFiles.has(srcNormalized) ||
          [...componentFiles].some(cf => srcNormalized.includes(cf) || cf.includes(srcNormalized))
        if (isMatch) {
          try {
            const meta = JSON.parse(ae.metadata ?? '{}')
            const key = `${meta.method ?? 'GET'}:${meta.path ?? ''}`
            if (!componentApiEdges.has(key)) {
              componentApiEdges.set(key, { ...ae, meta })
            }
          } catch { /* silent */ }
        }
      }
    }

    // Step 3: For each unique API, trace the full call chain
    const branches: PageFanoutBranch[] = []
    const involvedServicesSet = new Set<string>()

    for (const [, ae] of componentApiEdges) {
      const meta = ae.meta
      const hops: FanoutHop[] = []

      hops.push({ kind: 'vue_api_call', name: srcName(ae.sourceId), filePath: ae.sourceId, detail: `API → ${meta.path ?? ''}` })

      const cn = this.queries.getNode(ae.targetId)
      if (cn) {
        hops.push({ kind: 'controller_endpoint', name: cn.name, moduleId: cn.moduleId, filePath: cn.filePath, detail: `${meta.method ?? 'GET'} ${meta.path ?? ''}` })
        if (cn.moduleId) involvedServicesSet.add(cn.moduleId)

        const svcEdges = allEdges.filter(e => e.sourceId === cn.id && (e.kind === 'calls' || e.kind === 'mybatis_mapping'))
        for (const se of svcEdges) {
          const sn = this.queries.getNode(se.targetId)
          if (sn) {
            const hopKind = se.kind === 'mybatis_mapping' ? 'mybatis_mapper' as const : 'service_method' as const
            hops.push({ kind: hopKind, name: sn.name, moduleId: sn.moduleId, filePath: sn.filePath, detail: `${cn.name} → ${sn.name}` })
            if (sn.moduleId) involvedServicesSet.add(sn.moduleId)

            // Further trace service → sub-callees
            const subCalls = allEdges.filter(e => e.sourceId === sn.id && e.kind === 'calls')
            for (const sc of subCalls) {
              const subN = this.queries.getNode(sc.targetId)
              if (subN) {
                hops.push({ kind: 'service_method', name: subN.name, moduleId: subN.moduleId, filePath: subN.filePath, detail: `${sn.name} → ${subN.name}` })
                if (subN.moduleId) involvedServicesSet.add(subN.moduleId)
              }
            }
          }
        }

        // Check for Feign calls from this controller
        const feignEdges = this.queries.searchNodes('FeignClient', 20).filter(n => n.kind === 'interface')
        for (const fe of feignEdges) {
          const feignMethods = this.queries.getChildren(fe.id)
          for (const fm of feignMethods) {
            hops.push({ kind: 'feign_call', name: fm.name, moduleId: fe.moduleId, filePath: fe.filePath, detail: `${fe.name}.${fm.name}()` })
            if (fe.moduleId) involvedServicesSet.add(fe.moduleId)
          }
        }
      }

      if (hops.length > 0) {
        branches.push({
          method: meta.method ?? 'GET',
          path: meta.path ?? '',
          sourceComponent: ae.sourceId.split('/').pop() ?? '',
          trace: hops,
        })
      }
    }

    return {
      routePath: normalizedPageFile,
      pageFile: normalizedPageFile,
      branches,
      involvedServices: [...involvedServicesSet],
    }
  }

  findRelated(nodeIds: string[]): Map<string, { node: MiniCodeGraphNode; relationships: string[] }> {
    const result = new Map<string, { node: MiniCodeGraphNode; relationships: string[] }>()
    const seen = new Set<string>()

    for (const id of nodeIds) {
      if (seen.has(id)) continue
      seen.add(id)

      const node = this.queries.getNode(id)
      if (!node) continue

      const relationships: string[] = []

      for (const caller of this.queries.getCallers(id)) {
        if (!seen.has(caller.id)) {
          relationships.push(`called_by:${caller.name}`)
        }
      }

      for (const callee of this.queries.getCallees(id)) {
        if (!seen.has(callee.id)) {
          relationships.push(`calls:${callee.name}`)
        }
      }

      for (const child of this.queries.getChildren(id)) {
        if (!seen.has(child.id)) {
          relationships.push(`contains:${child.name}`)
        }
      }

      const parent = this.queries.getParent(id)
      if (parent && !seen.has(parent.id)) {
        relationships.push(`parent:${parent.name}`)
      }

      if (['interface', 'type_alias'].includes(node.kind)) {
        const impls = this.findImplementations(node)
        for (const impl of impls) {
          relationships.push(`implemented_by:${impl.name}`)
        }
      }

      result.set(id, { node, relationships })
    }

    return result
  }

  findImplementations(node: MiniCodeGraphNode): MiniCodeGraphNode[] {
    if (!['interface', 'type_alias'].includes(node.kind)) return []

    const results: MiniCodeGraphNode[] = []
    const allNodes = this.queries.searchNodes('', 10000)
    const nodeName = node.name
    const nodeQName = node.qualifiedName
    const simpleName = nodeQName.split('.').pop() ?? nodeName

    for (const n of allNodes) {
      if (n.id === node.id) continue
      if (isGeneratedFile(n.filePath)) continue

      // 1. Standard: UserService → UserService (same name)
      if (n.qualifiedName === nodeName || n.qualifiedName.endsWith(`.${nodeName}`)) {
        if (!results.find(r => r.id === n.id)) results.push(n)
        continue
      }

      // 2. Spring I-prefix: IUserService → UserService
      if (nodeName.startsWith('I') && /^I[A-Z]/.test(nodeName)) {
        const implName = nodeName.slice(1)
        if (n.name === implName || n.name === `${implName}Impl`) {
          if (!results.find(r => r.id === n.id)) results.push(n)
          continue
        }
      }

      // 3. Spring Impl suffix: UserService → UserServiceImpl
      const expectedImpl = findSpringImplName(nodeName)
      if (n.name === expectedImpl) {
        if (!results.find(r => r.id === n.id)) results.push(n)
        continue
      }

      // 4. Match by parent relationship (e.g. class Foo implements Bar {})
      if (n.parentId && (n.parentId.includes(nodeName) || n.parentId.includes(simpleName))) {
        if (!results.find(r => r.id === n.id)) results.push(n)
        continue
      }

      // 5. Match by qualified name containing simple name
      if (n.qualifiedName.includes(simpleName) && n.kind === 'class') {
        if (!results.find(r => r.id === n.id)) results.push(n)
      }
    }

    return results
  }

  findInterfaceCallers(methodNode: MiniCodeGraphNode): MiniCodeGraphNode[] {
    const callers = this.queries.getCallers(methodNode.id)
    const results: MiniCodeGraphNode[] = []

    for (const caller of callers) {
      const callerNode = this.queries.getNode(caller.id)
      if (!callerNode) continue

      if (callerNode.kind === 'method') {
        const parent = callerNode.parentId ? this.queries.getNode(callerNode.parentId) : null
        if (parent && ['interface', 'type_alias'].includes(parent.kind)) {
          // Spring: find Impl classes that implement this interface
          const impls = this.findImplementations(parent)
          for (const impl of impls) {
            const implChildren = this.queries.getChildren(impl.id)
            for (const child of implChildren) {
              if (child.name === callerNode.name && !results.find(r => r.id === child.id)) {
                results.push(child)
              }
            }
          }
        }
      }

      if (callerNode.kind === 'variable' || callerNode.kind === 'function') {
        const callbackCallers = this.queries.getCallers(caller.id)
        for (const cc of callbackCallers) {
          if (!results.find(r => r.id === cc.id)) results.push(cc)
        }
      }
    }

    return results
  }

  findInterfaceForImpl(node: MiniCodeGraphNode): MiniCodeGraphNode[] {
    if (!['class', 'method'].includes(node.kind)) return []
    const results: MiniCodeGraphNode[] = []

    if (node.kind === 'method' && node.parentId) {
      const parent = this.queries.getNode(node.parentId)
      if (parent) {
        // Standard: find interface with same name
        const allInterfaces = this.queries.searchNodes(parent.name, 50)
        for (const iface of allInterfaces) {
          if (iface.kind === 'interface' && iface.id !== parent.id) {
            const ifaceMethods = this.queries.getChildren(iface.id)
            for (const im of ifaceMethods) {
              if (im.name === node.name) results.push(im)
            }
          }
        }

        // Spring: if class is XxxImpl, find Xxx interface
        if (parent.name.endsWith('Impl')) {
          const ifaceName = parent.name.slice(0, -4)
          const ifaceNodes = this.queries.searchNodes(ifaceName, 20)
          for (const iface of ifaceNodes) {
            if (iface.kind === 'interface' && iface.id !== parent.id) {
              const ifaceMethods = this.queries.getChildren(iface.id)
              for (const im of ifaceMethods) {
                if (im.name === node.name && !results.find(r => r.id === im.id)) {
                  results.push(im)
                }
              }
            }
          }
        }

        // Spring I-prefix: if class is UserService, find IUserService
        if (!parent.name.endsWith('Impl')) {
          const ifaceName = `I${parent.name}`
          const ifaceNodes = this.queries.searchNodes(ifaceName, 10)
          for (const iface of ifaceNodes) {
            if (iface.kind === 'interface' && iface.id !== parent.id) {
              const ifaceMethods = this.queries.getChildren(iface.id)
              for (const im of ifaceMethods) {
                if (im.name === node.name && !results.find(r => r.id === im.id)) {
                  results.push(im)
                }
              }
            }
          }
        }
      }
    }

    return results
  }

  findCallbackTargets(node: MiniCodeGraphNode): { node: MiniCodeGraphNode; detail: string }[] {
    const results: { node: MiniCodeGraphNode; detail: string }[] = []

    const callers = this.queries.getCallers(node.id)
    for (const caller of callers) {
      const callees = this.queries.getCallees(caller.id)
      for (const callee of callees) {
        if (callee.kind === 'variable' || callee.kind === 'parameter') {
          const callbackUsages = this.queries.getCallees(callee.id)
          for (const usage of callbackUsages) {
            if (usage.kind === 'method_invocation' || usage.kind === 'call_expression') {
              if (!results.find(r => r.node.id === usage.id)) {
                results.push({ node: usage, detail: `callback via ${callee.name}` })
              }
            }
          }
        }
      }

      const chainCallees = this.queries.getCallees(caller.id)
      for (const callee of chainCallees) {
        if (['then', 'catch', 'finally', 'subscribe', 'map', 'forEach', 'filter', 'reduce'].includes(callee.name)) {
          const thenCallers = this.queries.getCallers(callee.id)
          for (const tc of thenCallers) {
            if (!results.find(r => r.node.id === tc.id)) {
              results.push({ node: tc, detail: `chain: ${callee.name}()` })
            }
          }
        }
      }
    }

    return results
  }

  findReactTargets(node: MiniCodeGraphNode): { node: MiniCodeGraphNode; detail: string }[] {
    const results: { node: MiniCodeGraphNode; detail: string }[] = []
    const reactHooks = ['useState', 'useEffect', 'useCallback', 'useMemo', 'useReducer', 'useContext']
    const reactPatterns = ['setState', 'dispatch', 'createContext']

    const callees = this.queries.getCallees(node.id)

    for (const callee of callees) {
      if (reactHooks.includes(callee.name)) {
        const hookCallers = this.queries.getCallers(callee.id)
        for (const hc of hookCallers) {
          const parent = hc.parentId ? this.queries.getNode(hc.parentId) : null
          if (parent && parent.kind === 'function' && parent.name !== 'anonymous') {
            if (!results.find(r => r.node.id === parent.id)) {
              results.push({ node: parent, detail: `hook: ${callee.name}() in ${parent.name}` })
            }
          }
        }
      }

      if (reactPatterns.includes(callee.name)) {
        const setStateCallers = this.queries.getCallers(callee.id)
        for (const sc of setStateCallers) {
          if (!results.find(r => r.node.id === sc.id)) {
            results.push({ node: sc, detail: `react: ${callee.name}()` })
          }
        }
      }
    }

    return results
  }

  findDeadCode(): MiniCodeGraphNode[] {
    const allNodes: MiniCodeGraphNode[] = this.queries.searchNodes('', 10000)
    return allNodes.filter(node => {
      if (['class', 'interface', 'enum'].includes(node.kind)) return false
      const callers = this.queries.getCallers(node.id)
      return callers.length === 0
    })
  }

  findAffectedTestFiles(sourceFiles: string[]): {
    testFile: string
    matchedSymbols: string[]
    confidence: number
  }[] {
    const allFiles = this.queries.getAllFiles()
    const testFiles = allFiles.filter(f =>
      f.path.match(/(test|spec|__tests__|__test__)/i) ||
      f.path.endsWith('.test.ts') || f.path.endsWith('.spec.ts') ||
      f.path.endsWith('.test.java') || f.path.endsWith('Test.java')
    )

    const sourceSymbols = new Set<string>()
    for (const sf of sourceFiles) {
      const nodes = this.queries.getNodesByFile(sf)
      for (const n of nodes) {
        sourceSymbols.add(n.name)
      }
    }

    const result: { testFile: string; matchedSymbols: string[]; confidence: number }[] = []

    for (const tf of testFiles) {
      const testNodes = this.queries.getNodesByFile(tf.path)
      const matched: string[] = []

      for (const tn of testNodes) {
        if (sourceSymbols.has(tn.name)) matched.push(tn.name)
        for (const callee of this.queries.getCallees(tn.id)) {
          if (sourceSymbols.has(callee.name) && !matched.includes(callee.name)) {
            matched.push(callee.name)
          }
        }
      }

      if (matched.length > 0) {
        result.push({
          testFile: tf.path,
          matchedSymbols: matched,
          confidence: Math.min(matched.length / Math.max(sourceSymbols.size, 1), 1),
        })
      }
    }

    return result.sort((a, b) => b.confidence - a.confidence)
  }

  findPathBetweenModules(fromSymbol: string, toSymbol: string, maxDepth = 8): BfsResult {
    const allPaths: PathHop[][] = []
    let truncated = false
    let exploredNodes = 0
    const fromResults = this.queries.searchNodes(fromSymbol, 5)
    const toResults = this.queries.searchNodes(toSymbol, 5)

    for (const from of fromResults) {
      for (const to of toResults) {
        const result = this.findPath(from.id, to.id, maxDepth)
        allPaths.push(...result.paths)
        exploredNodes += result.exploredNodes
        if (result.truncated) truncated = true
      }
    }

    return { paths: allPaths, truncated, exploredNodes }
  }

  findCrossModuleReferences(nodeId: string): { node: MiniCodeGraphNode; edgeKind: string; moduleId: string }[] {
    const results: { node: MiniCodeGraphNode; edgeKind: string; moduleId: string }[] = []
    const node = this.queries.getNode(nodeId)
    if (!node) return results

    const callerModules = new Set<string>()
    for (const caller of this.queries.getCallers(nodeId)) {
      if (caller.moduleId && caller.moduleId !== node.moduleId) {
        callerModules.add(caller.moduleId)
        results.push({ node: caller, edgeKind: 'called_by', moduleId: caller.moduleId })
      }
    }

    const calleeModules = new Set<string>()
    for (const callee of this.queries.getCallees(nodeId)) {
      if (callee.moduleId && callee.moduleId !== node.moduleId) {
        calleeModules.add(callee.moduleId)
        results.push({ node: callee, edgeKind: 'calls', moduleId: callee.moduleId })
      }
    }

    if (node.kind === 'interface' || node.kind === 'class') {
      const allNodes = this.queries.getAllNodes()
      for (const n of allNodes) {
        if (n.moduleId && n.moduleId !== node.moduleId) {
          if (n.qualifiedName === node.qualifiedName || n.name === node.name) {
            results.push({ node: n, edgeKind: 'same_symbol', moduleId: n.moduleId })
          }
        }
      }
    }

    return results
  }

  findServiceDependencies(moduleId: string): { moduleId: string; dependencies: string[] } {
    const deps = new Set<string>()
    const moduleNodes = this.queries.getAllNodes().filter(n => n.moduleId === moduleId)

    for (const node of moduleNodes) {
      const callees = this.queries.getCallees(node.id)
      for (const callee of callees) {
        if (callee.moduleId && callee.moduleId !== moduleId) {
          deps.add(callee.moduleId)
        }
      }

      const annotations = this.queries.getAnnotationsByNode(node.id)
      for (const ann of annotations) {
        if (ann.annotationName === 'FeignClient' && ann.value) {
          const nameMatch = ann.value.match(/name\s*=\s*["']([^"']+)["']/)
          if (nameMatch) {
            const serviceName = nameMatch[1]
            const targetModules = this.queries.getAllNodes()
              .filter(n => n.moduleId !== moduleId && n.kind === 'class' && n.name.toLowerCase().includes(serviceName.toLowerCase()))
            for (const tm of targetModules) {
              if (tm.moduleId) deps.add(tm.moduleId)
            }
          }
        }
      }

      const feignCalls = this.queries.getCallees(node.id)
        .filter(c => c.kind === 'method' && c.moduleId && c.moduleId !== moduleId)
      for (const fc of feignCalls) {
        if (fc.moduleId) deps.add(fc.moduleId)
      }
    }

    return { moduleId, dependencies: [...deps] }
  }

  findMicroserviceArchitecture(): {
    modules: string[]
    dependencies: { from: string; to: string }[]
    entryPoints: { module: string; endpoints: string[] }[]
  } {
    const allNodes = this.queries.getAllNodes()
    const moduleSet = new Set<string>()
    for (const n of allNodes) {
      if (n.moduleId) moduleSet.add(n.moduleId)
    }
    const modules = [...moduleSet].filter(m => m !== 'default')

    const dependencyPairs: { from: string; to: string }[] = []
    for (const mod of modules) {
      const { dependencies } = this.findServiceDependencies(mod)
      for (const dep of dependencies) {
        if (!dependencyPairs.some(d => d.from === mod && d.to === dep)) {
          dependencyPairs.push({ from: mod, to: dep })
        }
      }
    }

    const entryPoints: { module: string; endpoints: string[] }[] = []
    for (const mod of modules) {
      const controllers = this.queries.getAllNodes()
        .filter(n => n.moduleId === mod)
      const endpoints: string[] = []
      for (const ctrl of controllers) {
        const annotations = this.queries.getAnnotationsByNode(ctrl.id)
        for (const ann of annotations) {
          if (['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping'].includes(ann.annotationName)) {
            endpoints.push(`${ann.annotationName} ${ann.value} in ${ctrl.filePath}`)
          }
        }
      }
      if (endpoints.length > 0) {
        entryPoints.push({ module: mod, endpoints })
      }
    }

    return { modules, dependencies: dependencyPairs, entryPoints }
  }
}
