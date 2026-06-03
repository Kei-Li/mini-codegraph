# mini-codegraph

Lightweight code knowledge graph engine — tree-sitter AST parsing, SQLite graph storage, MCP server for AI agents.

## Features

- **tree-sitter AST parsing** — Java, TypeScript/TSX, Python, Vue, Kotlin
- **SQLite graph storage** — Nodes (symbols) + edges (calls, imports, extends, implements, references) + FTS5 full-text search
- **MCP Server** — Model Context Protocol over stdio (12 tools for AI agent integration)
- **Impact Analysis** — Blast radius analysis with depth control
- **Flow Tracing** — Find call paths between any two symbols
- **Framework Routes** — Auto-detect Express, NestJS, Next.js, Spring, React Router, Fastify, Koa routes
- **Java/Spring Deep Analysis** — 40+ domain-specific extractors
  - JPA entities, MyBatis mapper bindings, FeignClient cross-service calls
  - `@Transactional` propagation, `@Cacheable`/`@CacheEvict` topology
  - `@Async`/`@Scheduled`, AOP aspects, `@ControllerAdvice`
  - Spring Cloud Config, `@LoadBalanced`, SecurityFilterChain
  - Spring Batch jobs, `@Profile`, `@ConditionalOn*` auto-configuration
  - MapStruct, Lombok, OpenAPI contracts, Gateway routes
- **React Ecosystem** — JSX components, hooks, Redux/Zustand stores, React Query hooks
- **Vue Ecosystem** — Pinia stores, Vue i18n, Vue API mapping to controllers
- **Databases** — MongoDB (@Document entities, repositories, MongoTemplate), Redis (@RedisHash, RedisTemplate/Redisson), SQL (DDL tables, MyBatis/JPA/JDBC statements)
- **Infrastructure** — Docker containers, K8s resources, Maven/Gradle dependency graphs
- **Messaging** — Kafka, RabbitMQ, Pulsar, Spring Cloud Stream bindings
- **Other** — gRPC proto services, GraphQL, WebSocket, gRPC endpoints
- **Mermaid.js Visualization** — Architecture diagrams, dependency graphs, cache topology, transaction chains
- **Code Analysis** — Cyclomatic complexity, circular dependencies, dead imports, entry point detection
- **Incremental Sync** — Only re-index new/changed files
- **File Watcher** — Auto-sync on file changes with debounce
- **Dead Code Detection** — Find symbols with no callers
- **Test Impact** — Find affected test files when source changes
- **Agent Installer** — Auto-configure for opencode, Claude Code, Cursor, Codex, Gemini CLI, Hermes Agent, Antigravity, Kiro

## Architecture

```
Source Files → tree-sitter WASM AST → SQLite (WAL + FTS5) → MCP Server (JSON-RPC 2.0) → AI Agent
```

## Quick Start

```bash
git clone https://github.com/Kei-Li/mini-codegraph.git
cd mini-codegraph
npm install
npm run build
npm link

# Initialize and index a project
mini-cg init /path/to/project --index

# Or step by step
mini-cg init /path/to/project
mini-cg index /path/to/project
```

## CLI Commands (60+)

### Setup
| Command | Description |
|---|---|
| `mini-cg init [path]` | Initialize database |
| `mini-cg index [path]` | Index all supported files |
| `mini-cg sync [path]` | Incremental — index only changed files |
| `mini-cg serve [path]` | Start MCP server (stdio, daemon, or shared) |
| `mini-cg install` | Configure for AI agents |

### Core Queries
| Command | Description |
|---|---|
| `mini-cg search <query>` | Search symbols (FTS5 + fuzzy fallback) |
| `mini-cg status` | Index statistics and detected frameworks |
| `mini-cg files` | List indexed files |
| `mini-cg modules` | List indexed modules |
| `mini-cg context <task>` | Build comprehensive context for a task |
| `mini-cg callers <symbol>` | Find callers of a symbol |
| `mini-cg callees <symbol>` | Find callees of a symbol |
| `mini-cg impact <symbol>` | Blast radius analysis |
| `mini-cg explore <symbols>` | Explore related symbols grouped by file |
| `mini-cg trace <from> <to>` | Show call path between two symbols |
| `mini-cg dead-code` | Find symbols with no callers |
| `mini-cg affected <files...>` | Find test files affected by source changes |

### Frontend & Database Analysis
| Command | Description |
|---|---|
| `mini-cg react` | React components, hooks, Redux/Zustand stores, React Query |
| `mini-cg mongo` | MongoDB @Document entities, repositories, MongoTemplate |
| `mini-cg redis` | Redis @RedisHash, RedisTemplate/Redisson operations |
| `mini-cg sql` | SQL tables (DDL), MyBatis/JPA/JDBC SQL statements |

