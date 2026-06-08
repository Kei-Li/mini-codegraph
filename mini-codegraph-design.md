# Mini-CodeGraph 架构设计文档

## 1. 系统概述

Mini-CodeGraph 是一款本地优先的代码知识图谱引擎，通过 tree-sitter WASM 解析源码 AST，提取符号和调用关系，存入 SQLite 图数据库，通过 MCP Server 为 AI Agent 提供代码理解能力。

### 核心价值
- **零配置**：不改造存量项目即可接入
- **本地优先**：数据全在本地 SQLite，不联网
- **Agent 优先**：MCP 接口原生适配 AI 工具

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI Layer                             │
│  index / init / serve / query / workspace / exclude          │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    Orchestrator Layer                         │
│  MiniCodeGraph (index.ts)                                    │
│    ├── ExtractionOrchestrator (extraction/core/)             │
│    ├── GraphQueryManager (graph/)                            │
│    └── FileWatcher (sync/)                                   │
└──────┬──────────────┬──────────────┬────────────────────────┘
       │              │              │
┌──────▼────┐ ┌───────▼───────┐ ┌───▼───────────┐
│ Extraction │ │  Resolution   │ │    Sync       │
│  Pipeline  │ │  Pipeline     │ │    Layer      │
│            │ │               │ │               │
│ tree-sitter│ │ Cross-service │ │ File Watcher  │
│ WASM parse │ │ symbol resolve│ │ Incremental   │
│ 7+ Workers │ │ Maven/Gradle  │ │ change detect │
└──────┬─────┘ └───────┬───────┘ └───────┬───────┘
       │               │                 │
       └───────────────┼─────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                     Storage Layer                             │
│  SQLite (WAL + FTS5)                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │  nodes   │ │  edges   │ │  files   │ │fts_index │        │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                     │
│  │external_ │ │unresolved│ │annotations│                    │
│  │ symbols  │ │  refs    │ │          │                     │
│  └──────────┘ └──────────┘ └──────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

## 3. 模块结构

```
src/
├── index.ts                  # MiniCodeGraph 入口 (门面类)
├── types.ts                  # 核心类型定义
├── utils.ts                  # 工具函数 (FileLock, scanDirectory...)
├── logger.ts                 # 日志
│
├── cli/
│   ├── index.ts              # CLI 入口
│   └── commands/
│       ├── indexing.ts       # index / sync
│       ├── queries.ts        # search / callers / callees / impact
│       ├── serve.ts          # daemon / MCP server
│       ├── workspace.ts      # workspace 管理
│       ├── inspectors.ts     # 代码检查
│       └── exclude.ts        # 排除配置
│
├── extraction/
│   ├── core/
│   │   ├── orchestrator.ts   # 索引管线编排 (核心改造目标)
│   │   ├── worker-pool.ts    # Worker 线程池
│   │   ├── parse-worker.ts   # Worker 端解析逻辑
│   │   ├── worker-types.ts   # Worker 通信类型
│   │   ├── file-scanner.ts   # [新增] 流式文件扫描
│   │   ├── write-queue.ts    # [新增] 流式写入队列
│   │   ├── routes.ts         # 路由解析
│   │   └── post-processing.ts
│   ├── languages/            # 语言提取器
│   │   ├── java.ts
│   │   ├── typescript.ts
│   │   ├── python.ts
│   │   ├── kotlin.ts
│   │   └── vue.ts
│   ├── data/                 # 数据层提取器
│   └── infra/                # 基础设施提取器
│
├── db/
│   ├── connection.ts         # DatabaseConnection (SQLite 连接)
│   ├── queries.ts            # QueryManager (CRUD + 批量模式)
│   └── schema.ts             # DDL + FTS 定义
│
├── graph/
│   └── queries.ts            # GraphQueryManager (图查询)
│
├── resolution/
│   └── ...                   # 跨服务符号解析
│
├── sync/
│   ├── watcher.ts            # 文件变更监听
│   └── sync-service.ts       # 增量同步
│
├── daemon/
│   ├── server.ts             # Daemon 服务
│   ├── client.ts             # Daemon 客户端
│   └── shared.ts             # 共享 Daemon
│
├── mcp/
│   ├── server.ts             # MCP Server
│   ├── tools/                # MCP 工具实现
│   └── types.ts              # MCP 协议类型
│
└── workspace/
    ├── index.ts              # 工作区管理
    ├── graph-builder.ts      # 跨服务图构建
    └── extractors/           # 构建文件提取器
```

