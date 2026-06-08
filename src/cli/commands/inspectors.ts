import { resolve } from 'node:path'
import { MiniCodeGraph } from '../../index.js'
import { logInfo, logError } from '../../logger.js'

function openGraph(path: string) {
  const resolvedPath = resolve(path)
  const cg = MiniCodeGraph.open(resolvedPath)
  if (!cg) { logError('No index found.'); process.exit(1) }
  return cg
}

export function handleFeign(path: string): void {
  const cg = openGraph(path)
  try {
    const feignClients = cg.getGraph().getFeignClients()
    logInfo(JSON.stringify({ feignClients, count: feignClients.length }, null, 2))
  } catch {
    logInfo(JSON.stringify({ feignClients: [], count: 0 }))
  }
  cg.close()
}

export function handleMybatis(path: string): void {
  const cg = openGraph(path)
  try {
    const bindings = cg.getGraph().getMyBatisMappings()
    logInfo(JSON.stringify({ mybatisBindings: bindings, count: bindings.length }, null, 2))
  } catch {
    logInfo(JSON.stringify({ mybatisBindings: [], count: 0 }))
  }
  cg.close()
}

export function handleGateway(path: string): void {
  const cg = openGraph(path)
  const routes = cg.getGraph().getGatewayRoutes()
  logInfo(JSON.stringify({ gatewayRoutes: routes, count: routes.length }, null, 2))
  cg.close()
}

export function handleMq(path: string): void {
  const cg = openGraph(path)
  const bindings = cg.getGraph().getMessageQueueBindings()
  logInfo(JSON.stringify({ messageQueueBindings: bindings, count: bindings.length }, null, 2))
  cg.close()
}

export function handleApiMap(path: string): void {
  const cg = openGraph(path)
  const mappings = cg.getGraph().getVueApiMappings()
  logInfo(JSON.stringify({ apiMappings: mappings, count: mappings.length }, null, 2))
  cg.close()
}

export function handleSecurity(path: string): void {
  const cg = openGraph(path)
  const annotations = cg.getGraph().getSecurityAnnotations()
  logInfo(JSON.stringify({ securityAnnotations: annotations, count: annotations.length }, null, 2))
  cg.close()
}

export function handleJpa(path: string): void {
  const cg = openGraph(path)
  const entities = cg.getGraph().getJpaEntities()
  logInfo(JSON.stringify({ jpaEntities: entities, count: entities.length }, null, 2))
  cg.close()
}

export function handleBatch(path: string): void {
  const cg = openGraph(path)
  const jobs = cg.getGraph().getBatchJobs()
  logInfo(JSON.stringify({ batchJobs: jobs, count: jobs.length }, null, 2))
  cg.close()
}

export function handleResilience(path: string): void {
  const cg = openGraph(path)
  const policies = cg.getGraph().getResiliencePolicies()
  logInfo(JSON.stringify({ resiliencePolicies: policies, count: policies.length }, null, 2))
  cg.close()
}

export function handlePinia(path: string): void {
  const cg = openGraph(path)
  const stores = cg.getGraph().getPiniaStores()
  logInfo(JSON.stringify({ piniaStores: stores, count: stores.length }, null, 2))
  cg.close()
}

export function handleI18n(path: string): void {
  const cg = openGraph(path)
  const messages = cg.getGraph().getI18nMessages()
  logInfo(JSON.stringify({ i18nMessages: messages, count: messages.length }, null, 2))
  cg.close()
}

export function handleDocker(path: string): void {
  const cg = openGraph(path)
  const containers = cg.getGraph().getDeployContainers()
  logInfo(JSON.stringify({ dockerContainers: containers, count: containers.length }, null, 2))
  cg.close()
}

export function handleK8s(path: string): void {
  const cg = openGraph(path)
  const resources = cg.getGraph().getK8sResources()
  logInfo(JSON.stringify({ k8sResources: resources, count: resources.length }, null, 2))
  cg.close()
}

export function handleOpenapi(path: string): void {
  const cg = openGraph(path)
  const endpoints = cg.getGraph().getOpenApiEndpoints()
  logInfo(JSON.stringify({ openApiEndpoints: endpoints, count: endpoints.length }, null, 2))
  cg.close()
}

