import type { QueryManager } from '../../db/queries.js'
import type { DispatchPattern, DispatchResult, InferredEdge, InferredTarget } from './types.js'
import { INFERRED_EDGE_KINDS } from './types.js'

export function mergeInferredEdges(
  queries: QueryManager,
  patterns: DispatchPattern[],
  _moduleId: string,
  minConfidence = 0,
): DispatchResult {
  const edges: InferredEdge[] = []
  const byProvenance: Record<string, number> = {}
  const seenEdgeKeys = new Set<string>()
  let skippedCount = 0

  for (const pattern of patterns) {
    byProvenance[pattern.type] = (byProvenance[pattern.type] || 0) + 1

    for (const target of pattern.possibleTargets) {
      if (target.confidence < minConfidence) {
        skippedCount++
        continue
      }
      if (pattern.sourceId) {
        const edgeKind = edgeKindForProvenance(pattern.type)
        const edgeKey = `${pattern.sourceId}|${target.targetId}|${edgeKind}`
        if (seenEdgeKeys.has(edgeKey)) continue
        seenEdgeKeys.add(edgeKey)

        edges.push({
          source: pattern.sourceId,
          target: target.targetId,
          kind: edgeKind,
          metadata: JSON.stringify({
            provenance: pattern.type,
            confidence: target.confidence,
            provenanceDetail: target.provenanceDetail,
            condition: target.condition,
            alternatives: target.alternatives,
          }),
          line: 0,
          col: 0,
        })
      }

      if (target.interfaceId && target.interfaceId !== pattern.sourceId) {
        const edgeKind = 'conditional_impl'
        const edgeKey = `${target.interfaceId}|${target.targetId}|${edgeKind}`
        if (seenEdgeKeys.has(edgeKey)) continue
        seenEdgeKeys.add(edgeKey)

        edges.push({
          source: target.interfaceId,
          target: target.targetId,
          kind: edgeKind,
          metadata: JSON.stringify({
            provenance: pattern.type,
            confidence: target.confidence,
            provenanceDetail: target.provenanceDetail,
            condition: target.condition,
            alternatives: target.alternatives,
          }),
          line: 0,
          col: 0,
        })
      }
    }
  }

  const deduplicated = deduplicateEdges(edges)

  for (const edge of deduplicated) {
    try {
      queries.insertEdge(edge.source, edge.target, edge.kind, edge.metadata, edge.line, edge.col)
    } catch {
      continue
    }
  }

  if (skippedCount > 0) {
    process.stderr.write(`  Filtered out ${skippedCount} low-confidence targets (< ${minConfidence})\n`)
  }
  return {
    edges: deduplicated,
    patterns,
    stats: {
      totalEdges: deduplicated.length,
      totalPatterns: patterns.length,
      filteredTargets: skippedCount,
      byProvenance,
    },
  }
}

function edgeKindForProvenance(provenance: string): string {
  switch (provenance) {
    case 'proxy_handler':
      return 'proxy_wraps'
    case 'aop_proxy':
      return 'aop_advises'
    case 'strategy_registered':
      return 'dispatch_registration'
    case 'factory_product':
      return 'dispatch_registration'
    case 'spi_loaded':
      return 'dispatch_registration'
    case 'reflective_match':
      return 'dispatch_registration'
    case 'conditional_bean':
      return 'conditional_impl'
    default:
      return 'dispatch_registration'
  }
}

function deduplicateEdges(edges: InferredEdge[]): InferredEdge[] {
  const seen = new Set<string>()
  return edges.filter(e => {
    const key = `${e.source}|${e.target}|${e.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function getDispatchTargetsForNode(
  queries: QueryManager,
  nodeId: string,
  minConfidence = 0,
): InferredTarget[] {
  const targets: InferredTarget[] = []
  const allEdges = queries.getAllEdges()

  const dispatchEdges = allEdges.filter(e =>
    (e.sourceId === nodeId || e.targetId === nodeId) &&
    (INFERRED_EDGE_KINDS as readonly string[]).includes(e.kind)
  )

  for (const edge of dispatchEdges) {
    try {
      const meta = JSON.parse(edge.metadata ?? '{}')
      const confidence = meta.confidence ?? 0
      if (confidence < minConfidence) continue

      const targetId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId
      const targetNode = queries.getNode(targetId)

      targets.push({
        targetId,
        targetName: targetNode?.name ?? targetId,
        confidence,
        provenance: meta.provenance ?? 'unknown',
        provenanceDetail: meta.provenanceDetail ?? '',
        condition: meta.condition,
        alternatives: meta.alternatives,
      })
    } catch {
      continue
    }
  }

  return targets
}
