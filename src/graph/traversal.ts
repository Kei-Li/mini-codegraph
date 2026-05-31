import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode } from '../types.js'

export class GraphTraverser {
  constructor(private queries: QueryManager) {}

  findPath(
    fromId: string,
    toId: string,
    maxDepth = 10
  ): CodeGraphNode[][] {
    const paths: CodeGraphNode[][] = []
    const visited = new Set<string>()

    function bfs(
      q: QueryManager,
      current: string,
      target: string,
      depth: number,
      path: CodeGraphNode[]
    ): void {
      if (depth > maxDepth || visited.has(current)) return
      visited.add(current)

      const node = q.getNode(current)
      if (!node) return

      const newPath = [...path, node]

      if (current === target) {
        paths.push(newPath)
        visited.delete(current)
        return
      }

      // Explore callees (outgoing edges)
      const callees = q.getCallees(current)
      for (const callee of callees) {
        bfs(q, callee.id, target, depth + 1, newPath)
      }

      // Explore callers (incoming edges)
      const callers = q.getCallers(current)
      for (const caller of callers) {
        bfs(q, caller.id, target, depth + 1, newPath)
      }

      visited.delete(current)
    }

    bfs(this.queries, fromId, toId, 0, [])
    return paths
  }

  findImpactedNodes(nodeId: string, depth = 3): Map<string, CodeGraphNode> {
    const impacted = new Map<string, CodeGraphNode>()
    const visited = new Set<string>()

    function dfs(q: QueryManager, currentId: string, remainingDepth: number): void {
      if (remainingDepth < 0 || visited.has(currentId)) return
      visited.add(currentId)

      const node = q.getNode(currentId)
      if (node) {
        impacted.set(currentId, node)
      }

      // Find everything that calls this node (incoming calls)
      const callers = q.getCallers(currentId)
      for (const caller of callers) {
        dfs(q, caller.id, remainingDepth - 1)
      }

      // Find children (contains relationships)
      const children = q.getChildren(currentId)
      for (const child of children) {
        dfs(q, child.id, remainingDepth - 1)
      }
    }

    dfs(this.queries, nodeId, depth)
    impacted.delete(nodeId)
    return impacted
  }

  findDeadCode(): CodeGraphNode[] {
    const allNodes: CodeGraphNode[] = this.queries.searchNodes('', 10000)
    return allNodes.filter(node => {
      const callers = this.queries.getCallers(node.id)
      return callers.length === 0
    })
  }
}