export async function handleDiagram(path: string, options: { type: string }): Promise<void> {
  const cg = openGraph(path)

  const { generateArchitectureDiagram, generateServiceDependencyDiagram, generateSequenceDiagram, generateFullTraceDiagram, generateCacheTopologyDiagram, generateTxPropagationDiagram, getAllMermaidDiagrams } = await import('../../mermaid.js')
  const queries = cg.getGraph().getQueries()

  switch (options.type) {
    case 'architecture':
      logInfo(generateArchitectureDiagram(queries))
      break
    case 'dependencies':
      logInfo(generateServiceDependencyDiagram(queries))
      break
    case 'sequence':
      logInfo(generateSequenceDiagram(queries, ''))
      break
    case 'trace':
      logInfo(generateFullTraceDiagram(queries))
      break
    case 'cache':
      logInfo(generateCacheTopologyDiagram(queries))
      break
    case 'tx':
      logInfo(generateTxPropagationDiagram(queries))
      break
    default: {
      const diagrams = getAllMermaidDiagrams(queries)
      logInfo('--- Architecture ---')
      logInfo(diagrams.architecture)
      logInfo('\n--- Dependencies ---')
      logInfo(diagrams.dependencies)
      logInfo('\n--- Sequence ---')
      logInfo(diagrams.sequence)
    }
  }
  cg.close()
}

export function handleTrace(path: string, options: { path?: string; service?: string }): void {
  const cg = openGraph(path)
  const graph = cg.getGraph()
  let traces = graph.getFullTraces()
  if (options.path) traces = [graph.getFullTraceByEndpoint(options.path)].filter(Boolean) as any
  if (options.service) traces = graph.getFullTracesByService(options.service)
  logInfo(JSON.stringify({ traces: traces.slice(0, 20), count: Math.min(traces.length, 20) }, null, 2))
  cg.close()
}

export function handleConfig(path: string, options: { prefix?: string }): void {
  const cg = openGraph(path)
  const bindings = cg.getGraph().getConfigBindings()
  const filtered = options.prefix ? bindings.filter(b => b.prefix.startsWith(options.prefix!)) : bindings
  logInfo(JSON.stringify({ configBindings: filtered, count: filtered.length }, null, 2))
  cg.close()
}

export function handleTx(path: string, options: { conflicts?: boolean }): void {
  const cg = openGraph(path)
  const graph = cg.getGraph()
  if (options.conflicts) {
    const conflicts = graph.getTxBoundaryConflicts()
    logInfo(JSON.stringify({ txConflicts: conflicts, count: conflicts.length }, null, 2))
  } else {
    const txs = graph.getTxAnnotations()
    logInfo(JSON.stringify({ txAnnotations: txs, count: txs.length }, null, 2))
  }
  cg.close()
}

export function handleCache(path: string): void {
  const cg = openGraph(path)
  const topologies = cg.getGraph().getCacheTopologies()
  logInfo(JSON.stringify({ cacheTopologies: topologies, count: topologies.length }, null, 2))
  cg.close()
}

export function handleLombok(path: string, options: { class?: string }): void {
  const cg = openGraph(path)
  let synthetics = cg.getGraph().getLombokSynthetics()
  if (options.class) synthetics = synthetics.filter(s => s.nodeId.includes(options.class!))
  logInfo(JSON.stringify({ lombokSynthetics: synthetics, count: synthetics.length }, null, 2))
  cg.close()
}

export function handleGrpc(path: string): void {
  const cg = openGraph(path)
  const services = cg.getGraph().getGrpcServices()
  logInfo(JSON.stringify({ grpcServices: services, count: services.length }, null, 2))
  cg.close()
}

export function handleMapstruct(path: string): void {
  const cg = openGraph(path)
  const mappers = cg.getGraph().getMapStructMappers()
  logInfo(JSON.stringify({ mapstructMappers: mappers, count: mappers.length }, null, 2))
  cg.close()
}

export function handleAutoconfig(path: string): void {
  const cg = openGraph(path)
  const configs = cg.getGraph().getAutoConfigurations()
  logInfo(JSON.stringify({ autoConfigurations: configs, count: configs.length }, null, 2))
  cg.close()
}

export function handleMaven(path: string): void {
  const cg = openGraph(path)
  const modules = cg.getGraph().getMavenModules()
  const conflicts = cg.getGraph().getMavenScopeConflicts()
  logInfo(JSON.stringify({ mavenModules: modules, scopeConflicts: conflicts }, null, 2))
  cg.close()
}

