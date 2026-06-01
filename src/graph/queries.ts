import type { QueryManager } from '../db/queries.js'
import type { CodeGraphNode } from '../types.js'
import { GraphTraverser } from './traversal.js'
import { CodeAnalyzer } from '../analysis/index.js'

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

  search(query: string, limit = 20): { node: CodeGraphNode; snippets: string[]; score: number }[] {
    return this.queries.searchNodesWithRank(query, limit)
      .map(r => ({ node: r.node, snippets: [r.node.signature, r.node.docstring].filter(Boolean), score: r.rank }))
  }

  getNode(id: string): CodeGraphNode | undefined {
    return this.queries.getNode(id)
  }

  getCallers(nodeId: string): CodeGraphNode[] {
    return this.queries.getCallers(nodeId)
  }

  getCallees(nodeId: string): CodeGraphNode[] {
    return this.queries.getCallees(nodeId)
  }

  getContext(nodeId: string): {
    node: CodeGraphNode | undefined
    parent: CodeGraphNode | undefined
    children: CodeGraphNode[]
    callers: CodeGraphNode[]
    callees: CodeGraphNode[]
    implementations: CodeGraphNode[]
    annotations: { annotationName: string; value: string }[]
    crossServiceCallees: { node: CodeGraphNode; detail: string }[]
  } {
    const node = this.queries.getNode(nodeId)
    if (!node) return { node: undefined, parent: undefined, children: [], callers: [], callees: [], implementations: [], annotations: [], crossServiceCallees: [] }

    const parent = node.parentId ? this.queries.getNode(node.parentId) : undefined
    const children = this.queries.getChildren(nodeId)
    const callers = this.queries.getCallers(nodeId)
    const callees = this.queries.getCallees(nodeId)
    const annotations = this.queries.getAnnotationsByNode(nodeId)

    let implementations: CodeGraphNode[] = []
    if (['interface', 'type_alias'].includes(node.kind)) {
      implementations = this.traverser.findImplementations(node)
    }

    let crossServiceCallees: { node: CodeGraphNode; detail: string }[] = []
    if (node.kind === 'method' || node.kind === 'class') {
      crossServiceCallees = this.traverser.findCrossServiceCallees(node)
    }

    return { node, parent, children, callers, callees, implementations, annotations, crossServiceCallees }
  }

  getImpact(nodeId: string, depth = 2): CodeGraphNode[] {
    return Array.from(this.traverser.findImpactedNodes(nodeId, depth).values())
  }

  findRelated(nodeIds: string[]): Map<string, { node: CodeGraphNode; relationships: string[] }> {
    return this.traverser.findRelated(nodeIds)
  }

  findDeadCode(): CodeGraphNode[] {
    return this.traverser.findDeadCode()
  }

  findAffectedTestFiles(sourceFiles: string[]): { testFile: string; matchedSymbols: string[]; confidence: number }[] {
    return this.traverser.findAffectedTestFiles(sourceFiles)
  }

  findPath(fromId: string, toId: string, maxDepth = 12): import('./traversal.js').PathHop[][] {
    return this.traverser.findPath(fromId, toId, maxDepth)
  }

  findMicroserviceArchitecture(): {
    modules: string[]
    dependencies: { from: string; to: string }[]
    entryPoints: { module: string; endpoints: string[] }[]
  } {
    return this.traverser.findMicroserviceArchitecture()
  }

  getFeignClients(): {
    feignClient: CodeGraphNode
    feignMethods: CodeGraphNode[]
    annotations: { annotationName: string; value: string }[]
  }[] {
    const results: {
      feignClient: CodeGraphNode
      feignMethods: CodeGraphNode[]
      annotations: { annotationName: string; value: string }[]
    }[] = []

    const feignAnnotated = this.queries.getNodesByAnnotation('FeignClient')
    for (const node of feignAnnotated) {
      const children = this.queries.getChildren(node.id)
      const annotations = this.queries.getAnnotationsByNode(node.id)
      results.push({ feignClient: node, feignMethods: children, annotations })
    }

    const clientInterfaces = this.queries.getNodesByKind('interface')
      .filter(n => n.name.endsWith('Client'))

    for (const iface of clientInterfaces) {
      if (results.some(r => r.feignClient.id === iface.id)) continue
      const annotations = this.queries.getAnnotationsByNode(iface.id)
      if (annotations.some(a => a.annotationName === 'FeignClient') || annotations.length === 0) {
        const children = this.queries.getChildren(iface.id)
        results.push({ feignClient: iface, feignMethods: children, annotations })
      }
    }

    return results
  }

  getMyBatisMappings(): {
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
      if (node.kind === 'method') {
        const callees = this.queries.getCallees(node.id)
        for (const callee of callees) {
          if (callee.id.startsWith('mybatis:')) {
            try {
              const meta = JSON.parse(callee.signature || '{}')
              mappings.push({
                javaInterface: node.parentId ? this.queries.getNode(node.parentId)?.name || '' : '',
                methodName: node.name,
                xmlPath: callee.filePath,
                sqlId: callee.name,
              })
            } catch {}
          }
        }
      }
    }

    return mappings
  }

  getFileListing(pattern?: string): { path: string; language: string; nodeCount: number; moduleId?: string }[] {
    const files = this.queries.getAllFiles()
    let result = files.map(f => ({ path: f.path, language: f.language, nodeCount: f.nodeCount }))

    if (pattern) {
      const globPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
      const regex = new RegExp(globPattern, 'i')
      result = result.filter(f => regex.test(f.path))
    }

    return result
  }

  getStats(): { files: number; nodes: number; edges: number; modules: number } {
    return this.queries.getStats()
  }

  searchModule(query: string, moduleId: string, limit = 20): { node: CodeGraphNode; snippets: string[]; score: number }[] {
    return this.queries.searchNodesByModule(query, moduleId, limit)
      .map(n => ({ node: n, snippets: [n.signature, n.docstring].filter(Boolean), score: 0 }))
  }

  getCyclomaticComplexity(node: CodeGraphNode): any {
    return this.analyzer.computeCyclomaticComplexity(node)
  }

  findCircularDeps(): any[] {
    return this.analyzer.findCircularDeps()
  }

  findDeadImports(): any[] {
    return this.analyzer.findDeadImports()
  }

  findEntryPoints(): any[] {
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

  getStalenessWarning(): string | null {
    if (this.pendingFiles.size > 0) {
      return `${this.pendingFiles.size} files pending sync. Run sync to catch up.`
    }
    return null
  }

  checkStaleFiles(): void {
    if (this.pendingFiles.size > 0) {
      console.error(`Warning: ${this.pendingFiles.size} files pending sync. Run 'mini-cg sync' to catch up.`)
    }
  }

  getGatewayRoutes(): { id: string; uri: string; predicates: string[]; filters: string[] }[] {
    const routes: { id: string; uri: string; predicates: string[]; filters: string[] }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('gateway:')) {
        const anns = this.queries.getAnnotationsByNode(node.id)
        const meta: any = {}
        for (const a of anns) meta[a.annotationName] = a.value
        routes.push({
          id: node.name, uri: meta.uri ?? '',
          predicates: meta.predicates ? JSON.parse(meta.predicates) : [],
          filters: meta.filters ? JSON.parse(meta.filters) : [],
        })
      }
    }
    return routes
  }

  getMessageQueueBindings(): {
    type: string; queueName: string; exchange: string; routingKey: string; moduleId: string
  }[] {
    const bindings: { type: string; queueName: string; exchange: string; routingKey: string; moduleId: string }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('mq:')) {
        try {
          const meta = JSON.parse(node.signature || '{}')
          bindings.push({ ...meta, moduleId: node.moduleId ?? '' })
        } catch {}
      }
    }
    return bindings
  }

  getVueApiMappings(): { vueFile: string; apiPath: string; controllerMethod: string; controllerFile: string }[] {
    const mappings: { vueFile: string; apiPath: string; controllerMethod: string; controllerFile: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'api_mapping')
    for (const e of edges) {
      try {
        const meta = JSON.parse(e.metadata ?? '{}')
        mappings.push({
          vueFile: e.sourceId, apiPath: meta.path ?? '',
          controllerMethod: e.targetId, controllerFile: meta.controllerFile ?? '',
        })
      } catch {}
    }
    return mappings
  }

  getSecurityAnnotations(): { filePath: string; annotation: string; value: string }[] {
    const results: { filePath: string; annotation: string; value: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'secured_by')
    for (const e of edges) {
      try {
        const meta = JSON.parse(e.metadata ?? '{}')
        results.push({ filePath: e.sourceId, annotation: meta.annotation ?? '', value: meta.value ?? '' })
      } catch {}
    }
    return results
  }

  getJpaEntities(): { className: string; tableName: string; columns: number; relationships: number }[] {
    const entities: { className: string; tableName: string; columns: number; relationships: number }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('jpa:')) {
        try {
          const meta = JSON.parse(node.signature || '{}')
          entities.push({ className: node.name, tableName: meta.table ?? '', columns: meta.columns ?? 0, relationships: meta.relationships ?? 0 })
        } catch {}
      }
    }
    return entities
  }

  getBatchJobs(): { name: string; steps: string[]; chunkSize?: number }[] {
    const jobs: { name: string; steps: string[]; chunkSize?: number }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('batch:')) {
        try {
          const meta = JSON.parse(node.signature || '{}')
          jobs.push({ name: node.name, steps: meta.steps ?? [], chunkSize: meta.chunkSize })
        } catch {}
      }
    }
    return jobs
  }

  getResiliencePolicies(): { annotation: string; value: string; fallbackMethod: string; nodeId: string }[] {
    const policies: { annotation: string; value: string; fallbackMethod: string; nodeId: string }[] = []
    const edges = this.queries.getAllEdges().filter(e => e.kind === 'resilience_policy')
    for (const e of edges) {
      try {
        const meta = JSON.parse(e.metadata ?? '{}')
        policies.push({ annotation: meta.annotation ?? '', value: meta.value ?? '', fallbackMethod: meta.fallbackMethod ?? '', nodeId: e.sourceId })
      } catch {}
    }
    return policies
  }

  getPiniaStores(): { name: string; stateKeys: string[]; actions: string[]; getters: string[]; usedIn: string[] }[] {
    const stores: { name: string; stateKeys: string[]; actions: string[]; getters: string[]; usedIn: string[] }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('pinia:')) {
        try {
          const meta = JSON.parse(node.signature || '{}')
          stores.push({ name: node.name, stateKeys: meta.stateKeys ?? [], actions: meta.actions ?? [], getters: meta.getters ?? [], usedIn: meta.usedIn ?? [] })
        } catch {}
      }
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

  getDeployContainers(): { name: string; image: string; ports: string[]; dependsOn: string[] }[] {
    const containers: { name: string; image: string; ports: string[]; dependsOn: string[] }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('docker:')) {
        try {
          const meta = JSON.parse(node.signature || '{}')
          containers.push({ name: node.name, image: meta.image ?? '', ports: meta.ports ?? [], dependsOn: meta.dependsOn ?? [] })
        } catch {}
      }
    }
    return containers
  }

  getK8sResources(): { kind: string; name: string; image: string; replicas: number; ports: string[] }[] {
    const resources: { kind: string; name: string; image: string; replicas: number; ports: string[] }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('k8s:')) {
        try {
          const meta = JSON.parse(node.signature || '{}')
          resources.push({ kind: node.name.split(':')[0] ?? '', name: node.name, image: meta.image ?? '', replicas: meta.replicas ?? 1, ports: meta.ports ?? [] })
        } catch {}
      }
    }
    return resources
  }

  getOpenApiEndpoints(): { path: string; method: string; operationId: string; serviceName?: string }[] {
    const endpoints: { path: string; method: string; operationId: string; serviceName?: string }[] = []
    for (const node of this.queries.getAllNodes()) {
      if (node.id.startsWith('openapi:')) {
        const parts = node.id.replace('openapi:', '').split(':')
        endpoints.push({
          method: parts[0] ?? '', path: parts.slice(1).join(':'),
          operationId: node.name, serviceName: node.moduleId,
        })
      }
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
}
