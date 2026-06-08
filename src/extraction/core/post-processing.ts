import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join, relative } from 'node:path'

import type { QueryManager } from '../../db/queries.js'
import { indexOpenApiContracts } from '../infra/openapi-parser.js'
import { indexDeployment } from '../infra/docker-parser.js'
import { indexK8sResources } from '../infra/k8s-parser.js'
import { indexGatewayRoutes } from '../frameworks/gateway-parser.js'
import { indexQueueBindings } from '../middleware/message-queue-parser.js'
import { indexConfigProperties } from '../frameworks/config-extractor.js'
import { indexTransactionalAnnotations, findTxBoundaryConflicts } from '../frameworks/transaction-extractor.js'
import { indexCacheAnnotations } from '../frameworks/cache-extractor.js'
import { indexGrpcProtoFiles, findProtoDir } from '../infra/grpc-parser.js'
import { indexSpringAutoConfiguration } from '../frameworks/autoconfig-extractor.js'
import { parsePomXml, indexMavenDependencies } from '../infra/maven-parser.js'
import { indexGradleModules } from '../infra/gradle-parser.js'
import { indexCloudConfigBindings, detectBootstrapConfig } from '../frameworks/cloud-config-extractor.js'
import { indexLoadBalancerClients, resolveLbUris } from '../frameworks/loadbalancer-extractor.js'
import { indexK8sNetworkResources } from '../infra/k8s-network-extractor.js'
import { indexRepositoryRestEndpoints } from '../data/jpa-extractor.js'
import { indexActuatorEndpoints } from '../frameworks/config-extractor.js'
import { findMyBatisMapperDir, indexMyBatisMappers } from '../data/mybatis-extractor.js'
import type { MessageQueueBinding } from '../../types.js'
import { indexI18n } from '../frontend/vue-i18n-extractor.js'
import { findFiles } from '../../utils.js'
import { logError } from '../../logger.js'