## 4. 索引管线设计（10w+ 文件并行方案）

### 4.1 当前架构问题

详见 `docs/ADR-001-parallel-streaming-pipeline.md`，核心问题：

1. **结果全量内存堆积**：`result.nodes/edges` 在 `indexProject` 返回前持续增长 → 300~500MB
2. **全量源码跨线程传输**：Worker 将源码 postMessage 回主线程 → ~1GB 序列化
3. **串行 Batch 屏障**：200 文件 Batch 完全串行，尾部慢文件阻塞后续
4. **无背压队列**：Worker 忙时退化为同步主线程解析
5. **FTS 重建阻塞**：5~30s 阻塞事件循环

### 4.2 目标架构：流式并行管线

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│ FileScanner  │────→│   ParsePool     │────→│   WriteQueue     │────→ SQLite
│ (生产者)      │     │  (N Workers)     │     │   (单消费者)       │
│              │     │                  │     │                  │
│ AsyncGenerator│    │ 仅 filePath 传参  │     │  即时写入+自动聚合  │
│ 背压感知      │     │  队列排队背压     │     │  不做全量累积      │
└───────────────┘     └──────────────────┘     └──────────────────┘
```

### 4.3 核心新组件

#### FileScanner（新增：`extraction/core/file-scanner.ts`）

```typescript
export class FileScanner {
  constructor(private root: string, private excludePatterns?: string[])

  /** 流式生成待索引文件路径 */
  async *scan(): AsyncGenerator<string>

  /** 预扫描获取文件统计信息（用于跳过未变更文件） */
  async *scanWithStats(): AsyncGenerator<{ path: string; stat: Stats; contentHash?: string }>
}
```

#### WriteQueue（新增：`extraction/core/write-queue.ts`）

```typescript
export class WriteQueue {
  constructor(private db: DatabaseConnection, private queries: QueryManager)

  /** 推送单个文件的解析结果到写入队列 */
  push(result: PendingWrite): void

  /** 等待所有排队写入完成 */
  flushSync(): void

  /** 当前队列深度（作为背压信号） */
  get pressure(): number
}

interface PendingWrite {
  nodes: MiniCodeGraphNode[]
  edges: EdgeRecord[]
  file?: FileRecord
  annotations?: AnnotationRecord[]
}
```

#### WorkerPool 改造（`extraction/core/worker-pool.ts`）

```typescript
export class WorkerPool {
  /** 提交解析任务，Worker 全忙时自动排队 */
  submit(task: ParseTask): Promise<ParseResult>
  
  /** 当前排队任务数 */
  get pending(): number
  
  /** 背压系数 0~1（0=空闲, 1=满载） */
  get pressure(): number
}

interface ParseTask {
  filePath: string
  absolutePath: string
  grammarName: string
  language: string
}

