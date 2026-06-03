import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseConnection } from '../src/db/connection.js'
import { QueryManager } from '../src/db/queries.js'
import type { MiniCodeGraphNode } from '../src/types.js'

function createNode(id: string, name: string, kind: string, filePath: string): MiniCodeGraphNode {
  return {
    id, name, kind, filePath, qualifiedName: name, language: 'java',
    startLine: 1, endLine: 10, startColumn: 0, endColumn: 0,
    docstring: '', signature: '', visibility: 'public', isExported: false,
    parentId: null,
  }
}

describe('QueryManager', () => {
  let conn: DatabaseConnection
  let qm: QueryManager

  beforeEach(() => {
    conn = new DatabaseConnection(':memory:')
    conn.open()
    qm = new QueryManager(conn)
  })

  afterEach(() => {
    conn.close()
  })

  describe('node CRUD', () => {
    it('inserts and retrieves a node', () => {
      qm.insertNode(createNode('1', 'MyClass', 'class', 'Test.java'))
      const node = qm.getNode('1')
      expect(node).not.toBeNull()
      expect(node!.name).toBe('MyClass')
      expect(node!.kind).toBe('class')
    })

    it('returns null for non-existent node', () => {
      expect(qm.getNode('nonexistent')).toBeUndefined()
    })

    it('deletes nodes for a file', () => {
      qm.insertNode(createNode('1', 'MyClass', 'class', 'Test.java'))
      qm.deleteNodesForFile('Test.java')
      expect(qm.getNode('1')).toBeUndefined()
    })

    it('gets all nodes', () => {
      qm.insertNode(createNode('1', 'A', 'class', 'a.java'))
      qm.insertNode(createNode('2', 'B', 'function', 'b.java'))
      const all = qm.getAllNodes()
      expect(all).toHaveLength(2)
    })

    it('gets nodes by kind', () => {
      qm.insertNode(createNode('1', 'MyClass', 'class', 'Test.java'))
      qm.insertNode(createNode('2', 'myFunc', 'function', 'Test.java'))
      const classes = qm.getNodesByKind('class')
      expect(classes).toHaveLength(1)
      expect(classes[0].name).toBe('MyClass')
    })

    it('gets children of a node', () => {
      qm.insertNode(createNode('parent', 'Parent', 'class', 'Test.java'))
      qm.insertNode({ ...createNode('child', 'Child', 'method', 'Test.java'), parentId: 'parent' })
      const children = qm.getChildren('parent')
      expect(children).toHaveLength(1)
      expect(children[0].name).toBe('Child')
    })
  })

  describe('edge CRUD', () => {
    it('inserts and retrieves edges', () => {
      qm.insertNode(createNode('A', 'A', 'class', 'a.java'))
      qm.insertNode(createNode('B', 'B', 'class', 'b.java'))
      qm.insertEdge('A', 'B', 'calls', '{}', 5, 10)
      const edges = qm.getAllEdges()
      expect(edges).toHaveLength(1)
      expect(edges[0].sourceId).toBe('A')
      expect(edges[0].targetId).toBe('B')
      expect(edges[0].kind).toBe('calls')
    })

    it('gets edges by type', () => {
      qm.insertNode(createNode('A', 'A', 'class', 'a.java'))
      qm.insertNode(createNode('B', 'B', 'class', 'b.java'))
      qm.insertEdge('A', 'B', 'calls', '{}')
      qm.insertEdge('A', 'B', 'imports', '{}')
      const calls = qm.getEdgesByType('calls')
      expect(calls).toHaveLength(1)
      expect(calls[0].sourceId).toBe('A')
    })
  })

  describe('batch mode', () => {
    it('buffers and flushes nodes', () => {
      qm.enableBatchMode()
      qm.insertNode(createNode('1', 'A', 'class', 'a.java'))
      qm.insertNode(createNode('2', 'B', 'function', 'b.java'))
      expect(qm.getNode('1')).toBeUndefined()
      qm.flushBatch()
      expect(qm.getNode('1')).toBeDefined()
      expect(qm.getNode('2')).toBeDefined()
    })

    it('buffers and flushes edges', () => {
      qm.insertNode(createNode('A', 'A', 'class', 'a.java'))
      qm.insertNode(createNode('B', 'B', 'class', 'b.java'))
      qm.enableBatchMode()
      qm.insertEdge('A', 'B', 'calls', '{}')
      expect(qm.getAllEdges()).toHaveLength(0)
      qm.flushBatch()
      expect(qm.getAllEdges()).toHaveLength(1)
    })

    it('buffers and flushes deletes', () => {
      qm.insertNode(createNode('1', 'A', 'class', 'a.java'))
      qm.enableBatchMode()
      expect(qm.getNode('1')).not.toBeNull()
      qm.deleteNodesForFile('a.java')
      qm.flushBatch()
      expect(qm.getNode('1')).toBeUndefined()
    })

    it('flushBatch is no-op when empty', () => {
      expect(() => qm.flushBatch()).not.toThrow()
    })
  })

  describe('file records', () => {
    it('upserts and retrieves files', () => {
      qm.upsertFile({
        path: 'Test.java', contentHash: 'abc123', language: 'java',
        size: 100, modifiedAt: Date.now(), indexedAt: Date.now(), nodeCount: 5,
      })
      const allFiles = qm.getAllFiles()
      expect(allFiles).toHaveLength(1)
      expect(allFiles[0].path).toBe('Test.java')
    })

    it('upsert updates existing file', () => {
      qm.upsertFile({
        path: 'Test.java', contentHash: 'abc', language: 'java',
        size: 100, modifiedAt: 0, indexedAt: 0, nodeCount: 5,
      })
      qm.upsertFile({
        path: 'Test.java', contentHash: 'def', language: 'java',
        size: 200, modifiedAt: 0, indexedAt: 0, nodeCount: 10,
      })
      const files = qm.getAllFiles()
      expect(files).toHaveLength(1)
      expect(files[0].contentHash).toBe('def')
      expect(files[0].size).toBe(200)
    })
  })

  describe('annotations', () => {
    it('inserts and retrieves annotations', () => {
      qm.insertNode(createNode('1', 'A', 'class', 'a.java'))
      qm.insertAnnotation('1', '@Component', 'singleton', 5, 'mod1')
      qm.insertAnnotation('1', '@Scope', 'prototype', 6, 'mod1')
      const anns = qm.getAnnotationsByNode('1')
      expect(anns).toHaveLength(2)
    })
  })

  describe('callers and callees', () => {
    it('gets callers of a node', () => {
      qm.insertNode(createNode('caller', 'callerFunc', 'function', 'a.java'))
      qm.insertNode(createNode('callee', 'calleeFunc', 'function', 'b.java'))
      qm.insertEdge('caller', 'callee', 'calls')
      const callers = qm.getCallers('callee')
      expect(callers).toHaveLength(1)
      expect(callers[0].name).toBe('callerFunc')
    })

    it('gets callees of a node', () => {
      qm.insertNode(createNode('caller', 'callerFunc', 'function', 'a.java'))
      qm.insertNode(createNode('callee', 'calleeFunc', 'function', 'b.java'))
      qm.insertEdge('caller', 'callee', 'calls')
      const callees = qm.getCallees('caller')
      expect(callees).toHaveLength(1)
      expect(callees[0].name).toBe('calleeFunc')
    })
  })

  describe('getAllEdges edge cases', () => {
    it('returns empty array when no edges', () => {
      expect(qm.getAllEdges()).toEqual([])
    })

    it('handles edges with metadata, line, col', () => {
      qm.insertNode(createNode('A', 'A', 'class', 'a.java'))
      qm.insertNode(createNode('B', 'B', 'class', 'b.java'))
      qm.insertEdge('A', 'B', 'calls', '{"path":"/api"}', 10, 5)
      const edges = qm.getAllEdges()
      expect(edges[0].metadata).toBe('{"path":"/api"}')
      expect(edges[0].line).toBe(10)
      expect(edges[0].col).toBe(5)
    })
  })
})
