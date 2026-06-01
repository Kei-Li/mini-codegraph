import type { QueryManager } from '../db/queries.js'
import type { MiniCodeGraphNode, ModuleInfo } from '../types.js'
import { isGeneratedFile, isSpringServiceImpl, findSpringImplName } from '../generated.js'

export interface PathHop {
  node: MiniCodeGraphNode
  edgeKind: string
  detail?: string
}

export class GraphTraverser {
  constructor(private queries: QueryManager) {}

  findPath(fromId: string, toId: string, maxDepth = 12): PathHop[][] {
    const paths: PathHop[][] = []
    const visited = new Set<string>()

    const bfs = (current: string, target: string, depth: number, path: PathHop[]): void => {
      if (depth > maxDepth || visited.has(current)) return
      visited.add(current)

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
    return paths
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

      for (const caller of this.queries.getCallers(currentId)) {
        dfs(caller.id, remainingDepth - 1)
      }

      for (const child of this.queries.getChildren(currentId)) {
        dfs(child.id, remainingDepth - 1)
      }

      if (node) {
        const impls = this.findImplementations(node)
        for (const impl of impls) {
          dfs(impl.id, remainingDepth - 1)
        }
      }
    }

    dfs(nodeId, depth)
    impacted.delete(nodeId)
    return impacted
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

  findPathBetweenModules(fromSymbol: string, toSymbol: string, maxDepth = 8): PathHop[][] {
    const paths: PathHop[][] = []
    const fromResults = this.queries.searchNodes(fromSymbol, 5)
    const toResults = this.queries.searchNodes(toSymbol, 5)

    for (const from of fromResults) {
      for (const to of toResults) {
        const found = this.findPath(from.id, to.id, maxDepth)
        paths.push(...found)
      }
    }

    return paths
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
