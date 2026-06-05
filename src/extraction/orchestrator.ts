import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs'
import { relative, join, extname, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import type Parser from 'web-tree-sitter'
import type { DatabaseConnection } from '../db/connection.js'
import type { QueryManager } from '../db/queries.js'
import { GrammarLoader } from './grammar-loader.js'
import { parseJavaFile } from './languages/java.js'
import { parseTypeScriptFile } from './languages/typescript.js'
import { parsePythonFile } from './languages/python.js'
import { parseVueFile } from './languages/vue.js'
import { parseKotlinFile } from './languages/kotlin.js'
import { scanDirectory, findFiles, computeContentHash, languageForFile, validatePathWithinRoot } from '../utils.js'
import type { MiniCodeGraphNode, MiniCodeGraphEdge, FileRecord, ExtractionResult, ModuleInfo, MessageQueueBinding } from '../types.js'
import type { WorkerResponse } from './worker-types.js'
import { runResolutionPipeline, extractFileAnnotations, parseAndStoreVueTemplates } from '../resolution/index.js'
import { indexMyBatisMappers, findMyBatisMapperDir } from './mybatis-extractor.js'
import { detectSpring } from '../resolution/frameworks/java.js'
import { indexOpenApiContracts } from './openapi-parser.js'
import { indexDeployment } from './docker-parser.js'
import { indexK8sResources } from './k8s-parser.js'
import { indexJpaEntities } from './jpa-extractor.js'
import { indexSecurity } from './security-extractor.js'
import { indexBatchJobs } from './batch-extractor.js'
import { indexResilience } from './resilience-extractor.js'
import { indexPiniaStores } from './pinia-extractor.js'
import { indexI18n } from './vue-i18n-extractor.js'
import { indexGatewayRoutes } from './gateway-parser.js'
import { indexQueueBindings } from './message-queue-parser.js'
import { resolveVueApiToController } from './vue-api-mapper.js'
import { indexConfigProperties } from './config-extractor.js'
import { indexTransactionalAnnotations, findTxBoundaryConflicts } from './transaction-extractor.js'
import { indexCacheAnnotations } from './cache-extractor.js'
import { indexTraces } from './trace-analyzer.js'
import { indexLombokAnnotations } from './lombok-extractor.js'
import { indexGrpcProtoFiles, findProtoDir } from './grpc-parser.js'
import { indexMapStructMappers } from './mapstruct-extractor.js'
import { indexSpringAutoConfiguration } from './autoconfig-extractor.js'
import { findMavenScopeConflicts, parsePomXml, indexMavenDependencies } from './maven-parser.js'
import { indexGradleModules } from './gradle-parser.js'
import { indexCloudConfigBindings, detectBootstrapConfig } from './cloud-config-extractor.js'
import { indexLoadBalancerClients, resolveLbUris } from './loadbalancer-extractor.js'
import { indexGraphQLEndpoints } from './graphql-extractor.js'
import { indexWebSocketEndpoints } from './websocket-extractor.js'
import { indexTestAnnotations } from './test-extractor.js'
import { indexAsyncAnnotations } from './async-extractor.js'
import { indexReactComponents } from './react-extractor.js'
import { indexMongoEntities } from './mongo-extractor.js'
import { indexRedisAnnotations } from './redis-extractor.js'
import { indexSQLStatements } from './sql-extractor.js'
import { indexAopAnnotations, resolvePointcutMatches } from './aop-extractor.js'
import { indexSecurityFilterChains, indexWebSecurityCustomizer } from './security-filter-extractor.js'
import { indexK8sNetworkResources } from './k8s-network-extractor.js'
import { indexControllerAdvice } from './controller-advice-extractor.js'
import { indexInterceptors } from './interceptor-extractor.js'
import { indexStreamFunctions } from './stream-function-extractor.js'
import { indexJpaCustomQueries } from './jpa-query-extractor.js'
import { indexProfileAnnotations } from './profile-extractor.js'

export function sourceIncludesAny(source: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (source.includes(kw)) return true
  }
  return false
}

export const EXTRACTOR_GUARDS: Record<string, string[]> = {
  jpa: ['@Entity', '@Table(', '@Column(', '@Id', '@GeneratedValue', '@ManyToOne', '@OneToMany', '@JoinColumn', '@JoinTable'],
  security: ['@PreAuthorize', '@Secured', '@RolesAllowed', '@WithMockUser'],
  batch: ['@EnableBatchProcessing', '@JobScope', '@StepScope'],
  resilience: ['@CircuitBreaker', '@Retry', '@Bulkhead', '@RateLimiter', '@TimeLimiter'],
  lombok: ['@Data', '@Getter', '@Setter', '@AllArgsConstructor', '@NoArgsConstructor', '@Builder', '@Slf4j', '@Log4j', '@Value', '@ToString', '@EqualsAndHashCode'],
  mapstruct: ['@Mapper', '@Mapping'],
  graphql: ['@QueryMapping', '@MutationMapping', '@SchemaMapping', '@GraphQlController', '@GraphQl'],
  websocket: ['@MessageController', '@MessageMapping', '@SendToUser'],
  test: ['@Test', '@SpringBootTest', '@MockBean', '@InjectMocks', '@BeforeEach', '@BeforeAll', '@ExtendWith'],
  async: ['@Async', '@EnableAsync', '@Scheduled', '@EnableScheduling'],
  aop: ['@Aspect', '@Pointcut', '@Around', '@Before(', '@After(', '@AfterReturning', '@AfterThrowing'],
  securityFilter: ['@SecurityFilterChain', '@WebSecurityConfigurer'],
  controllerAdvice: ['@ControllerAdvice', '@RestControllerAdvice', '@ExceptionHandler'],
  interceptor: ['@Interceptor', '@HandlerInterceptor', '@WebMvcConfigurer'],
  jpaQuery: ['@Query(', '@NamedQuery', '@NamedNativeQuery', '@Modifying'],
  profile: ['@Profile', '@Conditional(', '@ConditionalOnProperty'],
  redis: ['@RedisHash', '@Cacheable', '@CacheEvict', '@CachePut', '@Caching'],
}

