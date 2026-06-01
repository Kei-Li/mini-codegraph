import type { QueryManager } from '../db/queries.js'
import type { MiniCodeGraphNode } from '../types.js'

export interface SynthesizedEdge {
  source: string
  target: string
  kind: string
  metadata: string
  line: number
  col: number
}

export function synthesizeCallbackEdges(
  queries: QueryManager,
  moduleId: string
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []

  const interfaceEdges = synthesizeInterfaceOverrides(queries, moduleId)
  edges.push(...interfaceEdges)

  const eventEdges = synthesizeEventEmitterEdges(queries, moduleId)
  edges.push(...eventEdges)

  return edges
}

function synthesizeInterfaceOverrides(
  queries: QueryManager,
  moduleId: string
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const allNodes = queries.getAllNodes()

  const interfaceMethods = new Map<string, MiniCodeGraphNode[]>()
  for (const node of allNodes) {
    if (node.kind === 'method' && node.parentId) {
      const parent = queries.getNode(node.parentId)
      if (parent && parent.kind === 'interface') {
        const key = parent.id
        if (!interfaceMethods.has(key)) interfaceMethods.set(key, [])
        interfaceMethods.get(key)!.push(node)
      }
    }
  }

  const classMethods = new Map<string, MiniCodeGraphNode[]>()
  for (const node of allNodes) {
    if (node.kind === 'method' && node.parentId) {
      const parent = queries.getNode(node.parentId)
      if (parent && parent.kind === 'class' && node.moduleId === moduleId) {
        const key = parent.id
        if (!classMethods.has(key)) classMethods.set(key, [])
        classMethods.get(key)!.push(node)
      }
    }
  }

  for (const [ifaceId, methods] of interfaceMethods) {
    const iface = queries.getNode(ifaceId)
    if (!iface) continue

    const impls = findConcreteClasses(queries, iface, moduleId)
    for (const impl of impls) {
      const implMethodList = classMethods.get(impl.id) ?? []
      for (const ifaceMethod of methods) {
        const matchingImpl = implMethodList.find(m => m.name === ifaceMethod.name)
        if (matchingImpl) {
          edges.push({
            source: matchingImpl.id,
            target: ifaceMethod.id,
            kind: 'implements',
            metadata: JSON.stringify({ synthesizedBy: 'interfaceOverride' }),
            line: matchingImpl.startLine,
            col: matchingImpl.startColumn,
          })
        }
      }
    }
  }

  return edges
}

function findConcreteClasses(
  queries: QueryManager,
  iface: MiniCodeGraphNode,
  moduleId: string
): MiniCodeGraphNode[] {
  const results: MiniCodeGraphNode[] = []
  const allNodes = queries.getAllNodes()

  for (const node of allNodes) {
    if (node.kind !== 'class' || node.moduleId !== moduleId) continue

    if (node.name === iface.name || node.name === `${iface.name}Impl`) {
      results.push(node)
      continue
    }

    const ifaceSimpleName = iface.qualifiedName.split('.').pop() || iface.name
    if (node.qualifiedName.endsWith(`.${ifaceSimpleName}`) || node.qualifiedName.endsWith(`.${ifaceSimpleName}Impl`)) {
      results.push(node)
      continue
    }

    if (iface.name.startsWith('I') && /^I[A-Z]/.test(iface.name)) {
      const baseName = iface.name.slice(1)
      if (node.name === baseName || node.name === `${baseName}Impl`) {
        results.push(node)
      }
    }
  }

  return results
}

