import type { MiniCodeGraphNode } from '../types.js'
import type { QueryManager } from '../db/queries.js'

export interface CollapsedGroup {
  representative: MiniCodeGraphNode
  siblings: { name: string; filePath: string }[]
  collapsedCount: number
}

export function collapsePolymorphicSiblings(
  nodes: MiniCodeGraphNode[],
  queries: QueryManager,
  maxGroups = 3
): (MiniCodeGraphNode | CollapsedGroup)[] {
  const interfaceMap = new Map<string, MiniCodeGraphNode[]>()
  const seen = new Set<string>()

  for (const node of nodes) {
    if (seen.has(node.id)) continue

    if (node.kind === 'class' || node.kind === 'struct') {
      const parentId = node.parentId
      const implementsEdge = queries.getAllEdges().find(e =>
        e.sourceId === node.id && e.kind === 'implements'
      )
      if (implementsEdge) {
        const iface = queries.getNode(implementsEdge.targetId)
        if (iface) {
          const key = iface.id
          if (!interfaceMap.has(key)) interfaceMap.set(key, [])
          interfaceMap.get(key)!.push(node)
          seen.add(node.id)
          continue
        }
      }

      if (parentId) {
        const parent = queries.getNode(parentId)
        if (parent && (parent.kind === 'interface' || parent.kind === 'trait')) {
          const key = parent.id
          if (!interfaceMap.has(key)) interfaceMap.set(key, [])
          interfaceMap.get(key)!.push(node)
          seen.add(node.id)
          continue
        }
      }
    }
  }

  const result: (MiniCodeGraphNode | CollapsedGroup)[] = []
  const addedSiblings = new Set<string>()

  let groupsAdded = 0
  for (const [, siblings] of interfaceMap) {
    if (groupsAdded >= maxGroups) break
    if (siblings.length < 2) continue

    const representative = siblings[0]

    result.push({
      representative,
      siblings: siblings.map(s => ({ name: s.name, filePath: s.filePath })),
      collapsedCount: siblings.length - 1,
    })

    for (const s of siblings) addedSiblings.add(s.id)
    groupsAdded++
  }

  for (const node of nodes) {
    if (!addedSiblings.has(node.id)) {
      result.push(node)
    }
  }

  return result
}

export function formatPolymorphGroup(group: CollapsedGroup): string {
  const siblingList = group.siblings
    .filter(s => s.name !== group.representative.name || s.filePath !== group.representative.filePath)
    .slice(0, 5)
    .map(s => `  - ${s.name} (${s.filePath})`)
    .join('\n')

  if (group.collapsedCount > 5) {
    return `${group.representative.name} +${group.collapsedCount} implementations\n${siblingList}\n  ... and ${group.collapsedCount - 5} more`
  }
  return `${group.representative.name} +${group.collapsedCount} implementations\n${siblingList}`
}
