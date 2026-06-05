# Mini-CodeGraph 企业级设计方案

> **目标**：面向 50 个左右微服务的大型旧系统，为 AI 编程助手提供代码知识图谱，让 Agent 理解跨服务依赖，修改代码时不跑偏。

---

## 统一命名规范

| 项 | 值 |
|---|---|
| 命令 | `mini-codegraph` |
| 存储目录 | `.mini-codegraph/` |
| 数据库 | `mini-codegraph.db` |
| MCP 工具前缀 | `mini_cg_` |
| 配置文件 | `workspace.yml` |

---

## 1. 项目概述

### 1.1 背景

大型企业系统通常由 **40-60 个微服务**（Spring Cloud + RabbitMQ + Redis + MySQL + MongoDB + Vue/React/TS）构成，开发者本地拥有全部仓库。AI 编程助手（Claude Code、opencode 等）在修改代码时需要理解：

- 当前服务的内部符号定义与引用
- **跨服务调用链**（Feign、RestTemplate、Gateway）
- **中间件依赖**（MQ 生产/消费、Redis 缓存、数据库表读写）
- **前后端关联**（Vue/React 组件 → API 路由）
- **架构规则**（分层依赖、循环依赖）

缺少这些上下文，Agent 容易"跑偏"——改错接口签名、遗漏调用方、误判影响范围。

### 1.2 解决方案

Mini-CodeGraph 是一个**本地优先、零配置**的代码知识图谱引擎：

- 通过静态分析（tree-sitter）构建**单仓库符号关系图**（函数、类、方法、字段 → 调用/继承/实现边）
- 扩展**工作区全局关系层**，自动发现工作区内全部项目，提取跨服务接口、中间件拓扑、数据库依赖
- 通过 **MCP 协议**向 Agent 暴露专用工具，将结构化信息注入 LLM 上下文
- Agent 修改代码前可实时查询"谁调用了我、我调用了谁、影响哪些服务"

### 1.3 适用规模

| 维度 | 目标 |
|---|---|
| 工作区项目数 | 10-60 个微服务/前端项目 |
| 单项目文件数 | 数百～数万 |
| 全量文件总数 | 10 万+ |
| 首次全量索引 | < 5 分钟（16 核） |
| 增量索引 | < 2 秒 |
| 全局关系刷新 | < 5 秒 |

---

## 2. 核心设计目标