function synthesizeEventEmitterEdges(
  queries: QueryManager,
  moduleId: string
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const allNodes = queries.getAllNodes()

  const javaNodes = allNodes.filter(n =>
    n.language === 'java' && n.moduleId === moduleId
  )

  for (const node of javaNodes) {
    if (node.name === 'addEventListener' || node.name === 'addListener' ||
        node.name === 'on' || node.name === 'subscribe') {
      const callers = queries.getCallers(node.id)
      for (const caller of callers) {
        const callees = queries.getCallees(caller.id)
        for (const callee of callees) {
          if (['publishEvent', 'fireEvent', 'dispatchEvent', 'emit'].includes(callee.name)) {
            edges.push({
              source: caller.id,
              target: callee.id,
              kind: 'event',
              metadata: JSON.stringify({ synthesizedBy: 'eventEmitter', event: callee.name }),
              line: caller.startLine,
              col: caller.startColumn,
            })
          }
        }
      }
    }
  }

  const springEdges = synthesizeSpringEventEdges(queries, moduleId)
  edges.push(...springEdges)

  return edges
}

export function synthesizeSpringEventEdges(
  queries: QueryManager,
  moduleId: string
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const eventListeners = queries.getNodesByAnnotation('EventListener')
  if (eventListeners.length === 0) return edges

  for (const listener of eventListeners) {
    if (listener.moduleId !== moduleId) continue
    const annotations = queries.getAnnotationsByNode(listener.id)
    const eventTypeAnn = annotations.find(a => a.annotationName === 'EventListener')
    const eventType = eventTypeAnn?.value?.replace(/[{}()]/g, '').trim()
    if (!eventType) continue

    const eventClassNodes = queries.searchNodes(eventType.split('.').pop() || eventType, 5)
    for (const ecn of eventClassNodes) {
      if (ecn.moduleId === moduleId) {
        edges.push({
          source: ecn.id,
          target: listener.id,
          kind: 'spring_event_listener',
          metadata: JSON.stringify({ eventType, synthesizedBy: 'springEvent' }),
          line: listener.startLine,
          col: listener.startColumn,
        })
      }
    }
  }

  const publishMethods = queries.searchNodes('publishEvent', 100)
    .filter(n => n.moduleId === moduleId && n.name === 'publishEvent')

  for (const pm of publishMethods) {
    const callers = queries.getCallers(pm.id)
    for (const caller of callers) {
      if (caller.moduleId !== moduleId) continue
      edges.push({
        source: caller.id,
        target: pm.id,
        kind: 'spring_event_publish',
        metadata: JSON.stringify({ synthesizedBy: 'springEvent' }),
        line: caller.startLine,
        col: caller.startColumn,
      })
    }
  }

  return edges
}

export function synthesizeMyBatisEdges(
  queries: QueryManager,
  mybatisMappings: { namespace: string; id: string; filePath: string; line: number }[]
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []

  for (const mapping of mybatisMappings) {
    const mapperClass = mapping.namespace
    const methodName = mapping.id

    const candidates = queries.searchNodes(mapperClass, 10)
    for (const candidate of candidates) {
      if (candidate.kind === 'interface' || candidate.kind === 'class') {
        const children = queries.getChildren(candidate.id)
        const method = children.find(c => c.name === methodName)
        if (method) {
          edges.push({
            source: method.id,
            target: `mybatis:${mapping.filePath}:${mapping.line}`,
            kind: 'mybatis_mapping',
            metadata: JSON.stringify({ xmlPath: mapping.filePath, sqlId: `${mapping.namespace}.${mapping.id}` }),
            line: mapping.line,
            col: 0,
          })
        }
      }
    }
  }

  return edges
}

export function synthesizeFeignClientEdges(
  queries: QueryManager,
  feignClient: MiniCodeGraphNode,
  targetServiceMethods: { node: MiniCodeGraphNode; route: string }[]
): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const feignMethods = queries.getChildren(feignClient.id)

  for (const feignMethod of feignMethods) {
    const matchedService = targetServiceMethods.find(tsm =>
      tsm.node.name.toLowerCase() === feignMethod.name.toLowerCase()
    )
    if (matchedService) {
      edges.push({
        source: feignMethod.id,
        target: matchedService.node.id,
        kind: 'feign_call',
        metadata: JSON.stringify({
          feignClient: feignClient.name,
          route: matchedService.route,
          synthesizedBy: 'feignClient',
        }),
        line: feignMethod.startLine,
        col: feignMethod.startColumn,
      })
    }
  }

  return edges
}
