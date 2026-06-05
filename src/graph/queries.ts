import type { QueryManager } from '../db/queries.js'
import type { MiniCodeGraphNode } from '../types.js'
import { GraphTraverser } from './traversal.js'
import { CodeAnalyzer } from '../analysis/index.js'
import { runQualifiedSearch, fuzzySearchFallback } from '../search/index.js'
import { safeJsonParse } from '../utils.js'
import type { InferredTarget, DispatchPattern } from '../resolution/dispatch-inference/types.js'
import { getDispatchTargetsForNode } from '../resolution/dispatch-inference/resolver.js'
import { readProjectConfig } from '../resolution/config-reader.js'
import { isNodeActiveUnderConfig } from '../resolution/condition-matcher.js'

export class GraphQueryManager {
  private queries: QueryManager
  private traverser: GraphTraverser
  private analyzer: CodeAnalyzer
  private projectRoot: string
  private pendingFiles: Set<string> = new Set()
  private lastSyncTime = Date.now()

  constructor(queries: QueryManager, projectRoot: string) {
    this.queries = queries
    this.projectRoot = projectRoot
    this.traverser = new GraphTraverser(queries)
    this.analyzer = new CodeAnalyzer(queries, projectRoot)
  }

  search(query: string, limit = 20): { node: MiniCodeGraphNode; snippets: string[]; score: number }[] {
    const allNodes = this.queries.getAllNodes()
    const results = runQualifiedSearch(
      query,
      (q, l) => this.queries.searchNodesWithRank(q, l),
      (q, l) => fuzzySearchFallback(q, allNodes, l),
      limit
    )
    return results
      .map(r => ({ node: r.node, snippets: [r.node.signature, r.node.docstring].filter(Boolean), score: r.rank }))
  }

  getNode(id: string): MiniCodeGraphNode | undefined {
    return this.queries.getNode(id)
  }

  getCallers(nodeId: string): MiniCodeGraphNode[] {
    return this.queries.getCallers(nodeId)
  }

  getCallees(nodeId: string): MiniCodeGraphNode[] {
    return this.queries.getCallees(nodeId)
  }

  getCallersWithExternal(nodeId: string): { node: MiniCodeGraphNode; provenance: string }[] {
    const internal = this.queries.getCallers(nodeId).map(n => ({ node: n, provenance: 'internal' as const }))
    const external = this.queries.getExternalReferencesByTarget(nodeId)
      .map(ref => ({
      node: {
        id: ref.id,
        kind: 'external_reference',
        name: ref.symbolName,
        qualifiedName: ref.serviceName ? `${ref.serviceName}.${ref.symbolName}` : ref.symbolName,
        filePath: `external://${ref.serviceName ?? 'unknown'}`,
        startLine: 0,
        endLine: 0,
        startColumn: 0,
        endColumn: 0,
        language: '',
        docstring: ref.detail ?? '',
        signature: ref.detail ?? '',
        visibility: 'public',
        isExported: true,
        parentId: null,
      },
      provenance: `external:${ref.serviceName ?? 'unknown'}`,
    }))
    const node = this.queries.getNode(nodeId)
    if (node) {
      const externalCallersFromOtherServices = this.queries.getExternalReferencesBySource(node.name)
        .filter(ref => ref.serviceName && ref.serviceName !== this.projectRoot)
        .map(ref => ({
          node: {
            id: ref.id,
            kind: 'external_reference',
            name: ref.symbolName,
            qualifiedName: `${ref.serviceName ?? 'unknown'}.${ref.symbolName}`,
            filePath: `external://${ref.serviceName ?? 'unknown'}`,
            startLine: 0,
            endLine: 0,
            startColumn: 0,
            endColumn: 0,
            language: '',
            docstring: ref.detail ?? '',
            signature: ref.detail ?? '',
            visibility: 'public',
            isExported: true,
            parentId: null,
          },
          provenance: `external_from:${ref.serviceName ?? 'unknown'}`,
        }))
      return [...internal, ...external, ...externalCallersFromOtherServices]
    }
    return [...internal, ...external]
  }

  getCalleesWithExternal(nodeId: string): { node: MiniCodeGraphNode; provenance: string }[] {
    const internal = this.queries.getCallees(nodeId).map(n => ({ node: n, provenance: 'internal' as const }))
    const node = this.queries.getNode(nodeId)
    if (node) {
      const external = this.queries.getExternalReferencesBySource(node.name)
        .map(ref => ({
          node: {
            id: ref.id,
            kind: 'external_reference',
            name: ref.symbolName,
            qualifiedName: ref.symbolName,
            filePath: `external://${ref.serviceName ?? 'unknown'}`,
            startLine: 0,
            endLine: 0,
            startColumn: 0,
            endColumn: 0,
            language: '',
            docstring: ref.detail ?? '',
            signature: ref.detail ?? '',
            visibility: 'public',
            isExported: true,
            parentId: null,
          },
          provenance: `external:${ref.serviceName ?? 'unknown'}`,
        }))
      return [...internal, ...external]
    }
    return internal
  }

  getContext(nodeId: string): {
    node: MiniCodeGraphNode | undefined
    parent: MiniCodeGraphNode | undefined
    children: MiniCodeGraphNode[]
    callers: MiniCodeGraphNode[]
    callees: MiniCodeGraphNode[]
    implementations: MiniCodeGraphNode[]
    annotations: { annotationName: string; value: string }[]
    crossServiceCallees: { node: MiniCodeGraphNode; detail: string }[]
  } {
    const node = this.queries.getNode(nodeId)
    if (!node) return { node: undefined, parent: undefined, children: [], callers: [], callees: [], implementations: [], annotations: [], crossServiceCallees: [] }

    const parent = node.parentId ? this.queries.getNode(node.parentId) : undefined
    const children = this.queries.getChildren(nodeId)
    const callers = this.queries.getCallers(nodeId)
    const callees = this.queries.getCallees(nodeId)
    const annotations = this.queries.getAnnotationsByNode(nodeId)

    let implementations: MiniCodeGraphNode[] = []
    if (['interface', 'type_alias'].includes(node.kind)) {
      implementations = this.traverser.findImplementations(node)
    }

    let crossServiceCallees: { node: MiniCodeGraphNode; detail: string }[] = []
    if (node.kind === 'method' || node.kind === 'class') {
      crossServiceCallees = this.traverser.findCrossServiceCallees(node)
    }

    return { node, parent, children, callers, callees, implementations, annotations, crossServiceCallees }
  }

  getImpact(nodeId: string, depth = 2): MiniCodeGraphNode[] {
    return Array.from(this.traverser.findImpactedNodes(nodeId, depth).values())
  }

  findRelated(nodeIds: string[]): Map<string, { node: MiniCodeGraphNode; relationships: string[] }> {
    return this.traverser.findRelated(nodeIds)
  }

  findDeadCode(): MiniCodeGraphNode[] {
    return this.traverser.findDeadCode()
  }

  findAffectedTestFiles(sourceFiles: string[]): { testFile: string; matchedSymbols: string[]; confidence: number }[] {
    return this.traverser.findAffectedTestFiles(sourceFiles)
  }

  findPath(fromId: string, toId: string, maxDepth = 12, maxNodes = 500): import('./traversal.js').BfsResult {
    return this.traverser.findPath(fromId, toId, maxDepth, maxNodes)
  }

  findMicroserviceArchitecture(): {
    modules: string[]
    dependencies: { from: string; to: string }[]
    entryPoints: { module: string; endpoints: string[] }[]
  } {
    return this.traverser.findMicroserviceArchitecture()
  }

