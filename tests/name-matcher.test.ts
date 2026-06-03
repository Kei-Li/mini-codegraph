import { describe, it, expect, vi } from 'vitest'
import { matchReference, findImplementations, resolveByNameAcrossModules } from '../src/resolution/name-matcher.js'
import type { QueryManager } from '../src/db/queries.js'
import type { MiniCodeGraphNode } from '../src/types.js'

function createMockNode(overrides: Partial<MiniCodeGraphNode> = {}): MiniCodeGraphNode {
  return {
    id: '1', name: 'TestNode', kind: 'class', qualifiedName: 'com.app.TestNode',
    filePath: 'src/TestNode.java', startLine: 1, endLine: 10, moduleId: 'module1',
    parentId: null, signature: '', docstring: '', language: 'java', annotations: [],
    ...overrides,
  } as MiniCodeGraphNode
}

function createQueryManager(nodes: MiniCodeGraphNode[]): QueryManager {
  return {
    searchNodes: vi.fn().mockReturnValue(nodes),
    getNode: vi.fn((id: string) => nodes.find(n => n.id === id) ?? null),
    getAllNodes: vi.fn().mockReturnValue(nodes),
  } as unknown as QueryManager
}

describe('matchReference', () => {
  it('returns empty array when no nodes match', () => {
    const qm = createQueryManager([])
    const results = matchReference(qm, 'NonExistent', 'src/a.ts', 'mod1')
    expect(results).toEqual([])
  })

  it('filters out same file matches', () => {
    const node = createMockNode({ id: '1', name: 'Foo', filePath: 'src/a.ts' })
    const qm = createQueryManager([node])
    const results = matchReference(qm, 'Foo', 'src/a.ts', 'mod1')
    expect(results).length(0)
  })

  it('matches by exact name', () => {
    const node = createMockNode({ id: '1', name: 'UserService', filePath: 'src/b.ts' })
    const qm = createQueryManager([node])
    const results = matchReference(qm, 'UserService', 'src/a.ts', 'mod1')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].strategy).toBe('exact_name')
    expect(results[0].confidence).toBe(0.7)
  })

  it('matches by qualified name contains', () => {
    const node = createMockNode({ id: '1', name: 'UserService', qualifiedName: 'com.app.UserService', filePath: 'src/b.ts' })
    const qm = createQueryManager([node])
    const results = matchReference(qm, 'com.app.UserService', 'src/a.ts', 'mod1')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].strategy).toBe('qualified_name_contains')
    expect(results[0].confidence).toBe(0.5)
  })

  it('returns results sorted by confidence descending', () => {
    const node1 = createMockNode({ id: '1', name: 'Foo', qualifiedName: 'com.other.Foo', filePath: 'b.ts' })
    const node2 = createMockNode({ id: '2', name: 'Foo', qualifiedName: 'com.app.Foo', filePath: 'c.ts' })
    const qm = createQueryManager([node1, node2])
    const results = matchReference(qm, 'com.app.Foo', 'src/a.ts', 'mod1')
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence)
    }
  })

  it('limits results to 10', () => {
    const nodes = Array.from({ length: 15 }, (_, i) =>
      createMockNode({ id: String(i), name: 'Foo', filePath: `f${i}.ts` })
    )
    const qm = createQueryManager(nodes)
    const results = matchReference(qm, 'Foo', 'other.ts', 'mod1')
    expect(results.length).toBeLessThanOrEqual(10)
  })

  it('filters by kind when provided', () => {
    const node1 = createMockNode({ id: '1', name: 'Foo', kind: 'class', filePath: 'b.ts' })
    const node2 = createMockNode({ id: '2', name: 'Foo', kind: 'function', filePath: 'c.ts' })
    const qm = createQueryManager([node1, node2])
    const results = matchReference(qm, 'Foo', 'a.ts', 'mod1', 'class')
    expect(results.every(r => r.node.kind === 'class')).toBe(true)
  })
})

describe('findImplementations', () => {
  it('returns empty for non-interface kind', () => {
    const qm = createQueryManager([])
    const node = createMockNode({ kind: 'class' })
    expect(findImplementations(qm, node)).toEqual([])
  })

  it('finds class with Impl suffix', () => {
    const iface = createMockNode({ id: '1', name: 'UserService', kind: 'interface', qualifiedName: 'com.app.UserService' })
    const impl = createMockNode({ id: '2', name: 'UserServiceImpl', kind: 'class', qualifiedName: 'com.app.UserServiceImpl' })
    const qm = createQueryManager([iface, impl])
    const results = findImplementations(qm, iface)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('2')
  })

  it('finds class with I-prefix convention', () => {
    const iface = createMockNode({ id: '1', name: 'IUserService', kind: 'interface', qualifiedName: 'com.app.IUserService' })
    const impl = createMockNode({ id: '2', name: 'UserService', kind: 'class', qualifiedName: 'com.app.UserService' })
    const qm = createQueryManager([iface, impl])
    const results = findImplementations(qm, iface)
    expect(results).toHaveLength(1)
  })
})

describe('resolveByNameAcrossModules', () => {
  it('returns matching nodes', () => {
    const node = createMockNode({ moduleId: 'mod2' })
    const qm = createQueryManager([node])
    const results = resolveByNameAcrossModules(qm, 'Test')
    expect(results).toHaveLength(1)
  })

  it('filters by excludeModuleId', () => {
    const node1 = createMockNode({ id: '1', moduleId: 'mod2' })
    const node2 = createMockNode({ id: '2', moduleId: 'mod1' })
    const qm = createQueryManager([node1, node2])
    const results = resolveByNameAcrossModules(qm, 'Test', 'mod1')
    expect(results.every(r => r.moduleId !== 'mod1')).toBe(true)
  })
})