### Java/Spring Domain Analysis
| Command | Description |
|---|---|
| `mini-cg routes` | Detect web framework routes |
| `mini-cg feign` | FeignClient cross-service call mappings |
| `mini-cg mybatis` | MyBatis mapper XML bindings |
| `mini-cg gateway` | API Gateway routes |
| `mini-cg mq` | Message queue bindings |
| `mini-cg api-map` | Vue frontend to API controller mappings |
| `mini-cg security` | Security annotations |
| `mini-cg jpa` | JPA entities |
| `mini-cg batch` | Spring Batch jobs |
| `mini-cg resilience` | Resilience policies |
| `mini-cg pinia` | Pinia stores |
| `mini-cg i18n` | i18n message usage |
| `mini-cg docker` | Docker deployment containers |
| `mini-cg k8s` | K8s resources |
| `mini-cg openapi` | OpenAPI contracts |
| `mini-cg diagram` | Mermaid architecture diagrams |
| `mini-cg config` | `@ConfigurationProperties` bindings |
| `mini-cg tx` | `@Transactional` annotations and propagation |
| `mini-cg cache` | Cache annotations and cache topology |
| `mini-cg lombok` | Lombok-synthesized methods |
| `mini-cg grpc` | gRPC services |
| `mini-cg mapstruct` | MapStruct mappers |
| `mini-cg autoconfig` | `@ConditionalOn*` auto-configuration |
| `mini-cg maven` | Maven module dependency graph |
| `mini-cg gradle` | Gradle module dependency graph |
| `mini-cg cloud-config` | `@RefreshScope` and Cloud Config |
| `mini-cg loadbalancer` | `@LoadBalanced` clients |
| `mini-cg graphql` | GraphQL endpoints |
| `mini-cg websocket` | WebSocket endpoints |
| `mini-cg test` | Test annotations |
| `mini-cg async` | `@Async` and `@Scheduled` methods |
| `mini-cg aop` | AOP aspects |
| `mini-cg security-filter` | SecurityFilterChain rules |
| `mini-cg k8s-net` | K8s Ingress/Service/NetworkPolicy |
| `mini-cg advice` | `@ControllerAdvice` handlers |
| `mini-cg interceptor` | HandlerInterceptor chain |
| `mini-cg stream-func` | Spring Cloud Stream functions |
| `mini-cg jpa-query` | JPA `@Query` annotations |
| `mini-cg profile` | `@Profile` annotations |

## MCP Tools (12 tools)

| Tool | Purpose |
|---|---|
| `mini_codegraph_search` | Quick symbol search by name |
| `mini_codegraph_context` | **Primary** — Build comprehensive context for a task |
| `mini_codegraph_trace` | Find call path between two symbols |
| `mini_codegraph_explore` | Batch query related symbols grouped by file |
| `mini_codegraph_callers` / `mini_codegraph_callees` | Find callers/callees |
| `mini_codegraph_node` | Get symbol details + source |
| `mini_codegraph_impact` | Blast radius analysis |
| `mini_codegraph_files` | List indexed files |
| `mini_codegraph_status` | Index health + detected frameworks |
| `mini_codegraph_feign` | List FeignClient interfaces and microservice targets |
| `mini_codegraph_mybatis` | Show MyBatis mapper XML bindings |
| `mini_codegraph_modules` | List indexed modules |
| `mini_codegraph_react` | List React components, hooks, stores, React Query |
| `mini_codegraph_mongo` | List MongoDB entities, repositories, template usage |
| `mini_codegraph_redis` | List Redis hashes, template operations |
| `mini_codegraph_sql` | List SQL tables and statements (DDL/MyBatis/JPA/JDBC) |

## Requirements

- Node.js 22+ (for built-in `node:sqlite`)
- WASM grammar files in `grammars/` (included; auto-downloaded from CDN if missing)

## Project Structure

```
src/
├── cli.ts                    # Commander CLI (60+ commands)
├── index.ts                  # MiniCodeGraph main class
├── types.ts                  # Shared types
├── errors.ts                 # Error hierarchy + logger
├── utils.ts                  # File scanning, gitignore, hashing
├── generated.ts              # Generated/test file detection
├── db/                       # SQLite layer (connection, schema, queries)
├── extraction/               # tree-sitter AST parsing (44 files)
│   ├── grammar-loader.ts     # WASM grammar download + cache
│   ├── orchestrator.ts       # Scan → Parse → Store pipeline
│   ├── routes.ts             # Framework route detection (7 frameworks)
│   ├── languages/            # Per-language parsers (java, typescript, python, vue)
│   └── *.extractor.ts        # 40+ domain-specific extractors
├── graph/                    # Graph queries + BFS/DFS traversal
├── mcp/                      # MCP protocol server (12 tools)
├── search/                   # FTS5 search + fuzzy fallback
├── sync/                     # File watcher + git hooks
├── context/                  # Context builder
├── analysis/                 # Cyclomatic complexity, circular deps, dead imports
├── resolution/               # Symbol resolution (imports, framework resolvers)
├── visualization/            # Mermaid.js diagram generator
├── daemon/                   # Daemon MCP server
└── ui/                       # CLI UI components
```

## License

MIT
