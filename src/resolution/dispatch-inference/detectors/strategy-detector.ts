import type { QueryManager } from '../../../db/queries.js'
import type { MiniCodeGraphNode } from '../../../types.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'
import { traceVariable } from '../variable-tracer.js'
import type { TracedVariable } from '../variable-tracer.js'

function buildTargetsForImplCandidates(
  implCandidates: MiniCodeGraphNode[],
  parent: MiniCodeGraphNode | null,
  caller: MiniCodeGraphNode,
  trace: TracedVariable,
  allNodes: MiniCodeGraphNode[],
  moduleId: string,
): InferredTarget[] {
  const interfaceName = parent && parent.name.endsWith('Map')
    ? parent.name.replace(/Map$/, '')
    : parent?.name ?? ''

  // When we have specific keys matched → higher confidence
  if (trace.possibleKeys.length > 0) {
    const lowerKeys = trace.possibleKeys.map(k => k.toLowerCase())
    const matched = allNodes.filter(n =>
      n.kind === 'class' &&
      n.moduleId === moduleId &&
      lowerKeys.some(k => n.name.toLowerCase().includes(k))
    )
    if (matched.length > 0) {
      return matched.map(impl => ({
        targetId: impl.id,
        targetName: impl.name,
        interfaceId: parent?.id,
        interfaceName,
        confidence: CONFIDENCE.STRATEGY_MAP_ENUMERATED,
        provenance: 'strategy_registered' as const,
        provenanceDetail: `${caller.name} → Map.get("${trace.possibleKeys.join('|')}") matched ${impl.name} in ${trace.methodName}`,
        condition: {
          source: 'runtime_key',
          value: trace.possibleKeys.join(', '),
          expression: `Map.get() dispatch via key=[${trace.possibleKeys.join(', ')}]`,
        },
      }))
    }
  }

  // No specific keys but we have a data source → list all implementations
  const ds = trace.dataSource
  if (ds) {
    return implCandidates.map(impl => ({
      targetId: impl.id,
      targetName: impl.name,
      interfaceId: parent?.id,
      interfaceName,
      confidence: CONFIDENCE.DATA_DRIVEN_DISPATCH,
      provenance: 'data_driven' as const,
      provenanceDetail: `${caller.name} → ${ds.detail} → Map.get(...) — 运行时刻由数据决定, ${impl.name} 是候选实现`,
      condition: {
        source: ds.kind,
        value: ds.entityType || ds.fieldName || ds.methodName,
        expression: ds.detail,
      },
    }))
  }

  // Fallback: list all implementations with unknown provenance
  return implCandidates.map(impl => ({
    targetId: impl.id,
    targetName: impl.name,
    interfaceId: parent?.id,
    interfaceName,
    confidence: CONFIDENCE.UNKNOWN,
    provenance: 'unknown' as const,
    provenanceDetail: `${caller.name} → Map.get() — 无法确定 key 来源, ${impl.name} 是候选`,
  }))
}

function findGetCallsWithKeyTracing(
  queries: QueryManager,
  moduleId: string,
): DispatchPattern[] {
  const patterns: DispatchPattern[] = []
  const allNodes = queries.getAllNodes()
  const allEdges = queries.getAllEdges()

  // Pre-compute all interface→impls mappings
  const implsByIface = new Map<string, MiniCodeGraphNode[]>()
  for (const node of allNodes) {
    if (node.kind === 'class' && node.moduleId === moduleId) {
      const impls = allEdges.filter(e =>
        e.kind === 'implements' && e.sourceId === node.id
      )
      for (const ie of impls) {
        const iface = queries.getNode(ie.targetId)
        if (iface) {
          const name = iface.name
          if (!implsByIface.has(name)) implsByIface.set(name, [])
          implsByIface.get(name)!.push(node)
        }
      }
    }
  }

  // Find Map-related get() calls
  const getCallNodes = allNodes.filter(n =>
    (n.name === 'get' || n.name === 'getOrDefault') &&
    n.kind === 'method' &&
    n.moduleId === moduleId
  )

  for (const getNode of getCallNodes) {
    const parent = getNode.parentId ? queries.getNode(getNode.parentId) : null
    if (!parent) continue

    const getCallsIncoming = allEdges.filter(e =>
      e.kind === 'calls' && e.targetId === getNode.id
    )

    for (const gc of getCallsIncoming) {
      const caller = queries.getNode(gc.sourceId)
      if (!caller) continue

      const callerChildren = allNodes.filter(n => n.parentId === caller.id)
      const argNodes = callerChildren.filter(n =>
        n.kind === 'argument' || n.kind === 'expression'
      )

      for (const arg of argNodes) {
        const trace = traceVariable(arg.name, caller.id, queries)
        if (!trace) continue

        // Determine interface name
        const interfaceName = parent.name.endsWith('Map')
          ? parent.name.replace(/Map$/, '')
          : parent.name

        // Get all impls of this interface
        const implCandidates = implsByIface.get(interfaceName) ?? []

        // Fallback: collect ALL interface implementations in the module
        const effectiveCandidates = implCandidates.length > 0
          ? implCandidates
          : [...implsByIface.values()].flat().filter(
              (n, idx, self) => self.findIndex(x => x.id === n.id) === idx
            )

        if (effectiveCandidates.length === 0) continue

        const targets = buildTargetsForImplCandidates(
          effectiveCandidates, parent, caller, trace, allNodes, moduleId,
        )

        if (targets.length === 0) continue

        patterns.push({
          type: targets[0].provenance as any,
          sourceId: parent.id,
          sourceName: parent.name,
          interfaceName,
          possibleTargets: targets,
        })

        patterns.push({
          type: targets[0].provenance as any,
          sourceId: caller.id,
          sourceName: caller.name,
          interfaceName,
          possibleTargets: targets.map(t => ({
            ...t,
            confidence: t.confidence * 0.9,
          })),
        })
      }
    }
  }

  return patterns
}

