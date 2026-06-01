import type { DatabaseConnection } from './connection.js'
import type { MiniCodeGraphNode, FileRecord, ModuleInfo, UnresolvedReference } from '../types.js'
import * as Q from './schema.js'

function mapRowToNode(row: Record<string, any>): MiniCodeGraphNode {
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
    moduleId: row.module_id,
    metadata: row.metadata,
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

function mapRowToModule(row: Record<string, any>): ModuleInfo {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    buildSystem: row.build_system,
    language: row.language,
    indexedAt: row.indexed_at,
  }
}

export class QueryManager {
  constructor(private db: DatabaseConnection) {}

  private sanitizeFts5(query: string): string {
    return query.replace(/[^\w\s-]/g, '').trim()
  }

  searchNodes(query: string, limit = 20): MiniCodeGraphNode[] {
    const safe = this.sanitizeFts5(query)
    if (!safe) return []
    const stmt = this.db.prepare(Q.SEARCH_NODES)
    const rows = stmt.all(safe, limit) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  searchNodesWithRank(query: string, limit = 20): { node: MiniCodeGraphNode; rank: number }[] {
    const safe = this.sanitizeFts5(query)
    if (!safe) return []
    const stmt = this.db.prepare(Q.SEARCH_NODES)
    const rows = stmt.all(safe, limit) as Record<string, any>[]
    return rows.map(r => ({ node: mapRowToNode(r), rank: r.rank as number }))
  }

  searchNodesByModule(query: string, moduleId: string, limit = 20): MiniCodeGraphNode[] {
    const safe = this.sanitizeFts5(query)
    if (!safe) return []
    const stmt = this.db.prepare(Q.SEARCH_NODES_BY_MODULE)
    const rows = stmt.all(safe, moduleId, limit) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getNode(id: string): MiniCodeGraphNode | undefined {
    const stmt = this.db.prepare(Q.GET_NODE_BY_ID)
    const row = stmt.get(id) as Record<string, any> | undefined
    return row ? mapRowToNode(row) : undefined
  }

  getNodesByFile(filePath: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_FILE)
    const rows = stmt.all(filePath) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getCallers(nodeId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CALLERS)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getCallees(nodeId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CALLEES)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getImports(nodeId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_IMPORTS)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getChildren(parentId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CHILDREN)
    const rows = stmt.all(parentId) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getParent(nodeId: string): MiniCodeGraphNode | undefined {
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

  getFilesByModule(moduleId: string): FileRecord[] {
    const stmt = this.db.prepare(Q.GET_FILES_BY_MODULE)
    const rows = stmt.all(moduleId) as Record<string, any>[]
    return rows.map(mapRowToFile)
  }

  getAllNodes(): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_ALL_NODES)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getNodesByKind(kind: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_KIND)
    const rows = stmt.all(kind) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getNodesByQualifiedName(qname: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_QUALIFIED_NAME)
    const rows = stmt.all(qname) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  getFileDependencies(filePath: string): string[] {
    const stmt = this.db.prepare(Q.GET_FILE_DEPENDENCIES)
    const rows = stmt.all(filePath) as Record<string, any>[]
    return rows.map(r => r.file_path)
  }

  getAllEdges(): { sourceId: string; targetId: string; kind: string; metadata: string; line: number; col: number }[] {
    const stmt = this.db.prepare('SELECT * FROM edges')
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(r => ({
      sourceId: r.source, targetId: r.target, kind: r.kind,
      metadata: r.metadata ?? '{}', line: r.line ?? 0, col: r.col ?? 0,
    }))
  }

  getEdgesByType(kind: string): { sourceId: string; targetId: string; metadata: string }[] {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE kind = ?')
    const rows = stmt.all(kind) as Record<string, any>[]
    return rows.map(r => ({
      sourceId: r.source, targetId: r.target,
      metadata: r.metadata ?? '{}',
    }))
  }

  getStats(): { files: number; nodes: number; edges: number; modules: number } {
    const files = this.db.prepare(Q.COUNT_FILES).get() as Record<string, any>
    const nodes = this.db.prepare(Q.COUNT_NODES).get() as Record<string, any>
    const edges = this.db.prepare(Q.COUNT_EDGES).get() as Record<string, any>
    const modules = this.db.prepare('SELECT COUNT(*) as count FROM modules').get() as Record<string, any>
    return { files: files.count, nodes: nodes.count, edges: edges.count, modules: modules?.count ?? 0 }
  }

  insertNode(node: MiniCodeGraphNode): void {
    const stmt = this.db.prepare(Q.INSERT_NODE)
    stmt.run(
      node.id, node.kind, node.name, node.qualifiedName,
      node.filePath, node.language, node.startLine, node.endLine,
      node.startColumn, node.endColumn, node.docstring, node.signature,
      node.visibility, node.isExported ? 1 : 0, node.parentId,
      node.moduleId ?? '', node.metadata ?? '{}'
    )
  }

  insertEdge(source: string, target: string, kind: string, metadata = '{}', line = 0, col = 0): void {
    const stmt = this.db.prepare(Q.INSERT_EDGE)
    stmt.run(source, target, kind, metadata, line, col)
  }

  upsertFile(file: FileRecord & { moduleId?: string }): void {
    const stmt = this.db.prepare(Q.UPSERT_FILE)
    stmt.run(
      file.path, file.contentHash, file.language, file.size,
      file.modifiedAt, file.indexedAt, file.nodeCount,
      file.moduleId ?? ''
    )
  }

  deleteNodesForFile(filePath: string): void {
    this.db.prepare(Q.DELETE_FILE_EDGES).run(filePath, filePath)
    this.db.prepare(Q.DELETE_FILE_NODES).run(filePath)
    this.db.prepare(Q.DELETE_FILE_RECORD).run(filePath)
    this.db.prepare(Q.DELETE_UNRESOLVED_REFS_BY_FILE).run(filePath)
  }

  resolveCallEdges(): number {
    const info = this.db.prepare(Q.RESOLVE_CALL_EDGES).run()
    return Number(info.changes)
  }

  insertUnresolvedRef(ref: UnresolvedReference): void {
    const stmt = this.db.prepare(Q.INSERT_UNRESOLVED_REF)
    stmt.run(
      ref.id, ref.sourceNodeId, ref.referenceName, ref.kind,
      ref.line, ref.col, ref.filePath, ref.moduleId, ref.metadata
    )
  }

  getUnresolvedRefs(): UnresolvedReference[] {
    const stmt = this.db.prepare(Q.GET_UNRESOLVED_REFS)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(r => ({
      id: r.id,
      sourceNodeId: r.source_node_id,
      referenceName: r.reference_name,
      kind: r.kind,
      line: r.line,
      col: r.col,
      filePath: r.file_path,
      moduleId: r.module_id,
      metadata: r.metadata,
    }))
  }

  insertModule(module: ModuleInfo): void {
    const stmt = this.db.prepare(Q.INSERT_MODULE)
    stmt.run(module.id, module.name, module.rootPath, module.buildSystem, module.language, module.indexedAt)
  }

  getAllModules(): ModuleInfo[] {
    const stmt = this.db.prepare(Q.GET_ALL_MODULES)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(mapRowToModule)
  }

  insertAnnotation(nodeId: string, annotationName: string, value: string, line: number, moduleId: string): void {
    const id = `${nodeId}:@${annotationName}`
    const stmt = this.db.prepare(Q.INSERT_ANNOTATION)
    stmt.run(id, nodeId, annotationName, value, line, moduleId)
  }

  getAnnotationsByNode(nodeId: string): { annotationName: string; value: string }[] {
    const stmt = this.db.prepare(Q.GET_ANNOTATIONS_BY_NODE)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(r => ({ annotationName: r.annotation_name, value: r.value }))
  }

  getNodesByAnnotation(annotationName: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_ANNOTATION)
    const rows = stmt.all(annotationName) as Record<string, any>[]
    return rows.map(mapRowToNode)
  }

  upsertTemplate(filePath: string, language: string, data: {
    componentRefs: string[]
    eventBindings: { event: string; handler: string; line: number }[]
    slotUsages: string[]
    directives: string[]
  }, moduleId: string): void {
    const id = `template:${filePath}`
    const stmt = this.db.prepare(Q.INSERT_TEMPLATE)
    stmt.run(
      id, filePath, language,
      JSON.stringify(data.componentRefs),
      JSON.stringify(data.eventBindings),
      JSON.stringify(data.slotUsages),
      JSON.stringify(data.directives),
      moduleId
    )
  }
}
