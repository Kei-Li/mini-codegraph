export const NODE_KINDS = [
  'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
  'function', 'method', 'property', 'field', 'variable', 'constant',
  'enum', 'enum_member', 'type_alias', 'namespace', 'parameter',
  'import', 'export', 'route', 'component',
] as const

export type NodeKind = (typeof NODE_KINDS)[number]

export type EdgeKind =
  | 'contains' | 'calls' | 'imports' | 'exports'
  | 'extends' | 'implements' | 'references'
  | 'type_of' | 'returns' | 'instantiates'
  | 'overrides' | 'decorates' | 'defines'
  | 'dispatch_registration' | 'dispatch_call'
  | 'proxy_wraps' | 'aop_advises' | 'conditional_impl'

export interface MiniCodeGraphNode {
  id: string
  kind: string
  name: string
  qualifiedName: string
  filePath: string
  language: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  docstring: string
  signature: string
  visibility: string
  isExported: boolean
  parentId: string | null
  moduleId?: string
  metadata?: string
}

export interface MiniCodeGraphEdge {
  sourceId: string
  targetId: string
  kind: string
  metadata: string
  line: number
  col: number
}

export interface FileRecord {
  path: string
  contentHash: string
  language: string
  size: number
  modifiedAt: number
  indexedAt: number
  nodeCount: number
}

export interface ModuleInfo {
  id: string
  name: string
  rootPath: string
  buildSystem: string
  language: string
  indexedAt: number
}

export interface ExtractionResult {
  nodes: MiniCodeGraphNode[]
  edges: MiniCodeGraphEdge[]
  errors: string[]
  unresolvedReferences?: UnresolvedReference[]
  modules?: ModuleInfo[]
}

export interface UnresolvedReference {
  id: string
  sourceNodeId: string
  referenceName: string
  kind: string
  line: number
  col: number
  filePath: string
  moduleId: string
  metadata: string
}

export interface LanguageConfig {
  name: string
  extensions: string[]
  grammarName: string
  grammarWasmFile: string
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { name: 'java', extensions: ['.java'], grammarName: 'java', grammarWasmFile: 'tree-sitter-java.wasm' },
  { name: 'kotlin', extensions: ['.kt', '.kts'], grammarName: 'kotlin', grammarWasmFile: 'tree-sitter-kotlin.wasm' },
  { name: 'typescript', extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], grammarName: 'typescript', grammarWasmFile: 'tree-sitter-typescript.wasm' },
  { name: 'python', extensions: ['.py', '.pyi'], grammarName: 'python', grammarWasmFile: 'tree-sitter-python.wasm' },
  { name: 'vue', extensions: ['.vue'], grammarName: 'typescript', grammarWasmFile: 'tree-sitter-typescript.wasm' },
  { name: 'xml', extensions: ['.xml'], grammarName: '', grammarWasmFile: '' },
  { name: 'yaml', extensions: ['.yml', '.yaml'], grammarName: '', grammarWasmFile: '' },
  { name: 'properties', extensions: ['.properties'], grammarName: '', grammarWasmFile: '' },
  { name: 'dockerfile', extensions: ['Dockerfile', '.dockerfile'], grammarName: '', grammarWasmFile: '' },
  { name: 'css', extensions: ['.css', '.scss', '.less'], grammarName: '', grammarWasmFile: '' },
  { name: 'html', extensions: ['.html', '.htm'], grammarName: '', grammarWasmFile: '' },
  { name: 'graphql', extensions: ['.graphql', '.gql'], grammarName: '', grammarWasmFile: '' },
]

export interface SearchResult {
  node: MiniCodeGraphNode
  snippets: string[]
  score: number
}

export interface AnnotationInfo {
  nodeId: string
  annotationName: string
  value: string
  line: number
}

export interface FrameworkDetectionResult {
  name: string
  version: string
  confidence: number
}

export interface GatewayRouteInfo {
  id: string
  uri: string
  predicates: string[]
  filters: string[]
  order: number
  metadata: Record<string, string>
}

export interface MessageQueueBinding {
  type: 'kafka' | 'rabbitmq' | 'stream' | 'pulsar'
  direction: 'publish' | 'subscribe'
  topic: string
  group?: string
  handlerClass?: string
  handlerMethod?: string
  binder?: string
}

export interface OpenApiEndpoint {
  path: string
  method: string
  operationId: string
  serviceName?: string
  parameters: { name: string; in: string; required: boolean }[]
  requestBody?: string
  responses: Record<string, string>
}

export interface DeployContainer {
  name: string
  image: string
  ports: string[]
  dependsOn: string[]
  envVars: string[]
}

export interface JpaEntity {
  className: string
  tableName: string
  columns: { name: string; field: string; type: string; nullable: boolean; unique: boolean }[]
  relationships: { field: string; targetEntity: string; type: string; fetch: string }[]
}

export interface VueApiCall {
  componentFile: string
  method: string
  url: string
  handler: string
  line: number
}

export interface FullTraceHop {
  kind: 'vue_page' | 'vue_api_call' | 'gateway_route' | 'controller_endpoint' | 'feign_call' | 'service_method' | 'mybatis_mapper' | 'sql_statement' | 'database_table' | 'mq_publish' | 'mq_subscribe' | 'cache_access'
  id: string
  name: string
  moduleId?: string
  filePath?: string
  detail: string
}

