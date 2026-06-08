import type { QueryManager } from '../db/queries.js'
import { safeJsonParse } from '../utils.js'
import type { MiniCodeGraphNode, MapStructMapperSummary, AutoConfigSummary, ConditionInfo, MavenModuleSummary, MavenScopeConflict, GradleModuleSummary, CloudConfigSummary, LoadBalancerClientSummary, LbUriSummary, GraphQLEndpointSummary, WebSocketEndpointSummary, TestAnnotationSummary, AsyncMethodSummary, ConfigPropertyBinding, TransactionalInfo, CacheTopology } from '../types.js'

// ── Local interfaces (moved from queries.ts) ──────────────────────────────

export interface AspectAdviceSummary {
  aspectClass: string
  filePath: string
  adviceType: string
  pointcut: string
}

export interface SecurityFilterRuleSummary {
  classFile: string
  urlPatterns: string[]
  method: string
  roles: string[]
  expression: string
}

export interface K8sServiceDetailSummary {
  serviceName: string
  type: string
  ports: { port: number; targetPort: number | string; protocol: string; name: string }[]
}

export interface K8sIngressDetailSummary {
  name: string
  host: string
  paths: { host: string; path: string; serviceName: string; servicePort: number | string }[]
  tlsHosts: string[]
}

export interface K8sNetPolSummary {
  name: string
  policyTypes: string[]
  ingressRuleCount: number
}

export interface ControllerAdviceSummary {
  className: string
  basePackages: string[]
  assignableTypes: string[]
  annotations: string[]
}

export interface InterceptorSummary {
  classFile: string
  className: string
  type: string
  urlPatterns: string[]
}

export interface StreamFunctionSummary {
  className: string
  beanMethod: string
  functionType: string
  inputType: string
  outputType: string
  bindingName: string
}

export interface JpaQuerySummary {
  repositoryClass: string
  methodName: string
  query: string
  nativeQuery: boolean
  modification: boolean
}

export interface JpaProcedureSummary {
  repositoryClass: string
  procedureName: string
  outputType: string
}

export interface ProfileSummary {
  className: string
  filePath: string
  profiles: string[]
}

// ── Summary functions ─────────────────────────────────────────────────────

export function getFeignClients(queries: QueryManager, limit?: number): {
  feignClient: MiniCodeGraphNode
  feignMethods: MiniCodeGraphNode[]
  annotations: { annotationName: string; value: string }[]
}[] {
  const results: {
    feignClient: MiniCodeGraphNode
    feignMethods: MiniCodeGraphNode[]
    annotations: { annotationName: string; value: string }[]
  }[] = []

  const feignAnnotated = queries.getNodesByAnnotation('FeignClient', limit)
  for (const node of feignAnnotated) {
    if (limit && results.length >= limit) break
    const children = queries.getChildren(node.id)
    const annotations = queries.getAnnotationsByNode(node.id)
    results.push({ feignClient: node, feignMethods: children, annotations })
  }

  if (!limit || results.length < limit) {
    const clientInterfaces = queries.getNodesByKind('interface')
      .filter(n => n.name.endsWith('Client'))

    for (const iface of clientInterfaces) {
      if (limit && results.length >= limit) break
      if (results.some(r => r.feignClient.id === iface.id)) continue
      const annotations = queries.getAnnotationsByNode(iface.id)
      if (annotations.some(a => a.annotationName === 'FeignClient') || annotations.length === 0) {
        const children = queries.getChildren(iface.id)
        results.push({ feignClient: iface, feignMethods: children, annotations })
      }
    }
  }

  return results
}