| 目标 | 说明 |
|---|---|
| **单进程本地运行** | 无中心服务器，完全离线，所有数据存储在本地 SQLite |
| **50 服务全局视野** | 自动发现工作区全部项目，构建跨仓库符号依赖图 |
| **Agent 优先** | 通过 MCP 暴露结构化查询工具，Agent 零学习成本 |
| **零配置上手** | `mini-codegraph init --workspace ./` 全自动完成 |
| **实时反馈** | 文件保存后秒级更新，跨服务接口变更自动感知 |
| **全栈深度覆盖** | Java/Kotlin（Spring 全家桶）+ Vue/React/TS + Python |
| **离线安全** | 不联网、不收集数据、敏感信息自动脱敏 |

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│              Agent (Claude Code / opencode / IDE)         │
│                   MCP 协议 (stdio)                        │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                   mini-codegraph (单进程)                  │
│                                                           │
│  ┌─────────────┬──────────────┬──────────────┬─────────┐ │
│  │  解析提取层   │   图存储层    │  语义解析层   │  上下文  │ │
│  │ extraction/ │    db/       │ resolution/  │ context/│ │
│  │ · 5 语言解析  │ · SQLite+FTS5│ · 动态推断    │ · 预算   │ │
│  │ · 25+提取器  │ · nodes/edges│ · Bean 解析  │ · 聚合  │ │
│  └──────┬───────┴──────┬───────┴──────┬───────┴────┬────┘ │
│         │              │              │            │       │
│  ┌──────▼──────────────▼──────────────▼────────────▼─────┐ │
│  │              工作区全局关系层 workspace/                 │ │
│  │  · scanner：项目发现 (pom.xml/package.json/.git)       │ │
│  │  · extractors/：8 个提取器（Spring Cloud、Gateway、    │ │
│  │    RabbitMQ、Redis、Database、Frontend、OpenAPI、      │ │
│  │    Database Migration）                                │ │
│  │  · graph-builder：全局图构建                            │ │
│  │  · sync：增量同步 + 哈希缓存                            │ │
│  └───────────────────────┬───────────────────────────────┘ │
│                          │                                  │
│  ┌───────────────────────▼───────────────────────────────┐ │
│  │  索引同步层 sync/                                     │ │
│  │  · 文件监视器 (chokidar + fs.watch)                    │ │
│  │  · Git 同步 / Git Hooks                               │ │
│  │  · 工作树管理 / 监视策略                               │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  MCP 服务层 mcp/ (21 个工具)                           │ │
│  │  · 搜索：search, context, explore                      │ │
│  │  · 导航：callers, callees, impact, node, files         │ │
│  │  · 全局：workspace_status, metrics, summary            │ │
│  │  · 高级：mermaid, dispatch, affected_tests 等          │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                           │
│  存储：.mini-codegraph/mini-codegraph.db                   │
└───────────────────────────────────────────────────────────┘
```

**核心理念**：每个项目本地存储自身的符号图 + 相关的跨服务外部符号/引用表。查询完全本地化，不依赖任何远程服务。MCP Server 启动后自动加载索引并开启监视。

---

## 4. 模块与代码结构

```
src/
├── extraction/                  # 解析提取层
│   ├── orchestrator.ts          # 解析编排器
│   ├── routes.ts                # 路由提取
│   ├── languages/               # tree-sitter 语言解析
│   │   ├── java.ts              # Java/Kotlin (Spring 注解)
│   │   ├── typescript.ts        # TS/JS/JSX/TSX
│   │   ├── python.ts            # Python (FastAPI/Flask)
│   │   ├── kotlin.ts            # Kotlin
│   │   └── vue.ts               # Vue SFC
│   ├── [25+ extractors]         # AOP、JPA、Security、ControllerAdvice 等
│   ├── stream-function-extractor.ts
│   ├── async-extractor.ts
│   ├── http-exchange-extractor.ts
│   └── observability-extractor.ts
├── db/                          # 图存储层
│   ├── connection.ts            # SQLite 连接管理
│   ├── schema.ts                # 全部表定义 + 查询语句
│   └── queries.ts               # GraphQueryManager
├── graph/                       # 图查询层
│   ├── queries.ts               # 图查询 (1576 行)
│   └── traversal.ts             # 图遍历算法
├── workspace/                   # 工作区全局关系层
│   ├── scanner.ts               # 项目发现
│   ├── graph-builder.ts         # 全局图构建
│   ├── sync.ts                  # 增量同步
│   └── extractors/              # 框架/中间件提取器
│       ├── spring-cloud.ts      # Spring Cloud (Feign/RestTemplate/Controller)
│       ├── gateway.ts           # Spring Cloud Gateway
│       ├── rabbitmq.ts          # RabbitMQ 生产/消费
│       ├── redis.ts             # Redis 缓存
│       ├── database.ts          # 数据库 (JPA/MyBatis/JDBC)
│       ├── frontend.ts          # 前端 (Vue/React/axios)
│       ├── openapi.ts           # OpenAPI 规范
│       └── database-migration.ts # 数据库迁移 (Flyway/Liquibase)
├── mcp/                         # MCP 服务层
│   ├── server.ts                # MCP Server (220 行)
│   ├── tools.ts                 # 21 个工具定义 (670 行)
│   ├── transport.ts / stdio-transport.ts / proxy.ts
│   ├── types.ts
│   └── handlers/
│       ├── workspace-status.ts  # 工作区状态
│       └── index.ts
├── resolution/                  # 语义解析层
│   ├── dispatch-inference/      # 动态调用推断
│   │   ├── detectors/           # 7 个检测器插件
│   │   ├── resolver.ts
│   │   └── variable-tracer.ts
│   └── frameworks/              # 框架检测
│       ├── java.ts              # Spring 多模块检测
│       └── vue.ts               # Vue 项目检测
├── sync/                        # 索引同步层
│   ├── watcher.ts               # 文件监视器
│   ├── git-sync.ts              # Git 同步
│   ├── git-hooks.ts             # Git Hooks
│   ├── watch-policy.ts          # 监视策略
│   ├── worktree.ts              # 工作树管理
│   └── index.ts
├── search/                      # 搜索层
│   ├── fuzzy.ts                 # 模糊搜索
│   ├── query-parser.ts          # 查询解析
│   └── index.ts
├── analysis/                    # 分析层
│   └── index.ts                 # 分析引擎
├── context/                     # 上下文层
│   ├── budget.ts                # 上下文预算
│   ├── formatter.ts             # 格式器
│   ├── polymorph.ts             # 多态处理
│   └── index.ts
├── daemon/                      # 守护进程
│   ├── server.ts / client.ts / shared.ts
├── ui/                          # UI
│   ├── glyphs.ts / shimmer-progress.ts / types.ts
├── visualization/               # 可视化
│   └── mermaid.ts               # Mermaid 图生成
├── cli.ts                       # CLI 入口 (1595 行)
├── cli/index.ts                 # CLI 引导
├── index.ts                     # MiniCodeGraph 主类
├── types.ts                     # 类型定义
├── utils.ts                     # 工具函数
├── logger.ts                    # 日志
├── errors.ts                    # 错误定义
└── generated.ts                 # 生成的辅助代码
```

### 模块交互原则

- **extraction/** 提供单文件/单仓库解析能力，不感知全局
- **workspace/** 在初始化或刷新时调用 extraction/ 的解析能力提取接口，构建全局边，写入 db/
- **mcp/** 直接查询 db/（含 external_* 表），返回统一结果
- **sync/** 监听文件变更，驱动 extraction/ 增量解析和 workspace/ 增量刷新
- **resolution/** 增强静态分析结果（反射推断、Bean 注入解析）

---

## 5. 核心数据结构

### 5.1 存储路径

```
.mini-codegraph/
├── mini-codegraph.db          # SQLite 数据库
├── workspace.yml              # 工作区配置
└── .lock                      # 文件锁（防多实例）
```

### 5.2 数据库表

#### 节点表（替代设计中的 symbols）

```sql
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,              -- function, method, class, interface, field, ...
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER, end_line INTEGER,
    start_column INTEGER, end_column INTEGER,
    docstring TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    visibility TEXT DEFAULT 'public',
    is_exported INTEGER DEFAULT 0,
    parent_id TEXT,                  -- 父节点（如方法所属类）
    module_id TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}'
);
```

#### 边表（替代设计中的 references）

```sql
CREATE TABLE edges (
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,              -- calls, imports, contains, implements, extends, ...
    metadata TEXT DEFAULT '{}',
    line INTEGER DEFAULT 0, col INTEGER DEFAULT 0,
    PRIMARY KEY (source, target, kind)
);
```

#### 文件表

```sql
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    modified_at INTEGER DEFAULT 0,
    indexed_at INTEGER DEFAULT 0,
    node_count INTEGER DEFAULT 0,
    module_id TEXT DEFAULT ''
);
```

#### 全文搜索

```sql
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    name, qualified_name, docstring, signature,
    content='nodes', content_rowid='rowid',
    tokenize='unicode61'
);
-- 自动同步触发器：INSERT / DELETE / UPDATE 时维护 FTS5
```

#### 跨服务关系表

```sql
CREATE TABLE external_symbols (
    id TEXT PRIMARY KEY,             -- 全局唯一ID，如 "feign.InventoryClient/reserve"
    name TEXT NOT NULL,
    kind TEXT NOT NULL,              -- http_endpoint, mq_queue, db_table, cache_key, ...
    providing_service TEXT NOT NULL, -- 所属服务名
    definition_file TEXT DEFAULT '',
    signature TEXT DEFAULT '',
    metadata JSON DEFAULT '{}'
);

