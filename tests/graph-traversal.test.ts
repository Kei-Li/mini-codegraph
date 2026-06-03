import { describe, it, expect } from 'vitest'
import type { QueryManager } from '../src/db/queries.js'
import type { MiniCodeGraphNode } from '../src/types.js'
import { GraphTraverser } from '../src/graph/traversal.js'

function createMockNode(id: string, name: string, kind: string = 'function', filePath: string = 'src/test.ts'): MiniCodeGraphNode {
  return { id, name, kind, filePath, qualifiedName: name, language: 'typescript', startLine: 1, endLine: 10, startColumn: 0, endColumn: 0, docstring: '', signature: '', visibility: 'public', isExported: false }
}

function createMockQueryManager(options: {
  callers?: Record<string, MiniCodeGraphNode[]>
  callees?: Record<string, MiniCodeGraphNode[]>
  nodes?: Record<string, MiniCodeGraphNode>
}): QueryManager {
  const { callers = {}, callees = {}, nodes = {} } = options

  const allNodesById: Record<string, MiniCodeGraphNode> = { ...nodes }
  for (const [, ns] of Object.entries(callees)) {
    for (const n of ns) allNodesById[n.id] = n
  }
  for (const [, ns] of Object.entries(callers)) {
    for (const n of ns) allNodesById[n.id] = n
  }

  return {
    getCallers: (id: string) => callers[id] ?? [],
    getCallees: (id: string) => callees[id] ?? [],
    getNode: (id: string) => allNodesById[id] ?? null as any,
    getAllNodes: () => Object.values(allNodesById),
    getChildren: () => [],
    getNodesByFile: () => [],
    getFileDependencies: () => [],
    getFilesByGlob: () => [],
    searchNodes: () => [],
    searchNodesWithRank: () => [],
    getNodeByQualifiedName: () => null as any,
    getParents: () => [],
    getEdges: () => [],
    getEdgesByType: () => [],
    getAnnotationsByNode: () => [],
    getTemplatesByNode: () => [],
    getModules: () => [],
    getModuleById: () => null as any,
    getUnresolvedReferences: () => [],
    getAllFiles: () => [],
    getFileByPath: () => null as any,
    insertNode: () => '',
    insertEdge: () => {},
    insertFile: () => {},
    insertModule: () => {},
    insertUnresolvedReference: () => {},
    insertAnnotation: () => {},
    insertTemplate: () => {},
    insertProjectMetadata: () => {},
    deleteNodes: () => {},
    deleteEdges: () => {},
    deleteFile: () => {},
    deleteUnresolvedReferencesByFile: () => {},
    deleteAnnotationsByFile: () => {},
    getProjectMetadata: () => null as any,
    updateFile: () => {},
    updateNode: () => {},
    updateModule: () => {},
    getFileCount: () => 0,
    getNodeCount: () => 0,
    getEdgeCount: () => 0,
    getModuleCount: () => 0,
    getPendingCount: () => 0,
    transaction: (fn: () => void) => fn(),
    clearAll: () => {},
    close: () => {},
  } as unknown as QueryManager
}

describe('GraphTraverser', () => {
  it('finds direct call path', () => {
    const nodeA = createMockNode('a', 'funcA')
    const nodeB = createMockNode('b', 'funcB')
    const qm = createMockQueryManager({
      callees: { a: [nodeB] },
      callers: { b: [nodeA] },
      nodes: { a: nodeA, b: nodeB },
    })
    const traverser = new GraphTraverser(qm)
    const paths = traverser.findPath('a', 'b', 5)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths[0].some(h => h.node.id === 'b')).toBe(true)
  })

  it('returns empty when no path exists', () => {
    const nodeA = createMockNode('a', 'funcA')
    const nodeC = createMockNode('c', 'funcC')
    const qm = createMockQueryManager({
      callees: { a: [], c: [] },
      nodes: { a: nodeA, c: nodeC },
    })
    const traverser = new GraphTraverser(qm)
    const paths = traverser.findPath('a', 'c', 5)
    expect(paths).toHaveLength(0)
  })

  it('respects maxDepth limit', () => {
    const nodes = [0, 1, 2, 3, 4, 5].map(i => createMockNode(`n${i}`, `func${i}`))
    const nodeMap: Record<string, MiniCodeGraphNode> = {}
    const callees: Record<string, MiniCodeGraphNode[]> = {}
    for (let i = 0; i < 5; i++) {
      nodeMap[nodes[i].id] = nodes[i]
      callees[nodes[i].id] = [nodes[i + 1]]
    }
    nodeMap[nodes[5].id] = nodes[5]
    callees[nodes[5].id] = []

    const qm = createMockQueryManager({ callees, nodes: nodeMap })
    const traverser = new GraphTraverser(qm)
    const paths = traverser.findPath('n0', 'n5', 3)
    expect(paths).toHaveLength(0)
  })
})