export class StrategyDetector implements IDispatchDetector {
  name = 'strategy-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const allEdges = queries.getAllEdges()

    // --- Original Map.put() strategy detection ---
    const classImplementations = new Map<string, { node: any; id: string }[]>()
    for (const node of allNodes) {
      if (node.kind === 'class' && node.moduleId === moduleId) {
        const impls = allEdges.filter(e =>
          e.kind === 'implements' && e.sourceId === node.id
        )
        if (impls.length > 0) {
          for (const ie of impls) {
            const iface = queries.getNode(ie.targetId)
            if (iface) {
              if (!classImplementations.has(iface.name)) {
                classImplementations.set(iface.name, [])
              }
              classImplementations.get(iface.name)!.push({ node, id: node.id })
            }
          }
        }
      }
    }

    for (const [ifaceName, impls] of classImplementations) {
      if (impls.length < 2) continue

      const targets: InferredTarget[] = impls.map((impl, idx) => ({
        targetId: impl.id,
        targetName: impl.node.name,
        interfaceId: undefined,
        confidence: CONFIDENCE.STRATEGY_MAP_ENUMERATED,
        provenance: 'strategy_registered',
        provenanceDetail: `Possible strategy implementation #${idx + 1}: ${impl.node.name} implements ${ifaceName}`,
        condition: {
          source: 'runtime_key',
          value: impl.node.name.toLowerCase(),
          expression: `${ifaceName} strategy key = "${impl.node.name.toLowerCase()}"`,
        },
      }))

      patterns.push({
        type: 'strategy_registered',
        sourceId: '',
        sourceName: ifaceName,
        interfaceName: ifaceName,
        possibleTargets: targets,
      })
    }

    // --- HashMap.put() caller-level detection ---
    const mapPutNodes = allNodes.filter(n =>
      n.name === 'put' && n.language === 'java'
    )

    for (const putNode of mapPutNodes) {
      if (putNode.moduleId !== moduleId) continue
      const callers = queries.getCallers(putNode.id)
      for (const caller of callers) {
        if (caller.moduleId !== moduleId) continue

        const calleeVarEdges = allEdges.filter(e =>
          (e.kind === 'references' || e.kind === 'calls') &&
          e.sourceId === caller.id &&
          e.targetId !== putNode.id
        )

        const targets: InferredTarget[] = calleeVarEdges.map(ce => ({
          targetId: ce.targetId,
          targetName: queries.getNode(ce.targetId)?.name ?? ce.targetId,
          confidence: CONFIDENCE.STRATEGY_MAP_ENUMERATED,
          provenance: 'strategy_registered',
          provenanceDetail: `HashMap.put() in ${caller.name}, target: ${queries.getNode(ce.targetId)?.name ?? ce.targetId}`,
          condition: {
            source: 'map_key',
            value: queries.getNode(ce.targetId)?.name ?? '',
            expression: `HashMap key = "${queries.getNode(ce.targetId)?.name ?? ''}"`,
          },
        }))

        if (targets.length > 0) {
          patterns.push({
            type: 'strategy_registered',
            sourceId: caller.id,
            sourceName: caller.name,
            possibleTargets: targets,
          })
        }
      }
    }

    // --- NEW: Runtime dispatch via Map.get() key tracing ---
    const runtimeDispatchPatterns = findGetCallsWithKeyTracing(queries, moduleId)
    patterns.push(...runtimeDispatchPatterns)

    return patterns
  }
}
