import type { QueryManager } from '../../../db/queries.js'
import type { MiniCodeGraphNode, MiniCodeGraphEdge } from '../../../types.js'
import type { DispatchPattern, IDispatchDetector, InferredTarget } from '../types.js'
import { CONFIDENCE } from '../types.js'
import { traceVariable } from '../variable-tracer.js'
import type { TracedVariable } from '../variable-tracer.js'

const BAR_W = 20

function showProgress(current: number, total: number, label: string): void {
  const pct = total > 0 ? Math.min(current / total, 1) : 0
  const filled = Math.round(pct * BAR_W)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_W - filled)
  process.stderr.write(`\r  · strategy-detector... [${bar}] ${(pct * 100).toFixed(0)}% ${label}`)
}

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

// ── Pre-computed index helpers ────────────────────────────────────────

interface Index {
  edgesBySource: Map<string, MiniCodeGraphEdge[]>
  edgesByTarget: Map<string, MiniCodeGraphEdge[]>
  nodesByParent: Map<string, MiniCodeGraphNode[]>
}

function buildIndex(allNodes: MiniCodeGraphNode[], allEdges: MiniCodeGraphEdge[]): Index {
  const edgesBySource = new Map<string, MiniCodeGraphEdge[]>()
  const edgesByTarget = new Map<string, MiniCodeGraphEdge[]>()
  const nodesByParent = new Map<string, MiniCodeGraphNode[]>()

  for (const e of allEdges) {
    let arr = edgesBySource.get(e.sourceId)
    if (!arr) { edgesBySource.set(e.sourceId, arr = []) }
    arr.push(e)
    arr = edgesByTarget.get(e.targetId)
    if (!arr) { edgesByTarget.set(e.targetId, arr = []) }
    arr.push(e)
  }

  for (const n of allNodes) {
    if (n.parentId) {
      let arr = nodesByParent.get(n.parentId)
      if (!arr) { nodesByParent.set(n.parentId, arr = []) }
      arr.push(n)
    }
  }

  return { edgesBySource, edgesByTarget, nodesByParent }
}

// ── Phase 1: class → implements → interface map ──────────────────────

function buildClassImplementations(
  allNodes: MiniCodeGraphNode[],
  idx: Index,
  queries: QueryManager,
  moduleId: string,
): Map<string, { node: MiniCodeGraphNode; id: string }[]> {
  const map = new Map<string, { node: MiniCodeGraphNode; id: string }[]>()
  const clsNodes = allNodes.filter(n => n.kind === 'class' && n.moduleId === moduleId)
  for (let i = 0; i < clsNodes.length; i++) {
    const node = clsNodes[i]
    if (i % 2000 === 0) showProgress(i, clsNodes.length, 'building interface→impl map')
    const impls = (idx.edgesBySource.get(node.id) ?? []).filter(e => e.kind === 'implements')
    for (const ie of impls) {
      const iface = queries.getNode(ie.targetId)
      if (iface) {
        const name = iface.name
        if (!map.has(name)) map.set(name, [])
        map.get(name)!.push({ node, id: node.id })
      }
    }
  }
  return map
}

// ── Phase 2: Map.put() caller-level detection ────────────────────────

