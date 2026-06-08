#!/usr/bin/env node

import { Command } from 'commander'
import { handleInit, handleSync, handleModules, handleExport } from './cli/commands/workspace.js'
import { handleIndex } from './cli/commands/indexing.js'
import { handleServe } from './cli/commands/serve.js'
import { handleSearch, handleStatus, handleContext, handleCallers, handleCallees, handleImpact, handleFiles, handleRoutes, handleAffected, handleExplore, handleDeadCode } from './cli/commands/queries.js'
import { handleFeign, handleMybatis, handleGateway, handleMq, handleApiMap, handleSecurity, handleJpa, handleBatch, handleResilience, handlePinia, handleI18n, handleDocker, handleK8s, handleOpenapi, handleDiagram, handleTrace, handleConfig, handleTx, handleCache, handleLombok, handleGrpc, handleMapstruct, handleAutoconfig, handleMaven, handleGradle, handleCloudConfig, handleLoadbalancer, handleGraphql, handleWebsocket, handleTest, handleAsync, handleAop, handleSecurityFilter, handleK8sNet, handleAdvice, handleInterceptor, handleStreamFunc, handleJpaQuery, handleProfile, handleReact, handleMongo, handleRedis, handleSql } from './cli/commands/inspectors.js'
import { handleInstall } from './cli/commands/install.js'
import { handleExclude } from './cli/commands/exclude.js'

export const program = new Command()

program
  .name('mini-codegraph')
  .description('mini-codegraph — lightweight code knowledge graph')
  .version('0.2.0')

program
  .command('init')
  .description('Initialize a mini-codegraph database for a project')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-i, --index', 'Also index after initialization')
  .option('-y, --yes', 'Non-interactive, accept defaults')
  .option('--multi-module', 'Discover and initialize sub-modules (Maven/Gradle multi-module)')
  .option('-e, --exclude <patterns>', 'Comma-separated glob patterns to exclude (e.g. "generated-sources/**,**/test/**")')
  .option('-w, --workspace <path>', 'Workspace root path for multi-project scanning and interface extraction')
  .option('--fast', 'Fast mode: skip framework-specific extractors, only index signatures and imports')
  .action(handleInit)

program
  .command('index')
  .description('Index all supported files in the project')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-f, --force', 'Force re-index all files')
  .option('--changed', 'Only index git-changed files (incremental)')
  .option('--multi-module', 'Index as multi-module (Maven/Gradle multi-module parent)')
  .option('-e, --exclude <patterns>', 'Comma-separated glob patterns to exclude (e.g. "generated-sources/**,**/test/**")')
  .option('-j, --json', 'Output structured JSON summary')
  .option('--progress', 'Show detailed indexing progress with file-by-file status')
  .option('--fast', 'Fast mode: skip framework-specific extractors, only index signatures and imports')
  .action(handleIndex)

program
  .command('sync')
  .description('Incremental update — index only new/changed files')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--git-hooks', 'Install git hooks for auto-sync on commit/merge/checkout')
  .action(handleSync)

program
  .command('modules')
  .description('List indexed modules')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleModules)

program
  .command('export')
  .description('Export graph as JSON')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-o, --output <file>', 'Output file path (default: stdout)')
  .option('--pretty', 'Pretty-print JSON')
  .action(handleExport)

program
  .command('serve')
  .description('Start the MCP server over stdio')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--daemon', 'Run in daemon mode with file watching')
  .option('--mcp', 'Run in MCP server mode (alias for --daemon)')
  .option('--shared', 'Run in shared daemon mode (multi-client over Unix socket)')
  .action(handleServe)

program
  .command('search')
  .description('Search for symbols in the index')
  .argument('<query>', 'Symbol name or search query')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, method, etc.)')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-m, --module <moduleId>', 'Filter by module')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleSearch)

program
  .command('status')
  .description('Show index statistics')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleStatus)

program
  .command('context')
  .description('Build context for a task description (15-step pipeline)')
  .argument('<task>', 'Task description')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--max-nodes <number>', 'Maximum symbols', '10')
  .option('--no-routes', 'Skip route detection')
  .option('--format <format>', 'Output format: json or markdown', 'json')
  .action(handleContext)

program
  .command('callers')
  .description('Find callers of a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleCallers)

program
  .command('callees')
  .description('Find callees of a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleCallees)

program
  .command('impact')
  .description('Analyze what code is affected by changing a symbol')
  .argument('<symbol>', 'Symbol name')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .action(handleImpact)

program
  .command('files')
  .description('List indexed files')
  .option('-p, --pattern <pattern>', 'Glob pattern filter')
  .option('--json', 'Output as JSON')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleFiles)

program
  .command('routes')
  .description('Detect web framework routes in the project')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--manifest', 'Show full routing manifest (URL→handler mapping)')
  .action(handleRoutes)

program
  .command('affected')
  .description('Find test files affected by changes to source files')
  .argument('[path]', 'Project root path', process.cwd())
  .argument('<files...>', 'Source file paths (relative to project root)')
  .action(handleAffected)

program
  .command('explore')
  .description('Explore related symbols grouped by file')
  .argument('<symbols>', 'Comma-separated symbol names')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleExplore)

program
  .command('dead-code')
  .description('Find symbols with no callers (potential dead code)')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleDeadCode)

program
  .command('feign')
  .description('Find FeignClient cross-service call mappings')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleFeign)

program
  .command('mybatis')
  .description('Show MyBatis mapper XML bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleMybatis)

program
  .command('gateway')
  .description('Show API Gateway routes')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleGateway)