export async function runPostProcessing(
  queries: QueryManager,
  projectRoot: string,
  moduleId: string | undefined,
  files: string[],
): Promise<void> {
  if (files.length === 0) return

  const mid = moduleId || 'default'

  const postSteps = [
    'MyBatis XML mappers',
    'Resolution pipeline',
    'Dispatch inference',
    'Spring beans',
    'OpenAPI contracts',
    'Docker deployment',
    'K8s resources',
    'Gateway routes',
    'MQ bindings',
    'Config properties',
    'Transactional annotations',
    'Cache annotations',
    'Auto-configuration',
    'Maven/Gradle modules',
    'Spring Cloud Config',
    'LoadBalanced clients',
    'gRPC proto files',
    'K8s network resources',
    'RestTemplate/Feign/WebFlux refs',
    'Vue→API mapping',
    'Spring Data REST endpoints',
    'Actuator endpoints',
  ]
  const totalPostSteps = postSteps.length
  let postStepIndex = 0
  const barWidth = 20
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let progressTimer: ReturnType<typeof setInterval> | null = null
  let postStartTime = Date.now()
  let spinIdx = 0
  const clearProgressTimer = () => {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null }
  }
  const nextPostStep = (name: string) => {
    if (postStepIndex === 0) postStartTime = Date.now()
    clearProgressTimer()
    postStepIndex++
    const pct = (postStepIndex - 1) / totalPostSteps
    const filled = Math.round(pct * barWidth)
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
    process.stderr.write(`\n  [${bar}] ${(pct * 100).toFixed(0)}% Step ${postStepIndex}/${totalPostSteps}: ${name}\n`)
    spinIdx = 0
    progressTimer = setInterval(() => {
      const elapsed = ((Date.now() - postStartTime) / 1000).toFixed(0)
      const pct2 = (postStepIndex - 1) / totalPostSteps
      const filled2 = Math.round(pct2 * barWidth)
      const bar2 = '█'.repeat(filled2) + '░'.repeat(barWidth - filled2)
      const spin = spinner[spinIdx % spinner.length]
      spinIdx++
      process.stderr.write(`\r  [${bar2}] ${(pct2 * 100).toFixed(0)}% Step ${postStepIndex}/${totalPostSteps}: ${spin} ${name}... (${elapsed}s)`)
    }, 200)
  }

  const mybatisDir = findMyBatisMapperDir(projectRoot)
  if (mybatisDir) {
    nextPostStep('MyBatis XML mappers')
    const mybatisMappings = indexMyBatisMappers(queries, projectRoot, mybatisDir, mid)
    if (mybatisMappings.length > 0) {
      process.stderr.write(`  Found ${mybatisMappings.length} MyBatis SQL mappings\n`)
    }
  }

  const resolved = queries.resolveCallEdges()
  if (resolved > 0) {
    process.stderr.write(`Resolved ${resolved} call edges\n`)
  }

  nextPostStep('Spring beans')
  try {
    const { indexSpringBeans } = await import('../frameworks/spring-bean-extractor.js')
    const beanResult = indexSpringBeans(queries, mid)
    if (beanResult.beans > 0 || beanResult.injections > 0) {
      process.stderr.write(`  Found ${beanResult.beans} stereotype beans, ${beanResult.injections} @Autowired injection edges\n`)
    }
  } catch (e) {
    process.stderr.write(`  Spring bean extraction skipped: ${e}\n`)
  }

  nextPostStep('OpenAPI contracts')
  const openApiEndpoints = indexOpenApiContracts(queries, projectRoot, mid)
  if (openApiEndpoints.length > 0) {
    process.stderr.write(`  Found ${openApiEndpoints.length} OpenAPI endpoints\n`)
  }

  nextPostStep('Docker deployment')
  const containers = indexDeployment(queries, projectRoot, mid)
  if (containers.length > 0) {
    process.stderr.write(`  Found ${containers.length} Docker containers\n`)
  }

  nextPostStep('K8s resources')
  const k8sResources = indexK8sResources(queries, projectRoot, mid)
  if (k8sResources.length > 0) {
    process.stderr.write(`  Found ${k8sResources.length} K8s resources\n`)
  }

  nextPostStep('Gateway routes')
  const gatewayRoutes = indexGatewayRoutes(queries, projectRoot, mid)
  if (gatewayRoutes.length > 0) {
    process.stderr.write(`  Found ${gatewayRoutes.length} gateway routes\n`)
  }

  nextPostStep('MQ bindings')
  const mqFiles = files.filter(f => f.endsWith('.java') || f.endsWith('.yml') || f.endsWith('.yaml'))
  const MQ_KEYWORDS = ['@EnableBinding', 'StreamBridge', 'spring.cloud.stream', 'rabbit',
    'kafka', 'jms', 'pulsar', '@JmsListener', '@RabbitListener', '@KafkaListener']
  const allMqBindings: MessageQueueBinding[] = []
  const mqHeadBuf = Buffer.alloc(4096)
  for (let mqIdx = 0; mqIdx < mqFiles.length; mqIdx++) {
    const mf = mqFiles[mqIdx]
    if (mqIdx % 100 === 0) {
      process.stderr.write(`\r  [MQ] ${mqIdx}/${mqFiles.length} files`)
    }
    try {
      const mqPath = join(projectRoot, mf)
      const fd = openSync(mqPath, 'r')
      const bytesRead = readSync(fd, mqHeadBuf, 0, 4096, 0)
      closeSync(fd)
      const head = mqHeadBuf.toString('utf-8', 0, bytesRead)
      if (!MQ_KEYWORDS.some(kw => head.includes(kw))) continue
      const mqSource = readFileSync(mqPath, 'utf-8')
      const bindings = indexQueueBindings(queries, mqSource, relative(projectRoot, mf).replace(/\\/g, '/'), mid)
      allMqBindings.push(...bindings)
    } catch (e) { logError(`Failed to read MQ file ${mf}`, e) }
  }
  if (allMqBindings.length > 0) {
    process.stderr.write(`  Found ${allMqBindings.length} MQ bindings\n`)
  }

  nextPostStep('Config properties')
  const configBindings = indexConfigProperties(queries, projectRoot, mid)
  if (configBindings.length > 0) {
    process.stderr.write(`  Found ${configBindings.length} @ConfigurationProperties bindings\n`)
  }

  nextPostStep('Transactional annotations')
  const annCache = queries.getAllAnnotations()
  const txInfos = indexTransactionalAnnotations(queries, mid, annCache)
  if (txInfos.length > 0) {
    process.stderr.write(`  Found ${txInfos.length} @Transactional annotations\n`)
    const txConflicts = findTxBoundaryConflicts(queries, mid, annCache)
    if (txConflicts.length > 0) {
      process.stderr.write(`  Found ${txConflicts.length} transaction boundary conflicts\n`)
    }
  }

  nextPostStep('Cache annotations')
  const cacheResult = indexCacheAnnotations(queries, projectRoot, mid)
  if (cacheResult.annotations.length > 0) {
    process.stderr.write(`  Found ${cacheResult.annotations.length} cache annotations (${cacheResult.topologies.length} cache topologies)\n`)
  }

  nextPostStep('Auto-configuration')
  const autoConfigs = indexSpringAutoConfiguration(queries, mid, projectRoot)
  if (autoConfigs.length > 0) {
    process.stderr.write(`  Found ${autoConfigs.length} conditional configuration classes\n`)
  }

  nextPostStep('Maven/Gradle modules')
  const pomPath = join(projectRoot, 'pom.xml')
  if (existsSync(pomPath)) {
    try {
      process.stderr.write('  Parsing Maven pom.xml...\n')
      const pomXml = readFileSync(pomPath, 'utf-8')
      const mavenConfig = parsePomXml(pomXml, projectRoot, pomPath)
      indexMavenDependencies(queries, mavenConfig, mid)
      process.stderr.write(`  Maven module: ${mavenConfig.module.artifactId}, ${mavenConfig.dependencies.length} dependencies\n`)
    } catch (e) {
      process.stderr.write(`  Failed to parse pom.xml: ${e}\n`)
    }
  } else {
    const settingsGradle = join(projectRoot, 'settings.gradle')
    const settingsGradleKts = join(projectRoot, 'settings.gradle.kts')
    if (existsSync(settingsGradle) || existsSync(settingsGradleKts)) {
      process.stderr.write('  Indexing Gradle modules...\n')
      const gradleModules = indexGradleModules(queries, projectRoot, mid)
      process.stderr.write(`  Found ${gradleModules.length} Gradle modules\n`)
    }
  }

  nextPostStep('Spring Cloud Config')
  const cloudCfgBindings = indexCloudConfigBindings(queries, mid)
  if (cloudCfgBindings.length > 0) {
    process.stderr.write(`  Found ${cloudCfgBindings.length} @RefreshScope beans\n`)
  }
  const bootstrapCfg = detectBootstrapConfig(projectRoot)
  if (bootstrapCfg.enabled) {
    process.stderr.write(`  Spring Cloud Config Server: ${bootstrapCfg.configServerUri || 'unknown'}\n`)
  }

  nextPostStep('LoadBalanced clients')
  const lbClients = indexLoadBalancerClients(queries, mid)
  if (lbClients.length > 0) {
    process.stderr.write(`  Found ${lbClients.length} @LoadBalanced clients\n`)
  }
  const lbUris = resolveLbUris(queries, mid)
  if (lbUris.length > 0) {
    process.stderr.write(`  Resolved ${lbUris.length} lb:// URIs\n`)
  }

  nextPostStep('gRPC proto files')
  const protoDir = findProtoDir(projectRoot)
  if (protoDir) {
    process.stderr.write(`  Scanning ${protoDir}...\n`)
    const grpcResult = indexGrpcProtoFiles(queries, projectRoot, protoDir, mid)
    if (grpcResult.services.length > 0) {
      process.stderr.write(`  Found ${grpcResult.services.length} gRPC services, ${grpcResult.messages.length} proto messages\n`)
    }
  }

  nextPostStep('K8s network resources')
  const k8sNet = indexK8sNetworkResources(queries, projectRoot, mid)
  if (k8sNet.services.length > 0 || k8sNet.ingresses.length > 0 || k8sNet.networkPolicies.length > 0) {
    process.stderr.write(`  ${k8sNet.services.length} Services, ${k8sNet.ingresses.length} Ingresses, ${k8sNet.networkPolicies.length} NetworkPolicies\n`)
  }

  nextPostStep('RestTemplate/Feign/WebFlux refs')
  try {
    const { storeRestTemplateReferences, storeWebClientReferences } = await import('./routes.js')
    const rtCount = storeRestTemplateReferences(projectRoot, queries, mid)
    if (rtCount > 0) process.stderr.write(`  Stored ${rtCount} RestTemplate external references\n`)
    const wcCount = storeWebClientReferences(projectRoot, queries, mid)
    if (wcCount > 0) process.stderr.write(`  Stored ${wcCount} WebClient external references\n`)
  } catch (e) { process.stderr.write(`  RestTemplate/WebClient persistence skipped: ${e}\n`) }

  try {
    const { storeFeignMethodReferences } = await import('./routes.js')
    const feignCount = storeFeignMethodReferences(queries, mid)
    if (feignCount > 0) process.stderr.write(`  Stored ${feignCount} Feign method external references\n`)
  } catch (e) { process.stderr.write(`  Feign persistence skipped: ${e}\n`) }

  try {
    const { storeWebFluxReferences } = await import('./routes.js')
    const wfCount = storeWebFluxReferences(projectRoot, queries, mid)
    if (wfCount > 0) process.stderr.write(`  Stored ${wfCount} WebFlux functional endpoints\n`)
  } catch (e) { process.stderr.write(`  WebFlux persistence skipped: ${e}\n`) }

  nextPostStep('Vue→API mapping')
  const vueRelFiles = files.filter(f => f.endsWith('.vue'))
  if (vueRelFiles.length > 0) {
    try {
      const { extractVueApiCalls, resolveVueApiToController } = await import('../frontend/vue-api-mapper.js')
      const allApiCalls: import('../../types.js').VueApiCall[] = []
      for (const vf of vueRelFiles) {
        try {
          const vfAbs = join(projectRoot, vf)
          const vfSource = readFileSync(vfAbs, 'utf-8')
          const calls = extractVueApiCalls(vfSource, vf.replace(/\\/g, '/'))
          allApiCalls.push(...calls)
        } catch { /* silent */ }
      }
      const apiMappings = resolveVueApiToController(queries, allApiCalls, mid)
      for (const m of apiMappings) {
        queries.insertEdge(m.apiCall.componentFile, m.controllerNodeId, 'api_mapping', JSON.stringify({ path: m.route, method: m.apiCall.method }), m.apiCall.line, 0)
      }
      if (apiMappings.length > 0) {
        process.stderr.write(`  ${apiMappings.length} Vue→API mappings\n`)
      }
    } catch (e) { process.stderr.write(`  Vue→API mapping skipped: ${e}\n`) }
  }

  nextPostStep('Spring Data REST endpoints')
  try {
    const restCount = indexRepositoryRestEndpoints(queries, mid)
    if (restCount > 0) process.stderr.write(`  Found ${restCount} Spring Data REST endpoints\n`)
  } catch (e) { process.stderr.write(`  Spring Data REST detection skipped: ${e}\n`) }

  nextPostStep('Actuator endpoints')
  try {
    const actCount = indexActuatorEndpoints(queries, projectRoot, mid)
    if (actCount > 0) process.stderr.write(`  Found ${actCount} Actuator endpoints\n`)
  } catch (e) { process.stderr.write(`  Actuator detection skipped: ${e}\n`) }

  clearProgressTimer()
}

