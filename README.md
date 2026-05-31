# mini-codegraph

Lightweight code knowledge graph built from scratch — tree-sitter AST parsing, SQLite graph storage, MCP server.

## Features

- **tree-sitter** — AST parsing for Java and TypeScript/TSX
- **SQLite** — Graph storage with FTS5 full-text search, WAL mode
- **MCP Server** — Model Context Protocol server over stdio (10 tools)
- **Impact Analysis** — Blast radius analysis before editing code
- **Framework Routes** — Auto-detect Express, NestJS, Next.js, Spring, React Router, Fastify, Koa routes
- **Incremental Sync** — Only re-index new/changed files
- **Dead Code Detection** — Find symbols with no callers
- **Test Impact** — Find affected test files when source changes
- **File Watcher** — Auto-sync on file changes with debounce
- **Agent Installer** — Auto-configure for opencode, Claude Code and more

## Architecture

```
Source Files → tree-sitter WASM AST → SQLite (WAL + FTS5) → MCP Server (JSON-RPC 2.0) → AI Agent
```

## Install

```bash
git clone https://github.com/Kei-Li/mini-codegraph.git
cd mini-codegraph
npm install
npm run build
npm link
```

## CLI Usage

```bash
# Initialize and index a project
mini-cg init /path/to/project
mini-cg index /path/to/project

# Incremental update (new/changed files only)
mini-cg sync /path/to/project

# Search for symbols
mini-cg search "ClassName" /path/to/project

# Show statistics and detected frameworks
mini-cg status /path/to/project

# Find callers/callees
mini-cg callers "someMethod" /path/to/project
mini-cg callees "someMethod" /path/to/project

# Impact analysis (before editing)
mini-cg impact "someMethod" /path/to/project

# Build context for a task
mini-cg context "how does authentication work" /path/to/project

# Explore related symbols grouped by file
mini-cg explore "UserService,AuthController" /path/to/project

# List indexed files
mini-cg files /path/to/project

# Detect web framework routes
mini-cg routes /path/to/project

# Find test files affected by source changes
mini-cg affected /path/to/project src/main/java/com/example/UserService.java

# Find dead code
mini-cg dead-code /path/to/project

# Start MCP server with file watching (for AI agent integration)
mini-cg serve /path/to/project --daemon

# Install and configure for AI agents
mini-cg install --target=opencode --yes
```

## MCP Tools (10 tools)

| Tool | Purpose |
|---|---|
| `codegraph_search` | Search symbols by name (FTS5) |
| `codegraph_context` | Build task context with code + relationships + routes |
| `codegraph_trace` | Find call path between two symbols |
| `codegraph_explore` | Batch query related symbols grouped by file |
| `codegraph_callers` / `codegraph_callees` | Find callers/callees |
| `codegraph_node` | Get symbol details + source |
| `codegraph_impact` | Blast radius analysis with depth control |
| `codegraph_files` | List indexed files |
| `codegraph_status` | Index health + detected frameworks |

## Framework Route Detection

mini-codegraph automatically detects routes from:

- **Express.js** — `.get()`, `.post()`, etc.
- **NestJS** — `@Controller`, `@Get`, `@Post` decorators
- **Next.js** — File-based routing in `app/` and `pages/`
- **Spring Boot** — `@RequestMapping`, `@GetMapping`, etc.
- **React Router** — `<Route path="...">`
- **Fastify** — `.get()`, `.post()`, etc.
- **Koa** — `.get()`, `.post()`, etc.

## Project Structure

```
src/
├── cli.ts                    # Commander CLI
├── index.ts                  # MiniCodeGraph main class
├── types.ts                  # Shared types
├── utils.ts                  # File scanning, gitignore, hashing
├── db/
│   ├── connection.ts         # SQLite connection (WAL mode)
│   ├── schema.ts             # DDL + queries
│   └── queries.ts            # Database query layer
├── extraction/
│   ├── grammar-loader.ts     # tree-sitter WASM loader
│   ├── orchestrator.ts       # Scan → Parse → Store
│   ├── routes.ts             # Framework route detection
│   └── languages/
│       ├── java.ts           # Java AST queries
│       └── typescript.ts     # TypeScript/TSX AST queries
├── graph/
│   ├── queries.ts            # Graph query manager
│   └── traversal.ts          # BFS/DFS with interface→impl resolution
├── mcp/
│   ├── server.ts             # MCP protocol handler
│   ├── transport.ts          # Stdio JSON-RPC 2.0
│   └── tools.ts              # 10 tool definitions
├── search/
│   └── index.ts              # FTS query parser
└── sync/
    └── watcher.ts            # File watcher with auto-sync
grammars/
├── tree-sitter.wasm           # Core tree-sitter WASM
├── tree-sitter-java.wasm      # Java grammar
└── tree-sitter-typescript.wasm # TypeScript grammar
```

## Requirements

- Node.js 22+ (for built-in `node:sqlite`)
- WASM grammar files in `grammars/` (included)

## License

MIT