function detectMapPutPatterns(
  allNodes: MiniCodeGraphNode[],
  idx: Index,
  queries: QueryManager,
  moduleId: string,
  patterns: DispatchPattern[],
): void {
  const mapPutNodes = allNodes.filter(n => n.name === 'put' && n.language === 'java')
  for (let i = 0; i < mapPutNodes.length; i++) {
    const putNode = mapPutNodes[i]
    if (putNode.moduleId !== moduleId) continue
    if (i % 500 === 0) showProgress(i, mapPutNodes.length, 'HashMap.put() detection')
    const callers = queries.getCallers(putNode.id)
    for (const caller of callers) {
      if (caller.moduleId !== moduleId) continue
      const calleeVarEdges = (idx.edgesBySource.get(caller.id) ?? []).filter(e =>
        (e.kind === 'references' || e.kind === 'calls') && e.targetId !== putNode.id
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
}

// ── Phase 3: Map.get() key tracing ───────────────────────────────────

function findGetCallsWithKeyTracing(
  queries: QueryManager,
  moduleId: string,
  idx: Index,
  allNodes: MiniCodeGraphNode[],
): DispatchPattern[] {
  const patterns: DispatchPattern[] = []

  // Build interface→impls map (fast via pre-indexed edges)
  const implsByIface = new Map<string, MiniCodeGraphNode[]>()
  const clsNodes = allNodes.filter(n => n.kind === 'class' && n.moduleId === moduleId)
  for (const node of clsNodes) {
    const impls = (idx.edgesBySource.get(node.id) ?? []).filter(e => e.kind === 'implements')
    for (const ie of impls) {
      const iface = queries.getNode(ie.targetId)
      if (iface) {
        const name = iface.name
        if (!implsByIface.has(name)) implsByIface.set(name, [])
        implsByIface.get(name)!.push(node)
      }
    }
  }

  const getCallNodes = allNodes.filter(n =>
    (n.name === 'get' || n.name === 'getOrDefault') &&
    n.kind === 'method' &&
    n.moduleId === moduleId
  )

  for (let g = 0; g < getCallNodes.length; g++) {
    const getNode = getCallNodes[g]
    if (g % 200 === 0) showProgress(g, getCallNodes.length, 'Map.get() key tracing')
    const parent = getNode.parentId ? queries.getNode(getNode.parentId) : null
    if (!parent) continue

    // Use pre-indexed edges by targetId for incoming calls
    const getCallsIncoming = (idx.edgesByTarget.get(getNode.id) ?? []).filter(e => e.kind === 'calls')

    for (const gc of getCallsIncoming) {
      const caller = queries.getNode(gc.sourceId)
      if (!caller) continue

      // Use pre-indexed nodes by parentId
      const callerChildren = idx.nodesByParent.get(caller.id) ?? []
      const argNodes = callerChildren.filter(n =>
        n.kind === 'argument' || n.kind === 'expression'
      )

      for (const arg of argNodes) {
        const trace = traceVariable(arg.name, caller.id, queries)
        if (!trace) continue

        const interfaceName = parent.name.endsWith('Map')
          ? parent.name.replace(/Map$/, '')
          : parent.name

        const implCandidates = implsByIface.get(interfaceName) ?? []

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
          type: targets[0].provenance,
          sourceId: parent.id,
          sourceName: parent.name,
          interfaceName,
          possibleTargets: targets,
        })

        patterns.push({
          type: targets[0].provenance,
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

// ── Detector class ────────────────────────────────────────────────────

export class StrategyDetector implements IDispatchDetector {
  name = 'strategy-detector'

  async detect(queries: QueryManager, moduleId: string, _allModuleIds: string[]): Promise<DispatchPattern[]> {
    const patterns: DispatchPattern[] = []
    const allNodes = queries.getAllNodes()
    const allEdges = queries.getAllEdges()

    // Build edge/node index once for all phases
    const idx = buildIndex(allNodes, allEdges)

    // ── Phase 1: class → implements → interface map ──
    const classImplementations = buildClassImplementations(allNodes, idx, queries, moduleId)
    showProgress(1, 1, 'building strategy patterns from interface→impl map')

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

    // ── Phase 2: HashMap.put() caller-level detection ──
    showProgress(0, 1, 'HashMap.put() detection')
    detectMapPutPatterns(allNodes, idx, queries, moduleId, patterns)

    // ── Phase 3: Map.get() key tracing ──
    showProgress(0, 1, 'Map.get() key tracing')
    const runtimeDispatchPatterns = findGetCallsWithKeyTracing(queries, moduleId, idx, allNodes)
    patterns.push(...runtimeDispatchPatterns)

    // Clear progress line before final output
    process.stderr.write('\r' + ' '.repeat(80) + '\r')
    return patterns
  }
}
