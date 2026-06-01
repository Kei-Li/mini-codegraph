import type { QueryManager } from '../db/queries.js'
import type { TransactionalInfo } from '../types.js'

const PROPAGATION_LEVELS = [
  'REQUIRED', 'SUPPORTS', 'MANDATORY', 'REQUIRES_NEW',
  'NOT_SUPPORTED', 'NEVER', 'NESTED',
] as const

const ISOLATION_LEVELS = [
  'DEFAULT', 'READ_UNCOMMITTED', 'READ_COMMITTED',
  'REPEATABLE_READ', 'SERIALIZABLE',
] as const

export function parseTransactionalValue(value: string): Partial<TransactionalInfo> {
  const info: Partial<TransactionalInfo> = {
    propagation: 'REQUIRED',
    isolation: 'DEFAULT',
    timeout: -1,
    readOnly: false,
    rollbackFor: [],
    noRollbackFor: [],
  }

  if (!value || value === '') return info

  const cleanValue = value.replace(/^@Transactional\(|\)$/g, '')
  const parts = splitAnnotationArgs(cleanValue)

  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === 'readOnly = true' || trimmed === 'readOnly=true') {
      info.readOnly = true
    } else if (trimmed.startsWith('propagation')) {
      const match = trimmed.match(/propagation\s*=\s*(Propagation\.)?(\w+)/)
      if (match) {
        const level = match[2]
        if (PROPAGATION_LEVELS.includes(level as any)) {
          info.propagation = level
        }
      }
    } else if (trimmed.startsWith('isolation')) {
      const match = trimmed.match(/isolation\s*=\s*(Isolation\.)?(\w+)/)
      if (match) {
        const level = match[2]
        if (ISOLATION_LEVELS.includes(level as any)) {
          info.isolation = level
        }
      }
    } else if (trimmed.startsWith('timeout')) {
      const match = trimmed.match(/timeout\s*=\s*(\d+)/)
      if (match) {
        info.timeout = parseInt(match[1])
      }
    } else if (trimmed.startsWith('rollbackFor')) {
      const match = trimmed.match(/rollbackFor\s*=\s*\{?([^}]+)\}?/)
      if (match) {
        info.rollbackFor = match[1].split(',').map(s => s.trim().replace(/\.class/g, ''))
      }
    } else if (trimmed.startsWith('noRollbackFor')) {
      const match = trimmed.match(/noRollbackFor\s*=\s*\{?([^}]+)\}?/)
      if (match) {
        info.noRollbackFor = match[1].split(',').map(s => s.trim().replace(/\.class/g, ''))
      }
    }
  }

  return info
}

function splitAnnotationArgs(input: string): string[] {
  const args: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(' || ch === '{') { depth++; current += ch }
    else if (ch === ')' || ch === '}') { depth--; current += ch }
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = '' }
    else { current += ch }
  }
  if (current.trim()) args.push(current.trim())
  return args
}

export function indexTransactionalAnnotations(
  queries: QueryManager,
  moduleId: string
): TransactionalInfo[] {
  const results: TransactionalInfo[] = []
  const allNodes = queries.getAllNodes()

  for (const node of allNodes) {
    const anns = queries.getAnnotationsByNode(node.id)

    for (const ann of anns) {
      if (ann.annotationName === 'Transactional') {
        const parsed = parseTransactionalValue(ann.value)
        const info: TransactionalInfo = {
          nodeId: node.id,
          methodName: node.name,
          className: node.parentId ? queries.getNode(node.parentId)?.name ?? '' : '',
          propagation: parsed.propagation ?? 'REQUIRED',
          isolation: parsed.isolation ?? 'DEFAULT',
          timeout: parsed.timeout ?? -1,
          readOnly: parsed.readOnly ?? false,
          rollbackFor: parsed.rollbackFor ?? [],
          noRollbackFor: parsed.noRollbackFor ?? [],
          filePath: node.filePath,
          line: node.startLine,
        }
        results.push(info)

        const txId = `tx:${moduleId}:${node.id}`
        queries.insertEdge(node.id, txId, 'transactional',
          JSON.stringify(info), node.startLine, 0)
      }
    }
  }

  const propagateEdges: { fromId: string; toId: string; txInfo: string }[] = []
  for (const info of results) {
    const callerEdges = queries.getCallers(info.nodeId)
    for (const caller of callerEdges) {
      const callerAnns = queries.getAnnotationsByNode(caller.id)
      if (callerAnns.some(a => a.annotationName !== 'Transactional')) {
        propagateEdges.push({
          fromId: caller.id,
          toId: info.nodeId,
          txInfo: JSON.stringify({ callerPropagation: 'REQUIRED', calleePropagation: info.propagation }),
        })
      }
    }
  }

  for (const pe of propagateEdges) {
    queries.insertEdge(pe.fromId, pe.toId, 'tx_propagate', pe.txInfo, 0, 0)
  }

  return results
}

export function findTxBoundaryConflicts(queries: QueryManager, moduleId: string): {
  outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string
}[] {
  const conflicts: {
    outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string
  }[] = []

  const txEdges = queries.getAllEdges().filter(e => e.kind === 'tx_propagate')
  for (const edge of txEdges) {
    try {
      const meta = JSON.parse(edge.metadata ?? '{}')
      const outerNode = queries.getNode(edge.sourceId)
      const innerNode = queries.getNode(edge.targetId)

      if (outerNode && innerNode) {
        const outerOuter = queries.getCallers(edge.sourceId)
          .map(c => queries.getNode(c.id))
          .filter(Boolean)
          .map(n => {
            const aa = queries.getAnnotationsByNode(n!.id)
            return aa.find(a => a.annotationName === 'Transactional')?.value ?? ''
          })
          .filter(v => v !== '')

        const innerAnns = queries.getAnnotationsByNode(edge.targetId)
        const innerTx = innerAnns.find(a => a.annotationName === 'Transactional')
        const innerProp = innerTx ? parseTransactionalValue(innerTx.value).propagation ?? 'REQUIRED' : 'REQUIRED'

        if (innerProp === 'REQUIRES_NEW' && outerOuter.length > 0) {
          conflicts.push({
            outerMethod: outerNode.name,
            innerMethod: innerNode.name,
            outerPropagation: meta.callerPropagation ?? 'REQUIRED',
            innerPropagation: innerProp!,
            warning: 'REQUIRES_NEW inside existing transaction: outer transaction will be suspended',
          })
        }
      }
    } catch {}
  }

  return conflicts
}
