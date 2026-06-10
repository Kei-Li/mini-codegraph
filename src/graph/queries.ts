import type { QueryManager } from '../db/queries.js'
import type { MiniCodeGraphNode } from '../types.js'
import { GraphTraverser } from './traversal.js'
import { CodeAnalyzer } from '../analysis/index.js'
import { runQualifiedSearch, fuzzySearchFallback } from '../search/index.js'
import { safeJsonParse } from '../utils.js'
import { logError } from '../logger.js'
import type { InferredTarget, DispatchPattern } from '../resolution/dispatch-inference/types.js'
import { getDispatchTargetsForNode } from '../resolution/dispatch-inference/resolver.js'
import { readProjectConfig } from '../resolution/config-reader.js'
import { isNodeActiveUnderConfig } from '../resolution/condition-matcher.js'
import {
  getFeignClients, getMyBatisMappings, getGatewayRoutes, getMessageQueueBindings,
  getVueApiMappings, getSecurityAnnotations, getJpaEntities, getReactComponents,
  getReactStores, getReactQueries, getMongoEntities, getRedisHashes, getRedisTemplates,
  getSqlTables, getSqlStatements, getBatchJobs, getResiliencePolicies, getPiniaStores,
  getI18nMessages, getDeployContainers, getK8sResources, getOpenApiEndpoints,
  getConfigBindings, getTxAnnotations, getTxBoundaryConflicts, getCacheTopologies,
  getRoutingManifest, getLombokSynthetics, getGrpcServices, getMapStructMappers,
  getAutoConfigurations, getMavenModules, getMavenScopeConflicts, getGradleModules,
  getCloudConfigs, getLoadBalancerClients, getLoadBalancerUris, getGraphQLEndpoints,
  getWebSocketEndpoints, getTestAnnotations, getAsyncMethods, getAspectAdvices,
  getSecurityFilterRules, getK8sServiceDetails, getK8sIngressDetails, getK8sNetworkPolicies,
  getControllerAdvices, getInterceptors, getStreamFunctions, getJpaCustomQueries,
  getJpaProcedures, getProfileAnnotations,
} from './queries-summary.js'


export class GraphQueryManager {
  private queries: QueryManager
  private traverser: GraphTraverser
  private analyzer: CodeAnalyzer
  private projectRoot: string
  private pendingFiles: Set<string> = new Set()
  getQueryManager(): QueryManager {
    return this.queries
  }

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
    const node = this.queries.getNode(nodeId)
    if (!node) return internal

    // External callers from OTHER services calling INTO this node (e.g., ServiceA calling ServiceB's endpoint)
    // We match by: the external_symbol's name or id contains this node's name
    const externalSymbolName = node.name
    const external = this.queries.getExternalReferencesByTarget(externalSymbolName)
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

    // External references from THIS service's code consuming external symbols
    // (e.g., RestTemplate calls, Feign calls, RabbitMQ publishes)
    const externalConsumed = this.queries.getExternalReferencesBySource(externalSymbolName)
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

    return [...internal, ...external, ...externalConsumed]
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

  getFeignClients(limit?: number) {
    return getFeignClients(this.queries, limit)
  }

  getMyBatisMappings(limit?: number) {
    return getMyBatisMappings(this.queries, limit)
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

  getCyclomaticComplexity(node: MiniCodeGraphNode): import('../analysis/index.js').ComplexityResult | null {
    return this.analyzer.computeCyclomaticComplexity(node)
  }

  findCircularDeps(): import('../analysis/index.js').CircularDepResult[] {
    return this.analyzer.findCircularDeps()
  }

  findDeadImports(): import('../analysis/index.js').DeadImportResult[] {
    return this.analyzer.findDeadImports()
  }

  async findEntryPoints(): Promise<import('../analysis/index.js').EntryPointResult[]> {
    return this.analyzer.findEntryPoints()
  }

  getQueries(): QueryManager {
    return this.queries
  }

  markFilePending(filePath: string): void {
    this.pendingFiles.add(filePath)
  }

  markSyncComplete(): void {
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
      logError(`Warning: ${this.pendingFiles.size} files pending sync. Run 'mini-codegraph sync' to catch up.`)
    }
  }

  getGatewayRoutes(limit?: number) {
    return getGatewayRoutes(this.queries, limit)
  }