export function shouldRunExtractor(source: string, name: string): boolean {
  const keywords = EXTRACTOR_GUARDS[name]
  if (!keywords) return true
  return sourceIncludesAny(source, keywords)
}

export class ExtractionOrchestrator {
  private grammarLoader: GrammarLoader
  private db: DatabaseConnection
  private queries: QueryManager
  private workerPool: Worker[] = []
  private useWorkers = false
  private parseTimeoutMs = 30000
  private workerHeartbeats = new Map<number, number>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(db: DatabaseConnection, queries: QueryManager) {
    this.db = db
    this.queries = queries
    this.grammarLoader = new GrammarLoader()
    this.enableWorkerPool(Math.max(1, cpus().length - 1))
  }

  enableWorkerPool(size = 2): void {
    if (this.workerPool.length > 0) return
    this.useWorkers = true
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./parse-worker.js', import.meta.url))
      worker.postMessage({ type: 'init' })
      this.workerPool.push(worker)
      this.workerHeartbeats.set(i, Date.now())
      worker.on('message', (msg: any) => {
        if (msg?.type === 'heartbeat') this.workerHeartbeats.set(i, Date.now())
      })
    }
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        const now = Date.now()
        for (let i = 0; i < this.workerPool.length; i++) {
          const last = this.workerHeartbeats.get(i) ?? 0
          if (now - last > 30000) {
            console.error(`Worker ${i} unresponsive for 30s, restarting...`)
            const old = this.workerPool[i]
            old.terminate()
            const worker = new Worker(new URL('./parse-worker.js', import.meta.url))
            worker.postMessage({ type: 'init' })
            this.workerPool[i] = worker
            this.workerHeartbeats.set(i, Date.now())
            worker.on('message', (msg: any) => {
              if (msg?.type === 'heartbeat') this.workerHeartbeats.set(i, Date.now())
            })
          }
        }
      }, 10000)
    }
  }

  async init(): Promise<void> {
    await this.grammarLoader.init()
  }

  async indexProject(projectRoot: string, moduleId?: string, excludePatterns?: string[], parallelModule?: boolean): Promise<ExtractionResult> {
    const files = scanDirectory(projectRoot, undefined, excludePatterns)

    console.error(`Found ${files.length} supported files to index`)

    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }
    let indexedCount = 0
    const startTime = Date.now()

    const mid = moduleId || 'default'
    const updateProgress = () => {
      const pct = ((indexedCount / files.length) * 100).toFixed(1)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const barLen = 20
      const filled = Math.round((indexedCount / files.length) * barLen)
      const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
      process.stderr.write(`\r[${bar}] ${pct}% (${indexedCount}/${files.length}) ${elapsed}s`)
    }

    const BATCH = 200
    const TX_SIZE = 10000
    this.queries.enableBatchMode()
    if (!parallelModule) this.db.exec('BEGIN')
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH)
        const batchResults = await Promise.all(batch.map(f => this.indexFileWorker(f, projectRoot, mid)))
        for (const fileResult of batchResults) {
          result.nodes.push(...fileResult.nodes)
          result.edges.push(...fileResult.edges)
          result.errors.push(...fileResult.errors)
          indexedCount++
          updateProgress()
        }
        if (!parallelModule && indexedCount % TX_SIZE === 0 && indexedCount < files.length) {
          this.queries.flushBatch()
          this.db.exec('COMMIT')
          this.db.exec('BEGIN')
        }
      }
      this.queries.flushBatch()
      if (!parallelModule) this.db.exec('COMMIT')
    } catch (e) {
      if (!parallelModule) this.db.exec('ROLLBACK')
      result.errors.push(`Batch transaction error: ${e}`)
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
    process.stderr.write(`\nIndexed ${indexedCount}/${files.length} files in ${totalTime}s\n`)

    const mybatisDir = findMyBatisMapperDir(projectRoot)
    if (mybatisDir) {
      process.stderr.write('Indexing MyBatis XML mappers...\n')
      const mybatisMappings = indexMyBatisMappers(this.queries, projectRoot, mybatisDir, mid)
      if (mybatisMappings.length > 0) {
        process.stderr.write(`  Found ${mybatisMappings.length} MyBatis SQL mappings\n`)
      }
    }

    const resolved = this.queries.resolveCallEdges()
    if (resolved > 0) {
      process.stderr.write(`Resolved ${resolved} call edges\n`)
    }

    process.stderr.write('Running resolution pipeline...\n')
    const resolvedRefs = await runResolutionPipeline(this.queries, projectRoot, mid, [mid])
    if (resolvedRefs > 0) {
      process.stderr.write(`  Resolved ${resolvedRefs} cross-module references\n`)
    }

    process.stderr.write('Running dispatch inference engine...\n')
    try {
      const { DispatchInferenceEngine } = await import('../resolution/dispatch-inference/index.js')
      const engine = new DispatchInferenceEngine(this.queries, projectRoot, mid, [mid])
      const dispatchResult = await engine.run()
      if (dispatchResult.stats.totalEdges > 0) {
        process.stderr.write(`  Inferred ${dispatchResult.stats.totalEdges} dispatch edges across ${dispatchResult.stats.totalPatterns} patterns\n`)
      }
    } catch (e) {
      process.stderr.write(`  Dispatch inference skipped: ${e}\n`)
    }

    process.stderr.write('Indexing OpenAPI contracts...\n')
    const openApiEndpoints = indexOpenApiContracts(this.queries, projectRoot, mid)
    if (openApiEndpoints.length > 0) {
      process.stderr.write(`  Found ${openApiEndpoints.length} OpenAPI endpoints\n`)
    }

    process.stderr.write('Indexing Docker deployment...\n')
    const containers = indexDeployment(this.queries, projectRoot, mid)
    if (containers.length > 0) {
      process.stderr.write(`  Found ${containers.length} Docker containers\n`)
    }

    process.stderr.write('Indexing K8s resources...\n')
    const k8sResources = indexK8sResources(this.queries, projectRoot, mid)
    if (k8sResources.length > 0) {
      process.stderr.write(`  Found ${k8sResources.length} K8s resources\n`)
    }

    process.stderr.write('Indexing gateway routes...\n')
    const gatewayRoutes = indexGatewayRoutes(this.queries, projectRoot, mid)
    if (gatewayRoutes.length > 0) {
      process.stderr.write(`  Found ${gatewayRoutes.length} gateway routes\n`)
    }

    const mqFiles = files.filter(f => f.endsWith('.java') || f.endsWith('.yml') || f.endsWith('.yaml'))
    const allMqBindings: MessageQueueBinding[] = []
    for (const mf of mqFiles) {
      try {
        const mqSource = readFileSync(join(projectRoot, mf), 'utf-8')
        if (!mqSource.includes('@EnableBinding') && !mqSource.includes('StreamBridge') &&
            !mqSource.includes('spring.cloud.stream') && !mqSource.includes('rabbit') &&
            !mqSource.includes('kafka') && !mqSource.includes('jms') &&
            !mqSource.includes('pulsar') && !mqSource.includes('@JmsListener') &&
            !mqSource.includes('@RabbitListener') && !mqSource.includes('@KafkaListener')) {
          continue
        }
        const bindings = indexQueueBindings(this.queries, mqSource, relative(projectRoot, mf).replace(/\\/g, '/'), mid)
        allMqBindings.push(...bindings)
      } catch (e) { console.error(`  Failed to read MQ file ${mf}: ${e}`) }
    }
    if (allMqBindings.length > 0) {
      process.stderr.write(`  Found ${allMqBindings.length} MQ bindings\n`)
    }

    process.stderr.write('Indexing config properties...\n')
    const configBindings = indexConfigProperties(this.queries, projectRoot, mid)
    if (configBindings.length > 0) {
      process.stderr.write(`  Found ${configBindings.length} @ConfigurationProperties bindings\n`)
    }

    process.stderr.write('Indexing transactional annotations...\n')
    const txInfos = indexTransactionalAnnotations(this.queries, mid)
    if (txInfos.length > 0) {
      process.stderr.write(`  Found ${txInfos.length} @Transactional annotations\n`)
      const txConflicts = findTxBoundaryConflicts(this.queries, mid)
      if (txConflicts.length > 0) {
        process.stderr.write(`  Found ${txConflicts.length} transaction boundary conflicts\n`)
      }
    }

    process.stderr.write('Indexing cache annotations...\n')
    const cacheResult = indexCacheAnnotations(this.queries, projectRoot, mid)
    if (cacheResult.annotations.length > 0) {
      process.stderr.write(`  Found ${cacheResult.annotations.length} cache annotations (${cacheResult.topologies.length} cache topologies)\n`)
    }

    process.stderr.write('Indexing @ConditionalOnProperty / auto-configuration...\n')
    const autoConfigs = indexSpringAutoConfiguration(this.queries, mid, projectRoot)
    if (autoConfigs.length > 0) {
      process.stderr.write(`  Found ${autoConfigs.length} conditional configuration classes\n`)
    }

    const pomPath = join(projectRoot, 'pom.xml')
    if (existsSync(pomPath)) {
      try {
        process.stderr.write('Parsing Maven pom.xml...\n')
        const pomXml = readFileSync(pomPath, 'utf-8')
        const mavenConfig = parsePomXml(pomXml, projectRoot, pomPath)
        indexMavenDependencies(this.queries, mavenConfig, mid)
        process.stderr.write(`  Maven module: ${mavenConfig.module.artifactId}, ${mavenConfig.dependencies.length} dependencies\n`)
      } catch (e) {
        process.stderr.write(`  Failed to parse pom.xml: ${e}\n`)
      }
    } else {
      const settingsGradle = join(projectRoot, 'settings.gradle')
      const settingsGradleKts = join(projectRoot, 'settings.gradle.kts')
      if (existsSync(settingsGradle) || existsSync(settingsGradleKts)) {
        process.stderr.write('Indexing Gradle modules...\n')
        const gradleModules = indexGradleModules(this.queries, projectRoot, mid)
        process.stderr.write(`  Found ${gradleModules.length} Gradle modules\n`)
      }
    }

    process.stderr.write('Indexing Spring Cloud Config...\n')
    const cloudCfgBindings = indexCloudConfigBindings(this.queries, mid)
    if (cloudCfgBindings.length > 0) {
      process.stderr.write(`  Found ${cloudCfgBindings.length} @RefreshScope beans\n`)
    }
    const bootstrapCfg = detectBootstrapConfig(projectRoot)
    if (bootstrapCfg.enabled) {
      process.stderr.write(`  Spring Cloud Config Server: ${bootstrapCfg.configServerUri || 'unknown'}\n`)
    }

    process.stderr.write('Indexing @LoadBalanced clients...\n')
    const lbClients = indexLoadBalancerClients(this.queries, mid)
    if (lbClients.length > 0) {
      process.stderr.write(`  Found ${lbClients.length} @LoadBalanced clients\n`)
    }
    const lbUris = resolveLbUris(this.queries, mid)
    if (lbUris.length > 0) {
      process.stderr.write(`  Resolved ${lbUris.length} lb:// URIs\n`)
    }

    const protoDir = findProtoDir(projectRoot)
    if (protoDir) {
      process.stderr.write(`Indexing gRPC proto files in ${protoDir}...\n`)
      const grpcResult = indexGrpcProtoFiles(this.queries, projectRoot, protoDir, mid)
      if (grpcResult.services.length > 0) {
        process.stderr.write(`  Found ${grpcResult.services.length} gRPC services, ${grpcResult.messages.length} proto messages\n`)
      }
    }

    process.stderr.write('Indexing K8s network resources (Ingress/Service/NetworkPolicy)...\n')
    const k8sNet = indexK8sNetworkResources(this.queries, projectRoot, mid)
    if (k8sNet.services.length > 0 || k8sNet.ingresses.length > 0 || k8sNet.networkPolicies.length > 0) {
      process.stderr.write(`  ${k8sNet.services.length} Services, ${k8sNet.ingresses.length} Ingresses, ${k8sNet.networkPolicies.length} NetworkPolicies\n`)
    }

    // --- Cross-service reference persistence (enterprise P0) ---

    process.stderr.write('Persisting RestTemplate cross-service references...\n')
    try {
      const { storeRestTemplateReferences, storeWebClientReferences } = await import('./routes.js')
      const rtCount = storeRestTemplateReferences(projectRoot, this.queries, mid)
      if (rtCount > 0) process.stderr.write(`  Stored ${rtCount} RestTemplate external references\n`)
      const wcCount = storeWebClientReferences(projectRoot, this.queries, mid)
      if (wcCount > 0) process.stderr.write(`  Stored ${wcCount} WebClient external references\n`)
    } catch (e) { process.stderr.write(`  RestTemplate/WebClient persistence skipped: ${e}\n`) }

    process.stderr.write('Persisting Feign method-level references...\n')
    try {
      const { storeFeignMethodReferences } = await import('./routes.js')
      const feignCount = storeFeignMethodReferences(this.queries, mid)
      if (feignCount > 0) process.stderr.write(`  Stored ${feignCount} Feign method external references\n`)
    } catch (e) { process.stderr.write(`  Feign persistence skipped: ${e}\n`) }

    process.stderr.write('Persisting WebFlux functional endpoints...\n')
    try {
      const { storeWebFluxReferences } = await import('./routes.js')
      const wfCount = storeWebFluxReferences(projectRoot, this.queries, mid)
      if (wfCount > 0) process.stderr.write(`  Stored ${wfCount} WebFlux functional endpoints\n`)
    } catch (e) { process.stderr.write(`  WebFlux persistence skipped: ${e}\n`) }

    // Vue frontend → controller API mapping (previously only in multi-module mode)
    const hasVueFiles = files.some(f => f.endsWith('.vue'))
    if (hasVueFiles) {
      process.stderr.write('Mapping Vue frontend to API endpoints...\n')
      try {
        const { extractVueApiCalls } = await import('./vue-api-mapper.js')
        const { resolveVueApiToController } = await import('./vue-api-mapper.js')
        const { findFiles } = await import('../utils.js')
        const vueFiles = findFiles(projectRoot, () => false).filter(f => f.endsWith('.vue'))
        const allApiCalls: import('../types.js').VueApiCall[] = []
        for (const vf of vueFiles) {
          try {
            const vfSource = readFileSync(vf, 'utf-8')
            const calls = extractVueApiCalls(vfSource, relative(projectRoot, vf).replace(/\\/g, '/'))
            allApiCalls.push(...calls)
          } catch { /* silent */ }
        }
        const apiMappings = resolveVueApiToController(this.queries, allApiCalls, mid)
        for (const m of apiMappings) {
          this.queries.insertEdge(m.apiCall.componentFile, m.controllerNodeId, 'api_mapping', JSON.stringify({ path: m.route, method: m.apiCall.method }), m.apiCall.line, 0)
        }
        if (apiMappings.length > 0) {
          process.stderr.write(`  ${apiMappings.length} Vue→API mappings\n`)
        }
      } catch (e) { process.stderr.write(`  Vue→API mapping skipped: ${e}\n`) }
    }

    // Spring Data REST endpoint detection
    process.stderr.write('Detecting Spring Data REST endpoints...\n')
    try {
      const { indexRepositoryRestEndpoints } = await import('./jpa-extractor.js')
      const restCount = indexRepositoryRestEndpoints(this.queries, mid)
      if (restCount > 0) process.stderr.write(`  Found ${restCount} Spring Data REST endpoints\n`)
    } catch (e) { process.stderr.write(`  Spring Data REST detection skipped: ${e}\n`) }

    // Actuator endpoint detection
    process.stderr.write('Detecting Actuator endpoints...\n')
    try {
      const { indexActuatorEndpoints } = await import('./config-extractor.js')
      const actCount = indexActuatorEndpoints(this.queries, projectRoot, mid)
      if (actCount > 0) process.stderr.write(`  Found ${actCount} Actuator endpoints\n`)
    } catch (e) { process.stderr.write(`  Actuator detection skipped: ${e}\n`) }

    return result
  }

  async indexMultiModule(parentDir: string, excludePatterns?: string[]): Promise<ExtractionResult> {
    const result: ExtractionResult = { nodes: [], edges: [], errors: [] }
    const modules = await this.discoverModules(parentDir)

    if (modules.length === 0) {
      console.error('No sub-modules found. Indexing as single project.')
      return this.indexProject(parentDir, 'default', excludePatterns)
    }

    console.error(`Found ${modules.length} sub-modules: ${modules.map(m => m.name).join(', ')}`)

    this.queries.enableBatchMode()
    for (const mod of modules) {
      this.queries.insertModule(mod)
    }

    const moduleResults = await Promise.all(
      modules.map(mod => this.indexProject(mod.rootPath, mod.id, excludePatterns, true))
    )
    for (const mr of moduleResults) {
      result.nodes.push(...mr.nodes)
      result.edges.push(...mr.edges)
      result.errors.push(...mr.errors)
    }

    const allModuleIds = modules.map(m => m.id)
    console.error('\nRunning cross-module resolution pipeline...')

    let totalCrossResolved = 0
    for (const mod of modules) {
      const resolved = await runResolutionPipeline(this.queries, parentDir, mod.id, allModuleIds)
      totalCrossResolved += resolved
    }

    if (totalCrossResolved > 0) {
      console.error(`  Resolved ${totalCrossResolved} cross-module references`)
    }

    console.error('Running cross-module dispatch inference...')
    try {
      const { DispatchInferenceEngine } = await import('../resolution/dispatch-inference/index.js')
      for (const mod of modules) {
        const engine = new DispatchInferenceEngine(this.queries, parentDir, mod.id, allModuleIds)
        const dispatchResult = await engine.run()
        if (dispatchResult.stats.totalEdges > 0) {
          console.error(`  ${mod.name}: ${dispatchResult.stats.totalEdges} dispatch edges (${dispatchResult.stats.totalPatterns} patterns)`)
        }
      }
    } catch (e) {
      process.stderr.write(`  Dispatch inference skipped: ${e}\n`)
    }

    const routeModule = modules.find(m => m.language === 'vue')
    if (routeModule) {
      const { extractAndStoreVueRouterRoutes } = await import('../resolution/index.js')
      extractAndStoreVueRouterRoutes(this.queries, routeModule.rootPath)
    }

    const vueModules = modules.filter(m => m.language === 'vue')
    for (const vm of vueModules) {
      process.stderr.write(`Indexing i18n for Vue module ${vm.name}...\n`)
      const i18nMessages = indexI18n(this.queries, vm.rootPath, vm.id)
      if (i18nMessages.length > 0) {
        process.stderr.write(`  Found ${i18nMessages.length} i18n messages\n`)
      }
    }

    const javaModules = modules.filter(m => m.language === 'java')
    for (const jm of javaModules) {
      process.stderr.write(`Indexing OpenAPI contracts for ${jm.name}...\n`)
      indexOpenApiContracts(this.queries, jm.rootPath, jm.id)
    }

    process.stderr.write('Mapping Vue frontend to API endpoints...\n')
    for (const vm of vueModules) {
      const { extractVueApiCalls } = await import('./vue-api-mapper.js')
      const vueFiles = findFiles(vm.rootPath, (_: string) => false).filter(f => f.endsWith('.vue'))
      const allApiCalls: import('../types.js').VueApiCall[] = []
      for (const vf of vueFiles) {
        try {
          const vfSource = readFileSync(vf, 'utf-8')
          const calls = extractVueApiCalls(vfSource, relative(vm.rootPath, vf).replace(/\\/g, '/'))
          allApiCalls.push(...calls)
        } catch (e) { console.error(`  Failed to extract API calls from ${vf}: ${e}`) }
      }
      const apiMappings = resolveVueApiToController(this.queries, allApiCalls, vm.id)
      for (const m of apiMappings) {
        this.queries.insertEdge(m.apiCall.componentFile, m.controllerNodeId, 'api_mapping', JSON.stringify({ path: m.route, method: m.apiCall.method }), m.apiCall.line, 0)
      }
      if (apiMappings.length > 0) {
        process.stderr.write(`  ${vm.name}: ${apiMappings.length} Vue→API mappings\n`)
      }
    }

    process.stderr.write('Building full traces (Vue→Gateway→Service→DB)...\n')
    for (const mod of modules) {
      indexConfigProperties(this.queries, mod.rootPath, mod.id)
      indexTransactionalAnnotations(this.queries, mod.id)
      indexCacheAnnotations(this.queries, mod.rootPath, mod.id)
    }
    const traces = indexTraces(this.queries, 'multi')
    if (traces.length > 0) {
      process.stderr.write(`  Built ${traces.length} full request traces\n`)
    }

    return result
  }

  async indexFile(filePath: string, projectRoot: string, moduleId?: string): Promise<ExtractionResult> {
    const validated = validatePathWithinRoot(projectRoot, filePath)
    if (!validated) return { nodes: [], edges: [], errors: [`Path rejected: ${filePath} is outside project root ${projectRoot}`] }
    filePath = validated

    const lang = languageForFile(filePath)
    if (!lang) return { nodes: [], edges: [], errors: [`Unsupported language: ${filePath}`] }

    if (lang.name === 'xml') {
      return { nodes: [], edges: [], errors: [] }
    }
    if (lang.name === 'yaml' || lang.name === 'properties') {
      return { nodes: [], edges: [], errors: [] }
    }

    const mid = moduleId || 'default'

    let source!: string
    let parser!: Parser
    let tree!: Parser.Tree
    let stat!: import('node:fs').Stats
    let contentHash!: string
    let relPath!: string
    let useStrippedSource = false
    let strippedSource: string | undefined

    const parseWithRetry = async (attempt: number): Promise<{ parser: Parser; tree: Parser.Tree; source: string; stat: import('node:fs').Stats; contentHash: string; relPath: string }> => {
      if (!useStrippedSource) {
        source = readFileSync(filePath, 'utf-8')
      } else {
        source = strippedSource!
      }
      stat = statSync(filePath)
      relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
      contentHash = computeContentHash(source)

      if (source.length > 1_048_576) {
        throw new Error(`File exceeds 1MB size limit (${(source.length / 1024 / 1024).toFixed(1)}MB)`)
      }

      if (attempt > 0) {
        this.grammarLoader.resetParser(lang.grammarName)
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      parser = await this.grammarLoader.loadGrammar(lang.grammarName)
      tree = parser.parse(source)

      if (!tree || !tree.rootNode) {
        throw new Error('Parse returned null tree')
      }

      return { parser, tree, source, stat, contentHash, relPath }
    }

    let parseAttempt = 0
    let useRegexFallback = false
    let parseError = ''
    while (true) {
      try {
        await parseWithRetry(parseAttempt)
        break
      } catch (e) {
        const errMsg = String(e)
        parseError = errMsg
        const isOom = errMsg.includes('out of memory') || errMsg.includes('OOM') || errMsg.includes('abort') || errMsg.includes('RuntimeError') || errMsg.includes('memory access out of bounds')

        // Tier 1: retry with fresh grammar (WASM heap reset)
        if (isOom && parseAttempt < 1) {
          parseAttempt++
          console.error(`  OOM on ${filePath}, retrying with fresh grammar (attempt ${parseAttempt})...`)
          this.grammarLoader.resetParser(lang.grammarName)
          await new Promise(resolve => setTimeout(resolve, 200))
          continue
        }

        // Tier 2: retry with comments stripped (reduces WASM memory pressure)
        if (isOom && parseAttempt < 2 && !useStrippedSource) {
          parseAttempt++
          useStrippedSource = true
          strippedSource = source
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n')
          console.error(`  OOM on ${filePath}, retrying with comments stripped (attempt ${parseAttempt})...`)
          this.grammarLoader.resetParser(lang.grammarName)
          await new Promise(resolve => setTimeout(resolve, 200))
          continue
        }

        // Tier 3: general retry for non-OOM errors
        if (parseAttempt < 2) {
          parseAttempt++
          console.error(`  Retry ${parseAttempt} for ${filePath}: ${errMsg.slice(0, 100)}`)
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }

        // Exhausted retries — fall back to regex for supported languages
        if (lang.name === 'java') {
          console.error(`  Falling back to regex parser for ${filePath}`)
          useRegexFallback = true
          break
        }

        return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${errMsg}`] }
      }
    }

    let parseResult: { nodes: any[]; edges: any[]; errors?: string[] }

    if (useRegexFallback) {
      const { parseJavaFileWithRegex } = await import('./languages/java.js')
      try {
        const fallbackSource = source || readFileSync(filePath, 'utf-8')
        const fbRelPath = relPath || relative(projectRoot, filePath).replace(/\\/g, '/')
        parseResult = parseJavaFileWithRegex(fallbackSource, fbRelPath, lang.name)
        parseResult.errors = [`Regex fallback used for ${filePath}: ${parseError}`]
      } catch (fbErr) {
        return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${parseError}; fallback also failed: ${fbErr}`] }
      }
    } else {
      parseResult = lang.name === 'java'
        ? parseJavaFile(tree, source, relPath, lang.name)
        : lang.name === 'python'
          ? parsePythonFile(tree, source, relPath, lang.name)
          : lang.name === 'vue'
            ? parseVueFile(parser, source, relPath, lang.name)
            : lang.name === 'kotlin'
              ? parseKotlinFile(source, relPath, parser, { language: 'kotlin', languageName: 'kotlin', namespaceDelimiter: '.', supportFullText: true })
              : parseTypeScriptFile(tree, source, relPath, lang.name)
    }

    // Ensure relPath is available for the rest of the function
    if (!relPath) {
      relPath = relative(projectRoot, filePath).replace(/\\/g, '/')
    }

    try {
      this.queries.deleteNodesForFile(relPath)

      const nodeMap = new Map<string, MiniCodeGraphNode>()
      for (const ni of parseResult.nodes) {
        const node: MiniCodeGraphNode = {
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          kind: ni.kind,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
          language: lang.name,
          startLine: ni.startLine,
          endLine: ni.endLine,
          startColumn: ni.startColumn,
          endColumn: ni.endColumn,
          docstring: ni.docstring,
          signature: ni.signature,
          visibility: ni.visibility,
          isExported: ni.isExported,
          parentId: ni.parentId,
          moduleId: mid,
        }
        nodeMap.set(node.id, node)
        this.queries.insertNode(node)
      }

      for (const ei of parseResult.edges) {
        this.queries.insertEdge(ei.source, ei.target, ei.kind, ei.metadata, ei.line, ei.col)
      }

      this.queries.upsertFile({
        path: relPath,
        contentHash,
        language: lang.name,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        indexedAt: Date.now(),
        nodeCount: parseResult.nodes.length,
        moduleId: mid,
      })

      if (source.includes('@')) {
        extractFileAnnotations(this.queries, source, relPath, mid, parseResult.nodes.map(ni => ({
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
        })))
      }

      if (lang.name === 'java') {
        if (shouldRunExtractor(source, 'jpa')) indexJpaEntities(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'security')) indexSecurity(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'batch')) indexBatchJobs(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'resilience')) indexResilience(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'lombok')) indexLombokAnnotations(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'mapstruct')) indexMapStructMappers(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'graphql')) indexGraphQLEndpoints(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'websocket')) indexWebSocketEndpoints(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'test')) indexTestAnnotations(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'async')) indexAsyncAnnotations(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'aop')) indexAopAnnotations(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'securityFilter')) indexSecurityFilterChains(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'controllerAdvice')) indexControllerAdvice(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'interceptor')) indexInterceptors(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'jpaQuery')) indexJpaCustomQueries(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'profile')) indexProfileAnnotations(this.queries, source, relPath, mid)
        if (shouldRunExtractor(source, 'redis')) indexRedisAnnotations(this.queries, source, relPath, mid)
        if (sourceIncludesAny(source, ['StreamBridge', 'Function<', 'Supplier<', 'Consumer<', 'java.util.function'])) {
          indexStreamFunctions(this.queries, source, relPath, mid)
        }
        if (sourceIncludesAny(source, ['Mongo', 'mongo', 'Document', 'mongodb'])) {
          indexMongoEntities(this.queries, source, relPath, mid)
        }
        if (sourceIncludesAny(source, ['sql', 'SQL', 'Sql', 'jdbc', 'Jdbc', 'PreparedStatement', 'ResultSet', 'Connection', 'DataSource'])) {
          indexSQLStatements(this.queries, source, relPath, mid)
        }
      }

      if (lang.name === 'vue') {
        parseAndStoreVueTemplates(this.queries, source, relPath, mid)
        indexPiniaStores(this.queries, source, relPath, mid, projectRoot)
      }

      if (lang.name === 'typescript') {
        indexReactComponents(this.queries, source, relPath, mid)
      }

      return {
        nodes: parseResult.nodes.map(ni => ({
          id: `${relPath}:${ni.name}:${ni.startLine}`,
          kind: ni.kind,
          name: ni.name,
          qualifiedName: ni.qualifiedName,
          filePath: relPath,
          language: lang.name,
          startLine: ni.startLine,
          endLine: ni.endLine,
          startColumn: ni.startColumn,
          endColumn: ni.endColumn,
          docstring: ni.docstring,
          signature: ni.signature,
          visibility: ni.visibility,
          isExported: ni.isExported,
          parentId: ni.parentId,
          moduleId: mid,
        })),
        edges: parseResult.edges.map(e => ({ sourceId: e.source, targetId: e.target, kind: e.kind, metadata: e.metadata, line: e.line, col: e.col })),
        errors: [],
      }
    } catch (e) {
      return { nodes: [], edges: [], errors: [`Error processing ${filePath}: ${e}`] }
    }
  }

  private getNextWorker(): Worker | null {
    if (this.workerPool.length === 0) return null
    const idx = Math.floor(Math.random() * this.workerPool.length)
    return this.workerPool[idx]
  }

  async indexFileWorker(
    filePath: string,
    projectRoot: string,
    moduleId: string,
    storeToDb = true
  ): Promise<ExtractionResult> {
    const validated = validatePathWithinRoot(projectRoot, filePath)
    if (!validated) return { nodes: [], edges: [], errors: [`Path rejected: ${filePath} is outside project root ${projectRoot}`] }
    const absPath = validated
    const lang = languageForFile(absPath)
    if (!lang || !['java', 'typescript', 'python', 'vue'].includes(lang.name)) {
      return { nodes: [], edges: [], errors: [] }
    }

    const worker = this.getNextWorker()
    if (!worker) {
      return this.indexFile(absPath, projectRoot, moduleId)
    }

    return new Promise((resolvePromise) => {
      const relPath = relative(projectRoot, absPath).replace(/\\/g, '/')
      const id = Math.random()

      const timeoutId = setTimeout(() => {
        worker.off('message', handler)
        resolvePromise(this.indexFile(absPath, projectRoot, moduleId))
      }, this.parseTimeoutMs)

      const handler = (msg: WorkerResponse) => {
        if (msg.type !== 'parse-result' || msg.id !== id) return
        clearTimeout(timeoutId)
        if (msg.error) {
          resolvePromise({ nodes: [], edges: [], errors: [`Worker error: ${msg.error}`] })
          return
        }

        const result = msg.result
        const src = msg.source ?? ''
        const fileStat = msg.stat
        const contentHash = msg.contentHash ?? ''

        if (!result || !fileStat) {
          resolvePromise({ nodes: [], edges: [], errors: ['Worker returned incomplete result'] })
          return
        }

        try {
          if (storeToDb) {
            this.queries.deleteNodesForFile(relPath)
            for (const ni of result.nodes) {
              this.queries.insertNode({
                id: `${relPath}:${ni.name}:${ni.startLine}`,
                kind: ni.kind, name: ni.name,
                qualifiedName: ni.qualifiedName,
                filePath: relPath, language: lang.name,
                startLine: ni.startLine, endLine: ni.endLine,
                startColumn: ni.startColumn, endColumn: ni.endColumn,
                docstring: ni.docstring ?? '', signature: ni.signature ?? '',
                visibility: ni.visibility ?? 'public',
                isExported: ni.isExported ?? false,
                parentId: ni.parentId, moduleId,
              })
            }
            for (const ei of result.edges) {
              this.queries.insertEdge(ei.source, ei.target, ei.kind, ei.metadata ?? '{}', ei.line, ei.col)
            }
            this.queries.upsertFile({
              path: relPath, contentHash, language: lang.name,
              size: fileStat.size, modifiedAt: fileStat.mtimeMs,
              indexedAt: Date.now(), nodeCount: result.nodes.length,
              moduleId,
            })
          }

          if (storeToDb) {
            if (src.includes('@')) {
              extractFileAnnotations(this.queries, src, relPath, moduleId, result.nodes.map(ni => ({
                id: `${relPath}:${ni.name}:${ni.startLine}`,
                name: ni.name,
                qualifiedName: ni.qualifiedName,
                filePath: relPath,
              })))
            }
            if (lang.name === 'java') {
              if (shouldRunExtractor(src, 'jpa')) indexJpaEntities(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'security')) indexSecurity(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'batch')) indexBatchJobs(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'resilience')) indexResilience(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'lombok')) indexLombokAnnotations(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'mapstruct')) indexMapStructMappers(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'graphql')) indexGraphQLEndpoints(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'websocket')) indexWebSocketEndpoints(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'test')) indexTestAnnotations(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'async')) indexAsyncAnnotations(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'aop')) indexAopAnnotations(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'securityFilter')) indexSecurityFilterChains(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'controllerAdvice')) indexControllerAdvice(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'interceptor')) indexInterceptors(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'jpaQuery')) indexJpaCustomQueries(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'profile')) indexProfileAnnotations(this.queries, src, relPath, moduleId)
              if (shouldRunExtractor(src, 'redis')) indexRedisAnnotations(this.queries, src, relPath, moduleId)
              if (sourceIncludesAny(src, ['StreamBridge', 'Function<', 'Supplier<', 'Consumer<', 'java.util.function'])) {
                indexStreamFunctions(this.queries, src, relPath, moduleId)
              }
              if (sourceIncludesAny(src, ['Mongo', 'mongo', 'Document', 'mongodb'])) {
                indexMongoEntities(this.queries, src, relPath, moduleId)
              }
              if (sourceIncludesAny(src, ['sql', 'SQL', 'Sql', 'jdbc', 'Jdbc', 'PreparedStatement', 'ResultSet', 'Connection', 'DataSource'])) {
                indexSQLStatements(this.queries, src, relPath, moduleId)
              }
            }
            if (lang.name === 'vue') {
              parseAndStoreVueTemplates(this.queries, src, relPath, moduleId)
            }
          }

          resolvePromise({
            nodes: result.nodes.map(ni => ({
              ...ni, id: `${relPath}:${ni.name}:${ni.startLine}`, filePath: relPath, language: lang.name, moduleId,
            })),
            edges: result.edges.map(e => ({ sourceId: e.source, targetId: e.target, kind: e.kind, metadata: e.metadata, line: e.line, col: e.col })),
            errors: [],
          })
        } catch (e) {
          resolvePromise({ nodes: [], edges: [], errors: [`DB error: ${e}`] })
        }
      }

      worker.on('message', handler)
      worker.postMessage({
        type: 'parse',
        id,
        filePath: relPath,
        absolutePath: absPath,
        grammarName: lang.grammarName,
        language: lang.name,
      })
    })
  }

  stopWorkers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    for (const worker of this.workerPool) {
      worker.postMessage({ type: 'shutdown' })
    }
    this.workerPool = []
    this.workerHeartbeats.clear()
  }

  private async discoverModules(parentDir: string): Promise<ModuleInfo[]> {
    const modules: ModuleInfo[] = []
    const seen = new Set<string>()

    const tryAddModule = (dirPath: string, buildSystem: string) => {
      if (seen.has(dirPath)) return
      seen.add(dirPath)

      const name = dirPath.split(/[/\\]/).pop() || 'unknown'
      let language = 'java'

      if (existsSync(join(dirPath, 'package.json'))) {
        try {
          const pkg = JSON.parse(readFileSync(join(dirPath, 'package.json'), 'utf-8'))
          const deps = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>
          if (deps.vue || deps.nuxt) language = 'vue'
          else if (deps.react || deps.next) language = 'typescript'
          else language = 'typescript'
        } catch (e) { console.error(`  Failed to parse package.json: ${e}`) }
      }

      modules.push({
        id: name,
        name,
        rootPath: dirPath,
        buildSystem,
        language,
        indexedAt: Date.now(),
      })
    }

    const pomPath = join(parentDir, 'pom.xml')
    if (existsSync(pomPath)) {
      try {
        const content = readFileSync(pomPath, 'utf-8')
        const moduleRegex = /<module>([^<]+)<\/module>/g
        let m: RegExpExecArray | null
        while ((m = moduleRegex.exec(content)) !== null) {
          const modulePath = join(parentDir, m[1].trim())
          if (existsSync(modulePath)) {
            tryAddModule(modulePath, 'maven')
          }
        }
      } catch (e) { console.error(`  Failed to read pom.xml: ${e}`) }
    }

    const settingsGradle = join(parentDir, 'settings.gradle')
    if (existsSync(settingsGradle)) {
      try {
        const content = readFileSync(settingsGradle, 'utf-8')
        const includeRegex = /include\s+['"]([^'"]+)['"]/g
        let m: RegExpExecArray | null
        while ((m = includeRegex.exec(content)) !== null) {
          const moduleName = m[1].trim().replace(/:/g, '/')
          const modulePath = join(parentDir, moduleName)
          if (existsSync(modulePath)) {
            tryAddModule(modulePath, 'gradle')
          }
        }
      } catch (e) { console.error(`  Failed to read settings.gradle: ${e}`) }
    }

    const entries = readdirSync(parentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.mini-codegraph') continue
      const subPath = join(parentDir, entry.name)

      if (seen.has(subPath)) continue

      if (existsSync(join(subPath, 'pom.xml'))) {
        tryAddModule(subPath, 'maven')
      } else if (existsSync(join(subPath, 'build.gradle')) || existsSync(join(subPath, 'build.gradle.kts'))) {
        tryAddModule(subPath, 'gradle')
      } else if (existsSync(join(subPath, 'package.json'))) {
        tryAddModule(subPath, 'npm')
      }
    }

    return modules
  }
}