interface ModuleInfo {
  id: string
  name: string
  rootPath: string
  language: string
  buildSystem: string
}

export async function runMultiModulePostProcessing(
  queries: QueryManager,
  _parentDir: string,
  modules: ModuleInfo[],
  _allModuleIds: string[],
): Promise<void> {
  const routeModule = modules.find(m => m.language === 'vue')
  if (routeModule) {
    const { extractAndStoreVueRouterRoutes } = await import('../../resolution/index.js')
    extractAndStoreVueRouterRoutes(queries, routeModule.rootPath)
  }

  const vueModules = modules.filter(m => m.language === 'vue')
  for (const vm of vueModules) {
    process.stderr.write(`Indexing i18n for Vue module ${vm.name}...\n`)
    const i18nMessages = indexI18n(queries, vm.rootPath, vm.id)
    if (i18nMessages.length > 0) {
      process.stderr.write(`  Found ${i18nMessages.length} i18n messages\n`)
    }
  }

  const javaModules = modules.filter(m => m.language === 'java')
  for (const jm of javaModules) {
    process.stderr.write(`Indexing OpenAPI contracts for ${jm.name}...\n`)
    indexOpenApiContracts(queries, jm.rootPath, jm.id)
  }

  process.stderr.write('Mapping Vue frontend to API endpoints...\n')
  for (const vm of vueModules) {
    const { extractVueApiCalls, resolveVueApiToController } = await import('../frontend/vue-api-mapper.js')
    const vueFiles = findFiles(vm.rootPath, () => false).filter(f => f.endsWith('.vue'))
    const allApiCalls: import('../../types.js').VueApiCall[] = []
    for (const vf of vueFiles) {
      try {
        const vfSource = readFileSync(vf, 'utf-8')
        const calls = extractVueApiCalls(vfSource, relative(vm.rootPath, vf).replace(/\\/g, '/'))
        allApiCalls.push(...calls)
      } catch (e) { logError(`Failed to extract API calls from ${vf}`, e) }
    }
    const apiMappings = resolveVueApiToController(queries, allApiCalls, vm.id)
    for (const m of apiMappings) {
      queries.insertEdge(m.apiCall.componentFile, m.controllerNodeId, 'api_mapping', JSON.stringify({ path: m.route, method: m.apiCall.method }), m.apiCall.line, 0)
    }
    if (apiMappings.length > 0) {
      process.stderr.write(`  ${vm.name}: ${apiMappings.length} Vue→API mappings\n`)
    }
  }

  process.stderr.write('Building full traces (Vue→Gateway→Service→DB)...\n')
  for (const mod of modules) {
    indexConfigProperties(queries, mod.rootPath, mod.id)
    indexTransactionalAnnotations(queries, mod.id)
    indexCacheAnnotations(queries, mod.rootPath, mod.id)
  }
}
