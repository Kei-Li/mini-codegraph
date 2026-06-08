# mini-codegraph

Lightweight code knowledge graph engine — tree-sitter AST parsing, SQLite graph storage, MCP server for AI agents.

> 完整文档见 [`docs/`](docs/README.md) — 架构设计、AI Agent 开发指南、架构决策记录（ADRs）

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
mini-codegraph init /path/to/project --index

# Or step by step
mini-codegraph init /path/to/project
mini-codegraph index /path/to/project
```

## CLI Commands (60+)

### Setup
| Command | Description |
|---|---|
| `mini-codegraph init [path]` | Initialize database |
| `mini-codegraph index [path]` | Index all supported files |
| `mini-codegraph sync [path]` | Incremental — index only changed files |
| `mini-codegraph serve [path]` | Start MCP server (stdio, daemon, or shared) |
| `mini-codegraph install` | Configure for AI agents |

### Core Queries
| Command | Description |
|---|---|
| `mini-codegraph search <query>` | Search symbols (FTS5 + fuzzy fallback) |
| `mini-codegraph status` | Index statistics and detected frameworks |
| `mini-codegraph files` | List indexed files |
| `mini-codegraph modules` | List indexed modules |
| `mini-codegraph context <task>` | Build comprehensive context for a task |
| `mini-codegraph callers <symbol>` | Find callers of a symbol |
| `mini-codegraph callees <symbol>` | Find callees of a symbol |
| `mini-codegraph impact <symbol>` | Blast radius analysis |
| `mini-codegraph explore <symbols>` | Explore related symbols grouped by file |
| `mini-codegraph trace <from> <to>` | Show call path between two symbols |
| `mini-codegraph dead-code` | Find symbols with no callers |
| `mini-codegraph affected <files...>` | Find test files affected by source changes |

### Frontend & Database Analysis
| Command | Description |
|---|---|
| `mini-codegraph react` | React components, hooks, Redux/Zustand stores, React Query |
| `mini-codegraph mongo` | MongoDB @Document entities, repositories, MongoTemplate |
| `mini-codegraph redis` | Redis @RedisHash, RedisTemplate/Redisson operations |
| `mini-codegraph sql` | SQL tables (DDL), MyBatis/JPA/JDBC SQL statements |

### Java/Spring Domain Analysis
| Command | Description |
|---|---|
| `mini-codegraph routes` | Detect web framework routes |
| `mini-codegraph feign` | FeignClient cross-service call mappings |
| `mini-codegraph mybatis` | MyBatis mapper XML bindings |
| `mini-codegraph gateway` | API Gateway routes |
| `mini-codegraph mq` | Message queue bindings |
| `mini-codegraph api-map` | Vue frontend to API controller mappings |
| `mini-codegraph security` | Security annotations |
| `mini-codegraph jpa` | JPA entities |
| `mini-codegraph batch` | Spring Batch jobs |
| `mini-codegraph resilience` | Resilience policies |
| `mini-codegraph pinia` | Pinia stores |
| `mini-codegraph i18n` | i18n message usage |
| `mini-codegraph docker` | Docker deployment containers |
| `mini-codegraph k8s` | K8s resources |
| `mini-codegraph openapi` | OpenAPI contracts |
| `mini-codegraph diagram` | Mermaid architecture diagrams |
| `mini-codegraph config` | `@ConfigurationProperties` bindings |
| `mini-codegraph tx` | `@Transactional` annotations and propagation |
| `mini-codegraph cache` | Cache annotations and cache topology |
| `mini-codegraph lombok` | Lombok-synthesized methods |
| `mini-codegraph grpc` | gRPC services |
| `mini-codegraph mapstruct` | MapStruct mappers |
| `mini-codegraph autoconfig` | `@ConditionalOn*` auto-configuration |
| `mini-codegraph maven` | Maven module dependency graph |
| `mini-codegraph gradle` | Gradle module dependency graph |
| `mini-codegraph cloud-config` | `@RefreshScope` and Cloud Config |
| `mini-codegraph loadbalancer` | `@LoadBalanced` clients |
| `mini-codegraph graphql` | GraphQL endpoints |
| `mini-codegraph websocket` | WebSocket endpoints |
| `mini-codegraph test` | Test annotations |
| `mini-codegraph async` | `@Async` and `@Scheduled` methods |
| `mini-codegraph aop` | AOP aspects |
| `mini-codegraph security-filter` | SecurityFilterChain rules |
| `mini-codegraph k8s-net` | K8s Ingress/Service/NetworkPolicy |
| `mini-codegraph advice` | `@ControllerAdvice` handlers |
| `mini-codegraph interceptor` | HandlerInterceptor chain |
| `mini-codegraph stream-func` | Spring Cloud Stream functions |
| `mini-codegraph jpa-query` | JPA `@Query` annotations |
| `mini-codegraph profile` | `@Profile` annotations |

## MCP Tools (12 tools)

| Tool | Purpose |
|---|---|
| `mini_cg_search` | Quick symbol search by name |
| `mini_cg_context` | **Primary** — Build comprehensive context for a task |
| `mini_cg_trace` | Find call path between two symbols |
| `mini_cg_explore` | Batch query related symbols grouped by file |
| `mini_cg_callers` / `mini_cg_callees` | Find callers/callees |
| `mini_cg_node` | Get symbol details + source |
| `mini_cg_impact` | Blast radius analysis |
| `mini_cg_files` | List indexed files |
| `mini_cg_status` | Index health + detected frameworks |
| `mini_cg_feign` | List FeignClient interfaces and microservice targets |
| `mini_cg_mybatis` | Show MyBatis mapper XML bindings |
| `mini_cg_modules` | List indexed modules |
| `mini_cg_react` | List React components, hooks, stores, React Query |
| `mini_cg_mongo` | List MongoDB entities, repositories, template usage |
| `mini_cg_redis` | List Redis hashes, template operations |
| `mini_cg_sql` | List SQL tables and statements (DDL/MyBatis/JPA/JDBC) |

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