// WorkerResponse 不再包含 source
interface WorkerResponse {
  type: 'parse-result'
  id: number
  result: ExtractionResult
  contentHash: string
  stat: { size: number; mtimeMs: number }
}
```

### 4.4 管线整合

```typescript
async indexProject(root: string, ...): Promise<IndexResult> {
  const scanner = new FileScanner(root, excludePatterns)
  const writeQueue = new WriteQueue(this.db, this.queries)
  let totalNodes = 0, totalEdges = 0, totalFiles = 0
  const errors: string[] = []

  const CONCURRENCY = this.workerPool.size * 2
  const scannerIter = scanner.scan()[Symbol.asyncIterator]()

  // 流式管线：持续从 scanner 取文件，提交给 Worker Pool
  // Worker 返回后立即入 WriteQueue，不累积结果
  while (true) {
    const batch: string[] = []
    while (batch.length < CONCURRENCY) {
      const { value, done } = await scannerIter.next()
      if (done) break
      batch.push(value)
    }
    if (batch.length === 0) break

    // 提交一批文件给 Worker Pool（自动排队 + 背压）
    const results = await Promise.allSettled(
      batch.map(f => this.workerPool.subject({
        filePath: f, absolutePath: join(root, f), ...
      }))
    )

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        errors.push(`${batch[i]}: ${r.reason}`)
        continue
      }
      const parseResult = r.value
      totalNodes += parseResult.nodes.length
      totalEdges += parseResult.edges.length
      totalFiles++
      writeQueue.push({
        nodes: parseResult.nodes,
        edges: parseResult.edges,
        file: { path: batch[i], contentHash: parseResult.contentHash, ... },
      })
    }
  }

  writeQueue.flushSync()
  this.rebuildFtsInBackground()
  return { filesIndexed: totalFiles, totalNodes, totalEdges, errors }
}
```

### 4.5 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Worker 通信 | 仅传递 filePath | 消除 ~1GB 源码序列化开销 |
| 结果存储 | WriteQueue 即时写入 | 避免 O(N) 内存累积 |
| 背压机制 | 任务队列排队 | Worker 全忙时不退化为主线程 |
| FTS 重建 | 后台异步执行 | 不阻塞索引主流程 |
| DB 写入 | 单消费者 WriteQueue | node:sqlite 同步 API 天然串行 |

## 5. 数据模型

### SQLite 核心表

```sql
-- 符号节点
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,              -- "文件路径:符号名:起始行"
  kind TEXT NOT NULL,               -- class / method / field / interface / ...
  name TEXT NOT NULL,               -- 符号名
  qualified_name TEXT,              -- 全限定名
  file_path TEXT NOT NULL,
  language TEXT NOT NULL,
  start_line INTEGER, end_line INTEGER,
  start_column INTEGER, end_column INTEGER,
  docstring TEXT,
  signature TEXT,
  visibility TEXT DEFAULT 'public',
  is_exported INTEGER DEFAULT 0,
  parent_id TEXT,                   -- 父节点 ID (方法所属类)
  module_id TEXT DEFAULT 'default',
  metadata TEXT DEFAULT '{}'        -- JSON 扩展字段
);

-- 关系边
CREATE TABLE edges (
  source TEXT NOT NULL,              -- 调用者节点 ID
  target TEXT NOT NULL,              -- 被调用者节点 ID
  kind TEXT NOT NULL,                -- calls / imports / extends / implements / references
  metadata TEXT DEFAULT '{}',
  line INTEGER, col INTEGER
);

-- 文件记录
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  content_hash TEXT,
  language TEXT,
  size INTEGER,
  modified_at REAL,
  indexed_at REAL,
  node_count INTEGER DEFAULT 0,
  module_id TEXT DEFAULT 'default'
);

-- FTS5 全文搜索索引
CREATE VIRTUAL TABLE fts_nodes USING fts5(
  id, name, qualified_name, docstring, signature, file_path,
  content='nodes', content_rowid='rowid'
);
```

## 6. 接口契约

### MiniCodeGraph 门面类

```typescript
class MiniCodeGraph {
  static init(root: string): MiniCodeGraph
  static open(root: string): MiniCodeGraph | null

  async index(excludePatterns?: string[], fastMode?: boolean): Promise<IndexResult>
  async sync(): Promise<ExtractionResult>
  
  close(): void  // 停止 Workers + 关闭 DB + 释放锁

  getGraph(): GraphQueryManager
  getPendingFiles(): PendingFile[]
}
```

### GraphQueryManager 查询接口

```typescript
class GraphQueryManager {
  search(query: string, limit?: number): SearchResult[]
  getCallers(symbolId: string): Caller[]
  getCallees(symbolId: string): Callee[]
  getImpact(symbolId: string, depth?: number): ImpactResult
  getFlow(source: string, target: string): FlowPath | null
}
```

## 7. 实施路线

### 阶段一：核心管线重构（P0）
- 实现 `FileScanner` async generator
- 实现 `WriteQueue` with batch aggregation
- 修改 `indexProject` 使用流式模型
- 移除 `result.nodes/edges` 全量累积
- 去掉 Worker source 回传

### 阶段二：Worker Pool 增强（P0）
- 添加任务队列支持背压
- 添加 `pending()` 和 `pressure()` 信号
- Scanner 根据背压自适应调速

### 阶段三：写入优化（P1）
- 文件 upsert 改为批量 INSERT OR REPLACE
- `flushBatch` 改为增量 SQL 构建
- WAL checkpoint 定时触发

### 阶段四：后台化（P2）
- FTS 重建后台化
- Post-processing 流式触发
- Resolution pipeline 增量式