program
  .command('mq')
  .description('Show message queue bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleMq)

program
  .command('api-map')
  .description('Show Vue frontend to API controller mappings')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleApiMap)

program
  .command('security')
  .description('Show security annotations')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleSecurity)

program
  .command('jpa')
  .description('Show JPA entities')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleJpa)

program
  .command('batch')
  .description('Show Spring Batch jobs')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleBatch)

program
  .command('resilience')
  .description('Show resilience policies (CircuitBreaker, Retry, etc.)')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleResilience)

program
  .command('pinia')
  .description('Show Pinia stores')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handlePinia)

program
  .command('i18n')
  .description('Show i18n message usage')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleI18n)

program
  .command('docker')
  .description('Show Docker deployment containers')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleDocker)

program
  .command('k8s')
  .description('Show K8s resources')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleK8s)

program
  .command('openapi')
  .description('Show OpenAPI contracts')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleOpenapi)

program
  .command('diagram')
  .description('Generate Mermaid architecture diagrams')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-t, --type <type>', 'Diagram type: architecture, dependencies, sequence, trace, cache, tx, all', 'all')
  .action(handleDiagram)

program
  .command('trace')
  .description('Show full request traces (Vue → Gateway → Service → DB)')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-p, --path <path>', 'Filter by endpoint path')
  .option('-s, --service <name>', 'Filter by service name')
  .action(handleTrace)

program
  .command('config')
  .description('Show @ConfigurationProperties bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-p, --prefix <prefix>', 'Filter by config prefix')
  .action(handleConfig)

program
  .command('tx')
  .description('Show @Transactional annotations and propagation chains')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--conflicts', 'Show only boundary conflicts')
  .action(handleTx)

program
  .command('cache')
  .description('Show cache annotations and cache topology')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleCache)

program
  .command('lombok')
  .description('Show Lombok-synthesized getters, setters, constructors')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-c, --class <name>', 'Filter by class name')
  .action(handleLombok)

program
  .command('grpc')
  .description('Show gRPC services and proto messages')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleGrpc)

program
  .command('mapstruct')
  .description('Show MapStruct mappers with source→target DTO mappings')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleMapstruct)

program
  .command('autoconfig')
  .description('Show @ConditionalOn* / @AutoConfiguration conditional configuration')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleAutoconfig)

program
  .command('maven')
  .description('Show Maven module dependency graph')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleMaven)

program
  .command('gradle')
  .description('Show Gradle module dependency graph')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleGradle)

program
  .command('cloud-config')
  .description('Show @RefreshScope and Spring Cloud Config bindings')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleCloudConfig)

program
  .command('loadbalancer')
  .description('Show @LoadBalanced clients and lb:// URI targets')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleLoadbalancer)

program
  .command('graphql')
  .description('Show GraphQL @QueryMapping / @MutationMapping endpoints')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleGraphql)

program
  .command('websocket')
  .description('Show WebSocket @MessageMapping / @SendTo endpoints')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleWebsocket)

program
  .command('test')
  .description('Show test annotations (@SpringBootTest, @MockBean, etc.)')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleTest)

program
  .command('async')
  .description('Show @Async and @Scheduled methods')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleAsync)

program
  .command('aop')
  .description('Show AOP @Aspect advices and pointcut weaving')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleAop)

program
  .command('security-filter')
  .description('Show SecurityFilterChain / HttpSecurity authorization rules')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleSecurityFilter)

program
  .command('k8s-net')
  .description('Show K8s Ingress/Service/NetworkPolicy details')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleK8sNet)

program
  .command('advice')
  .description('Show @ControllerAdvice / @ExceptionHandler global handlers')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleAdvice)

program
  .command('interceptor')
  .description('Show HandlerInterceptor / Filter chain')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleInterceptor)

program
  .command('stream-func')
  .description('Show Spring Cloud Stream functional beans (Function/Consumer/Supplier)')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleStreamFunc)

program
  .command('jpa-query')
  .description('Show JPA @Query / @Modifying / @Procedure custom queries')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleJpaQuery)

program
  .command('profile')
  .description('Show @Profile annotations — which beans activate in which environments')
  .argument('[path]', 'Project root path', process.cwd())
  .action(handleProfile)

program
  .command('react')
  .description('Show React components, hooks, stores, and data queries')
  .argument('[path]', 'Project root path', process.cwd())
  .option('--detail', 'Include hooks, props, and children details')
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action(handleReact)

program
  .command('mongo')
  .description('Show MongoDB entities — @Document collections, repositories, template usage')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action(handleMongo)

program
  .command('redis')
  .description('Show Redis hashes, repositories, and template operations')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action(handleRedis)

program
  .command('sql')
  .description('Show SQL tables and statements — DDL, MyBatis SQL, JPA @Query, JDBC')
  .argument('[path]', 'Project root path', process.cwd())
  .option('-l, --limit <number>', 'Max results (default: 50)', parseInt)
  .action(handleSql)

program
  .command('install')
  .description('Install and configure mini-codegraph for AI agents')
  .option('--target <agents>', 'Comma-separated agent targets (opencode, claude, cursor, codex, gemini, hermes, antigravity, kiro)')
  .option('--yes', 'Non-interactive, accept defaults')
  .option('--location <type>', 'Install location: global or local (default: global)')
  .action(handleInstall)

program
  .command('exclude')
  .description('Manage file/directory exclusion patterns for indexing')
  .argument('<action>', 'add, remove, or list')
  .argument('[pattern]', 'Glob pattern to exclude (e.g. "generated-sources/**" or "**/*.gen.*")')
  .action(handleExclude)

program.parse(process.argv)