  getMessageQueueBindings(limit?: number) {
    return getMessageQueueBindings(this.queries, limit)
  }

  getVueApiMappings() {
    return getVueApiMappings(this.queries)
  }

  getSecurityAnnotations() {
    return getSecurityAnnotations(this.queries)
  }

  getJpaEntities(limit?: number) {
    return getJpaEntities(this.queries, limit)
  }

  getReactComponents(limit?: number) {
    return getReactComponents(this.queries, limit)
  }

  getReactStores(limit?: number) {
    return getReactStores(this.queries, limit)
  }

  getReactQueries(limit?: number) {
    return getReactQueries(this.queries, limit)
  }

  getMongoEntities(limit?: number) {
    return getMongoEntities(this.queries, limit)
  }

  getRedisHashes(limit?: number) {
    return getRedisHashes(this.queries, limit)
  }

  getRedisTemplates(limit?: number) {
    return getRedisTemplates(this.queries, limit)
  }

  getSqlTables(limit?: number) {
    return getSqlTables(this.queries, limit)
  }

  getSqlStatements(limit?: number) {
    return getSqlStatements(this.queries, limit)
  }

  getBatchJobs(limit?: number) {
    return getBatchJobs(this.queries, limit)
  }

  getResiliencePolicies() {
    return getResiliencePolicies(this.queries)
  }

  getPiniaStores(limit?: number) {
    return getPiniaStores(this.queries, limit)
  }

  getI18nMessages() {
    return getI18nMessages(this.queries)
  }

  getDeployContainers(limit?: number) {
    return getDeployContainers(this.queries, limit)
  }

  getK8sResources(limit?: number) {
    return getK8sResources(this.queries, limit)
  }

  getOpenApiEndpoints(limit?: number) {
    return getOpenApiEndpoints(this.queries, limit)
  }

  getAllEdgesByKind(kind: string): { sourceId: string; targetId: string; metadata: string }[] {
    return this.queries.getAllEdges().filter(e => e.kind === kind)
      .map(e => ({ sourceId: e.sourceId, targetId: e.targetId, metadata: e.metadata ?? '' }))
  }

