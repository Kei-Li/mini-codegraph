# mini-codegraph — Developer Agent Guide

## 工作流程（必须遵守）

每次开发完成后，必须执行以下步骤，**不得跳过验收环节直接提交**：

```
开发 → 构建 + 测试 → 验收审查 → 全部 PASS → 提交 GitHub
                                ↓
                             FAIL → 返回开发修复
```

### Step 1: 开发实现
- 按照本指南进行编码、修改

### Step 2: 构建 + 测试
```bash
npm run build    # 必须无错误
npm test         # 必须全部通过
```

### Step 3: 验收审查
以 `ACCEPTANCE.md` 为验收标准，逐项审查本次改动涉及的范围：
- 遍历 ACCEPTANCE.md 清单中相关的检查项
- 对比设计文档 `mini-codegraph-design.md` 的具体要求
- 每项给出 PASS / FAIL / 部分PASS
- 若有 FAIL，记录具体文件、行号、修复方案

### Step 4: 结果判定
- **全部 PASS** → 进入 Step 5
- **存在 FAIL** → 返回 Step 1 修复，修复后重新执行 Step 2 → Step 3
- **部分PASS（轻微偏差）** → 评估是否影响功能正确性；不影响则可进入 Step 5

### Step 5: 提交 GitHub
```bash
git add -A
git status                # 确认只包含预期文件
git commit -m "描述本次变更"
git push
```

---

## Project Overview

mini-codegraph is a lightweight, local-first code knowledge graph engine. It parses source code (Java, TypeScript/JSX, Python, Vue, Kotlin) via tree-sitter WASM, stores nodes/edges in SQLite with FTS5, and exposes code intelligence through MCP tools and a CLI.

Based on a custom fork of `@colbymchenry/codegraph`, redesigned with a **workspace-aware global relationship layer** for cross-service microservice analysis. The reference project lives at `D:\IT\github-projects\codegraph`.

## Build, Test, Run

```bash
npm run build            # tsc → dist/
npm test                 # vitest run (all tests)
npm run test:watch       # vitest watch mode
npm run test:coverage    # vitest with coverage
npm run test:quick       # tsc + node --test
```

**CLI commands:**
```bash
node dist/cli/index.js init <path>          # Initialize DB
node dist/cli/index.js init <path> --index   # Init + index
node dist/cli/index.js init <path> --workspace <dir>  # Init with workspace
node dist/cli/index.js index <path>          # Full index
node dist/cli/index.js serve <path>          # MCP server over stdio
node dist/cli/index.js serve <path> --daemon # Daemon mode with file watching
# Also: sync, search, status, context, callers, callees, impact, files,
#        routes, feign, mybatis, modules, react, mongo, redis, sql, ...
```

## Architecture

### Layered Pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact, paths)
              ↓
       MCP Server / CLI (tools, context building)
```

### Module Layout

```
src/
├── index.ts              — MiniCodeGraph class (main API: init/open/index/sync)
├── types.ts              — All shared types, NodeKind/EdgeKind
├── cli.ts                — CLI (commander), all commands
├── cli/index.ts          — Entry point
├── db/
│   ├── connection.ts     — DatabaseSync wrapper (WAL, pragmas)
│   ├── schema.ts         — DDL + query constants
│   └── queries.ts        — QueryManager (CRUD + batch inserts)
├── extraction/
│   ├── orchestrator.ts   — ExtractionOrchestrator (file indexing)
│   ├── parse-worker.ts   — Worker thread for tree-sitter parsing
│   ├── grammar-loader.ts — WASM grammar loading
│   ├── routes.ts         — Route detection
│   ├── languages/        — Per-language extractors
│   └── (49 extractors)   — jpa, mybatis, redis, mongo, react, k8s, ...
├── graph/
│   ├── queries.ts        — GraphQueryManager (search, getCallers, impact, ...)
│   └── traversal.ts      — GraphTraverser (BFS path finding, tree-sitter bridge)
├── resolution/
│   ├── name-matcher.ts   — Symbol name matching (fuzzy)
│   ├── frameworks/       — Framework detectors (java/spring, vue, etc.)
│   └── callback-synthesizer.ts  — Dynamic dispatch synthesis
├── workspace/            — Cross-service global relationship layer
│   ├── scanner.ts        — WorkspaceScanner: detect projects in workspace
│   ├── sync.ts           — WorkspaceSync: orchestrate refresh
│   ├── graph-builder.ts  — WorkspaceGraphBuilder: build global graph
│   └── extractors/       — Framework extractors
│       ├── frameworks.ts — IExtractor interface + registry
│       ├── spring-cloud.ts
│       ├── rabbitmq.ts
│       ├── redis.ts
│       ├── database.ts
│       └── frontend.ts
├── mcp/
│   ├── server.ts         — MCPServer (JSON-RPC over stdio)
│   ├── tools.ts          — Tool definitions (mini_cg_*)
│   └── handlers/         — Tool handler implementations
├── search/               — FTS5 search + fuzzy fallback
├── context/              — ContextBuilder (markdown formatting)
├── sync/                 — FileWatcher (chokidar), git-hooks
├── daemon/               — Daemon mode (TCP socket, shared daemon)
├── analysis/             — CodeAnalyzer (Spring patterns, transactions)
├── visualization/        — Mermaid diagram generation
├── ui/                   — Terminal UI (shimmer progress)
└── shared/               — Config loader
```

### Key Data Types (from types.ts)

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`, `defines`

