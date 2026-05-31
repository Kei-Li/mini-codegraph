import type { DatabaseConnection } from './connection.js'
import type { CodeGraphNode, FileRecord } from '../types.js'
import * as Q from './schema.js'

function mapRowToNode(row: Record<string, any>): CodeGraphNode {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? '',
    signature: row.signature ?? '',
    visibility: row.visibility ?? 'public',
    isExported: !!row.is_exported,
    parentId: row.parent_id,
  }
}

function mapRowToFile(row: Record<string, any>): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
  }
}

export class QueryManager {
  constructor(private db: DatabaseConnection) {}

  searchNodes(query: string, limit = 20): CodeGraphNode[] {
    const stmt = this.db.prepare(Q.SEARCH_NODES)
    const rows = stmt.all(query, limit) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  searchNodesWithRank(query: string, limit = 20): { node: CodeGraphNode; rank: number }[] {
    const stmt = this.db.prepare(Q.SEARCH_NODES)
    const rows = stmt.all(query, limit) as Record<string, any>[]
    return rows.map(r => ({ node: mapRowToNode(r), rank: r.rank as number }))
  }

  getNode(id: string): CodeGraphNode | undefined {
    const stmt = this.db.prepare(Q.GET_NODE_BY_ID)
    const row = stmt.get(id) as Record<string, any> | undefined
    return row ? mapRowToNode(row) : undefined
  }

  getNodesByFile(filePath: string): CodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_FILE)
    const rows = stmt.all(filePath) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getCallers(nodeId: string): CodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CALLERS)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getCallees(nodeId: string): CodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CALLEES)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getChildren(parentId: string): CodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CHILDREN)
    const rows = stmt.all(parentId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getParent(nodeId: string): CodeGraphNode | undefined {
    const node = this.getNode(nodeId)
    if (!node?.parentId) return undefined
    return this.getNode(node.parentId)
  }

  getFileRecord(filePath: string): FileRecord | undefined {
    const stmt = this.db.prepare(Q.GET_FILE)
    const row = stmt.get(filePath) as Record<string, any> | undefined
    return row ? mapRowToFile(row) : undefined
  }

  getAllFiles(): FileRecord[] {
    const stmt = this.db.prepare(Q.GET_ALL_FILES)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(mapRowToFile)
  }

  getAllNodes(): CodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_ALL_NODES)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getFileDependencies(filePath: string): string[] {
    const stmt = this.db.prepare(Q.GET_FILE_DEPENDENCIES)
    const rows = stmt.all(filePath) as Record<string, any>[]
    return rows.map(r => r.file_path)
  }

  getStats(): { files: number; nodes: number; edges: number } {
    const files = this.db.prepare(Q.COUNT_FILES).get() as Record<string, any>
    const nodes = this.db.prepare(Q.COUNT_NODES).get() as Record<string, any>
    const edges = this.db.prepare(Q.COUNT_EDGES).get() as Record<string, any>
    return { files: files.count, nodes: nodes.count, edges: edges.count }
  }

  insertNode(node: CodeGraphNode): void {
    const stmt = this.db.prepare(Q.INSERT_NODE)
    stmt.run(
      node.id, node.kind, node.name, node.qualifiedName,
      node.filePath, node.language, node.startLine, node.endLine,
      node.startColumn, node.endColumn, node.docstring, node.signature,
      node.visibility, node.isExported ? 1 : 0, node.parentId
    )
  }

  insertEdge(source: string, target: string, kind: string, metadata = '{}', line = 0, col = 0): void {
    const stmt = this.db.prepare(Q.INSERT_EDGE)
    stmt.run(source, target, kind, metadata, line, col)
  }

  upsertFile(file: FileRecord): void {
    const stmt = this.db.prepare(Q.UPSERT_FILE)
    stmt.run(
      file.path, file.contentHash, file.language, file.size,
      file.modifiedAt, file.indexedAt, file.nodeCount
    )
  }

  deleteNodesForFile(filePath: string): void {
    this.db.prepare(Q.DELETE_FILE_EDGES).run(filePath, filePath)
    this.db.prepare(Q.DELETE_FILE_NODES).run(filePath)
    this.db.prepare(Q.DELETE_FILE_RECORD).run(filePath)
  }

  resolveCallEdges(): number {
    const info = this.db.prepare(Q.RESOLVE_CALL_EDGES).run()
    return Number(info.changes)
  }
}