export function handleGradle(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ gradleModules: cg.getGraph().getGradleModules() }, null, 2))
  cg.close()
}

export function handleCloudConfig(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ cloudConfigs: cg.getGraph().getCloudConfigs() }, null, 2))
  cg.close()
}

export function handleLoadbalancer(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ lbClients: cg.getGraph().getLoadBalancerClients(), lbUris: cg.getGraph().getLoadBalancerUris() }, null, 2))
  cg.close()
}

export function handleGraphql(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ graphqlEndpoints: cg.getGraph().getGraphQLEndpoints() }, null, 2))
  cg.close()
}

export function handleWebsocket(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ websocketEndpoints: cg.getGraph().getWebSocketEndpoints() }, null, 2))
  cg.close()
}

export function handleTest(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ testAnnotations: cg.getGraph().getTestAnnotations() }, null, 2))
  cg.close()
}

export function handleAsync(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ asyncMethods: cg.getGraph().getAsyncMethods() }, null, 2))
  cg.close()
}

export function handleAop(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ aspects: cg.getGraph().getAspectAdvices() }, null, 2))
  cg.close()
}

export function handleSecurityFilter(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ securityFilters: cg.getGraph().getSecurityFilterRules() }, null, 2))
  cg.close()
}

export function handleK8sNet(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({
    services: cg.getGraph().getK8sServiceDetails(),
    ingresses: cg.getGraph().getK8sIngressDetails(),
    networkPolicies: cg.getGraph().getK8sNetworkPolicies(),
  }, null, 2))
  cg.close()
}

export function handleAdvice(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ controllerAdvices: cg.getGraph().getControllerAdvices() }, null, 2))
  cg.close()
}

export function handleInterceptor(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ interceptors: cg.getGraph().getInterceptors() }, null, 2))
  cg.close()
}

export function handleStreamFunc(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ streamFunctions: cg.getGraph().getStreamFunctions() }, null, 2))
  cg.close()
}

export function handleJpaQuery(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ jpaQueries: cg.getGraph().getJpaCustomQueries(), procedures: cg.getGraph().getJpaProcedures() }, null, 2))
  cg.close()
}

export function handleProfile(path: string): void {
  const cg = openGraph(path)
  logInfo(JSON.stringify({ profiles: cg.getGraph().getProfileAnnotations() }, null, 2))
  cg.close()
}

export function handleReact(path: string, options: { detail?: boolean; limit?: number }): void {
  const cg = openGraph(path)
  const graph = cg.getGraph()
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
  const components = graph.getReactComponents(limit)
  const stores = graph.getReactStores(limit)
  const queries = graph.getReactQueries(limit)
  const result: any = {
    components: options.detail ? components : components.map((c: any) => ({ componentName: c.componentName, filePath: c.filePath, hookCount: c.hooks.length })),
    stores,
    queries,
    total: components.length, truncated: components.length >= limit,
  }
  logInfo(JSON.stringify(result, null, 2))
  cg.close()
}

export function handleMongo(path: string, options: { limit?: number }): void {
  const cg = openGraph(path)
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
  const all = cg.getGraph().getMongoEntities(limit)
  logInfo(JSON.stringify({ mongoEntities: all, total: all.length, truncated: all.length >= limit }, null, 2))
  cg.close()
}

export function handleRedis(path: string, options: { limit?: number }): void {
  const cg = openGraph(path)
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
  const hashes = cg.getGraph().getRedisHashes(limit)
  const templates = cg.getGraph().getRedisTemplates(limit)
  logInfo(JSON.stringify({
    redisHashes: hashes, redisHashesTotal: hashes.length,
    redisTemplates: templates, redisTemplatesTotal: templates.length,
    truncated: hashes.length >= limit || templates.length >= limit,
  }, null, 2))
  cg.close()
}

export function handleSql(path: string, options: { limit?: number }): void {
  const cg = openGraph(path)
  const limit = Math.min(Math.max(1, options.limit ?? 50), 500)
  const tables = cg.getGraph().getSqlTables(limit)
  const stmts = cg.getGraph().getSqlStatements(limit)
  logInfo(JSON.stringify({
    tables: tables.slice(0, limit), tablesTotal: tables.length,
    sqlStatements: stmts.slice(0, limit), sqlStatementsTotal: stmts.length,
    truncated: tables.length > limit || stmts.length > limit,
  }, null, 2))
  cg.close()
}