  getFullTraces(): import('../types.js').FullTrace[] {
    const traces: import('../types.js').FullTrace[] = []
    const allEdges = this.queries.getAllEdges()
    const apiEdges = allEdges.filter(e => e.kind === 'api_mapping')
    for (const ae of apiEdges) {
      const hops: import('../types.js').FullTraceHop[] = []
      const meta = safeJsonParse(ae.metadata ?? '{}') as Record<string, unknown>
      hops.push({ kind: 'vue_api_call', id: ae.sourceId, name: ae.sourceId.split('/').pop() ?? '', detail: `API → ${String(meta.path ?? '')}` })
      const cn = this.queries.getNode(ae.targetId)
      if (cn) {
        hops.push({ kind: 'controller_endpoint', id: cn.id, name: cn.name, moduleId: cn.moduleId, filePath: cn.filePath, detail: `${String(meta.method ?? 'GET')} ${String(meta.path ?? '')}` })
        const svcEdges = allEdges.filter(e => e.sourceId === cn.id && e.kind === 'calls')
        for (const se of svcEdges) {
          const sn = this.queries.getNode(se.targetId)
          if (sn) hops.push({ kind: 'service_method', id: sn.id, name: sn.name, moduleId: sn.moduleId, filePath: sn.filePath, detail: `${cn.name} → ${sn.name}` })
        }
      }
      if (hops.length > 1) {
        traces.push({ id: `trace:${ae.sourceId}`, hops, entryPoint: ae.sourceId, endpointPath: String(meta.path ?? ''), httpMethod: String(meta.method ?? 'GET') })
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

  // Page fan-out: uses GraphTraverser to find all API calls from a page component
  getPageFanoutTraces(pageFile: string, projectRoot?: string): import('../types.js').PageFanoutTrace {
    const traverser = new GraphTraverser(this.queries)
    return traverser.fanoutTrace(pageFile, 3, projectRoot)
  }

  getPageFanoutByRoute(routePath: string): import('../types.js').PageFanoutTrace | undefined {
    // Try to match route paths to page components via entry_points
    const entryPoints = this.queries.getAllEdges().filter(e => e.kind === 'route_entry')
    for (const ep of entryPoints) {
      try {
        const meta = JSON.parse(ep.metadata ?? '{}')
        if (meta.path === routePath || (meta.path && routePath.includes(meta.path))) {
          return this.getPageFanoutTraces(ep.sourceId)
        }
      } catch { /* silent */ }
    }
    // Fallback: scan entry_points table
    try {
      const db = this.queries.getDb()
      const rows = db.prepare(`SELECT file_path, path FROM entry_points WHERE kind = 'page_entry'`).all() as { file_path: string; path: string }[]
      for (const row of rows) {
        if (row.path === routePath || (row.path && routePath.includes(row.path))) {
          return this.getPageFanoutTraces(row.file_path)
        }
      }
    } catch { /* silent */ }
    return undefined
  }

  getBacktrace(nodeId: string, maxDepth = 15, maxPaths = 10): import('../types.js').BacktraceResult {
    const traverser = new GraphTraverser(this.queries)
    return traverser.backtraceToEntry(nodeId, maxDepth, maxPaths)
  }

  getServiceTrace(service: string, includeExternal = true, maxEntryPoints = 50): import('../types.js').ServiceTraceResult {
    const qm = this.queries
    const allNodes = qm.getAllNodes()
    const allEdges = qm.getAllEdges()

    const serviceNodes = allNodes.filter(n => n.moduleId === service)
    const serviceFiles = qm.getFilesByModule ? qm.getFilesByModule(service) : []

    // 1) Module info
    const modules = qm.getAllModules()
    const mod = modules.find(m => m.id === service)

    // 2) Entry points from entry_points table
    const entryPoints: import('../types.js').ServiceTraceEntry[] = []
    try {
      const db = qm.getDb()
      const rows = db.prepare(`SELECT * FROM entry_points WHERE service = ?`).all(service) as { kind: string; http_method: string; path: string; method: string; queue_name: string; cron_expr: string; file_path: string; line: number; signature: string }[]
      let count = 0
      for (const row of rows) {
        if (count >= maxEntryPoints) break
        const internalTrace: import('../types.js').ServiceTraceHop[] = []

        // Build internal trace: find controller → service → mybatis
        if (row.kind === 'rest_endpoint' && row.http_method && row.path) {
          const controllerNodes = serviceNodes.filter(n =>
            n.kind === 'method' && n.name === row.method
          )
          for (const cn of controllerNodes) {
            internalTrace.push({ kind: 'controller_endpoint', name: cn.name, filePath: cn.filePath, detail: `${row.http_method} ${row.path}` })
            const calleeEdges = allEdges.filter(e => e.sourceId === cn.id && e.kind === 'calls')
            for (const ce of calleeEdges) {
              const sn = qm.getNode(ce.targetId)
              if (sn) {
                internalTrace.push({ kind: 'service_method', name: sn.name, filePath: sn.filePath, detail: `${cn.name} → ${sn.name}` })
                const subEdges = allEdges.filter(e => e.sourceId === sn.id && (e.kind === 'calls' || e.kind === 'mybatis_mapping'))
                for (const se of subEdges) {
                  const subN = qm.getNode(se.targetId)
                  if (subN) {
                    const hopKind = se.kind === 'mybatis_mapping' ? 'mybatis_mapper' as const : 'service_method' as const
                    internalTrace.push({ kind: hopKind, name: subN.name, filePath: subN.filePath, detail: `${sn.name} → ${subN.name}` })
                  }
                }
              }
            }
          }
        }

        entryPoints.push({
          kind: row.kind as import('../types.js').ServiceTraceEntry['kind'],
          httpMethod: row.http_method,
          path: row.path,
          queueName: row.queue_name,
          cronExpr: row.cron_expr,
          method: row.method,
          filePath: row.file_path,
          line: row.line,
          signature: row.signature,
          internalTrace,
        })
        count++
      }
    } catch { /* entry_points table may be empty */ }

    // 3) Cross-service calls
    const outgoingCalls: { targetService: string; kind: string; endpoint: string }[] = []
    const incomingCalls: { sourceService: string; kind: string; endpoint: string }[] = []
    const dependentServices = new Set<string>()

    if (includeExternal) {
      try {
        const db = qm.getDb()
        const extRefs = db.prepare(`SELECT * FROM external_references WHERE source_service = ?`).all(service) as { target_service: string; reference_type: string; source_location: string; source_service: string }[]
        for (const ref of extRefs) {
          outgoingCalls.push({ targetService: ref.target_service, kind: ref.reference_type, endpoint: ref.source_location })
          dependentServices.add(ref.target_service)
        }
        const inboundRefs = db.prepare(`SELECT * FROM external_references WHERE target_service = ?`).all(service) as { target_service: string; reference_type: string; source_location: string; source_service: string }[]
        for (const ref of inboundRefs) {
          incomingCalls.push({ sourceService: ref.source_service, kind: ref.reference_type, endpoint: ref.source_location })
        }
      } catch { /* external_references table may not exist */ }
    }

    // 4) Module-level dependency from architecture
    const traverser = new GraphTraverser(qm)
    try {
      const arch = traverser.findServiceDependencies(service)
      for (const dep of arch.dependencies) {
        dependentServices.add(dep)
      }
    } catch { /* silent */ }

    return {
      service,
      moduleInfo: mod ? { rootPath: mod.rootPath, buildSystem: mod.buildSystem, language: mod.language } : undefined,
      entryPoints,
      outgoingCalls,
      incomingCalls,
      dependentServices: [...dependentServices],
      stats: {
        totalEntryPoints: entryPoints.length,
        totalNodes: serviceNodes.length,
        totalFiles: serviceFiles.length,
      },
    }
  }

  getConfigBindings() {
    return getConfigBindings(this.queries)
  }

  getTxAnnotations() {
    return getTxAnnotations(this.queries)
  }

  getTxBoundaryConflicts() {
    return getTxBoundaryConflicts(this.queries)
  }

  getCacheTopologies() {
    return getCacheTopologies(this.queries)
  }

  getRoutingManifest(limit = 50) {
    return getRoutingManifest(this.queries, limit)
  }

  getLombokSynthetics(limit?: number) {
    return getLombokSynthetics(this.queries, limit)
  }

  getGrpcServices(limit?: number) {
    return getGrpcServices(this.queries, limit)
  }

  getMapStructMappers(limit?: number) {
    return getMapStructMappers(this.queries, limit)
  }

  getAutoConfigurations() {
    return getAutoConfigurations(this.queries)
  }

  getMavenModules(limit?: number) {
    return getMavenModules(this.queries, limit)
  }

  getMavenScopeConflicts(limit?: number) {
    return getMavenScopeConflicts(this.queries, limit)
  }

  getGradleModules(limit?: number) {
    return getGradleModules(this.queries, limit)
  }

  getCloudConfigs() {
    return getCloudConfigs(this.queries)
  }

  getLoadBalancerClients() {
    return getLoadBalancerClients(this.queries)
  }

  getLoadBalancerUris() {
    return getLoadBalancerUris(this.queries)
  }

  getGraphQLEndpoints() {
    return getGraphQLEndpoints(this.queries)
  }

  getWebSocketEndpoints() {
    return getWebSocketEndpoints(this.queries)
  }

  getTestAnnotations() {
    return getTestAnnotations(this.queries)
  }

  getAsyncMethods() {
    return getAsyncMethods(this.queries)
  }

  getAspectAdvices() {
    return getAspectAdvices(this.queries)
  }

  getSecurityFilterRules() {
    return getSecurityFilterRules(this.queries)
  }

  getK8sServiceDetails() {
    return getK8sServiceDetails(this.queries)
  }

  getK8sIngressDetails() {
    return getK8sIngressDetails(this.queries)
  }

  getK8sNetworkPolicies() {
    return getK8sNetworkPolicies(this.queries)
  }

  getControllerAdvices() {
    return getControllerAdvices(this.queries)
  }

  getInterceptors() {
    return getInterceptors(this.queries)
  }

  getStreamFunctions() {
    return getStreamFunctions(this.queries)
  }

  getJpaCustomQueries() {
    return getJpaCustomQueries(this.queries)
  }

  getJpaProcedures() {
    return getJpaProcedures(this.queries)
  }

  getProfileAnnotations() {
    return getProfileAnnotations(this.queries)
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




