import type { DatabaseConnection } from './connection.js'
import type { MiniCodeGraphNode, MiniCodeGraphEdge, FileRecord, ModuleInfo, UnresolvedReference } from '../types.js'
import * as Q from './schema.js'

// SQLite row result — columns are dynamic, so access is untyped
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteRow = Record<string, any>

function mapRowToNode(row: SqliteRow): MiniCodeGraphNode {
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

function mapRowToFile(row: SqliteRow): FileRecord {
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

function mapRowToModule(row: SqliteRow): ModuleInfo {
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

  // Read cache for heavy read-only operations (e.g. dispatch inference).
  // Cache is populated lazily by getAllNodes()/getAllEdges() when enabled.
  private _readCacheEnabled = false
  private _cachedAllNodes: MiniCodeGraphNode[] | null = null
  private _cachedAllEdges: ReturnType<QueryManager['getAllEdges']> | null = null

  /** Enable the read cache so getAllNodes()/getAllEdges() skip repeated SQLite queries. */
  enableReadCache(): void {
    this._readCacheEnabled = true
    this._cachedAllNodes = null
    this._cachedAllEdges = null
  }

  /** Disable read cache and free cached data. */
  flushReadCache(): void {
    this._readCacheEnabled = false
    this._cachedAllNodes = null
    this._cachedAllEdges = null
  }

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
      const cols = 'path,content_hash,language,size,modified_at,indexed_at,node_count,module_id'
      const rows: string[] = []
      for (const f of this.pendingFiles) {
        rows.push(`(${[e(f.path), e(f.contentHash), e(f.language), f.size, f.modifiedAt, f.indexedAt, f.nodeCount, e(f.moduleId ?? '')].join(',')})`)
      }
      const CHUNK = 2000
      for (let i = 0; i < rows.length; i += CHUNK) {
        sqls.push(`INSERT OR REPLACE INTO files (${cols}) VALUES ${rows.slice(i, i + CHUNK).join(',')}`)
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

    // Execute SQL in incremental chunks to avoid O(n²) string concatenation
    if (sqls.length > 0) {
      const MAX_CHUNK = 50
      for (let i = 0; i < sqls.length; i += MAX_CHUNK) {
        const chunk = sqls.slice(i, i + MAX_CHUNK)
        this.db.exec(chunk.join('; '))
      }
    }
  }

  private sanitizeFts5(query: string): string {
    return query.replace(/[^\w\s-]/g, '').trim()
  }

  searchNodes(query: string, limit = 20): MiniCodeGraphNode[] {
    const safe = this.sanitizeFts5(query)
    if (!safe) return []
    try {
      const stmt = this.db.prepare(Q.SEARCH_NODES)
      const rows = stmt.all(safe, limit) as SqliteRow[]
      return rows.map(mapRowToNode)
    } catch {
      return this.fallbackSearch(safe, limit).map(r => r.node)
    }
  }

  searchNodesWithRank(query: string, limit = 20): { node: MiniCodeGraphNode; rank: number }[] {
    const safe = this.sanitizeFts5(query)
    if (!safe) return []
    try {
      const stmt = this.db.prepare(Q.SEARCH_NODES)
      const rows = stmt.all(safe, limit) as SqliteRow[]
      return rows.map(r => ({ node: mapRowToNode(r), rank: r.rank as number }))
    } catch {
      return this.fallbackSearch(safe, limit)
    }
  }

  private fallbackSearch(query: string, limit = 20): { node: MiniCodeGraphNode; rank: number }[] {
    const words = query.split(/\s+/).filter(Boolean)
    if (words.length === 0) return []
    const conditions = words.map(() => '(name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ?)').join(' AND ')
    const params: string[] = []
    for (const w of words) {
      const p = `%${w}%`
      params.push(p, p, p)
    }
    try {
      const stmt = this.db.prepare(`SELECT * FROM nodes WHERE ${conditions} LIMIT ?`)
      const rows = stmt.all(...params, limit) as SqliteRow[]
      return rows.map((r, i) => ({ node: mapRowToNode(r), rank: rows.length - i }))
    } catch {
      return []
    }
  }

  searchNodesByModule(query: string, moduleId: string, limit = 20): MiniCodeGraphNode[] {
    const safe = this.sanitizeFts5(query)
    if (!safe) return []
    try {
      const stmt = this.db.prepare(Q.SEARCH_NODES_BY_MODULE)
      const rows = stmt.all(safe, moduleId, limit) as SqliteRow[]
      return rows.map(mapRowToNode)
    } catch {
      return this.fallbackSearch(safe, limit).map(r => r.node)
    }
  }

  getNode(id: string): MiniCodeGraphNode | undefined {
    const stmt = this.db.prepare(Q.GET_NODE_BY_ID)
    const row = stmt.get(id) as SqliteRow | undefined
    return row ? mapRowToNode(row) : undefined
  }

  getNodesByFile(filePath: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_FILE)
    const rows = stmt.all(filePath) as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getCallers(nodeId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CALLERS)
    const rows = stmt.all(nodeId) as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getCallees(nodeId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CALLEES)
    const rows = stmt.all(nodeId) as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getImports(nodeId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_IMPORTS)
    const rows = stmt.all(nodeId) as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getChildren(parentId: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_CHILDREN)
    const rows = stmt.all(parentId) as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getParent(nodeId: string): MiniCodeGraphNode | undefined {
    const node = this.getNode(nodeId)
    if (!node?.parentId) return undefined
    return this.getNode(node.parentId)
  }

  getFileRecord(filePath: string): FileRecord | undefined {
    const stmt = this.db.prepare(Q.GET_FILE)
    const row = stmt.get(filePath) as SqliteRow | undefined
    return row ? mapRowToFile(row) : undefined
  }

  getAllFiles(): FileRecord[] {
    const stmt = this.db.prepare(Q.GET_ALL_FILES)
    const rows = stmt.all() as SqliteRow[]
    return rows.map(mapRowToFile)
  }

  getFilesByModule(moduleId: string): FileRecord[] {
    const stmt = this.db.prepare(Q.GET_FILES_BY_MODULE)
    const rows = stmt.all(moduleId) as SqliteRow[]
    return rows.map(mapRowToFile)
  }

  getAllNodes(): MiniCodeGraphNode[] {
    if (this._readCacheEnabled) {
      if (this._cachedAllNodes) return this._cachedAllNodes
      const stmt = this.db.prepare(Q.GET_ALL_NODES)
      const rows = stmt.all() as SqliteRow[]
      this._cachedAllNodes = rows.map(mapRowToNode)
      return this._cachedAllNodes
    }
    const stmt = this.db.prepare(Q.GET_ALL_NODES)
    const rows = stmt.all() as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getNodesByKind(kind: string, limit?: number): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(limit ? `${Q.GET_NODES_BY_KIND} LIMIT ?` : Q.GET_NODES_BY_KIND)
    const rows = limit ? stmt.all(kind, limit) : stmt.all(kind)
    return (rows as SqliteRow[]).map(mapRowToNode)
  }

  getNodesByQualifiedName(qname: string): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(Q.GET_NODES_BY_QUALIFIED_NAME)
    const rows = stmt.all(qname) as SqliteRow[]
    return rows.map(mapRowToNode)
  }

  getFileDependencies(filePath: string): string[] {
    const stmt = this.db.prepare(Q.GET_FILE_DEPENDENCIES)
    const rows = stmt.all(filePath) as SqliteRow[]
    return rows.map(r => r.file_path)
  }

  getAllEdges(): MiniCodeGraphEdge[] {
    if (this._readCacheEnabled) {
      if (this._cachedAllEdges) return this._cachedAllEdges
      const stmt = this.db.prepare('SELECT * FROM edges')
      const rows = stmt.all() as SqliteRow[]
      this._cachedAllEdges = rows.map(r => ({
        sourceId: r.source, targetId: r.target, kind: r.kind,
        metadata: r.metadata ?? '{}', line: r.line ?? 0, col: r.col ?? 0,
      }))
      return this._cachedAllEdges
    }
    const stmt = this.db.prepare('SELECT * FROM edges')
    const rows = stmt.all() as SqliteRow[]
    return rows.map(r => ({
      sourceId: r.source, targetId: r.target, kind: r.kind,
      metadata: r.metadata ?? '{}', line: r.line ?? 0, col: r.col ?? 0,
    }))
  }

  getEdgesByType(kind: string): { sourceId: string; targetId: string; metadata: string }[] {
    const stmt = this.db.prepare('SELECT * FROM edges WHERE kind = ?')
    const rows = stmt.all(kind) as SqliteRow[]
    return rows.map(r => ({
      sourceId: r.source, targetId: r.target,
      metadata: r.metadata ?? '{}',
    }))
  }

  getStats(): { files: number; nodes: number; edges: number; modules: number } {
    const files = this.db.prepare(Q.COUNT_FILES).get() as SqliteRow
    const nodes = this.db.prepare(Q.COUNT_NODES).get() as SqliteRow
    const edges = this.db.prepare(Q.COUNT_EDGES).get() as SqliteRow
    const modules = this.db.prepare('SELECT COUNT(*) as count FROM modules').get() as SqliteRow
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
    const rows = stmt.all() as SqliteRow[]
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
    const rows = stmt.all() as SqliteRow[]
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
    const rows = stmt.all(nodeId) as SqliteRow[]
    return rows.map(r => ({ annotationName: r.annotation_name, value: r.value }))
  }

  getAllAnnotations(): Map<string, { annotationName: string; value: string }[]> {
    const stmt = this.db.prepare('SELECT node_id, annotation_name, value FROM annotations')
    const rows = stmt.all() as { node_id: string; annotation_name: string; value: string }[]
    const map = new Map<string, { annotationName: string; value: string }[]>()
    for (const r of rows) {
      let arr = map.get(r.node_id)
      if (!arr) { arr = []; map.set(r.node_id, arr) }
      arr.push({ annotationName: r.annotation_name, value: r.value })
    }
    return map
  }

  getNodesByAnnotation(annotationName: string, limit?: number): MiniCodeGraphNode[] {
    const stmt = this.db.prepare(limit ? `${Q.GET_NODES_BY_ANNOTATION} LIMIT ?` : Q.GET_NODES_BY_ANNOTATION)
    const rows = limit ? stmt.all(annotationName, limit) : stmt.all(annotationName)
    return (rows as SqliteRow[]).map(mapRowToNode)
  }

  getNodesByIdPrefix(prefix: string, limit?: number): MiniCodeGraphNode[] {
    const sql = limit ? Q.GET_NODES_BY_ID_PREFIX_LIMIT : Q.GET_NODES_BY_ID_PREFIX
    const stmt = this.db.prepare(sql)
    const rows = limit ? stmt.all(prefix, limit) : stmt.all(prefix)
    return (rows as SqliteRow[]).map(mapRowToNode)
  }

  insertExternalSymbol(id: string, name: string, kind: string, providingService: string, definitionFile: string, signature: string, metadata: string): void {
    const stmt = this.db.prepare(Q.INSERT_EXTERNAL_SYMBOL)
    stmt.run(id, name, kind, providingService, definitionFile, signature, metadata)
  }

  insertExternalReference(sourceLocation: string, externalSymbolId: string, referenceType: string, targetService: string, metadata: string, sourceService = ''): void {
    const stmt = this.db.prepare(Q.INSERT_EXTERNAL_REFERENCE)
    stmt.run(sourceLocation, externalSymbolId, referenceType, targetService, sourceService, metadata)
  }

  getExternalSymbolsByService(serviceName: string): { id: string; name: string; kind: string; providingService: string; signature: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_SYMBOLS_BY_SERVICE)
    const rows = stmt.all(serviceName) as SqliteRow[]
    return rows.map(r => ({
      id: r.id, name: r.name, kind: r.kind,
      providingService: r.providing_service,
      signature: r.signature ?? '',
    }))
  }

  getExternalReferencesBySymbol(symbolId: string): { id: number; sourceLocation: string; referenceType: string; targetService: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_REFS_BY_SYMBOL)
    const rows = stmt.all(symbolId) as SqliteRow[]
    return rows.map(r => ({
      id: r.id, sourceLocation: r.source_location,
      referenceType: r.reference_type, targetService: r.target_service,
    }))
  }

  getAllExternalSymbols(): { id: string; name: string; kind: string; serviceName?: string; signature?: string; version?: number }[] {
    const stmt = this.db.prepare(Q.GET_ALL_EXTERNAL_SYMBOLS)
    const rows = stmt.all() as SqliteRow[]
    return rows.map(r => ({
      id: r.id, name: r.name, kind: r.kind,
      serviceName: r.providing_service,
      signature: r.signature ?? '',
      version: r.version as number | undefined,
    }))
  }

  getAllExternalReferences(): { id: string; sourceLocation: string; symbolName: string; serviceName?: string; sourceService?: string; referenceType?: string; detail?: string; sourceSymbol: string }[] {
    const stmt = this.db.prepare(Q.GET_ALL_EXTERNAL_REFERENCES)
    const rows = stmt.all() as SqliteRow[]
    return rows.map(r => ({
      id: r.id,
      sourceLocation: r.source_location,
      symbolName: r.external_symbol_id,
      sourceSymbol: r.external_symbol_id,
      serviceName: r.target_service,
      sourceService: r.source_service,
      referenceType: r.reference_type,
    }))
  }

  getExternalReferencesByTarget(symbolName: string): { id: string; symbolName: string; serviceName?: string; detail?: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_REFS_BY_SYMBOL_NAME)
    const rows = stmt.all(symbolName) as SqliteRow[]
    return rows.map(r => ({
      id: r.id,
      symbolName: r.symbol_name,
      serviceName: r.service_name,
      detail: r.source_location,
    }))
  }

  updateExternalSymbol(id: string, name: string, kind: string, providingService: string, signature: string): void {
    const stmt = this.db.prepare(Q.UPDATE_EXTERNAL_SYMBOL)
    stmt.run(name, kind, providingService, signature, id)
  }

  deleteExternalSymbol(id: string): void {
    const stmt = this.db.prepare(Q.DELETE_EXTERNAL_SYMBOL_BY_ID)
    stmt.run(id)
  }

  deleteExternalReference(id: number): void {
    const stmt = this.db.prepare(Q.DELETE_EXTERNAL_REFERENCE_BY_ID)
    stmt.run(id)
  }

  getExternalReferencesBySource(sourceName: string): { id: string; symbolName: string; serviceName?: string; detail?: string; sourceSymbol: string }[] {
    const stmt = this.db.prepare(Q.GET_EXTERNAL_REFS_BY_SOURCE_NAME)
    const rows = stmt.all(`%${sourceName}%`) as SqliteRow[]
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

  // === Flowable methods ===
  insertFlowableProcess(id: string, processId: string, name: string, isExecutable: number, version: string, targetNamespace: string, filePath: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_FLOWABLE_PROCESS).run(id, processId, name, isExecutable, version, targetNamespace, filePath, moduleId)
  }

  insertFlowableNode(id: string, processId: string, name: string, type: string, implementation: string, async: number, documentation: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_FLOWABLE_NODE).run(id, processId, name, type, implementation, async, documentation, moduleId)
  }

  insertFlowableFlow(id: string, processId: string, fromNode: string, toNode: string, conditionExpression: string, conditionLanguage: string): void {
    this.db.prepare(Q.INSERT_FLOWABLE_FLOW).run(id, processId, fromNode, toNode, conditionExpression, conditionLanguage)
  }

  getFlowableProcessesByModule(moduleId: string): Record<string, unknown>[] {
    return this.db.prepare(Q.GET_FLOWABLE_PROCESSES_BY_MODULE).all(moduleId) as Record<string, unknown>[]
  }

  getAllFlowableProcesses(): Record<string, unknown>[] {
    return this.db.prepare(Q.GET_ALL_FLOWABLE_PROCESSES).all() as Record<string, unknown>[]
  }

  getFlowableNodesByProcess(processId: string): Record<string, unknown>[] {
    return this.db.prepare(Q.GET_FLOWABLE_NODES_BY_PROCESS).all(processId) as Record<string, unknown>[]
  }

  getFlowableFlowsByProcess(processId: string): Record<string, unknown>[] {
    return this.db.prepare(Q.GET_FLOWABLE_FLOWS_BY_PROCESS).all(processId) as Record<string, unknown>[]
  }

  // === Drools methods ===
  insertDroolsRule(id: string, packageName: string, ruleName: string, dialect: string, salience: number, activationGroup: string, agendaGroup: string, noLoop: number, lockOnActive: number, autoFocus: number, duration: number, whenCondition: string, thenAction: string, filePath: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_DROOLS_RULE).run(id, packageName, ruleName, dialect, String(salience), activationGroup, agendaGroup, noLoop, lockOnActive, autoFocus, String(duration), whenCondition, thenAction, filePath, moduleId)
  }

  insertDroolsType(id: string, packageName: string, typeName: string, fields: string, filePath: string): void {
    this.db.prepare(Q.INSERT_DROOLS_TYPE).run(id, packageName, typeName, fields, filePath)
  }

  insertDroolsQuery(id: string, packageName: string, queryName: string, parameters: string, expression: string, filePath: string): void {
    this.db.prepare(Q.INSERT_DROOLS_QUERY).run(id, packageName, queryName, parameters, expression, filePath)
  }

  insertDroolsFunction(id: string, packageName: string, functionName: string, returnType: string, parameters: string, body: string, filePath: string): void {
    this.db.prepare(Q.INSERT_DROOLS_FUNCTION).run(id, packageName, functionName, returnType, parameters, body, filePath)
  }

  searchDroolsRules(searchTerm: string, moduleId?: string): Record<string, unknown>[] {
    const like = `%${searchTerm}%`
    if (moduleId) {
      return this.db.prepare(Q.SEARCH_DROOLS_RULES_FTS).all(moduleId, like, like, like) as Record<string, unknown>[]
    }
    return this.db.prepare(Q.SEARCH_DROOLS_RULES).all(like, like, like) as Record<string, unknown>[]
  }

  getDroolsRulesByModule(moduleId: string): Record<string, unknown>[] {
    return this.db.prepare(Q.GET_DROOLS_RULES_BY_MODULE).all(moduleId) as Record<string, unknown>[]
  }

  getAllDroolsRules(): Record<string, unknown>[] {
    return this.db.prepare(Q.GET_ALL_DROOLS_RULES).all() as Record<string, unknown>[]
  }

  // === Maven methods ===
  insertMavenProperty(id: string, pomId: string, key: string, value: string, resolvedValue: string, provenance: string): void {
    this.db.prepare(Q.INSERT_MAVEN_PROPERTY).run(id, pomId, key, value, resolvedValue, provenance)
  }

  insertMavenDepMgmt(id: string, pomId: string, groupId: string, artifactId: string, version: string, scope: string): void {
    this.db.prepare(Q.INSERT_MAVEN_DEP_MGMT).run(id, pomId, groupId, artifactId, version, scope)
  }

  // === Enterprise methods ===
  insertEnterpriseAnnotation(id: string, frameworkName: string, annotationName: string, nodeId: string, kind: string, description: string, filePath: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_ENTERPRISE_ANNOTATION).run(id, frameworkName, annotationName, nodeId, kind, description, filePath, moduleId)
  }

  insertContainerImage(id: string, serviceName: string, imageName: string, registryUrl: string, baseImage: string, ports: string, jvmFlags: string, buildTool: string, filePath: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_CONTAINER_IMAGE).run(id, serviceName, imageName, registryUrl, baseImage, ports, jvmFlags, buildTool, filePath, moduleId)
  }

  insertCicdPipeline(id: string, pipelineType: string, triggerBranches: string, vmImage: string, stages: string, filePath: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_CICD_PIPELINE).run(id, pipelineType, triggerBranches, vmImage, stages, filePath, moduleId)
  }

  // === Entry points ===
  insertEntryPoint(data: { id: string; kind: string; service: string; method: string; filePath: string; line: number; signature: string; httpMethod?: string; path?: string; queueName?: string; cronExpr?: string }): void {
    this.db.prepare(Q.INSERT_ENTRY_POINT).run(data.id, data.kind, data.service, data.method, data.filePath, data.line, data.signature, data.httpMethod ?? '', data.path ?? '', data.queueName ?? '', data.cronExpr ?? '')
  }

  deleteEntryPointsByService(service: string): void {
    this.db.prepare('DELETE FROM entry_points WHERE service = ?').run(service)
  }

  // === Service dependencies ===
  insertServiceDependency(sourceService: string, targetService: string, dependencyType: string, optional: number, detectedFrom: string, moduleId: string): void {
    this.db.prepare(Q.INSERT_SERVICE_DEPENDENCY).run(sourceService, targetService, dependencyType, optional, detectedFrom, moduleId)
  }

  deleteServiceDependenciesByService(service: string): void {
    this.db.prepare('DELETE FROM service_dependencies WHERE source_service = ?').run(service)
  }

  getAllServiceDependencies(): { sourceService: string; targetService: string; dependencyType: string; optional: number }[] {
    const rows = this.db.prepare('SELECT * FROM service_dependencies').all() as { source_service: string; target_service: string; dependency_type: string; optional: number }[]
    return rows.map(r => ({
      sourceService: r.source_service,
      targetService: r.target_service,
      dependencyType: r.dependency_type,
      optional: r.optional,
    }))
  }
}