CREATE TABLE external_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_location TEXT NOT NULL,   -- 引用位置 (file:line:col)
    external_symbol_id TEXT NOT NULL REFERENCES external_symbols(id),
    reference_type TEXT NOT NULL,    -- rpc_call, http_request, mq_publish, db_rw, ...
    target_service TEXT DEFAULT '',
    source_service TEXT DEFAULT '',
    metadata JSON DEFAULT '{}'
);
```

#### 辅助表

| 表 | 用途 |
|---|---|
| `modules` | 多模块项目子模块注册 |
| `unresolved_refs` | 未解析的符号引用（待后续推断） |
| `annotations` | Java/Kotlin 注解索引 |
| `templates` | Vue SFC 模板元数据 |
| `project_metadata` | 项目级元数据（版本、创建时间） |

---

## 6. 核心流程

### 6.1 项目初始化

```
mini-codegraph init --workspace D:/workspace/microservices
```

1. **加载配置**：生成 `.mini-codegraph/workspace.yml`
2. **扫描工作区**：遍历根目录下一级子目录，识别含 `pom.xml`、`build.gradle`、`package.json`、`.git` 的独立项目
3. **多模块检测**：识别 Maven/Gradle 多模块项目，注册子模块
4. **提取接口清单（并行）**：对每个项目调用提取器，输出该服务的 provides / consumes
5. **构建全局图**：所有 provides → 全局符号表，consumes 匹配 → 跨项目引用边
6. **写库**：跨服务边写入 external_symbols / external_references
7. **启动监视**：监视当前项目文件 + 工作区其他项目的接口定义文件

### 6.2 全量索引

```
mini-codegraph index
```

- **文件发现**：fast-glob 扫描，跳过 `.gitignore` + node_modules/target/build/dist/.venv
- **大文件跳过**：> 1MB 跳过，> 500KB 仅提取顶层符号
- **并行解析**：Worker 线程池（CPU 核数 -1），每 Worker 复用 tree-sitter 解析器
- **批量写入**：每 5000 条或 2 秒事务提交；索引前 DROP INDEX，完成后 CREATE INDEX
- **SQLite 优化**：`PRAGMA journal_mode=WAL; synchronous=OFF; cache_size=-65536`

### 6.3 增量同步

文件保存后自动触发（防抖 2 秒）：

1. 仅重新解析变更文件
2. 局部更新 nodes / edges / files 表
3. 若涉及对外接口变更，触发轻量级工作区刷新
4. 接口清单哈希缓存，仅变更才重新提取

### 6.4 Agent 查询处理

Agent 调用 `mini_cg_callers` 时，查询合并内部 + 外部数据：

```sql
-- 内部调用者
SELECT source_location, caller_name FROM internal_callers WHERE target_id = ?
UNION ALL
-- 本服务消费的外部接口
SELECT source_location, symbol_name FROM external_refs WHERE symbol_id = ?
UNION ALL
-- 其他服务调用本服务
SELECT source_location, symbol_name FROM external_refs
WHERE providing_service = 'current-service'
```

结果标注 `provenance: internal | external`，Agent 可清晰区分。

---

## 7. 语言与框架支持

### 7.1 当前实现的语言解析

| 语言 | 解析工具 | 状态 |
|---|---|---|
| Java/Kotlin（含 Spring 注解） | tree-sitter-java + tree-sitter-kotlin | ✅ 完整 AST |
| TypeScript/JavaScript/JSX/TSX | tree-sitter-tsx | ✅ 完整 AST |
| Vue SFC（template/script/style） | tree-sitter-vue | ✅ 完整解析 |
| Python（FastAPI/Flask） | tree-sitter-python | ✅ 按需支持 |
| Groovy | 正则 + AST 片段 | ⚠️ 轻度解析 |

### 7.2 预留的语言扩展

| 语言 | 计划 |
|---|---|
| CSS/SCSS/Less | tree-sitter-css/scss — 类选择器提取 |
| HTML | tree-sitter-html — 元素 id/ref |
| GraphQL | tree-sitter-graphql — schema/operation 提取 |
| Markdown | tree-sitter-markdown — 轻度索引 |
| Go / C# | 架构预留，暂不实现 |

### 7.3 框架版本兼容性

Mini-CodeGraph 的框架提取器已验证以下版本：

| 框架/中间件 | 兼容版本 | 说明 |
|---|---|---|
| **Spring Boot** | 3.5.x（最新 3.5.14） | 需 Java 17+ |
| **Spring Framework** | 6.2.x（最新 6.2.18） | Spring Boot 3.5 内置 |
| **Spring Cloud** | 2025.0.x (Northfields) | 对应 Spring Boot 3.5.x |
| **Spring Security** | 6.5.x | — |
| **Spring Data BOM** | 2025.0.x | 含 JPA、MongoDB、Redis 等 |
| **Spring Authorization Server** | 1.5.x | — |
| **Spring GraphQL** | 1.4.x | — |
| **Spring Integration** | 6.5.x | — |
| **Spring Kafka** | 3.3.x（最新 3.3.15） | — |
| **Spring LDAP** | 3.3.x（最新 3.3.7） | — |
| **Spring Session** | 3.5.x | — |
| **Spring Batch** | 5.2.x | — |
| **RabbitMQ** | 3.13.x | 提取器适配 |
| **Redis** | 7.x | 提取器适配 |
| **MySQL** | 8.x / 9.x | JPA / MyBatis 提取 |
| **MongoDB** | 7.x / 8.x | Spring Data MongoDB 提取 |
| **Vue** | 3.x | SFC 解析 |
| **React** | 18.x / 19.x | TSX 解析 |

> 以上版本由 `spring-boot-dependencies` BOM 统一管理，提取器基于这些版本的注解/配置模式开发，对更早版本也保持基本兼容。框架版本不影响项目本身的运行，仅影响提取器的注解识别准确度。

---

## 8. 框架与中间件提取规则

### 8.1 Spring Cloud 组件

| 组件 | 提供/消费 | 提取方法 |
|---|---|---|
| 服务注册 | 提供：spring.application.name | 解析 bootstrap.yml / application.yml |
| Feign | 消费：@FeignClient(name="xxx") 方法 | tree-sitter AST 提取接口名、方法签名 |
| RestTemplate | 消费：http://SERVICE/... | 正则匹配 URL 中的服务名 |
| WebClient | 消费：webClient.get().uri("http://SERVICE/...") | AST + 正则混合 |
| Gateway 路由 | 消费：routes[].uri: lb://service | YAML 解析 |
| Controller | 提供：@RequestMapping/@GetMapping 路径 | tree-sitter 提取路径和 HTTP 方法 |
| WebFlux | 提供：RouterFunction 路由 | AST 提取 |
| Spring Data REST | 提供：自动暴露的 REST 端点 | 推断并注册 |

### 8.2 RabbitMQ

| 角色 | 提取方法 |
|---|---|
| 生产者 | rabbitTemplate.convertAndSend(exchange, routingKey, msg) — AST 提取参数 |
| 消费者 | @RabbitListener(queues = "xxx") — 提取队列名 |
| 拓扑关联 | 解析 application.yml 中的 bindings、exchanges、queues |

### 8.3 数据库与缓存

| 中间件 | 提供/消费 | 提取方式 |
|---|---|---|
| MySQL | 消费：表读写 | JPA @Table、MyBatis XML、JdbcTemplate SQL 分析 |
| MongoDB | 消费：集合读写 | @Document(collection="xxx") |
| Redis | 消费：键访问 | 正则提取 redisTemplate.opsForValue().get("key")；@Cacheable AST |
| 数据库迁移 | 表结构定义 | Flyway / Liquibase 脚本解析 |

### 8.4 前后端关联

前端 axios/fetch 调用 URL 与后端 Controller 路由通过路径和方法匹配，建立连线。支持 Vue Router 和 React Router 的路由定义解析。

### 8.5 额外提取器

| 提取器 | 用途 |
|---|---|
| OpenAPI | 解析 openapi.yaml 提取端点定义 |
| AOP | @Aspect/@Around 切面解析 |
| Security | @Secured/@PreAuthorize 安全注解 |
| ControllerAdvice | @ExceptionHandler 全局异常处理 |
| Observability | @Timed/@Counted 监控注解 |
| HTTP Exchange | @HttpExchange 声明式 HTTP 客户端 |

---

## 9. 性能架构

### 9.1 性能目标

| 指标 | 目标 |
|---|---|
| 首次全量索引（10 万文件） | < 5 分钟（16 核） |
| 增量索引（保存单个文件） | < 2 秒 |
| 工作区全局关系刷新（50 服务） | < 5 秒 |
| 符号搜索（FTS5） | < 50ms |
| 调用者/影响分析查询 | < 200ms |
| 内存峰值 | < 2 GB |
| 磁盘占用 | < 源码大小的 15% |

### 9.2 索引加速

| 策略 | 说明 |
|---|---|
| Worker 线程池 | `os.cpus().length - 1`，复用 tree-sitter 实例 |
| 批量事务 | 每 5000 条或 2 秒提交；全量前 DROP INDEX 后 CREATE |
| SQLite WAL 模式 | `journal_mode=WAL; synchronous=OFF; cache_size=-65536` |
| 大文件截断 | > 1MB 跳过，> 500KB 仅顶层符号 |
| --fast 模式 | 仅索引签名 + 导入，1 分钟内完成 10 万文件 |
| LRU 缓存 | MCP Server 缓存最近 500 条查询结果 |

### 9.3 工作区刷新

- 每个项目接口清单**哈希缓存**，仅变更才重新提取
- 全局符号匹配在内存 HashMap 完成
- external_* 表差异更新，不整表重建

---

## 10. MCP 工具与 Agent 交互

### 10.1 工具列表（当前已实现 21 个）

| 工具名 | 参数 | 用途 |
|---|---|---|
| **搜索类** | | |
| `mini_cg_search` | query, kind?, limit?, offset? | 按名称搜索符号，FTS5 全文匹配 |
| `mini_cg_context` | task, maxNodes?, includeCode? | 根据任务描述自动收集相关符号和代码片段 |
| `mini_cg_explore` | query | 自然语言探索，返回相关符号与源码 |
| **导航类** | | |
| `mini_cg_callers` | symbolId, limit?, offset? | 获取所有调用者（含外部服务） |
| `mini_cg_callees` | symbolId, limit?, offset? | 获取所有被调用者（含 MQ/DB） |
| `mini_cg_impact` | symbolId, depth? | 影响面分析（递归展开调用链） |
| `mini_cg_node` | symbolId | 符号详情 + 完整源码 |
| `mini_cg_files` | directory? | 浏览项目文件结构 |
| `mini_cg_file_content` | path | 获取文件内容 |
| **全局类** | | |
| `mini_cg_workspace_status` | 无 | 工作区所有服务概览（项目数、语言、状态） |
| `mini_cg_summary` | scope? | 项目或工作区摘要统计 |
| `mini_cg_metrics` | 无 | 性能指标（索引时间、缓存命中率等） |
| **高级类** | | |
| `mini_cg_mermaid` | focus? | 生成 Mermaid 依赖关系图 |
| `mini_cg_related_tests` | file, symbol? | 找出与变更相关的测试文件 |
| `mini_cg_dispatch` | file? | 识别 dispatch/策略模式的所有分发目标 |
| `mini_cg_search_files` | pattern | 按 glob 模式搜索文件 |
| `mini_cg_recent_changes` | hours? | 近期变更的文件和符号 |
| `mini_cg_unresolved_refs` | limit?, offset? | 未解析的引用列表 |
| `mini_cg_export` | format? | 导出图数据（JSON/DOT） |
| `mini_cg_module` | 无 | 当前模块/项目信息 |
| `mini_cg_available_tools` | 无 | 列出所有可用工具及用法 |

### 10.2 Agent 使用引导

```
你是项目代码助手。理解代码时，优先使用 mini_cg_* 工具：
- 修改公共函数/接口前，先用 mini_cg_callers 检查全局调用者
- 评估变更影响使用 mini_cg_impact
- 需要跨服务信息时查看 mini_cg_workspace_status（50+ 服务概览）
- 理解业务流程使用 mini_cg_explore 或 mini_cg_context
- 查看依赖关系使用 mini_cg_mermaid
- 处理动态调用使用 mini_cg_dispatch
```

### 10.3 典型交互示例

**用户**："修改订单服务的取消接口，需要改哪些地方？"

**Agent**：
1. `mini_cg_search("cancelOrder")` → 定位符号
2. `mini_cg_callers(orderCancel)` → 发现 3 个内部调用者 + 2 个外部服务（支付服务、仓储服务）通过 Feign 调用
3. `mini_cg_impact(orderCancel, depth=2)` → 影响链路：取消订单 → 释放库存 → 退款
4. `mini_cg_workspace_status` → 确认支付服务和仓储服务在本地已克隆
5. 读取源码，分析影响，给出修改方案

---

## 11. 安全与隐私设计

| 维度 | 措施 |
|---|---|
| **离线运行** | 不发起任何网络连接（除 MCP stdio），无遥测 |
| **路径安全** | `path.resolve` + 前缀比对防路径穿越，限制在工作区目录内 |
| **敏感过滤** | 跳过 .env/*.pem/*.key/credentials.*；配置中 password/secret/token 脱敏 |
| **只读访问** | 所有 MCP 工具只读，不修改代码或索引 |
| **文件锁** | `.mini-codegraph/.lock` 防多实例写入冲突 |

---

## 12. 边界与异常处理

| 场景 | 处理策略 |
|---|---|
| 超大仓库 | `--progress` 进度指示；`--fast` 快速模式；检查点中断恢复 |
| 不完整工作区 | 未克隆仓库标记 `unavailable`，Agent 不误判 |
| 动态代码 | `@reflective` 伪节点标记，提示 Agent 存在动态调用风险 |
| 解析失败降级 | 回退正则提取，标记 `precision: low` |
| 并发保护 | SQLite WAL 模式 + 文件锁 |
| 语言混合项目 | 按扩展名分配解析器，跨语言调用关联（如 JNI） |

---

## 13. 扩展性预留

| 方向 | 说明 |
|---|---|
| **插件化提取器** | 实现 IExtractor 接口，注册到 workspace/extractors/ |
| **自定义提取规则** | 放置在 `.mini-codegraph/extractors/` 自动加载 |
| **业务标签** | metadata JSON 字段注入 tags（如 `domain:order`） |
| **语义搜索** | 向量嵌入 + sqlite-vss，增加 `mini_cg_semantic_search` |
| **远程团队** | 架构预留可选的全局图中心服务 |

---

## 14. 技术选型与部署

### 14.1 项目技术栈

| 层面 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 语言 / 运行时 | TypeScript / Node.js | 22.5+（22 LTS） | MCP 生态、异步 I/O |
| 解析引擎 | tree-sitter | 0.20+ | 多语言 AST 解析 |
| 存储 | SQLite + FTS5 | 3.46+（Node 内置） | 零依赖、嵌入式全文搜索 |
| MCP 协议 | @modelcontextprotocol/sdk | 1.x | 标准协议 |
| 文件监视 | chokidar + fs.watch | 4.x | 跨平台稳定 |
| CLI 框架 | commander | 12.x | 命令行交互 |
| 并行 | worker_threads | Node 内置 | 多核并行解析 |

### 14.2 目标分析框架

| 框架 | 基线版本 |
|---|---|
| Spring Boot | 3.5.x |
| Spring Framework | 6.2.x |
| Spring Cloud | 2025.0.x (Northfields) |
| Spring Security | 6.5.x |
| Spring Data | 2025.0.x |
| RabbitMQ | 3.13.x |
| Redis | 7.x |
| MySQL | 8.x / 9.x |
| MongoDB | 7.x / 8.x |
| Vue | 3.x |
| React | 18.x / 19.x |

### 14.3 部署

```bash
# 安装 CLI
npm install -g mini-codegraph

