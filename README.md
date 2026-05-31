# mini-codegraph

Lightweight code knowledge graph built from scratch — tree-sitter AST parsing, SQLite graph storage, MCP server.

## Architecture

```
Source Files → tree-sitter WASM AST → SQLite (WAL + FTS5) → MCP Server (JSON-RPC 2.0) → AI Agent
```

- **tree-sitter** — AST parsing for Java and TypeScript/TSX
- **SQLite** — Graph storage with FTS5 full-text search, WAL mode
- **MCP** — Model Context Protocol server over stdio (9 tools)
- **CLI** — Commander-based command line interface

## Install

```bash
npm install -g mini-codegraph
```

Or build from source:

```bash
git clone https://github.com/Kei-Li/mini-codegraph.git
cd mini-codegraph
npm install
npm run build
```

## Usage

```bash
# Initialize and index a project
mini-cg init /path/to/project
mini-cg index /path/to/project

# Search for symbols
mini-cg search "ClassName" /path/to/project

# Show statistics
mini-cg status /path/to/project

# Find callers/callees
mini-cg callers "someMethod" /path/to/project
mini-cg callees "someMethod" /path/to/project

# Build context for a task
mini-cg context "how does authentication work" /path/to/project

# List indexed files
mini-cg files /path/to/project

# Start MCP server (for AI agent integration)
mini-cg serve /path/to/project
```

## MCP Tools (9 tools)

| Tool | Purpose |
|---|---|
| `codegraph_search` | Search symbols by name (FTS5) |
| `codegraph_context` | Build task context with code + relationships |
| `codegraph_trace` | Find call path between two symbols |
| `codegraph_callers` / `codegraph_callees` | Find callers/callees |
| `codegraph_node` | Get symbol details + source |
| `codegraph_impact` | Blast radius analysis |
| `codegraph_files` | List indexed files |
| `codegraph_status` | Index health |

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
│   └── languages/
│       ├── java.ts           # Java AST queries
│       └── typescript.ts     # TypeScript/TSX AST queries
├── graph/
│   ├── queries.ts            # Graph query manager
│   └── traversal.ts          # BFS/DFS traversal
├── mcp/
│   ├── server.ts             # MCP protocol handler
│   ├── transport.ts          # Stdio JSON-RPC 2.0
│   └── tools.ts              # 9 tool definitions
├── search/
│   └── index.ts              # FTS query parser
└── sync/
    └── watcher.ts            # Chokidar file watcher
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


