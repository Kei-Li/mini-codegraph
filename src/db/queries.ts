import type { DatabaseConnection } from './connection.js'
import type { MiniCodeGraphNode, MiniCodeGraphEdge, FileRecord, ModuleInfo, UnresolvedReference } from '../types.js'
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

  getDb(): DatabaseConnection { return this.db }

  private batchMode = false
  private pendingNodes: MiniCodeGraphNode[] = []
  private pendingEdges: { source: string; target: string; kind: string; metadata: string; line: number; col: number }[] = []
  private pendingFiles: (FileRecord & { moduleId?: string })[] = []
  private pendingDeletes: string[] = []
  private pendingAnnotations: { id: string; nodeId: string; annotationName: string; value: string; line: number; moduleId: string }[] = []

  enableBatchMode(): void { this.batchMode = true }

  flushBatch(): void {
    if (this.pendingNodes.length === 0 && this.pendingEdges.length === 0 &&
        this.pendingFiles.length === 0 && this.pendingDeletes.length === 0 &&
        this.pendingAnnotations.length === 0) return

    const e = (s: any) => `'${String(s ?? '').replace(/'/g, "''")}'` // SQLite-safe: only ' needs escaping in strings
    const sqls: string[] = []

    if (this.pendingDeletes.length > 0) {
      const paths = this.pendingDeletes.map(e).join(',')
      sqls.push(`DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path IN (${paths})) OR target IN (SELECT id FROM nodes WHERE file_path IN (${paths}))`)
      sqls.push(`DELETE FROM nodes WHERE file_path IN (${paths})`)
      sqls.push(`DELETE FROM files WHERE path IN (${paths})`)
      sqls.push(`DELETE FROM unresolved_refs WHERE file_path IN (${paths})`)
      this.pendingDeletes = []
    }

    if (this.pendingNodes.length > 0) {
      const cols = 'id,kind,name,qualified_name,file_path,language,start_line,end_line,start_column,end_column,docstring,signature,visibility,is_exported,parent_id,module_id,metadata'
      const rows: string[] = []
      for (const n of this.pendingNodes) {
        rows.push(`(${[e(n.id), e(n.kind), e(n.name), e(n.qualifiedName), e(n.filePath), e(n.language),
          n.startLine, n.endLine, n.startColumn, n.endColumn,
          e(n.docstring), e(n.signature), e(n.visibility),
          n.isExported ? 1 : 0, e(n.parentId), e(n.moduleId ?? ''), e(n.metadata ?? '{}')].join(',')})`)
      }
      const CHUNK = 2000
      for (let i = 0; i < rows.length; i += CHUNK) {
        sqls.push(`INSERT OR REPLACE INTO nodes (${cols}) VALUES ${rows.slice(i, i + CHUNK).join(',')}`)
      }
      this.pendingNodes = []
    }

    if (this.pendingEdges.length > 0) {
      const cols = 'source,target,kind,metadata,line,col'
      const rows: string[] = []
      for (const eo of this.pendingEdges) {
        rows.push(`(${[e(eo.source), e(eo.target), e(eo.kind), e(eo.metadata), eo.line, eo.col].join(',')})`)
      }
      const CHUNK = 2000
      for (let i = 0; i < rows.length; i += CHUNK) {
        sqls.push(`INSERT OR IGNORE INTO edges (${cols}) VALUES ${rows.slice(i, i + CHUNK).join(',')}`)
      }
      this.pendingEdges = []
    }

    if (this.pendingFiles.length > 0) {
      for (const f of this.pendingFiles) {
        sqls.push(`INSERT INTO files (path,content_hash,language,size,modified_at,indexed_at,node_count,module_id) VALUES (${[e(f.path), e(f.contentHash), e(f.language), f.size, f.modifiedAt, f.indexedAt, f.nodeCount, e(f.moduleId ?? '')].join(',')}) ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash,size=excluded.size,modified_at=excluded.modified_at,indexed_at=excluded.indexed_at,node_count=excluded.node_count`)
      }
      this.pendingFiles = []
    }

    if (this.pendingAnnotations.length > 0) {
      const cols = 'id,node_id,annotation_name,value,line,module_id'
      const rows: string[] = []
      for (const a of this.pendingAnnotations) {
        rows.push(`(${[e(a.id), e(a.nodeId), e(a.annotationName), e(a.value), a.line, e(a.moduleId)].join(',')})`)
      }
      const CHUNK = 2000
      for (let i = 0; i < rows.length; i += CHUNK) {
        sqls.push(`INSERT OR IGNORE INTO annotations (${cols}) VALUES ${rows.slice(i, i + CHUNK).join(',')}`)
      }
      this.pendingAnnotations = []
    }

    if (sqls.length > 0) {
      this.db.exec(sqls.join('; '))
    }
  }

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

  getNodesByKind(kind: string, limit?: number): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(limit ? `${Q.GET_NODES_BY_KIND} LIMIT ?` : Q.GET_NODES_BY_KIND)
    const rows = limit ? stmt.all(kind, limit) : stmt.all(kind)
    return (rows as Record<string, any>[]).map(mapRowToNode)
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

  getAllEdges(): MiniCodeGraphEdge[] {
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
    if (this.batchMode) {
      this.pendingNodes.push(node)
      return
    }
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
    if (this.batchMode) {
      this.pendingEdges.push({ source, target, kind, metadata, line, col })
      return
    }
    const stmt = this.db.prepare(Q.INSERT_EDGE)
    stmt.run(source, target, kind, metadata, line, col)
  }

  upsertFile(file: FileRecord & { moduleId?: string }): void {
    if (this.batchMode) {
      this.pendingFiles.push(file)
      return
    }
    const stmt = this.db.prepare(Q.UPSERT_FILE)
    stmt.run(
      file.path, file.contentHash, file.language, file.size,
      file.modifiedAt, file.indexedAt, file.nodeCount,
      file.moduleId ?? ''
    )
  }

  deleteNodesForFile(filePath: string): void {
    if (this.batchMode) {
      this.pendingDeletes.push(filePath)
      return
    }
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
    if (this.batchMode) {
      this.pendingAnnotations.push({ id, nodeId, annotationName, value, line, moduleId })
      return
    }
    const stmt = this.db.prepare(Q.INSERT_ANNOTATION)
    stmt.run(id, nodeId, annotationName, value, line, moduleId)
  }

  getAnnotationsByNode(nodeId: string): { annotationName: string; value: string }[] {
    const stmt = this.db.prepare(Q.GET_ANNOTATIONS_BY_NODE)
    const rows = stmt.all(nodeId) as Record<string, any>[]
    return rows.map(r => ({ annotationName: r.annotation_name, value: r.value }))
  }

  getNodesByAnnotation(annotationName: string, limit?: number): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(limit ? `${Q.GET_NODES_BY_ANNOTATION} LIMIT ?` : Q.GET_NODES_BY_ANNOTATION)
    const rows = limit ? stmt.all(annotationName, limit) : stmt.all(annotationName)
    return (rows as Record<string, any>[]).map(mapRowToNode)
  }

  getNodesByIdPrefix(prefix: string, limit?: number): MiniCodeGraphNode[] {
    const sql = limit ? Q.GET_NODES_BY_ID_PREFIX_LIMIT : Q.GET_NODES_BY_ID_PREFIX
    const stmt = this.db.prepare(sql)
    const rows = limit ? stmt.all(prefix, limit) : stmt.all(prefix)
    return (rows as Record<string, any>[]).map(mapRowToNode)
  }

  insertExternalSymbol(id: string, name: string, kind: string, providingService: string, definitionFile: string, signature: string, metadata: string): void {
    const stmt = this.db.prepare(Q.INSERT_EXTERNAL_SYMBOL)
    stmt.run(id, name, kind, providingService, definitionFile, signature, metadata)
  }

  insertExternalReference(sourceLocation: string, externalSymbolId: string, referenceType: string, targetService: string, metadata: string): void {
    const stmt = this.db.prepare(Q.INSERT_EXTERNAL_REFERENCE)
    stmt.run(sourceLocation, externalSymbolId, referenceType, targetService, metadata)
  }

  getExternalSymbolsByService(serviceName: string): { id: string; name: string; kind: string; providingService: string; signature: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_SYMBOLS_BY_SERVICE)
    const rows = stmt.all(serviceName) as Record<string, any>[]
    return rows.map(r => ({
      id: r.id, name: r.name, kind: r.kind,
      providingService: r.providing_service,
      signature: r.signature ?? '',
    }))
  }

  getExternalReferencesBySymbol(symbolId: string): { id: number; sourceLocation: string; referenceType: string; targetService: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_REFS_BY_SYMBOL)
    const rows = stmt.all(symbolId) as Record<string, any>[]
    return rows.map(r => ({
      id: r.id, sourceLocation: r.source_location,
      referenceType: r.reference_type, targetService: r.target_service,
    }))
  }

  getAllExternalSymbols(): { id: string; name: string; kind: string; serviceName?: string; signature?: string }[] {
    const stmt = this.db.prepare(Q.GET_ALL_EXTERNAL_SYMBOLS)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(r => ({
      id: r.id, name: r.name, kind: r.kind,
      serviceName: r.providing_service,
      signature: r.signature ?? '',
    }))
  }

  getAllExternalReferences(): { id: string; sourceLocation: string; symbolName: string; serviceName?: string; detail?: string; sourceSymbol: string }[] {
    const stmt = this.db.prepare(Q.GET_ALL_EXTERNAL_REFERENCES)
    const rows = stmt.all() as Record<string, any>[]
    return rows.map(r => ({
      id: r.id,
      sourceLocation: r.source_location,
      symbolName: r.external_symbol_id,
      sourceSymbol: r.external_symbol_id,
      serviceName: r.target_service,
    }))
  }

  getExternalReferencesByTarget(symbolName: string): { id: string; symbolName: string; serviceName?: string; detail?: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_REFS_BY_SYMBOL_NAME)
    const rows = stmt.all(symbolName) as Record<string, any>[]
    return rows.map(r => ({
      id: r.id,
      symbolName: r.symbol_name,
      serviceName: r.service_name,
      detail: r.source_location,
    }))
  }

  getExternalReferencesBySource(sourceName: string): { id: string; symbolName: string; serviceName?: string; detail?: string; sourceSymbol: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_REFS_BY_SOURCE_NAME)
    const rows = stmt.all(`%${sourceName}%`) as Record<string, any>[]
    return rows.map(r => ({
      id: r.id,
      symbolName: r.symbol_name,
      serviceName: r.service_name,
      detail: r.source_location,
      sourceSymbol: r.symbol_name,
    }))
  }

  deleteExternalSymbolsByService(serviceName: string): void {
    this.db.prepare(Q.DELETE_EXTERNAL_SYMBOLS_BY_SERVICE).run(serviceName)
  }

  deleteExternalReferencesByService(serviceName: string): void {
    this.db.prepare(Q.DELETE_EXTERNAL_REFS_BY_SERVICE).run(serviceName, serviceName)
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