### External (Cross-Service) Tables

```
external_symbols — interfaces/endpoints provided by other services
  (id, name, kind, providing_service, definition_file, signature, metadata)

external_references — how current service consumes external symbols
  (id, source_location, external_symbol_id, reference_type, target_service, metadata)
```

## Module Interactions

- **Core** (`MiniCodeGraph`) provides single-project indexing API — workspace-unaware.
- **Workspace** module calls core's extractors to discover interfaces, builds global cross-service edges, injects into current project's `external_*` tables.
- **MCP** module queries core storage (including `external_*` tables), merges internal + external results with provenance tagging.
- **GraphQueryManager** is the main query facade: `search()`, `getCallers()`, `getCallees()`, `getImpact()`, `findPath()`, `getContext()`, etc.

## Key Design Patterns

1. **MockGraph in tests**: Use `createMockGraph(overrides)` to mock `GraphQueryManager` — all MCP tools accept `(args, graph)` so testing is simple.

2. **Batch inserts**: `QueryManager.enableBatchMode()` + `flushBatch()` for bulk indexing. Chunks of 2000 rows per INSERT.

3. **IExtractor interface** (`workspace/extractors/frameworks.ts`):
   ```ts
   interface IExtractor {
     name: string
     extract(projectRoot: string, queries: QueryManager): Promise<ExtractionOutput>
   }
   // ExtractionOutput = { provides: [...], consumes: [...] }
   ```

4. **Workspace sync flow**:
   - `WorkspaceScanner.scan()` → detects all projects
   - `frameworkExtractor.extractAll(projectRoot, queries)` → collects provides/consumes per project
   - `WorkspaceGraphBuilder.refreshExternalTables()` → diffs, inserts into `external_*` tables
   - Hash-based caching avoids re-extracting unchanged projects

5. **Pragmas for SQLite** (connection.ts):
   - WAL mode, synchronous=NORMAL, cache=-65536 (64MB), mmap=256MB, temp_store=MEMORY

## Extension Points

### New Language Support
1. Add WASM grammar file to `grammars/`
2. Add `LanguageConfig` entry in `types.ts:SUPPORTED_LANGUAGES`
3. Add tree-sitter queries in `extraction/languages/`
4. Register in `ExtractionOrchestrator`

### New Framework Extractor
1. Implement `IExtractor` interface
2. Register in `WorkspaceSync` constructor via `frameworkExtractor.register()`
3. Add file in `workspace/extractors/`

### New MCP Tool
1. Add definition in `mcp/tools.ts` (`createTools()` array)
2. Add handler implementation (or import from `mcp/handlers/`)
3. Add integration test in `tests/mcp-tools.test.ts`

## Testing Patterns

- **Unit tests** with mocked `GraphQueryManager` (see `tests/mcp-tools.test.ts`)
- **Integration tests** with temp directories and real `MiniCodeGraph` instances (see `tests/index.test.ts`)
- All tests use `vi.mock()` for external modules (file system, tree-sitter, etc.)
- Tests create temp dirs via `mkdtempSync` and clean up in `afterEach`
- Coverage: `vitest run --coverage` (v8 provider, excludes daemon/ and cli.ts)

## 验收标准

项目验收标准定义在 `ACCEPTANCE.md`，开发完成后必须对照该文件逐项审查：
- `ACCEPTANCE.md` 覆盖 Design §4-§12 的全部关键检查项
- 每个 FAIL 必须修复后才能提交
- 验收结果可作为 commit message 的附件说明

## Cross-Project Reference

The upstream `codegraph` project at `D:\IT\github-projects\codegraph` has more mature implementations of:
- Complex framework resolvers (`src/resolution/frameworks/`)
- Dynamic dispatch synthesis (`callback-synthesizer.ts`)
- Installer/target system (`src/installer/`)
- Agent evaluation benchmarks (`__tests__/evaluation/`)
- Bundling and release workflows
- Detailed MCP server instructions (`server-instructions.ts`)

When implementing complex features (especially around resolution, synthesis, or MCP tool behavior), check the codegraph project for reference implementations and patterns.

## Code Conventions

- **TypeScript** with `NodeNext` module resolution, strict mode
- **Biome** for formatting (`indentWidth: 2`, `quoteStyle: single`, `trailingCommas: all`, `lineWidth: 120`)
- **No commented code** — if something isn't needed, remove it
- **No console.log in production code** — use the `logger.ts` or `console.error` for daemon/server mode
- **async/await** over raw promises
- **Named exports** over default exports
- **Import with `.js` extension** (per NodeNext module resolution): `from './foo.js'`
- **SQL** in `db/schema.ts` as exported constants (uppercase)
- **Error handling**: Return structured error objects from tools, use try-catch in CLI
- **Path handling**: Always use `path.resolve()` and prefix checks to prevent path traversal