export interface FullTrace {
  id: string
  hops: FullTraceHop[]
  entryPoint: string
  endpointPath: string
  httpMethod: string
}

export interface FanoutHop {
  kind: 'component' | 'vue_api_call' | 'gateway_route' | 'controller_endpoint'
       | 'feign_call' | 'service_method' | 'repository_method' | 'mybatis_mapper'
       | 'sql_statement' | 'database_table' | 'mq_publish' | 'mq_subscribe' | 'cache_access'
  name: string
  moduleId?: string
  filePath?: string
  detail: string
}

export interface PageFanoutBranch {
  method: string
  path: string
  sourceComponent: string
  trace: FanoutHop[]
}

export interface PageFanoutTrace {
  routePath: string
  routeName?: string
  pageFile: string
  branches: PageFanoutBranch[]
  involvedServices: string[]
}

export interface BacktraceHop {
  id: string
  name: string
  kind: string
  filePath: string
  detail: string
}

export interface BacktracePath {
  hops: BacktraceHop[]
  entryPointKind: string
  entryPointPath?: string
}

export interface BacktraceResult {
  paths: BacktracePath[]
  foundEntry: boolean
  rootNodeId: string
  rootNodeName: string
}

export interface ConfigPropertyBinding {
  configClass: string
  prefix: string
  filePath: string
  properties: { key: string; value: string; sourceFile: string; sourceLine: number }[]
  moduleId: string
}

export interface TransactionalInfo {
  nodeId: string
  methodName: string
  className: string
  propagation: string
  isolation: string
  timeout: number
  readOnly: boolean
  rollbackFor: string[]
  noRollbackFor: string[]
  filePath: string
  line: number
}

export interface CacheAnnotation {
  type: 'Cacheable' | 'CacheEvict' | 'CachePut' | 'Caching'
  cacheNames: string[]
  key: string
  condition: string
  unless: string
  keyGenerator: string
  cacheManager: string
  nodeId: string
  methodName: string
  className: string
  filePath: string
  line: number
  moduleId: string
}

export interface CacheTopology {
  cacheName: string
  entries: CacheAnnotation[]
  redisConfig?: { host: string; port: number; database: number; cluster: boolean }
  relatedServices: string[]
}

export interface ExternalSymbol {
  id: string
  name: string
  kind: string
  providingService: string
  definitionFile: string
  signature: string
  metadata: string
}

export interface ExternalReference {
  id: number
  sourceLocation: string
  externalSymbolId: string
  referenceType: string
  targetService: string
  metadata: string
}

export interface WorkspaceProject {
  name: string
  rootPath: string
  language: string
  buildSystem: string
  detectedAt: number
  provides: ExternalSymbol[]
  consumes: { symbolId: string; referenceType: string; sourceLocation: string }[]
}

export interface ServiceTraceHop {
  kind: 'controller_endpoint' | 'service_method' | 'mybatis_mapper' | 'sql_statement' | 'mq_publish' | 'cache_access'
  name: string
  filePath?: string
  detail: string
}

export interface ServiceTraceEntry {
  kind: 'rest_endpoint' | 'mq_listener' | 'scheduled_task' | 'page_entry'
  httpMethod?: string
  path?: string
  queueName?: string
  cronExpr?: string
  method: string
  filePath: string
  line: number
  signature: string
  internalTrace: ServiceTraceHop[]
}

export interface ServiceTraceResult {
  service: string
  moduleInfo?: { rootPath: string; buildSystem: string; language: string }
  entryPoints: ServiceTraceEntry[]
  outgoingCalls: { targetService: string; kind: string; endpoint: string }[]
  incomingCalls: { sourceService: string; kind: string; endpoint: string }[]
  dependentServices: string[]
  stats: { totalEntryPoints: number; totalNodes: number; totalFiles: number }
}

// Used by GraphQueryManager summary methods
export interface MapStructMapperSummary {
  interfaceName: string
  methods: {
    methodName: string
    sourceType: string
    targetType: string
    fieldMappings: { source: string; target: string }[]
  }[]
}

export interface AutoConfigSummary {
  className: string
  filePath: string
  conditions: ConditionInfo[]
  autoConfigureAfter: string[]
  autoConfigureBefore: string[]
}

export interface ConditionInfo {
  type: string
  value: string
  matchIfMissing: boolean
}

export interface MavenModuleSummary {
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

export interface MavenScopeConflict {
  artifactKey: string
  scopes: string[]
  modules: string[]
}

export interface GradleModuleSummary {
  name: string
  dependencies: { group: string; artifact: string; version: string; configuration: string; isProject: boolean }[]
  submodules: { name: string; path: string }[]
}

export interface CloudConfigSummary {
  className: string
  filePath: string
  refreshScope: boolean
  configKey?: string
}

export interface LoadBalancerClientSummary {
  className: string
  fieldName: string
  serviceName?: string
}

export interface LbUriSummary {
  uri: string
  targetService: string
}

export interface GraphQLEndpointSummary {
  className: string
  methodName: string
  field: string
  returnType: string
  kind: string
}

export interface WebSocketEndpointSummary {
  className: string
  methodName: string
  destination: string
  kind: string
}

export interface TestAnnotationSummary {
  className: string
  filePath: string
  annotation: string
  mockBeans: string[]
}

export interface AsyncMethodSummary {
  className: string
  methodName: string
  kind: 'async' | 'scheduled'
  cron?: string
  fixedRate?: number
  fixedDelay?: number
  executor?: string
}