  getFeignClients(limit?: number): {
    feignClient: MiniCodeGraphNode
    feignMethods: MiniCodeGraphNode[]
    annotations: { annotationName: string; value: string }[]
  }[] {
    const results: {
      feignClient: MiniCodeGraphNode
      feignMethods: MiniCodeGraphNode[]
      annotations: { annotationName: string; value: string }[]
    }[] = []

    const feignAnnotated = this.queries.getNodesByAnnotation('FeignClient', limit)
    for (const node of feignAnnotated) {
      if (limit && results.length >= limit) break
      const children = this.queries.getChildren(node.id)
      const annotations = this.queries.getAnnotationsByNode(node.id)
      results.push({ feignClient: node, feignMethods: children, annotations })
    }

    if (!limit || results.length < limit) {
      const clientInterfaces = this.queries.getNodesByKind('interface')
        .filter(n => n.name.endsWith('Client'))

      for (const iface of clientInterfaces) {
        if (limit && results.length >= limit) break
        if (results.some(r => r.feignClient.id === iface.id)) continue
        const annotations = this.queries.getAnnotationsByNode(iface.id)
        if (annotations.some(a => a.annotationName === 'FeignClient') || annotations.length === 0) {
          const children = this.queries.getChildren(iface.id)
          results.push({ feignClient: iface, feignMethods: children, annotations })
        }
      }
    }

    return results
  }

  getMyBatisMappings(limit?: number): {
    javaInterface: string
    methodName: string
    xmlPath: string
    sqlId: string
  }[] {
    const mappings: {
      javaInterface: string
      methodName: string
      xmlPath: string
      sqlId: string
    }[] = []

    const mapperEdges = this.queries.getAllNodes()
    for (const node of mapperEdges) {
      if (limit && mappings.length >= limit) break
      if (node.kind === 'method') {
        const callees = this.queries.getCallees(node.id)
        for (const callee of callees) {
          if (limit && mappings.length >= limit) break
          if (callee.id.startsWith('mybatis:')) {
            try {
              const meta = safeJsonParse(callee.signature || '{}')
              mappings.push({
                javaInterface: node.parentId ? this.queries.getNode(node.parentId)?.name || '' : '',
                methodName: node.name,
                xmlPath: callee.filePath,
                sqlId: callee.name,
              })
            } catch { /* silent */ }
          }
        }
      }
    }

    return mappings
  }

  getFileListing(pattern?: string, limit?: number): { path: string; language: string; nodeCount: number; moduleId?: string }[] {
    const files = this.queries.getAllFiles()
    let result = files.map(f => ({ path: f.path, language: f.language, nodeCount: f.nodeCount }))

    if (pattern) {
      const globPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
      const regex = new RegExp(globPattern, 'i')
      result = result.filter(f => regex.test(f.path))
    }

    if (limit !== undefined) {
      return result.slice(0, limit)
    }
    return result
  }

  getStats(): { files: number; nodes: number; edges: number; modules: number } {
    return this.queries.getStats()
  }

  searchModule(query: string, moduleId: string, limit = 20): { node: MiniCodeGraphNode; snippets: string[]; score: number }[] {
    return this.queries.searchNodesByModule(query, moduleId, limit)
      .map(n => ({ node: n, snippets: [n.signature, n.docstring].filter(Boolean), score: 0 }))
  }

  getCyclomaticComplexity(node: MiniCodeGraphNode): any {
    return this.analyzer.computeCyclomaticComplexity(node)
  }

  findCircularDeps(): any[] {
    return this.analyzer.findCircularDeps()
  }

  findDeadImports(): any[] {
    return this.analyzer.findDeadImports()
  }

  async findEntryPoints(): Promise<any[]> {
    return this.analyzer.findEntryPoints()
  }

  getQueries(): QueryManager {
    return this.queries
  }

  markFilePending(filePath: string): void {
    this.pendingFiles.add(filePath)
  }

  markSyncComplete(): void {
    this.lastSyncTime = Date.now()
    this.pendingFiles.clear()
  }

  getProjectRoot(): string {
    return this.projectRoot
  }

  getStalenessWarning(): string | null {
    if (this.pendingFiles.size > 0) {
      return `${this.pendingFiles.size} files pending sync. Run sync to catch up.`
    }
    return null
  }

  checkStaleFiles(): void {
    if (this.pendingFiles.size > 0) {
      console.error(`Warning: ${this.pendingFiles.size} files pending sync. Run 'mini-codegraph sync' to catch up.`)
    }
  }

  getGatewayRoutes(limit?: number): { id: string; uri: string; predicates: string[]; filters: string[] }[] {
    const routes: { id: string; uri: string; predicates: string[]; filters: string[] }[] = []
    for (const node of this.queries.getNodesByIdPrefix('gateway:', limit)) {
      const anns = this.queries.getAnnotationsByNode(node.id)
      const meta: any = {}
      for (const a of anns) meta[a.annotationName] = a.value
      routes.push({
        id: node.name, uri: meta.uri ?? '',
        predicates: meta.predicates ? safeJsonParse(meta.predicates) : [],
        filters: meta.filters ? safeJsonParse(meta.filters) : [],
      })
    }
    return routes
  }

  getMessageQueueBindings(limit?: number): {
    type: string; queueName: string; exchange: string; routingKey: string; moduleId: string
  }[] {
    const bindings: { type: string; queueName: string; exchange: string; routingKey: string; moduleId: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('mq:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        bindings.push({ ...meta, moduleId: node.moduleId ?? '' })
      } catch { /* silent */ }
    }
    return bindings
  }