# 在某个微服务目录下初始化（关联整个工作区）
cd order-service
mini-codegraph init --workspace D:/workspace/microservices

# 启动 MCP Server（供 Agent 连接）
mini-codegraph serve --mcp

# 全量索引
mini-codegraph index

# Agent MCP 配置
{
  "mcpServers": {
    "mini-codegraph": {
      "command": "mini-codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

`serve --mcp` 启动后自动加载索引并开启文件监视。Agent 通过 MCP 协议调用 21 个工具。

---

## 15. 开发状态与里程碑

### 已完成（P0-P7 全部完成）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 项目初始化、数据库 schema、基本解析框架 | ✅ |
| P1 | 5 个语言解析器、25+ 提取器 | ✅ |
| P2 | Spring Cloud / Feign / Gateway / WebClient / WebFlux 提取 | ✅ |
| P3 | RabbitMQ / Redis / DB / 数据库迁移 提取 | ✅ |
| P4 | Vue/React 前端关联 + OpenAPI 提取 | ✅ |
| P5 | 21 个 MCP 工具、动态推断、AOP/Security 提取 | ✅ |
| P6 | Worker 线程池、批量写入、WAL 优化、模糊搜索 | ✅ |
| P7 | 守护进程、可视化、Git 同步、安全加固 | ✅ |

### 待优化

| 方向 | 优先级 | 说明 |
|---|---|---|
| CSS/HTML/GraphQL/Markdown 解析 | 低 | 影响前端深度分析 |
| 语义搜索（向量嵌入） | 中 | 自然语言查代码 |
| 架构规则校验（lint） | 中 | 分层/循环依赖检测 |
| Git 历史分析 | 低 | 函数演进追溯 |
| 版本号统一 | 高 | package.json/cli/daemon/mcp 版本不一致 |

---

## 16. 未来优化方向

### 16.1 语义搜索（自然语言查找代码符号）

让 Agent 能用自然语言（如"处理订单超时的逻辑"）找到相关代码。

- **向量化**：为符号生成嵌入向量（符号名+签名+注释）
- **模型**：all-MiniLM-L6-v2 ONNX，离线运行
- **存储**：sqlite-vss 或内存 ANN 索引
- **工具**：`mini_cg_semantic_search(query, topK)`

### 16.2 动态调用推断

降低反射/动态代理盲区：

- Spring Bean 注入推断（接口→唯一实现）
- 反射调用检测（Method.invoke 参数提取）
- AOP 切面展开（@Pointcut 表达式匹配）
- 策略/工厂模式检测

### 16.3 Git 历史分析

- 符号级别变更追踪（git log -L）
- mini_cg_history / mini_cg_blame 工具

### 16.4 架构规则校验

- YAML 定义分层/依赖规则
- `mini_cg_lint` 自动检测违规

### 16.5 可视化导出

- D3.js 力导向图（HTML 静态文件）
- 按服务/中间件类型过滤

---

## 附录：与原始设计的差异说明

Mini-CodeGraph 在实现过程中对原始设计做了以下调整：

| 设计原文 | 实际实现 | 原因 |
|---|---|---|
| 表名 `symbols` / `references` | `nodes` / `edges` | 更通用，支持非符号关系 |
| 独立 `core/` 模块 | 扁平化为 `extraction/` + `db/` + `graph/` | 减少嵌套，便于扩展 |
| 9 个 MCP 工具 | 21 个工具 | 实际需求驱动 |
| 6 个工作区提取器 | 8 个提取器 | 增加 OpenAPI、数据库迁移 |
| — | 新增 daemon/ 守护进程 | 支持 --serve 后台运行 |
| — | 新增 resolution/ 动态推断 | 提升静态分析准确度 |
| — | 新增 visualization/ 可视化 | 辅助理解和调试 |