export function getMyBatisMappings(queries: QueryManager, limit?: number): {
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

  const mapperEdges = queries.getAllNodes()
  for (const node of mapperEdges) {
    if (limit && mappings.length >= limit) break
    if (node.kind === 'method') {
      const callees = queries.getCallees(node.id)
      for (const callee of callees) {
        if (limit && mappings.length >= limit) break
        if (callee.id.startsWith('mybatis:')) {
          try {
            mappings.push({
              javaInterface: node.parentId ? queries.getNode(node.parentId)?.name || '' : '',
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

export function getGatewayRoutes(queries: QueryManager, limit?: number): { id: string; uri: string; predicates: string[]; filters: string[] }[] {
  const routes: { id: string; uri: string; predicates: string[]; filters: string[] }[] = []
  for (const node of queries.getNodesByIdPrefix('gateway:', limit)) {
    const anns = queries.getAnnotationsByNode(node.id)
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

export function getMessageQueueBindings(queries: QueryManager, limit?: number): {
  type: string; queueName: string; exchange: string; routingKey: string; moduleId: string
}[] {
  const bindings: { type: string; queueName: string; exchange: string; routingKey: string; moduleId: string }[] = []
  for (const node of queries.getNodesByIdPrefix('mq:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      bindings.push({ ...meta, moduleId: node.moduleId ?? '' })
    } catch { /* silent */ }
  }
  return bindings
}

export function getVueApiMappings(queries: QueryManager): { vueFile: string; apiPath: string; controllerMethod: string; controllerFile: string }[] {
  const mappings: { vueFile: string; apiPath: string; controllerMethod: string; controllerFile: string }[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'api_mapping')
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

export function getSecurityAnnotations(queries: QueryManager): { filePath: string; annotation: string; value: string }[] {
  const results: { filePath: string; annotation: string; value: string }[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'secured_by')
  for (const e of edges) {
    try {
      const meta = safeJsonParse(e.metadata ?? '{}')
      results.push({ filePath: e.sourceId, annotation: meta.annotation ?? '', value: meta.value ?? '' })
    } catch { /* silent */ }
  }
  return results
}

export function getJpaEntities(queries: QueryManager, limit?: number): { className: string; tableName: string; columns: number; relationships: number }[] {
  const entities: { className: string; tableName: string; columns: number; relationships: number }[] = []
  for (const node of queries.getNodesByIdPrefix('jpa:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      entities.push({ className: node.name, tableName: meta.table ?? '', columns: meta.columns ?? 0, relationships: meta.relationships ?? 0 })
    } catch { /* silent */ }
  }
  return entities
}

export function getReactComponents(queries: QueryManager, limit?: number): { componentName: string; filePath: string; hooks: string[]; props: string[]; children: string[] }[] {
  const comps: { componentName: string; filePath: string; hooks: string[]; props: string[]; children: string[] }[] = []
  for (const node of queries.getNodesByIdPrefix('react:', limit)) {
    if (node.kind === 'component') {
      try {
        const meta = safeJsonParse(node.signature || '{}')
        comps.push({ componentName: node.name, filePath: node.filePath, hooks: meta.hooks ?? [], props: meta.props ?? [], children: meta.children ?? [] })
      } catch { /* silent */ }
    }
  }
  return comps
}

export function getReactStores(queries: QueryManager, limit?: number): { storeName: string; filePath: string; type: string; detail: string }[] {
  const stores: { storeName: string; filePath: string; type: string; detail: string }[] = []
  for (const node of queries.getNodesByIdPrefix('react:store:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      const type = meta.slices ? 'redux' : meta.stateFields ? 'zustand' : 'unknown'
      stores.push({ storeName: node.name, filePath: node.filePath, type, detail: JSON.stringify(meta) })
    } catch { /* silent */ }
  }
  return stores
}

export function getReactQueries(queries: QueryManager, limit?: number): { hookName: string; filePath: string; endpoint: string; method: string }[] {
  const querieList: { hookName: string; filePath: string; endpoint: string; method: string }[] = []
  for (const node of queries.getNodesByIdPrefix('react:query:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      querieList.push({ hookName: node.name, filePath: node.filePath, endpoint: meta.endpoint ?? '', method: meta.method ?? 'GET' })
    } catch { /* silent */ }
  }
  return querieList
}

export function getMongoEntities(queries: QueryManager, limit?: number): { className: string; filePath: string; collection: string; fields: number; repositories: boolean }[] {
  const entities: { className: string; filePath: string; collection: string; fields: number; repositories: boolean }[] = []
  for (const node of queries.getNodesByIdPrefix('mongo:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      entities.push({ className: node.name, filePath: node.filePath, collection: meta.collection ?? '', fields: meta.fields ?? 0, repositories: meta.repository ?? false })
    } catch { /* silent */ }
  }
  return entities
}

export function getRedisHashes(queries: QueryManager, limit?: number): { className: string; filePath: string; redisKey: string; fields: number; ttl?: string }[] {
  const hashes: { className: string; filePath: string; redisKey: string; fields: number; ttl?: string }[] = []
  for (const node of queries.getNodesByIdPrefix('redis:hash:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      hashes.push({ className: node.name, filePath: node.filePath, redisKey: meta.redisKey ?? '', fields: (meta.fields ?? []).length, ttl: meta.ttl })
    } catch { /* silent */ }
  }
  return hashes
}

export function getRedisTemplates(queries: QueryManager, limit?: number): { className: string; filePath: string; operations: string[]; keyPatterns: string[] }[] {
  const tpls: { className: string; filePath: string; operations: string[]; keyPatterns: string[] }[] = []
  for (const node of queries.getNodesByIdPrefix('redis:template:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      tpls.push({ className: node.name, filePath: node.filePath, operations: meta.operations ?? [], keyPatterns: meta.keyPatterns ?? [] })
    } catch { /* silent */ }
  }
  return tpls
}

export function getSqlTables(queries: QueryManager, limit?: number): { tableName: string; filePath: string; columns: number; engine?: string }[] {
  const tables: { tableName: string; filePath: string; columns: number; engine?: string }[] = []
  for (const node of queries.getNodesByIdPrefix('mysql:table:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      tables.push({ tableName: node.name, filePath: node.filePath, columns: meta.columns ?? 0, engine: meta.engine })
    } catch { /* silent */ }
  }
  return tables
}

export function getSqlStatements(queries: QueryManager, limit?: number): { methodName: string; filePath: string; className: string; sql: string; dbType: string }[] {
  const sqls: { methodName: string; filePath: string; className: string; sql: string; dbType: string }[] = []
  for (const node of queries.getNodesByIdPrefix('mysql:sql:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      sqls.push({ methodName: node.name, filePath: node.filePath, className: meta.className ?? '', sql: (meta.sql ?? '').slice(0, 200), dbType: meta.dbType ?? '' })
    } catch { /* silent */ }
  }
  return sqls
}

export function getBatchJobs(queries: QueryManager, limit?: number): { name: string; steps: string[]; chunkSize?: number }[] {
  const jobs: { name: string; steps: string[]; chunkSize?: number }[] = []
  for (const node of queries.getNodesByIdPrefix('batch:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      jobs.push({ name: node.name, steps: meta.steps ?? [], chunkSize: meta.chunkSize })
    } catch { /* silent */ }
  }
  return jobs
}

export function getResiliencePolicies(queries: QueryManager): { annotation: string; value: string; fallbackMethod: string; nodeId: string }[] {
  const policies: { annotation: string; value: string; fallbackMethod: string; nodeId: string }[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'resilience_policy')
  for (const e of edges) {
    try {
      const meta = safeJsonParse(e.metadata ?? '{}')
      policies.push({ annotation: meta.annotation ?? '', value: meta.value ?? '', fallbackMethod: meta.fallbackMethod ?? '', nodeId: e.sourceId })
    } catch { /* silent */ }
  }
  return policies
}

export function getPiniaStores(queries: QueryManager, limit?: number): { name: string; stateKeys: string[]; actions: string[]; getters: string[]; usedIn: string[] }[] {
  const stores: { name: string; stateKeys: string[]; actions: string[]; getters: string[]; usedIn: string[] }[] = []
  for (const node of queries.getNodesByIdPrefix('pinia:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      stores.push({ name: node.name, stateKeys: meta.stateKeys ?? [], actions: meta.actions ?? [], getters: meta.getters ?? [], usedIn: meta.usedIn ?? [] })
    } catch { /* silent */ }
  }
  return stores
}

export function getI18nMessages(queries: QueryManager): { locale: string; key: string; value: string; usedBy: string[] }[] {
  const msgs: { locale: string; key: string; value: string; usedBy: string[] }[] = []
  const i18nEdges = queries.getAllEdges().filter(e => e.kind === 'i18n_usage')
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

export function getDeployContainers(queries: QueryManager, limit?: number): { name: string; image: string; ports: string[]; dependsOn: string[] }[] {
  const containers: { name: string; image: string; ports: string[]; dependsOn: string[] }[] = []
  for (const node of queries.getNodesByIdPrefix('docker:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      containers.push({ name: node.name, image: meta.image ?? '', ports: meta.ports ?? [], dependsOn: meta.dependsOn ?? [] })
    } catch { /* silent */ }
  }
  return containers
}

export function getK8sResources(queries: QueryManager, limit?: number): { kind: string; name: string; image: string; replicas: number; ports: string[] }[] {
  const resources: { kind: string; name: string; image: string; replicas: number; ports: string[] }[] = []
  for (const node of queries.getNodesByIdPrefix('k8s:', limit)) {
    try {
      const meta = safeJsonParse(node.signature || '{}')
      resources.push({ kind: node.name.split(':')[0] ?? '', name: node.name, image: meta.image ?? '', replicas: meta.replicas ?? 1, ports: meta.ports ?? [] })
    } catch { /* silent */ }
  }
  return resources
}

export function getOpenApiEndpoints(queries: QueryManager, limit?: number): { path: string; method: string; operationId: string; serviceName?: string }[] {
  const endpoints: { path: string; method: string; operationId: string; serviceName?: string }[] = []
  for (const node of queries.getNodesByIdPrefix('openapi:', limit)) {
    const parts = node.id.replace('openapi:', '').split(':')
    endpoints.push({
      method: parts[0] ?? '', path: parts.slice(1).join(':'),
      operationId: node.name, serviceName: node.moduleId,
    })
  }
  return endpoints
}

export function getConfigBindings(queries: QueryManager): ConfigPropertyBinding[] {
  const bindings: ConfigPropertyBinding[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'config_binding')
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

export function getTxAnnotations(queries: QueryManager): TransactionalInfo[] {
  const list: TransactionalInfo[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'transactional')
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

export function getTxBoundaryConflicts(queries: QueryManager): { outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string }[] {
  const conflicts: { outerMethod: string; innerMethod: string; outerPropagation: string; innerPropagation: string; warning: string }[] = []
  const txEdges = queries.getAllEdges().filter(e => e.kind === 'tx_propagate')
  for (const e of txEdges) {
    try {
      const meta = safeJsonParse(e.metadata ?? '{}')
      const on = queries.getNode(e.sourceId)
      const inn = queries.getNode(e.targetId)
      if (on && inn && meta.innerPropagation === 'REQUIRES_NEW') {
        conflicts.push({ outerMethod: on.name, innerMethod: inn.name, outerPropagation: meta.callerPropagation ?? 'REQUIRED', innerPropagation: 'REQUIRES_NEW', warning: 'REQUIRES_NEW inside existing transaction: outer tx will be suspended' })
      }
    } catch { /* silent */ }
  }
  return conflicts
}

export function getCacheTopologies(queries: QueryManager): CacheTopology[] {
  const topologies: CacheTopology[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'cache_annotation')
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

export function getRoutingManifest(queries: QueryManager, limit = 50): { path: string; method: string; handler: string; filePath: string; line: number }[] {
  const manifest: { path: string; method: string; handler: string; filePath: string; line: number }[] = []
  const routeAnnotations = ['GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping', 'RequestMapping']

  for (const node of queries.getAllNodes()) {
    const annotations = queries.getAnnotationsByNode(node.id)
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

export function getLombokSynthetics(queries: QueryManager, limit?: number): { nodeId: string; annotation: string; field?: string }[] {
  const results: { nodeId: string; annotation: string; field?: string }[] = []
  const edges = queries.getAllEdges().filter(e => e.kind === 'lombok_synthetic')
  for (const e of edges) {
    if (limit !== undefined && results.length >= limit) break
    try {
      const meta = safeJsonParse(e.metadata ?? '{}')
      results.push({ nodeId: e.sourceId, annotation: meta.annotation ?? '', field: meta.field })
    } catch { /* silent */ }
  }
  return results
}

export function getGrpcServices(queries: QueryManager, limit?: number): { name: string; package: string; rpcMethods: string[]; filePath: string; stubClass?: string }[] {
  const services: { name: string; package: string; rpcMethods: string[]; filePath: string; stubClass?: string }[] = []
  const grpcEdges = queries.getAllEdges().filter(e => e.kind === 'grpc_stub')
  const stubMap = new Map<string, string>()
  for (const e of grpcEdges) {
    try {
      const meta = safeJsonParse(e.metadata ?? '{}')
      stubMap.set(e.sourceId, meta.stubClass ?? '')
    } catch { /* silent */ }
  }

  for (const node of queries.getNodesByIdPrefix('grpc:', limit)) {
    if (node.kind === 'interface') {
      const children = queries.getChildren(node.id)
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

export function getMapStructMappers(queries: QueryManager, limit?: number): MapStructMapperSummary[] {
  const mappers: MapStructMapperSummary[] = []
  for (const node of queries.getAllNodes()) {
    if (limit !== undefined && mappers.length >= limit) break
    if (node.kind === 'interface') {
      const anns = queries.getAnnotationsByNode(node.id)
      if (anns.some(a => a.annotationName === 'Mapper')) {
        const methods = queries.getChildren(node.id).filter(c => c.kind === 'method')
        const sourceEdges = queries.getAllEdges().filter(e => e.kind === 'mapstruct_source' && e.sourceId.startsWith(node.id.split(':')[0]))
        const targetEdges = queries.getAllEdges().filter(e => e.kind === 'mapstruct_target' && e.sourceId.startsWith(node.id.split(':')[0]))
        mappers.push({
          interfaceName: node.name,
          methods: methods.map(m => {
            const se = sourceEdges.find(e => e.targetId === node.id && safeJsonParse(e.metadata || '{}').method === m.name)
            const te = targetEdges.find(e => e.sourceId === node.id && safeJsonParse(e.metadata || '{}').method === m.name)
            const fieldMappings: { source: string; target: string }[] = []
            const mappingAnns = queries.getAnnotationsByNode(m.id)
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

export function getAutoConfigurations(queries: QueryManager): AutoConfigSummary[] {
  const configs: AutoConfigSummary[] = []
  for (const node of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(node.id)
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

    const afterEdges = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'auto_configure_after')
    const beforeEdges = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'auto_configure_before')

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

export function getMavenModules(queries: QueryManager, limit?: number): MavenModuleSummary[] {
  const modules: MavenModuleSummary[] = []
  for (const node of queries.getNodesByIdPrefix('pom:', limit)) {
    if (node.kind === 'module') {
      const depEdges = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'maven_depends_on')
      const submoduleEdges = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'maven_submodule')
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

export function getMavenScopeConflicts(queries: QueryManager, limit?: number): MavenScopeConflict[] {
  const depToScopes = new Map<string, { scopes: Set<string>; modules: Set<string> }>()
  for (const node of queries.getNodesByIdPrefix('pom:', limit)) {
    if (node.kind === 'module') {
      const deps = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'maven_depends_on')
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

export function getGradleModules(queries: QueryManager, limit?: number): GradleModuleSummary[] {
  const modules: GradleModuleSummary[] = []
  for (const node of queries.getNodesByIdPrefix('gradle:', limit)) {
    if (node.kind === 'module') {
      const depEdges = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'gradle_depends_on')
      const subEdges = queries.getAllEdges().filter(e => e.sourceId === node.id && e.kind === 'gradle_submodule')
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

export function getCloudConfigs(queries: QueryManager): CloudConfigSummary[] {
  const configs: CloudConfigSummary[] = []
  for (const node of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(node.id)
    const ccAnn = anns.find(a => a.annotationName === 'CloudConfigRef')
    if (!ccAnn) continue
    try {
      const parsed = safeJsonParse(ccAnn.value)
      configs.push({ className: node.name, filePath: node.filePath, refreshScope: parsed.refreshScope, configKey: parsed.configKey })
    } catch { /* silent */ }
  }
  return configs
}

export function getLoadBalancerClients(queries: QueryManager): LoadBalancerClientSummary[] {
  const clients: LoadBalancerClientSummary[] = []
  for (const node of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(node.id)
    const lbAnn = anns.find(a => a.annotationName === 'LoadBalancedClient')
    if (!lbAnn) continue
    try {
      const parsed = safeJsonParse(lbAnn.value)
      clients.push({ className: node.parentId ? (queries.getNode(node.parentId)?.name || '') : '', fieldName: parsed.fieldName, serviceName: parsed.serviceName })
    } catch { /* silent */ }
  }
  return clients
}

export function getLoadBalancerUris(queries: QueryManager): LbUriSummary[] {
  const results: LbUriSummary[] = []
  const allEdges = queries.getAllEdges()
  for (const e of allEdges) {
    if (e.kind === 'gateway_route') {
      try {
        const meta = safeJsonParse(e.metadata || '{}')
        if (meta.uri?.startsWith('lb://')) results.push({ uri: meta.uri, targetService: meta.uri.replace('lb://', '') })
      } catch { /* silent */ }
    }
  }
  const feignNodes = queries.getNodesByAnnotation('FeignClient')
  for (const fn of feignNodes) {
    const anns = queries.getAnnotationsByNode(fn.id)
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

export function getGraphQLEndpoints(queries: QueryManager): GraphQLEndpointSummary[] {
  const endpoints: GraphQLEndpointSummary[] = []
  const allEdges = queries.getAllEdges().filter(e => e.kind === 'graphql_handler')
  for (const e of allEdges) {
    try {
      const meta = safeJsonParse(e.metadata || '{}')
      const target = queries.getNode(e.targetId)
      endpoints.push({
        className: queries.getNode(e.sourceId)?.name || '',
        methodName: target?.name || '',
        field: meta.field || '',
        returnType: meta.returnType || '',
        kind: meta.kind || 'query',
      })
    } catch { /* silent */ }
  }
  return endpoints
}

export function getWebSocketEndpoints(queries: QueryManager): WebSocketEndpointSummary[] {
  const endpoints: WebSocketEndpointSummary[] = []
  const allEdges = queries.getAllEdges().filter(e => e.kind === 'websocket_handler')
  for (const e of allEdges) {
    try {
      const meta = safeJsonParse(e.metadata || '{}')
      const target = queries.getNode(e.targetId)
      endpoints.push({
        className: queries.getNode(e.sourceId)?.name || '',
        methodName: target?.name || '',
        destination: meta.destination || '',
        kind: meta.kind || 'message_mapping',
      })
    } catch { /* silent */ }
  }
  return endpoints
}

export function getTestAnnotations(queries: QueryManager): TestAnnotationSummary[] {
  const tests: TestAnnotationSummary[] = []
  const allEdges = queries.getAllEdges().filter(e => e.kind === 'mock_replaces')
  const mockMap = new Map<string, string[]>()
  for (const e of allEdges) {
    if (!mockMap.has(e.sourceId)) mockMap.set(e.sourceId, [])
    const target = queries.getNode(e.targetId)
    if (target) mockMap.get(e.sourceId)!.push(target.name)
  }

  for (const [nodeId, mocks] of mockMap) {
    const node = queries.getNode(nodeId)
    if (!node) continue
    const anns = queries.getAnnotationsByNode(nodeId)
    for (const a of anns) {
      if (['SpringBootTest', 'WebMvcTest', 'DataJpaTest'].includes(a.annotationName)) {
        tests.push({ className: node.name, filePath: node.filePath, annotation: a.annotationName, mockBeans: mocks })
      }
    }
  }
  return tests
}

export function getAsyncMethods(queries: QueryManager): AsyncMethodSummary[] {
  const methods: AsyncMethodSummary[] = []
  const allEdges = queries.getAllEdges().filter(e => e.kind === 'async_method' || e.kind === 'scheduled_method')
  for (const e of allEdges) {
    try {
      const meta = safeJsonParse(e.metadata || '{}')
      const target = queries.getNode(e.targetId)
      methods.push({
        className: queries.getNode(e.sourceId)?.name || '',
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

export function getAspectAdvices(queries: QueryManager): AspectAdviceSummary[] {
  const advices: AspectAdviceSummary[] = []
  for (const e of queries.getAllEdges()) {
    if (!e.kind.startsWith('aspect_')) continue
    const source = queries.getNode(e.sourceId)
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

export function getSecurityFilterRules(queries: QueryManager): SecurityFilterRuleSummary[] {
  const rules: SecurityFilterRuleSummary[] = []
  for (const e of queries.getAllEdges()) {
    if (!e.kind.startsWith('security_filter_')) continue
    const source = queries.getNode(e.sourceId)
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

export function getK8sServiceDetails(queries: QueryManager): K8sServiceDetailSummary[] {
  return queries.getAllNodes()
    .filter(n => {
      const anns = queries.getAnnotationsByNode(n.id)
      return anns.some(a => a.annotationName === 'K8sService')
    })
    .map(n => {
      const ann = queries.getAnnotationsByNode(n.id).find(a => a.annotationName === 'K8sService')
      const parsed = ann ? safeJsonParse(ann.value) : {}
      return { serviceName: n.name.replace('k8s:Service:', ''), type: parsed.type || 'ClusterIP', ports: parsed.ports || [] }
    })
}

export function getK8sIngressDetails(queries: QueryManager): K8sIngressDetailSummary[] {
  const ingresses: K8sIngressDetailSummary[] = []
  for (const n of queries.getAllNodes()) {
    if (!n.id.startsWith('k8s:Ingress:')) continue
    const anns = queries.getAnnotationsByNode(n.id)
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

export function getK8sNetworkPolicies(queries: QueryManager): K8sNetPolSummary[] {
  const policies: K8sNetPolSummary[] = []
  for (const n of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(n.id)
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

export function getControllerAdvices(queries: QueryManager): ControllerAdviceSummary[] {
  const advices: ControllerAdviceSummary[] = []
  for (const n of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(n.id)
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

export function getInterceptors(queries: QueryManager): InterceptorSummary[] {
  const interceptors: InterceptorSummary[] = []
  for (const n of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(n.id)
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

export function getStreamFunctions(queries: QueryManager): StreamFunctionSummary[] {
  const funcs: StreamFunctionSummary[] = []
  for (const e of queries.getAllEdges()) {
    if (e.kind !== 'stream_function') continue
    const target = queries.getNode(e.targetId)
    try {
      const meta = safeJsonParse(e.metadata || '{}')
      funcs.push({
        className: queries.getNode(e.sourceId)?.name || '',
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

export function getJpaCustomQueries(queries: QueryManager): JpaQuerySummary[] {
  const queriesList: JpaQuerySummary[] = []
  for (const e of queries.getAllEdges()) {
    if (e.kind !== 'jpa_query') continue
    const target = queries.getNode(e.targetId)
    try {
      const meta = safeJsonParse(e.metadata || '{}')
      queriesList.push({
        repositoryClass: queries.getNode(e.sourceId)?.name || '',
        methodName: target?.name || '',
        query: meta.query || '',
        nativeQuery: meta.native || false,
        modification: meta.modification || false,
      })
    } catch { /* silent */ }
  }
  return queriesList
}

export function getJpaProcedures(queries: QueryManager): JpaProcedureSummary[] {
  const procs: JpaProcedureSummary[] = []
  for (const n of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(n.id)
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

export function getProfileAnnotations(queries: QueryManager): ProfileSummary[] {
  const profiles: ProfileSummary[] = []
  for (const n of queries.getAllNodes()) {
    const anns = queries.getAnnotationsByNode(n.id)
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