  getVueApiMappings(): { vueFile: string; apiPath: string; controllerMethod: string; controllerFile: string }[] {
    const mappings: { vueFile: string; apiPath: string; controllerMethod: string; controllerFile: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'api_mapping')
    for (const e of edges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        mappings.push({
          vueFile: e.sourceId, apiPath: meta.path ?? '',
          controllerMethod: e.targetId, controllerFile: meta.controllerFile ?? '',
        })
      } catch { /* silent */ }
    }
    return mappings
  }

  getSecurityAnnotations(): { filePath: string; annotation: string; value: string }[] {
    const results: { filePath: string; annotation: string; value: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'secured_by')
    for (const e of edges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        results.push({ filePath: e.sourceId, annotation: meta.annotation ?? '', value: meta.value ?? '' })
      } catch { /* silent */ }
    }
    return results
  }

  getJpaEntities(limit?: number): { className: string; tableName: string; columns: number; relationships: number }[] {
    const entities: { className: string; tableName: string; columns: number; relationships: number }[] = []
    for (const node of this.queries.getNodesByIdPrefix('jpa:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        entities.push({ className: node.name, tableName: meta.table ?? '', columns: meta.columns ?? 0, relationships: meta.relationships ?? 0 })
      } catch { /* silent */ }
    }
    return entities
  }

  getReactComponents(limit?: number): { componentName: string; filePath: string; hooks: string[]; props: string[]; children: string[] }[] {
    const comps: { componentName: string; filePath: string; hooks: string[]; props: string[]; children: string[] }[] = []
    for (const node of this.queries.getNodesByIdPrefix('react:', limit)) {
      if (node.kind === 'component') {
        try {
          const meta = safeJsonParse(node.signature || '{}')
          comps.push({ componentName: node.name, filePath: node.filePath, hooks: meta.hooks ?? [], props: meta.props ?? [], children: meta.children ?? [] })
        } catch { /* silent */ }
      }
    }
    return comps
  }

  getReactStores(limit?: number): { storeName: string; filePath: string; type: string; detail: string }[] {
    const stores: { storeName: string; filePath: string; type: string; detail: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('react:store:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        const type = meta.slices ? 'redux' : meta.stateFields ? 'zustand' : 'unknown'
        stores.push({ storeName: node.name, filePath: node.filePath, type, detail: JSON.stringify(meta) })
      } catch { /* silent */ }
    }
    return stores
  }

  getReactQueries(limit?: number): { hookName: string; filePath: string; endpoint: string; method: string }[] {
    const queries: { hookName: string; filePath: string; endpoint: string; method: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('react:query:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        queries.push({ hookName: node.name, filePath: node.filePath, endpoint: meta.endpoint ?? '', method: meta.method ?? 'GET' })
      } catch { /* silent */ }
    }
    return queries
  }

  getMongoEntities(limit?: number): { className: string; filePath: string; collection: string; fields: number; repositories: boolean }[] {
    const entities: { className: string; filePath: string; collection: string; fields: number; repositories: boolean }[] = []
    for (const node of this.queries.getNodesByIdPrefix('mongo:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        entities.push({ className: node.name, filePath: node.filePath, collection: meta.collection ?? '', fields: meta.fields ?? 0, repositories: meta.repository ?? false })
      } catch { /* silent */ }
    }
    return entities
  }

  getRedisHashes(limit?: number): { className: string; filePath: string; redisKey: string; fields: number; ttl?: string }[] {
    const hashes: { className: string; filePath: string; redisKey: string; fields: number; ttl?: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('redis:hash:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        hashes.push({ className: node.name, filePath: node.filePath, redisKey: meta.redisKey ?? '', fields: (meta.fields ?? []).length, ttl: meta.ttl })
      } catch { /* silent */ }
    }
    return hashes
  }

  getRedisTemplates(limit?: number): { className: string; filePath: string; operations: string[]; keyPatterns: string[] }[] {
    const tpls: { className: string; filePath: string; operations: string[]; keyPatterns: string[] }[] = []
    for (const node of this.queries.getNodesByIdPrefix('redis:template:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        tpls.push({ className: node.name, filePath: node.filePath, operations: meta.operations ?? [], keyPatterns: meta.keyPatterns ?? [] })
      } catch { /* silent */ }
    }
    return tpls
  }

  getSqlTables(limit?: number): { tableName: string; filePath: string; columns: number; engine?: string }[] {
    const tables: { tableName: string; filePath: string; columns: number; engine?: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('mysql:table:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        tables.push({ tableName: node.name, filePath: node.filePath, columns: meta.columns ?? 0, engine: meta.engine })
      } catch { /* silent */ }
    }
    return tables
  }

  getSqlStatements(limit?: number): { methodName: string; filePath: string; className: string; sql: string; dbType: string }[] {
    const sqls: { methodName: string; filePath: string; className: string; sql: string; dbType: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('mysql:sql:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        sqls.push({ methodName: node.name, filePath: node.filePath, className: meta.className ?? '', sql: (meta.sql ?? '').slice(0, 200), dbType: meta.dbType ?? '' })
      } catch { /* silent */ }
    }
    return sqls
  }

  getBatchJobs(limit?: number): { name: string; steps: string[]; chunkSize?: number }[] {
    const jobs: { name: string; steps: string[]; chunkSize?: number }[] = []
    for (const node of this.queries.getNodesByIdPrefix('batch:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        jobs.push({ name: node.name, steps: meta.steps ?? [], chunkSize: meta.chunkSize })
      } catch { /* silent */ }
    }
    return jobs
  }

  getResiliencePolicies(): { annotation: string; value: string; fallbackMethod: string; nodeId: string }[] {
    const policies: { annotation: string; value: string; fallbackMethod: string; nodeId: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'resilience_policy')
    for (const e of edges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        policies.push({ annotation: meta.annotation ?? '', value: meta.value ?? '', fallbackMethod: meta.fallbackMethod ?? '', nodeId: e.sourceId })
      } catch { /* silent */ }
    }
    return policies
  }

  getPiniaStores(limit?: number): { name: string; stateKeys: string[]; actions: string[]; getters: string[]; usedIn: string[] }[] {
    const stores: { name: string; stateKeys: string[]; actions: string[]; getters: string[]; usedIn: string[] }[] = []
    for (const node of this.queries.getNodesByIdPrefix('pinia:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        stores.push({ name: node.name, stateKeys: meta.stateKeys ?? [], actions: meta.actions ?? [], getters: meta.getters ?? [], usedIn: meta.usedIn ?? [] })
      } catch { /* silent */ }
    }
    return stores
  }

  getI18nMessages(): { locale: string; key: string; value: string; usedBy: string[] }[] {
    const msgs: { locale: string; key: string; value: string; usedBy: string[] }[] = []
    const i18nEdges = this.queries.getAllEdges().filter(e => e.kind === 'i18n_usage')
    const usageMap = new Map<string, string[]>()
    for (const e of i18nEdges) {
      const parts = e.targetId.replace('i18n:', '').split(':')
      if (parts.length >= 2) {
        const key = `${parts[0]}:${parts.slice(1).join(':')}`
        if (!usageMap.has(key)) usageMap.set(key, [])
        usageMap.get(key)!.push(e.sourceId)
      }
    }
    for (const [key, usedBy] of usageMap) {
      const colonIdx = key.indexOf(':')
      const locale = key.substring(0, colonIdx)
      const msgKey = key.substring(colonIdx + 1)
      msgs.push({ locale, key: msgKey, value: '', usedBy })
    }
    return msgs
  }

  getDeployContainers(limit?: number): { name: string; image: string; ports: string[]; dependsOn: string[] }[] {
    const containers: { name: string; image: string; ports: string[]; dependsOn: string[] }[] = []
    for (const node of this.queries.getNodesByIdPrefix('docker:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        containers.push({ name: node.name, image: meta.image ?? '', ports: meta.ports ?? [], dependsOn: meta.dependsOn ?? [] })
      } catch { /* silent */ }
    }
    return containers
  }

  getK8sResources(limit?: number): { kind: string; name: string; image: string; replicas: number; ports: string[] }[] {
    const resources: { kind: string; name: string; image: string; replicas: number; ports: string[] }[] = []
    for (const node of this.queries.getNodesByIdPrefix('k8s:', limit)) {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        resources.push({ kind: node.name.split(':')[0] ?? '', name: node.name, image: meta.image ?? '', replicas: meta.replicas ?? 1, ports: meta.ports ?? [] })
      } catch { /* silent */ }
    }
    return resources
  }

  getOpenApiEndpoints(limit?: number): { path: string; method: string; operationId: string; serviceName?: string }[] {
    const endpoints: { path: string; method: string; operationId: string; serviceName?: string }[] = []
    for (const node of this.queries.getNodesByIdPrefix('openapi:', limit)) {
      const parts = node.id.replace('openapi:', '').split(':')
      endpoints.push({
        method: parts[0] ?? '', path: parts.slice(1).join(':'),
        operationId: node.name, serviceName: node.moduleId,
      })
    }
    return endpoints
  }

  getAllEdgesByKind(kind: string): { sourceId: string; targetId: string; metadata: string }[] {
    return this.queries.getAllEdges().filter(e => e.kind === kind)
      .map(e => ({ sourceId: e.sourceId, targetId: e.targetId, metadata: e.metadata ?? '' }))
  }

  async buildContext(task: string): Promise<import('../context/index.js').ContextSymbol[]> {
    const { ContextBuilder } = await import('../context/index.js')
    const builder = new ContextBuilder(this.queries, this, this.projectRoot)
    const result = await builder.buildContext(task)
    return result.symbols
  }

  async buildContextWithRoutes(task: string): Promise<{
    task: string
    symbols: import('../context/index.js').ContextSymbol[]
    stats: { totalFiles: number; modules: number; nodes: number; edges: number }
    routes?: { path: string; method: string; handler: string }[]
  }> {
    const { ContextBuilder } = await import('../context/index.js')
    const builder = new ContextBuilder(this.queries, this, this.projectRoot)
    return builder.buildContext(task)
  }

  getContextBuilder(): Promise<import('../context/index.js').ContextBuilder> {
    return import('../context/index.js').then(m => new m.ContextBuilder(this.queries, this, this.projectRoot))
  }

  getFullTraces(): import('../types.js').FullTrace[] {
    const traces: import('../types.js').FullTrace[] = []
    const allEdges = this.queries.getAllEdges()
    const apiEdges = allEdges.filter(e => e.kind === 'api_mapping')
    for (const ae of apiEdges) {
      const hops: import('../types.js').FullTraceHop[] = []
      let meta: any = {}
      try { meta = safeJsonParse(ae.metadata ?? '{}') } catch { /* silent */ }
      hops.push({ kind: 'vue_api_call', id: ae.sourceId, name: ae.sourceId.split('/').pop() ?? '', detail: `API → ${meta.path ?? ''}` })
      const cn = this.queries.getNode(ae.targetId)
      if (cn) {
        hops.push({ kind: 'controller_endpoint', id: cn.id, name: cn.name, moduleId: cn.moduleId, filePath: cn.filePath, detail: `${meta.method ?? 'GET'} ${meta.path ?? ''}` })
        const svcEdges = allEdges.filter(e => e.sourceId === cn.id && e.kind === 'calls')
        for (const se of svcEdges) {
          const sn = this.queries.getNode(se.targetId)
          if (sn) hops.push({ kind: 'service_method', id: sn.id, name: sn.name, moduleId: sn.moduleId, filePath: sn.filePath, detail: `${cn.name} → ${sn.name}` })
        }
      }
      if (hops.length > 1) {
        traces.push({ id: `trace:${ae.sourceId}`, hops, entryPoint: ae.sourceId, endpointPath: meta.path ?? '', httpMethod: meta.method ?? 'GET' })
      }
    }
    return traces
  }

  getFullTraceByEndpoint(path: string): import('../types.js').FullTrace | undefined {
    return this.getFullTraces().find(t => t.endpointPath.includes(path) || path.includes(t.endpointPath))
  }

  getFullTracesByService(serviceName: string): import('../types.js').FullTrace[] {
    return this.getFullTraces().filter(t => t.hops.some(h => h.moduleId?.toLowerCase().includes(serviceName.toLowerCase())))
  }

  getConfigBindings(): import('../types.js').ConfigPropertyBinding[] {
    const bindings: import('../types.js').ConfigPropertyBinding[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'config_binding')
    const seen = new Set<string>()
    for (const e of edges) {
      if (!seen.has(e.sourceId)) {
        seen.add(e.sourceId)
        try {
          const meta = safeJsonParse(e.metadata ?? '{}')
          bindings.push({
            configClass: e.sourceId,
            prefix: meta.prefix ?? '',
            filePath: '',
            properties: [{ key: meta.key ?? '', value: meta.value ?? '', sourceFile: '', sourceLine: 0 }],
            moduleId: '',
          })
        } catch { /* silent */ }
      }
    }
    return bindings
  }

  getTxAnnotations(): import('../types.js').TransactionalInfo[] {
    const list: import('../types.js').TransactionalInfo[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'transactional')
    for (const e of edges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        list.push({
          nodeId: e.sourceId,
          methodName: meta.methodName ?? '',
          className: meta.className ?? '',
          propagation: meta.propagation ?? 'REQUIRED',
          isolation: meta.isolation ?? 'DEFAULT',
          timeout: meta.timeout ?? -1,
          readOnly: meta.readOnly ?? false,
          rollbackFor: meta.rollbackFor ?? [],
          noRollbackFor: meta.noRollbackFor ?? [],
          filePath: meta.filePath ?? '',
          line: meta.line ?? 0,
        })
      } catch { /* silent */ }
    }
    return list
  }

  getTxBoundaryConflicts(): { outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string }[] {
    const conflicts: { outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string }[] = []
    const txEdges = this.queries.getAllEdges().filter(e => e.kind === 'tx_propagate')
    for (const e of txEdges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        const on = this.queries.getNode(e.sourceId)
        const inn = this.queries.getNode(e.targetId)
        if (on && inn && meta.innerPropagation === 'REQUIRES_NEW') {
          conflicts.push({ outerMethod: on.name, innerMethod: inn.name, outerPropagation: meta.callerPropagation ?? 'REQUIRED', innerPropagation: 'REQUIRES_NEW', warning: 'REQUIRES_NEW inside existing transaction: outer tx will be suspended' })
        }
      } catch { /* silent */ }
    }
    return conflicts
  }

  getCacheTopologies(): import('../types.js').CacheTopology[] {
    const topologies: import('../types.js').CacheTopology[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'cache_annotation')
    const cacheMap = new Map<string, any[]>()
    for (const e of edges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        for (const name of meta.cacheNames ?? []) {
          if (!cacheMap.has(name)) cacheMap.set(name, [])
          cacheMap.get(name)!.push(meta)
        }
      } catch { /* silent */ }
    }
    for (const [cacheName, entries] of cacheMap) {
      const services = new Set<string>()
      for (const e of entries) if (e.moduleId) services.add(e.moduleId)
      topologies.push({ cacheName, entries, relatedServices: Array.from(services) })
    }
    return topologies
  }

  getRoutingManifest(limit = 50): { path: string; method: string; handler: string; filePath: string; line: number }[] {
    const manifest: { path: string; method: string; handler: string; filePath: string; line: number }[] = []
    const routeAnnotations = ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping']

    for (const node of this.queries.getAllNodes()) {
      const annotations = this.queries.getAnnotationsByNode(node.id)
      for (const a of annotations) {
        if (routeAnnotations.includes(a.annotationName)) {
          const method = a.annotationName === 'RequestMapping' ? 'ANY' : a.annotationName.replace('Mapping', '').toUpperCase()
          const path = a.value.replace(/"/g, '')
          manifest.push({
            path, method,
            handler: `${node.name} (${node.qualifiedName})`,
            filePath: node.filePath,
            line: node.startLine,
          })
        }
      }
    }

    return manifest.slice(0, limit)
  }

  getLombokSynthetics(limit?: number): { nodeId: string; annotation: string; field?: string }[] {
    const results: { nodeId: string; annotation: string; field?: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'lombok_synthetic')
    for (const e of edges) {
      if (limit !== undefined && results.length >= limit) break
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        results.push({ nodeId: e.sourceId, annotation: meta.annotation ?? '', field: meta.field })
      } catch { /* silent */ }
    }
    return results
  }

  getGrpcServices(limit?: number): { name: string; package: string; rpcMethods: string[]; filePath: string; stubClass?: string }[] {
    const services: { name: string; package: string; rpcMethods: string[]; filePath: string; stubClass?: string }[] = []
    const grpcEdges = this.queries.getAllEdges().filter(e => e.kind === 'grpc_stub')
    const stubMap = new Map<string, string>()
    for (const e of grpcEdges) {
      try {
        const meta = safeJsonParse(e.metadata ?? '{}')
        stubMap.set(e.sourceId, meta.stubClass ?? '')
      } catch { /* silent */ }
    }

    for (const node of this.queries.getNodesByIdPrefix('grpc:', limit)) {
      if (node.kind === 'interface') {
        const children = this.queries.getChildren(node.id)
        const parts = node.qualifiedName.split('.')
        services.push({
          name: node.name,
          package: parts.length > 1 ? parts.slice(0, -1).join('.') : '',
          rpcMethods: children.filter(c => c.kind === 'method').map(c => c.name),
          filePath: node.filePath,
          stubClass: stubMap.get(node.id) || undefined,
        })
      }
    }
    return services
  }

  getMapStructMappers(limit?: number): MapStructMapperSummary[] {
    const mappers: MapStructMapperSummary[] = []
    const annotations = new Map<string, string[]>()
    for (const node of this.queries.getAllNodes()) {
      if (limit !== undefined && mappers.length >= limit) break
      if (node.kind === 'interface') {
        const anns = this.queries.getAnnotationsByNode(node.id)
        if (anns.some(a => a.annotationName === 'Mapper')) {
          const methods = this.queries.getChildren(node.id).filter(c => c.kind === 'method')
          const sourceEdges = this.queries.getAllEdges().filter(e => e.kind === 'mapstruct_source' && e.sourceId.startsWith(node.id.split(':')[0]))
          const targetEdges = this.queries.getAllEdges().filter(e => e.kind === 'mapstruct_target' && e.sourceId.startsWith(node.id.split(':')[0]))
          mappers.push({
            interfaceName: node.name,
            methods: methods.map(m => {
              const se = sourceEdges.find(e => e.targetId === node.id && safeJsonParse(e.metadata || '{}').method === m.name)
              const te = targetEdges.find(e => e.sourceId === node.id && safeJsonParse(e.metadata || '{}').method === m.name)
              const fieldMappings: { source: string; target: string }[] = []
              const mappingAnns = this.queries.getAnnotationsByNode(m.id)
                .filter(a => a.annotationName === 'Mapping')
              for (const ma of mappingAnns) {
                const parts = ma.value.split('→')
                if (parts.length === 2) fieldMappings.push({ source: parts[0], target: parts[1] })
              }
              return {
                methodName: m.name,
                sourceType: se ? safeJsonParse(se.metadata || '{}').sourceType ?? '' : '',
                targetType: te ? safeJsonParse(te.metadata || '{}').targetType ?? '' : '',
                fieldMappings,
              }
            }),
          })
        }
      }
    }
    return mappers
  }

  getAutoConfigurations(): AutoConfigSummary[] {
    const configs: AutoConfigSummary[] = []
    for (const node of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(node.id)
      const conditionalAnn = anns.find(a => a.annotationName === 'ConditionalConfig')
      if (!conditionalAnn) continue

      const conditions: ConditionInfo[] = []
      try {
        const parsed = safeJsonParse(conditionalAnn.value)
        if (Array.isArray(parsed)) {
          for (const c of parsed) {
            conditions.push({ type: c.type, value: c.value, matchIfMissing: c.matchIfMissing ?? false })
          }
        }
      } catch { /* silent */ }

      const afterEdges = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'auto_configure_after')
      const beforeEdges = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'auto_configure_before')

      configs.push({
        className: node.name,
        filePath: node.filePath,
        conditions,
        autoConfigureAfter: afterEdges.map(e => e.targetId.split(':').pop() || ''),
        autoConfigureBefore: beforeEdges.map(e => e.targetId.split(':').pop() || ''),
      })
    }
    return configs
  }

  getMavenModules(limit?: number): MavenModuleSummary[] {
    const modules: MavenModuleSummary[] = []
    for (const node of this.queries.getNodesByIdPrefix('pom:', limit)) {
      if (node.kind === 'module') {
        const depEdges = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'maven_depends_on')
        const submoduleEdges = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'maven_submodule')
        modules.push({
          artifactId: node.name,
          qualifiedName: node.qualifiedName,
          dependencies: depEdges.map(e => {
            const meta = safeJsonParse(e.metadata || '{}')
            return {
              groupId: meta.groupId || '',
              artifactId: meta.artifactId || '',
              version: meta.version || '',
              scope: meta.scope || 'compile',
              optional: meta.optional || false,
            }
          }),
          submodules: submoduleEdges.map(e => e.targetId.split(':').pop() || ''),
        })
      }
    }
    return modules
  }

  getMavenScopeConflicts(limit?: number): MavenScopeConflict[] {
    const depToScopes = new Map<string, { scopes: Set<string>; modules: Set<string> }>()
    for (const node of this.queries.getNodesByIdPrefix('pom:', limit)) {
      if (node.kind === 'module') {
        const deps = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'maven_depends_on')
        for (const d of deps) {
          const meta = safeJsonParse(d.metadata || '{}')
          const key = `${meta.groupId}:${meta.artifactId}`
          if (!depToScopes.has(key)) depToScopes.set(key, { scopes: new Set(), modules: new Set() })
          const entry = depToScopes.get(key)!
          entry.scopes.add(meta.scope || 'compile')
          entry.modules.add(node.name)
        }
      }
    }
    return [...depToScopes.entries()]
      .filter(([_, v]) => v.scopes.size > 1)
      .map(([k, v]) => ({ artifactKey: k, scopes: [...v.scopes], modules: [...v.modules] }))
  }

  getGradleModules(limit?: number): GradleModuleSummary[] {
    const modules: GradleModuleSummary[] = []
    for (const node of this.queries.getNodesByIdPrefix('gradle:', limit)) {
      if (node.kind === 'module') {
        const depEdges = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'gradle_depends_on')
        const subEdges = this.queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'gradle_submodule')
        modules.push({
          name: node.name,
          dependencies: depEdges.map(e => {
            const meta = safeJsonParse(e.metadata || '{}')
            return { group: meta.group || '', artifact: meta.artifact || '', version: meta.version || '', configuration: meta.configuration || 'implementation', isProject: meta.isProject || false }
          }),
          submodules: subEdges.map(e => {
            const meta = safeJsonParse(e.metadata || '{}')
            return { name: e.targetId.split(':').pop() || '', path: meta.path || '' }
          }),
        })
      }
    }
    return modules
  }

  getCloudConfigs(): CloudConfigSummary[] {
    const configs: CloudConfigSummary[] = []
    for (const node of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(node.id)
      const ccAnn = anns.find(a => a.annotationName === 'CloudConfigRef')
      if (!ccAnn) continue
      try {
        const parsed = safeJsonParse(ccAnn.value)
        configs.push({ className: node.name, filePath: node.filePath, refreshScope: parsed.refreshScope, configKey: parsed.configKey })
      } catch { /* silent */ }
    }
    return configs
  }

  getLoadBalancerClients(): LoadBalancerClientSummary[] {
    const clients: LoadBalancerClientSummary[] = []
    for (const node of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(node.id)
      const lbAnn = anns.find(a => a.annotationName === 'LoadBalancedClient')
      if (!lbAnn) continue
      try {
        const parsed = safeJsonParse(lbAnn.value)
        clients.push({ className: node.parentId ? (this.queries.getNode(node.parentId)?.name || '') : '', fieldName: parsed.fieldName, serviceName: parsed.serviceName })
      } catch { /* silent */ }
    }
    return clients
  }

  getLoadBalancerUris(): LbUriSummary[] {
    const results: LbUriSummary[] = []
    const allEdges = this.queries.getAllEdges()
    for (const e of allEdges) {
      if (e.kind === 'gateway_route') {
        try {
          const meta = safeJsonParse(e.metadata || '{}')
          if (meta.uri?.startsWith('lb://')) results.push({ uri: meta.uri, targetService: meta.uri.replace('lb://', '') })
        } catch { /* silent */ }
      }
    }
    const feignNodes = this.queries.getNodesByAnnotation('FeignClient')
    for (const fn of feignNodes) {
      const anns = this.queries.getAnnotationsByNode(fn.id)
      for (const a of anns) {
        if (a.annotationName === 'FeignClient') {
          const nameMatch = a.value.match(/name\s*=\s*["'](\w[\w-]*)["']/)
          if (nameMatch && !a.value.includes('url=')) {
            results.push({ uri: `lb://${nameMatch[1]}`, targetService: nameMatch[1] })
          }
        }
      }
    }
    return results
  }

  getGraphQLEndpoints(): GraphQLEndpointSummary[] {
    const endpoints: GraphQLEndpointSummary[] = []
    const allEdges = this.queries.getAllEdges().filter(e => e.kind === 'graphql_handler')
    for (const e of allEdges) {
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        const target = this.queries.getNode(e.targetId)
        endpoints.push({
          className: this.queries.getNode(e.sourceId)?.name || '',
          methodName: target?.name || '',
          field: meta.field || '',
          returnType: meta.returnType || '',
          kind: meta.kind || 'query',
        })
      } catch { /* silent */ }
    }
    return endpoints
  }

  getWebSocketEndpoints(): WebSocketEndpointSummary[] {
    const endpoints: WebSocketEndpointSummary[] = []
    const allEdges = this.queries.getAllEdges().filter(e => e.kind === 'websocket_handler')
    for (const e of allEdges) {
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        const target = this.queries.getNode(e.targetId)
        endpoints.push({
          className: this.queries.getNode(e.sourceId)?.name || '',
          methodName: target?.name || '',
          destination: meta.destination || '',
          kind: meta.kind || 'message_mapping',
        })
      } catch { /* silent */ }
    }
    return endpoints
  }

  getTestAnnotations(): TestAnnotationSummary[] {
    const tests: TestAnnotationSummary[] = []
    const allEdges = this.queries.getAllEdges().filter(e => e.kind === 'mock_replaces')
    const mockMap = new Map<string, string[]>()
    for (const e of allEdges) {
      if (!mockMap.has(e.sourceId)) mockMap.set(e.sourceId, [])
      const target = this.queries.getNode(e.targetId)
      if (target) mockMap.get(e.sourceId)!.push(target.name)
    }

    for (const [nodeId, mocks] of mockMap) {
      const node = this.queries.getNode(nodeId)
      if (!node) continue
      const anns = this.queries.getAnnotationsByNode(nodeId)
      for (const a of anns) {
        if (['SpringBootTest', 'WebMvcTest', 'DataJpaTest'].includes(a.annotationName)) {
          tests.push({ className: node.name, filePath: node.filePath, annotation: a.annotationName, mockBeans: mocks })
        }
      }
    }
    return tests
  }

  getAsyncMethods(): AsyncMethodSummary[] {
    const methods: AsyncMethodSummary[] = []
    const allEdges = this.queries.getAllEdges().filter(e => e.kind === 'async_method' || e.kind === 'scheduled_method')
    for (const e of allEdges) {
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        const target = this.queries.getNode(e.targetId)
        methods.push({
          className: this.queries.getNode(e.sourceId)?.name || '',
          methodName: target?.name || '',
          kind: e.kind === 'async_method' ? 'async' : 'scheduled',
          cron: meta.cron,
          fixedRate: meta.fixedRate,
          fixedDelay: meta.fixedDelay,
          executor: meta.executor,
        })
      } catch { /* silent */ }
    }
    return methods
  }

  getAspectAdvices(): AspectAdviceSummary[] {
    const advices: AspectAdviceSummary[] = []
    for (const e of this.queries.getAllEdges()) {
      if (!e.kind.startsWith('aspect_')) continue
      const source = this.queries.getNode(e.sourceId)
      if (!source) continue
      advices.push({
        aspectClass: source.name,
        filePath: source.filePath,
        adviceType: e.kind.replace('aspect_', ''),
        pointcut: (safeJsonParse(e.metadata || '{}')).pointcut || '',
      })
    }
    return advices
  }

  getSecurityFilterRules(): SecurityFilterRuleSummary[] {
    const rules: SecurityFilterRuleSummary[] = []
    for (const e of this.queries.getAllEdges()) {
      if (!e.kind.startsWith('security_filter_')) continue
      const source = this.queries.getNode(e.sourceId)
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        rules.push({
          classFile: source?.filePath || '',
          urlPatterns: meta.urlPatterns || [],
          method: e.kind.replace('security_filter_', ''),
          roles: meta.roles || [],
          expression: meta.expression || '',
        })
      } catch { /* silent */ }
    }
    return rules
  }

  getK8sServiceDetails(): K8sServiceDetailSummary[] {
    return this.queries.getAllNodes()
      .filter(n => {
        const anns = this.queries.getAnnotationsByNode(n.id)
        return anns.some(a => a.annotationName === 'K8sService')
      })
      .map(n => {
        const ann = this.queries.getAnnotationsByNode(n.id).find(a => a.annotationName === 'K8sService')
        const parsed = ann ? safeJsonParse(ann.value) : {}
        return { serviceName: n.name.replace('k8s:Service:', ''), type: parsed.type || 'ClusterIP', ports: parsed.ports || [] }
      })
  }

  getK8sIngressDetails(): K8sIngressDetailSummary[] {
    const ingresses: K8sIngressDetailSummary[] = []
    for (const n of this.queries.getAllNodes()) {
      if (!n.id.startsWith('k8s:Ingress:')) continue
      const anns = this.queries.getAnnotationsByNode(n.id)
      const pathAnns = anns.filter(a => a.annotationName === 'IngressPath')
      const tlsAnns = anns.filter(a => a.annotationName === 'IngressTLS')
      ingresses.push({
        name: n.name,
        host: n.qualifiedName.replace('ingress:', ''),
        paths: pathAnns.map(a => safeJsonParse(a.value)),
        tlsHosts: tlsAnns.map(a => safeJsonParse(a.value).host),
      })
    }
    return ingresses
  }

  getK8sNetworkPolicies(): K8sNetPolSummary[] {
    const policies: K8sNetPolSummary[] = []
    for (const n of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(n.id)
      const npAnn = anns.find(a => a.annotationName === 'K8sNetworkPolicy')
      if (!npAnn) continue
      try {
        const parsed = safeJsonParse(npAnn.value)
        policies.push({
          name: n.name.replace('k8s:NetworkPolicy:', ''),
          policyTypes: parsed.policyTypes || [],
          ingressRuleCount: parsed.ingressRules || 0,
        })
      } catch { /* silent */ }
    }
    return policies
  }

  getControllerAdvices(): ControllerAdviceSummary[] {
    const advices: ControllerAdviceSummary[] = []
    for (const n of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(n.id)
      const caAnn = anns.find(a => a.annotationName === 'ControllerAdvice')
      if (!caAnn) continue
      try {
        const parsed = safeJsonParse(caAnn.value)
        advices.push({
          className: n.name,
          basePackages: parsed.basePackages || [],
          assignableTypes: parsed.assignableTypes || [],
          annotations: parsed.annotations || [],
        })
      } catch { /* silent */ }
    }
    return advices
  }

  getInterceptors(): InterceptorSummary[] {
    const interceptors: InterceptorSummary[] = []
    for (const n of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(n.id)
      const iAnn = anns.find(a => a.annotationName === 'Interceptor')
      if (!iAnn) continue
      try {
        const parsed = safeJsonParse(iAnn.value)
        interceptors.push({
          classFile: n.filePath,
          className: n.name,
          type: parsed.type || 'HandlerInterceptor',
          urlPatterns: parsed.urlPatterns || ['/*'],
        })
      } catch { /* silent */ }
    }
    return interceptors
  }

  getStreamFunctions(): StreamFunctionSummary[] {
    const funcs: StreamFunctionSummary[] = []
    for (const e of this.queries.getAllEdges()) {
      if (e.kind !== 'stream_function') continue
      const target = this.queries.getNode(e.targetId)
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        funcs.push({
          className: this.queries.getNode(e.sourceId)?.name || '',
          beanMethod: target?.name || '',
          functionType: meta.type || 'Function',
          inputType: meta.input || '',
          outputType: meta.output || '',
          bindingName: meta.binding || '',
        })
      } catch { /* silent */ }
    }
    return funcs
  }

  getJpaCustomQueries(): JpaQuerySummary[] {
    const queries: JpaQuerySummary[] = []
    for (const e of this.queries.getAllEdges()) {
      if (e.kind !== 'jpa_query') continue
      const target = this.queries.getNode(e.targetId)
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        queries.push({
          repositoryClass: this.queries.getNode(e.sourceId)?.name || '',
          methodName: target?.name || '',
          query: meta.query || '',
          nativeQuery: meta.native || false,
          modification: meta.modification || false,
        })
      } catch { /* silent */ }
    }
    return queries
  }

  getJpaProcedures(): JpaProcedureSummary[] {
    const procs: JpaProcedureSummary[] = []
    for (const n of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(n.id)
      const pAnn = anns.find(a => a.annotationName === 'JpaProcedure')
      if (!pAnn) continue
      try {
        const parsed = safeJsonParse(pAnn.value)
        procs.push({
          repositoryClass: n.filePath.split('/').pop()?.replace('.java', '') || '',
          procedureName: parsed.procedureName || '',
          outputType: parsed.outputType || '',
        })
      } catch { /* silent */ }
    }
    return procs
  }

  getProfileAnnotations(): ProfileSummary[] {
    const profiles: ProfileSummary[] = []
    for (const n of this.queries.getAllNodes()) {
      const anns = this.queries.getAnnotationsByNode(n.id)
      const pAnn = anns.find(a => a.annotationName === 'Profile')
      if (!pAnn) continue
      try {
        profiles.push({
          className: n.name,
          filePath: n.filePath,
          profiles: safeJsonParse(pAnn.value),
        })
      } catch { /* silent */ }
    }
    return profiles
  }

  private inferServiceFromLocation(sourceLocation: string, modules: { id: string; rootPath: string }[]): string | null {
    const normalized = sourceLocation.replace(/\\/g, '/')
    // Absolute path match
    for (const mod of modules) {
      const root = mod.rootPath.replace(/\\/g, '/')
      if (normalized.startsWith(root)) return mod.id
    }
    // sourceLocation is typically: src/main/java/com/demo/{service}/...
    // Extract the {service} segment and match against known module names
    const knownModules = new Map<string, string>()
    for (const mod of modules) {
      knownModules.set(mod.id, mod.id)
      const dirName = mod.id.replace(/-service$/, '').replace(/-/g, '')
      if (dirName !== mod.id) knownModules.set(dirName, mod.id)
    }
    // Match package-name segment (e.g., 'order' in com.demo.order → 'order-service')
    const pkgMatch = normalized.match(/\/com\/demo\/([\w-]+)\//)
    if (pkgMatch) {
      const pkg = pkgMatch[1]
      // try exact
      if (knownModules.has(pkg)) return knownModules.get(pkg)!
      // try with -service suffix
      const withSvc = pkg + '-service'
      if (knownModules.has(withSvc)) return withSvc
    }
    // Fallback: scan path segments for known service names
    const parts = normalized.split(/[/\\:]/)
    const knownServiceNames = modules.map(m => m.id)
    for (const part of parts) {
      if (knownServiceNames.includes(part)) return part
    }
    return null
  }

  getServiceConsumers(serviceName: string): { service: string; refs: { symbolId: string; referenceType: string; sourceLocation: string }[] }[] {
    const symbols = this.queries.getAllExternalSymbols()
    const refs = this.queries.getAllExternalReferences()
    const modules = this.queries.getAllModules()

    // symbols that serviceName provides
    const providedSymbols = new Set(
      symbols.filter(s => s.serviceName === serviceName).map(s => s.id)
    )

    // refs that consume those symbols → infer consumer from sourceLocation
    const grouped = new Map<string, { symbolId: string; referenceType: string; sourceLocation: string }[]>()
    for (const r of refs) {
      if (providedSymbols.has(r.symbolName)) {
        const consumer = this.inferServiceFromLocation(r.sourceLocation, modules) || 'unknown'
        const refsList = grouped.get(consumer) || []
        refsList.push({ symbolId: r.symbolName, referenceType: r.referenceType || '', sourceLocation: r.sourceLocation })
        grouped.set(consumer, refsList)
      }
    }
    return Array.from(grouped.entries()).map(([svc, refsList]) => ({ service: svc, refs: refsList }))
  }

  getServiceDependencies(serviceName: string): { service: string; refs: { symbolId: string; referenceType: string }[] }[] {
    const symbols = this.queries.getAllExternalSymbols()
    const refs = this.queries.getAllExternalReferences()
    const modules = this.queries.getAllModules()

    // refs where sourceLocation belongs to serviceName
    const targetServices = new Map<string, { symbolId: string; referenceType: string }[]>()
    for (const r of refs) {
      const consumer = this.inferServiceFromLocation(r.sourceLocation, modules)
      if (consumer !== serviceName) continue
      const sym = symbols.find(s => s.id === r.symbolName)
      const provider = sym?.serviceName || ''
      if (!provider || provider === serviceName) continue
      const items = targetServices.get(provider) || []
      items.push({ symbolId: r.symbolName, referenceType: r.referenceType || '' })
      targetServices.set(provider, items)
    }
    return Array.from(targetServices.entries()).map(([svc, items]) => ({ service: svc, refs: items }))
  }

  getDispatchTargets(
    nodeId: string,
    options?: { minConfidence?: number; kind?: string },
  ): InferredTarget[] {
    return getDispatchTargetsForNode(this.queries, nodeId, options?.minConfidence ?? 0)
  }

  getDispatchChain(nodeId: string, maxDepth = 3): {
    symbol: MiniCodeGraphNode | undefined
    dispatchPatterns: DispatchPattern[]
  }[] {
    const result: {
      symbol: MiniCodeGraphNode | undefined
      dispatchPatterns: DispatchPattern[]
    }[] = []
    const visited = new Set<string>()
    const queue: string[] = [nodeId]

    while (queue.length > 0 && result.length < maxDepth) {
      const currentId = queue.shift()!
      if (visited.has(currentId)) continue
      visited.add(currentId)

      const symbol = this.queries.getNode(currentId)
      const allEdges = this.queries.getAllEdges()
      const dispatchEdges = allEdges.filter(e =>
        (e.sourceId === currentId || e.targetId === currentId) &&
        ['dispatch_registration', 'proxy_wraps', 'aop_advises', 'conditional_impl'].includes(e.kind)
      )

      const patterns: DispatchPattern[] = []
      for (const edge of dispatchEdges) {
        try {
          const meta = JSON.parse(edge.metadata ?? '{}')
          const targetId = edge.sourceId === currentId ? edge.targetId : edge.sourceId
          const targetNode = this.queries.getNode(targetId)
          patterns.push({
            type: meta.provenance ?? 'unknown',
            sourceId: edge.sourceId,
            sourceName: this.queries.getNode(edge.sourceId)?.name ?? '',
            interfaceName: this.queries.getNode(edge.targetId)?.name,
            possibleTargets: [{
              targetId,
              targetName: targetNode?.name ?? targetId,
              confidence: meta.confidence ?? 0,
              provenance: meta.provenance ?? 'unknown',
              provenanceDetail: meta.provenanceDetail ?? '',
              condition: meta.condition,
              alternatives: meta.alternatives,
            }],
          })
        } catch { /* silent */ }
      }

      result.push({ symbol, dispatchPatterns: patterns })

      for (const p of patterns) {
        for (const t of p.possibleTargets) {
          if (!visited.has(t.targetId)) queue.push(t.targetId)
        }
      }
    }

    return result
  }

  getInferredEdgesByKind(kind: string): { sourceId: string; targetId: string; metadata: string }[] {
    return this.queries.getAllEdges()
      .filter(e => e.kind === kind)
      .map(e => ({ sourceId: e.sourceId, targetId: e.targetId, metadata: e.metadata ?? '' }))
  }

  getCallersWithDispatch(
    nodeId: string,
    options?: { minConfidence?: number; includeInferred?: boolean },
  ): { node: MiniCodeGraphNode; confidence: number; provenance: string; detail: string }[] {
    const minConf = options?.minConfidence ?? 0
    const includeInferred = options?.includeInferred ?? true

    const staticCallers = this.queries.getCallers(nodeId)
      .map(n => ({ node: n, confidence: 1.0, provenance: 'static_direct' as const, detail: 'Static call' }))

    if (!includeInferred) return staticCallers

    const dispatchTargets = getDispatchTargetsForNode(this.queries, nodeId, minConf)
    const inferredCallers: { node: MiniCodeGraphNode; confidence: number; provenance: string; detail: string }[] = []

    for (const dt of dispatchTargets) {
      const targetNode = this.queries.getNode(dt.targetId)
      if (!targetNode) continue

      const targetCallers = this.queries.getCallers(dt.targetId)
      for (const tc of targetCallers) {
        inferredCallers.push({
          node: tc,
          confidence: dt.confidence,
          provenance: dt.provenance,
          detail: dt.provenanceDetail,
        })
      }
    }

    const seen = new Set<string>()
    const merged = [...staticCallers, ...inferredCallers].filter(item => {
      const key = `${item.node.id}:${item.provenance}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    return merged
  }

  getActiveImplementations(
    interfaceName: string,
    configOverrides?: Record<string, string>,
  ): { className: string; confidence: number; evaluations: { matched: boolean; reason: string }[]; active: boolean }[] {
    const config = readProjectConfig(this.projectRoot)
    if (configOverrides) {
      for (const [key, value] of Object.entries(configOverrides)) {
        config.properties.set(key, value)
      }
    }

    const allNodes = this.queries.getAllNodes()
    const ifaceNode = allNodes.find(n =>
      (n.name === interfaceName || n.qualifiedName === interfaceName || n.qualifiedName.endsWith(`.${interfaceName}`)) &&
      (n.kind === 'interface' || n.kind === 'class')
    )
    if (!ifaceNode) return []

    const allEdges = this.queries.getAllEdges()
    const implIds = allEdges
      .filter(e => (e.kind === 'implements' || e.kind === 'conditional_impl') && e.targetId === ifaceNode.id)
      .map(e => e.sourceId)

    const nameImpls = allNodes.filter(n =>
      n.kind === 'class' && n.moduleId === ifaceNode.moduleId &&
      (n.name === `${ifaceNode.name}Impl` || n.name.endsWith(ifaceNode.name))
    ).map(n => n.id)

    const allIds = [...new Set([...implIds, ...nameImpls])]
    const results: { className: string; confidence: number; evaluations: { matched: boolean; reason: string }[]; active: boolean }[] = []

    for (const id of allIds) {
      const result = isNodeActiveUnderConfig(this.queries, id, config)
      const node = this.queries.getNode(id)
      results.push({
        className: node?.name ?? id,
        confidence: result.active ? 0.8 : 0.3,
        evaluations: result.evaluations.map(e => ({ matched: e.matched, reason: e.reason })),
        active: result.active,
      })
    }

    return results
  }

  getServiceDependencyGraph(): { nodes: { name: string; provides: number }[]; edges: { from: string; to: string; types: string[] }[] } {
    const symbols = this.queries.getAllExternalSymbols()
    const refs = this.queries.getAllExternalReferences()
    const modules = this.queries.getAllModules()
    const providesCount = new Map<string, number>()
    for (const s of symbols) {
      const svc = s.serviceName || ''
      providesCount.set(svc, (providesCount.get(svc) || 0) + 1)
    }
    const allServiceNames = new Set(providesCount.keys())

    const edges: { from: string; to: string; types: string[] }[] = []
    const edgeSet = new Set<string>()
    for (const r of refs) {
      const consumer = this.inferServiceFromLocation(r.sourceLocation, modules)
      const sym = symbols.find(s => s.id === r.symbolName)
      const provider = sym?.serviceName || ''
      if (consumer && provider && consumer !== provider && allServiceNames.has(consumer) && allServiceNames.has(provider)) {
        const key = `${consumer}|${provider}`
        const refType = r.referenceType || 'unknown'
        if (!edgeSet.has(key)) {
          edgeSet.add(key)
          edges.push({ from: consumer, to: provider, types: [refType] })
        } else {
          const existing = edges.find(e => e.from === consumer && e.to === provider)
          if (existing && !existing.types.includes(refType)) {
            existing.types.push(refType)
          }
        }
      }
    }

    const nodes = Array.from(allServiceNames).map(name => ({ name, provides: providesCount.get(name) || 0 }))
    return { nodes, edges }
  }

  findWorkspaceCircularDeps(): { cycle: string[] }[] {
    const graph = this.getServiceDependencyGraph()
    const adj = new Map<string, string[]>()
    for (const n of graph.nodes) adj.set(n.name, [])
    for (const e of graph.edges) {
      adj.get(e.from)?.push(e.to)
    }

    const cycles: { cycle: string[] }[] = []
    const visited = new Set<string>()
    const recStack = new Set<string>()
    const path: string[] = []

    const dfs = (node: string): void => {
      visited.add(node)
      recStack.add(node)
      path.push(node)
      for (const neighbor of adj.get(node) || []) {
        if (!visited.has(neighbor)) {
          dfs(neighbor)
        } else if (recStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor)
          if (cycleStart >= 0) {
            cycles.push({ cycle: [...path.slice(cycleStart), neighbor] })
          }
        }
      }
      path.pop()
      recStack.delete(node)
    }

    for (const n of graph.nodes) {
      if (!visited.has(n.name)) dfs(n.name)
    }

    return cycles
  }
}

interface AspectAdviceSummary {
  aspectClass: string
  filePath: string
  adviceType: string
  pointcut: string
}

interface SecurityFilterRuleSummary {
  classFile: string
  urlPatterns: string[]
  method: string
  roles: string[]
  expression: string
}

interface K8sServiceDetailSummary {
  serviceName: string
  type: string
  ports: { port: number; targetPort: number | string; protocol: string; name: string }[]
}

interface K8sIngressDetailSummary {
  name: string
  host: string
  paths: { host: string; path: string; serviceName: string; servicePort: number | string }[]
  tlsHosts: string[]
}

interface K8sNetPolSummary {
  name: string
  policyTypes: string[]
  ingressRuleCount: number
}

interface ControllerAdviceSummary {
  className: string
  basePackages: string[]
  assignableTypes: string[]
  annotations: string[]
}

interface InterceptorSummary {
  classFile: string
  className: string
  type: string
  urlPatterns: string[]
}

interface StreamFunctionSummary {
  className: string
  beanMethod: string
  functionType: string
  inputType: string
  outputType: string
  bindingName: string
}

interface JpaQuerySummary {
  repositoryClass: string
  methodName: string
  query: string
  nativeQuery: boolean
  modification: boolean
}

interface JpaProcedureSummary {
  repositoryClass: string
  procedureName: string
  outputType: string
}

interface ProfileSummary {
  className: string
  filePath: string
  profiles: string[]
}

interface MapStructMapperSummary {
  interfaceName: string
  methods: {
    methodName: string
    sourceType: string
    targetType: string
    fieldMappings: { source: string; target: string }[]
  }[]
}

interface AutoConfigSummary {
  className: string
  filePath: string
  conditions: ConditionInfo[]
  autoConfigureAfter: string[]
  autoConfigureBefore: string[]
}

interface ConditionInfo {
  type: string
  value: string
  matchIfMissing: boolean
}

interface MavenModuleSummary {
  artifactId: string
  qualifiedName: string
  dependencies: {
    groupId: string
    artifactId: string
    version: string
    scope: string
    optional: boolean
  }[]
  submodules: string[]
}

interface MavenScopeConflict {
  artifactKey: string
  scopes: string[]
  modules: string[]
}

interface GradleModuleSummary {
  name: string
  dependencies: { group: string; artifact: string; version: string; configuration: string; isProject: boolean }[]
  submodules: { name: string; path: string }[]
}

interface CloudConfigSummary {
  className: string
  filePath: string
  refreshScope: boolean
  configKey?: string
}

interface LoadBalancerClientSummary {
  className: string
  fieldName: string
  serviceName?: string
}

interface LbUriSummary {
  uri: string
  targetService: string
}

interface GraphQLEndpointSummary {
  className: string
  methodName: string
  field: string
  returnType: string
  kind: string
}

interface WebSocketEndpointSummary {
  className: string
  methodName: string
  destination: string
  kind: string
}

interface TestAnnotationSummary {
  className: string
  filePath: string
  annotation: string
  mockBeans: string[]
}

interface AsyncMethodSummary {
  className: string
  methodName: string
  kind: 'async' | 'scheduled'
  cron?: string
  fixedRate?: number
  fixedDelay?: number
  executor?: string
}
