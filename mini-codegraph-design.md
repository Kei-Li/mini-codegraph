Mini-CodeGraph 完整设计方案（最终版）
项目名称：mini-codegraph
统一命名规范：

命令：mini-codegraph

存储目录：.mini-codegraph/

数据库：mini-codegraph.db

MCP 工具前缀：mini_cg_

配置文件：workspace.yml

目录
项目概述

核心设计目标

整体架构

模块与代码结构

核心数据结构

核心流程

语言与框架支持

框架与中间件提取规则

性能架构与优化细节

MCP 工具与 Agent 交互

安全与隐私设计

边界与异常处理

扩展性预留

技术选型与部署

开发计划与里程碑

未来优化方向及详细开发细节

1. 项目概述
Mini-CodeGraph 是一个本地优先、零配置的代码知识图谱生成与查询工具。
它基于 colbymchenry/codegraph 内核，通过静态分析构建单仓库的符号关系图，并扩展工作区感知能力，自动发现本地所有微服务与前端项目，生成跨仓库的全局依赖视图。
通过 MCP 协议 向本地编程 Agent（Claude Code、opencode 等）暴露专用工具，让 Agent 在修改代码时能够实时查询全局影响链，杜绝“跑偏”。

核心场景：
数十个微服务（Spring Cloud + RabbitMQ + Redis + MySQL + MongoDB + Vue/React/TS）构成的旧系统，开发者本地同时拥有所有仓库，Agent 需理解跨服务调用、中间件依赖、前后端关联。

2. 核心设计目标
目标	说明
单进程本地运行	无中心服务器，不依赖外部服务，完全在开发者本机执行。
全局视野	自动发现工作区内所有项目，构建跨仓库符号关系图。
Agent 优先	通过 MCP 协议暴露专用工具，将结构化信息直接注入 LLM 上下文。
零配置上手	仅需指定工作区根目录，其余全自动完成。
实时反馈	文件保存后秒级更新索引，跨服务接口变更自动感知。
全栈覆盖	深度支持 Java (Spring Cloud)、Kotlin、TypeScript/Vue/React；轻量支持 Groovy、Python 等。
极简实现	复用原 codegraph 的 tree-sitter 解析和 SQLite 存储，新增模块完全解耦，不引入重型依赖。
大规模耐受	支持 10 万+ 文件索引，首次全量 < 5 分钟，增量 < 2 秒，查询 < 200ms。
安全隐私	完全离线，不联网，不收集数据，敏感信息自动过滤。
3. 整体架构
text
┌─────────────────────────────────────────────────────────┐
│              Agent (Claude Code / opencode / IDE)        │
│                   MCP 协议 (stdio)                       │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│          mini-codegraph MCP Server (单进程)              │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  内核（精简自 codegraph）                         │   │
│  │  · tree-sitter 多语言解析                         │   │
│  │  · 符号定义/引用/调用/继承提取                     │   │
│  │  · SQLite + FTS5 存储                            │   │
│  │  · 文件监视器 (OS 原生事件)                       │   │
│  │  · 高性能索引调度器 (Worker 池)                   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  工作区全局关系层                                 │   │
│  │  · 工作区扫描器                                   │   │
│  │  · 框架/中间件提取器 (可插拔)                     │   │
│  │  · 全局图构建器                                   │   │
│  │  · 外部符号/引用注入 (external_* 表)               │   │
│  │  · 工作区增量同步                                 │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  存储：项目本地 .mini-codegraph/mini-codegraph.db         │
└──────────────────────────────────────────────────────────┘
核心理念：
所有跨服务关系以外部符号表的形式存储在当前项目的 SQLite 中，查询完全本地化。MCP Server 启动后自动加载索引并开启监视，Agent 通过标准 MCP 工具获取本地和全局信息。

4. 模块与代码结构
text
src/
├── core/                       # 内核（精简增强）
│   ├── parser/                 # tree-sitter 解析 & 符号/边提取
│   │   ├── index.ts
│   │   └── languages/          # 各语言查询定义
│   ├── store/                  # SQLite 管理
│   │   ├── connection.ts
│   │   ├── schema.ts           # 含 external_* 表
│   │   └── queries.ts
│   ├── watcher/                # 文件监视器
│   │   └── index.ts
│   └── indexer/                # 索引调度
│       ├── full-index.ts       # 全量并行索引
│       ├── incremental.ts      # 增量更新
│       └── worker-pool.ts      # Worker 线程池管理
├── workspace/                  # 工作区全局关系
│   ├── scanner.ts              # 识别项目与语言栈
│   ├── extractors/             # 接口/依赖提取器
│   │   ├── spring-cloud.ts
│   │   ├── rabbitmq.ts
│   │   ├── redis.ts
│   │   ├── database.ts
│   │   ├── frontend.ts
│   │   └── frameworks.ts
│   ├── graph-builder.ts        # 合并为 external_symbols/references
│   └── sync.ts                 # 工作区增量同步调度
├── mcp/                        # MCP 工具定义
│   ├── tools.ts
│   ├── handlers/
│   │   ├── explore.ts
│   │   ├── search.ts
│   │   ├── callers.ts
│   │   ├── callees.ts
│   │   ├── impact.ts
│   │   ├── node.ts
│   │   └── files.ts
│   └── server.ts
├── cli/
│   └── index.ts                # mini-codegraph 命令入口
└── shared/
    ├── types.ts
    └── config.ts
模块交互原则：

Core 提供单仓库索引 API，不感知全局。

Workspace 模块在初始化或刷新时调用 Core 的解析能力提取接口，构建全局边，注入当前项目存储。

MCP 模块直接查询 Core 存储（包含 external 表），返回统一结果。

5. 核心数据结构
5.1 存储路径
项目配置与索引目录：.mini-codegraph/

数据库文件：.mini-codegraph/mini-codegraph.db

工作区配置：.mini-codegraph/workspace.yml

5.2 新增跨服务关系表
sql
-- 外部符号（其他服务提供的接口、队列、数据库等）
CREATE TABLE external_symbols (
    id TEXT PRIMARY KEY,                  -- 全局唯一ID，如 "grpc.Inventory/Reserve"
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                   -- rpc_method, http_endpoint, mq_queue, db_table, cache_key, ...
    providing_service TEXT NOT NULL,      -- 所属服务名
    definition_file TEXT,
    signature TEXT,
    metadata JSON
);

-- 外部引用（当前项目如何引用外部符号）
CREATE TABLE external_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_location TEXT NOT NULL,        -- 当前项目内引用位置 (file:line:col)
    external_symbol_id TEXT NOT NULL REFERENCES external_symbols(id),
    reference_type TEXT NOT NULL,         -- rpc_call, http_request, mq_publish, mq_consume, db_rw, cache_get, ...
    target_service TEXT,
    metadata JSON
);

CREATE INDEX idx_ext_ref_symbol ON external_references(external_symbol_id);
CREATE INDEX idx_ext_ref_location ON external_references(source_location);
原单仓库表（symbols, references, files, FTS5）保持不变。

6. 核心流程
6.1 项目初始化
bash
mini-codegraph init --workspace /path/to/microservices
加载配置：生成 .mini-codegraph/workspace.yml，记录工作区根路径、排除规则。

扫描工作区：遍历根目录下一级子目录，识别包含 pom.xml、package.json、.git 等的目录为独立项目。

提取接口清单（并行）：对每个项目调用对应提取器，产出该项目的 provides 和 consumes。

构建全局图：将所有 provides 收集为全局符号表，解析 consumes 并匹配，生成跨项目引用边。

注入本地：筛选与当前项目相关的跨服务边，写入 external_symbols 和 external_references 表。

启动监视：监视当前项目文件变更，同时监视工作区内其他项目的接口定义文件（如 .proto, application.yml, @FeignClient 文件等）。

6.2 全量索引与增量同步
全量索引 (mini-codegraph index)：

文件发现：使用 fast-glob 扫描项目文件，过滤忽略规则，跳过 >1MB 文件。

并行解析：Worker 线程池（CPU 核数 -1），每个 Worker 加载所需 tree-sitter 解析器，处理文件队列。

批量写入：主线程每 5000 条符号或每 2 秒执行一次事务插入。全量索引前 DROP INDEX，插入完成后 CREATE INDEX，并填充 FTS5。

增量同步（文件监视自动触发）：

监听文件变更事件，去抖 2 秒。

仅重新解析变更文件，局部更新符号表及相关边。

若涉及对外接口变更，触发轻量级工作区刷新（更新本项目的 external 表）。

6.3 工作区全局关系刷新
触发条件：初始化时、检测到其他项目的接口定义文件变更（防抖 5 秒）。

刷新策略：

为每个项目缓存上次提取的接口清单哈希，仅变更时才重新提取。
在内存中 HashMap 快速匹配 provides/consumes。
与当前 external 表差异比较，执行增量更新。
性能：仅操作几 KB 数据，通常 < 1 秒。

6.4 Agent 查询处理
Agent 调用 mini_cg_callers 等工具时，查询逻辑合并本地与外部数据：

sql
-- 内部调用者
SELECT r.source_location, s.name AS caller_name
FROM references r JOIN symbols s ON r.source_id = s.id
WHERE r.target_id = ?

UNION ALL

-- 外部调用者（本服务消费的外部接口）
SELECT er.source_location, es.name
FROM external_references er
JOIN external_symbols es ON er.external_symbol_id = es.id
WHERE er.external_symbol_id = ? -- 外部接口ID

UNION ALL

-- 外部调用者（其他服务调用本服务符号）
SELECT er.source_location, es.name
FROM external_references er
JOIN external_symbols es ON er.external_symbol_id = es.id
WHERE es.providing_service = 'current-service' AND es.name = ?
结果标注 provenance（internal / external），Agent 可清晰区分。

7. 语言与框架支持
7.1 后端语言
语言	支持深度	解析工具	说明
Java	完整 AST	tree-sitter-java	所有 Spring 注解、Feign、JPA 等
Kotlin	完整 AST	tree-sitter-kotlin	与 Java 同等深度，支持 Spring 注解
Groovy	轻度解析	正则 + AST 片段	仅 Gradle 脚本和 Spock 测试
Python	按需支持	tree-sitter-python	若存在 Python 服务，提供 FastAPI/Flask 路由提取
Go / C#	保留扩展点	—	暂不实现，架构预留
7.2 前端语言与文件
文件/语言	支持深度	解析工具
TypeScript/JavaScript (含 JSX/TSX)	完整 AST	tree-sitter-tsx
Vue SFC (.vue)	完整解析（template/script/style）	tree-sitter-vue
CSS/SCSS/Less	类选择器提取	tree-sitter-css/scss
HTML	元素 id、ref	tree-sitter-html
GraphQL	按需支持	tree-sitter-graphql
Markdown	轻度索引	tree-sitter-markdown
降级策略：若 tree-sitter 解析失败，回退正则提取函数/类名，标记 precision: low。

8. 框架与中间件提取规则
8.1 Spring Cloud 组件
组件	提供/消费	提取方法
服务注册	提供：spring.application.name	解析 bootstrap.yml / application.yml
Feign	消费：@FeignClient(name="xxx") 方法	tree-sitter AST 提取接口名、方法签名
RestTemplate	消费：http://SERVICE/...	正则匹配 URL 中的服务名
Gateway 路由	消费：routes[].uri: lb://service	YAML 解析
Controller	提供：@RequestMapping 路径	tree-sitter 提取路径和 HTTP 方法
8.2 RabbitMQ
角色	提取方法
生产者	rabbitTemplate.convertAndSend(exchange, routingKey, msg) AST 提取参数
消费者	@RabbitListener(queues = "xxx") 提取队列名
拓扑关联	解析 application.yml 中的 bindings、exchanges、queues
8.3 数据库与缓存
中间件	提供/消费	提取方式
MySQL	消费：表读写	JPA @Table、MyBatis XML、JdbcTemplate SQL 分析
MongoDB	消费：集合读写	@Document(collection="xxx")
Redis	消费：键访问	正则提取 redisTemplate.opsForValue().get("key")；@Cacheable AST
8.4 前后端关联
前端 axios/fetch 调用 URL 与后端 Controller 路由通过路径和方法匹配，建立连线。

9. 性能架构与优化细节
9.1 性能目标
指标	目标
首次全量索引（10 万文件）	< 5 分钟（16 核机器）
增量索引（保存单个文件）	< 2 秒
工作区全局关系刷新	< 5 秒
符号搜索（FTS5）	< 50ms
调用者/影响分析查询	< 200ms
内存峰值	< 2 GB
磁盘占用	< 项目源码大小的 15%
9.2 索引加速策略
文件发现与过滤

使用 fast-glob 快速扫描，严格遵循 .gitignore 和内置黑名单（node_modules、target、build、dist、.venv 等）。

文件大小超过 1MB 直接跳过。

并行解析

创建 Worker 线程池，线程数为 os.cpus().length - 1。

每个 Worker 加载所需语言的 tree-sitter 解析器，复用实例。

任务队列长度控制在 2000，避免内存溢出。

解析结果序列化为轻量 JSON 传递。

批量写入优化

主线程每收集 5000 条符号或间隔 2 秒，开启一个事务批量插入。

全量索引前 DROP INDEX 在 references 等表上的二级索引，插入完成后 CREATE INDEX。

SQLite 配置：PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;（索引期间），PRAGMA cache_size=-65536;（64MB 页面缓存）。

内存管理

及时释放 Worker 传回的符号数据。

对超过 500KB 的大文件，仅提取顶层符号，跳过完整引用解析。

提供 --fast 模式：仅索引函数/类签名和导入，1 分钟内完成 10 万文件。

9.3 查询性能优化
references 表复合索引 (target_id, source_file)。

FTS5 使用外部内容表，避免重复文本。

MCP Server 内部 LRU 缓存最近 500 条查询结果。

9.4 增量索引与文件监视
文件监视基于 OS 原生事件（inotify / FSEvents / ReadDirectoryChangesW），防抖 2 秒。

通过 mtime 快速判断文件是否实际变更。

仅重新解析变更的文件，局部更新符号表。

9.5 工作区刷新性能
每个仓库接口清单哈希缓存，仅变更时才重新提取。

全局符号匹配在内存中 HashMap 完成。

external_* 表采用差异更新，不整表重建。

10. MCP 工具与 Agent 交互
10.1 工具列表（前缀 mini_cg_）
工具名	参数	用途
mini_cg_explore	query: string	探索问题，返回相关符号与源码片段
mini_cg_search	name: string, kind?: string	按名称搜索符号
mini_cg_callers	symbolId: string	获取所有调用者（含外部服务）
mini_cg_callees	symbolId: string	获取所有被调用者（含 MQ/DB）
mini_cg_impact	symbolId: string, depth?: number	影响面分析
mini_cg_node	symbolId: string	符号详情与完整源码
mini_cg_files	directory?: string	浏览项目文件结构
mini_cg_workspace_status	无	查看工作区内所有服务概览
10.2 Agent 使用引导（System Prompt 片段）
text
你是项目代码助手。理解代码时，优先使用 mini_cg_* 工具，而不是 grep 或手动读文件。
- 修改公共函数/接口前，先用 mini_cg_callers 检查全局调用者。
- 评估变更影响使用 mini_cg_impact。
- 询问业务流程或代码逻辑使用 mini_cg_explore。
- 需要跨服务信息时查看 mini_cg_workspace_status。
10.3 典型交互示例
用户：“调用 B 的前提是订单状态是什么？”

Agent 调用 mini_cg_search("B") 定位符号。

mini_cg_callers(B) 获取所有调用位置。

读取调用处所在函数的源码（通过 mini_cg_explore 或 mini_cg_node）。

LLM 分析代码中的条件语句，给出前提。

若需深入，用 mini_cg_impact 查看状态字段的影响范围。

11. 安全与隐私设计
11.1 数据本地化与离线
整个系统运行期间不发起任何网络连接（除 MCP 的 stdio 通道）。

无遥测，不收集任何使用数据或代码片段。

11.2 路径安全
文件读取限制在工作区配置内指定的项目目录，拒绝访问系统路径（如 /etc、~/.ssh），使用 path.resolve 和前缀比对防止路径穿越。

11.3 敏感信息过滤
自动跳过 .env、*.pem、*.key、credentials.* 等文件。

配置文件解析时，对包含 password、secret、token 等关键词的值脱敏为 ***。

对高熵字符串（疑似密钥）不纳入索引。

11.4 权限模型
MCP 工具全部只读，无法修改代码或索引。

数据库文件以用户读写权限创建，多用户环境互不干扰，通过文件锁防止并发写入损坏。

11.5 外部符号表隐私
external_symbols 仅存储接口签名和文件位置，不复制其他服务的完整源码。Agent 若需详情会通过本地文件系统读取，受文件权限控制。

12. 边界与异常处理
12.1 超大型仓库
提供 --progress 指示当前索引进度，索引完成前 Agent 可降级策略（等待或使用文本搜索）。

若索引时间过长，提供中断与恢复机制（通过检查点记录）。

12.2 不完整工作区
若部分微服务仓库未克隆，mini_cg_workspace_status 标记为 unavailable，Agent 据此不会错误断言全局调用链。

12.3 动态代码与反射
静态分析无法处理 Class.forName、动态代理、SPI 等。在调用点标记 @reflective 伪节点，提醒 Agent 存在动态调用风险。

12.4 解析失败降级
当 tree-sitter 解析失败（语法错误或不支持的语言特性），回退到基于正则的符号提取，标记为 precision: low，Agent 可知信息不完整。

12.5 并发与损坏保护
SQLite 开启 WAL 模式，读写并发友好。

多实例启动检测：使用文件锁 .mini-codegraph/.lock 防止同时运行多个 MCP Server 导致写冲突。

12.6 语言混合项目
一个仓库包含多种语言（如 Java + Kotlin），索引器自动识别扩展名分配解析器，并尝试关联跨语言调用（如 JNI 边界）。

13. 扩展性预留
13.1 插件化提取器
所有框架/中间件提取器实现 IExtractor 接口，在 workspace/extractors/ 下注册，通过配置文件启用或禁用。

用户可自定义提取规则（如针对公司内部框架），放置在 .mini-codegraph/extractors/ 下自动加载。

13.2 自定义符号元数据
symbols 表预留 tags JSON 字段，可扩展注入业务标签（如 domain:order、criticality:high），配合 CI 数据或手动标注，增强 Agent 领域理解。

13.3 语义搜索扩展
未来可在索引时为每个符号的签名+注释生成向量嵌入（使用本地轻量模型），并增加 mini_cg_semantic_search 工具。

向量存储可选用 sqlite-vss 扩展或独立文件。

13.4 远程团队扩展
架构预留可选的“全局图中心服务”，但当前版本坚守本地优先，不引入网络依赖。

14. 技术选型与部署
层面	选型	理由
语言	TypeScript / Node.js 22.5+	继承 codegraph 生态，MCP 友好
解析引擎	tree-sitter	多语言支持，高性能
存储	SQLite + FTS5 (node:sqlite 内置)	零依赖，嵌入式全文搜索
MCP SDK	@modelcontextprotocol/sdk	标准协议，兼容主流 Agent
文件监视	chokidar + 原生 fs.watch	跨平台稳定
CLI 框架	commander	命令行交互
并行	worker_threads	多核并行解析
部署
bash
# 安装 CLI
npm install -g mini-codegraph

# 在某个微服务目录下初始化
cd order-service
mini-codegraph init --workspace ~/workspace/microservices

# Agent MCP 配置
{
  "mcpServers": {
    "mini-codegraph": {
      "command": "mini-codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
serve --mcp 启动后自动加载当前项目索引，并开启文件监视与工作区同步。

15. 开发计划与里程碑
阶段	内容	预计
P0	Fork colbymchenry/codegraph，精简核心，去除旧命名，保留单仓库索引与 MCP Server 骨架	1 周
P1	实现工作区扫描器、external_* 表、基本全局关系框架，能手动注入测试边	1 周
P2	Spring Cloud / Feign / Gateway 提取器，支持基于注解和配置的消费提供关系提取	1 周
P3	RabbitMQ / Redis / DB 提取器，消息队列拓扑与数据存储依赖分析	1 周
P4	前端关联提取：Vue SFC、React TSX、CSS 类名、axios/fetch 调用 → 后端路由匹配	3 天
P5	MCP 工具完善：查询合并外部数据、增量同步与文件监视扩展、Agent 使用引导	1 周
P6	性能优化：Worker 池、批量写入、索引重建策略；10 万文件压力测试与调优	1 周
P7	集成 opencode 验证，安全加固（路径白名单、敏感信息过滤），编写文档	1 周
总计：约 6-7 周完成 MVP。

16. 未来优化方向及详细开发细节
本章节在之前简单列举的基础上，深入展开每个优化方向的实现思路、技术选型、核心挑战与预计集成方式，可作为后续迭代开发的参考蓝图。

16.1 语义搜索（自然语言查找代码符号）
目标：让 Agent 能用自然语言（如“处理订单超时的逻辑”）直接找到相关代码符号，而不仅仅依赖精确名称搜索。

实现思路：

向量化：在索引时为每个符号（函数/方法/类）生成文本嵌入。输入文本由以下部分拼接：

符号名称和签名

所在文件的前几行注释/Javadoc

包含该符号的关键调用语句（可选，提升上下文）

本地嵌入模型：使用轻量级 Transformer 模型，如 all-MiniLM-L6-v2（ONNX 格式，约 80MB），完全离线运行。可选用 @xenova/transformers 在 Node.js 中加载。

存储：向量存储可直接用 SQLite 的 BLOB 存储，或使用专门的本地向量索引（如 sqlite-vss 扩展）。初期可默认采用内存 Flat 索引 + 近似最近邻（ANN），当符号数量超过 10 万时引入轻量 ANN 索引（如 hnswlib-node）。

工具实现：新增 mini_cg_semantic_search(query, topK)，将查询语句转换为向量，与符号向量进行余弦相似度匹配，返回排名靠前的符号及其代码片段。

开发细节：

在 core/indexer 中新增 embedding-generator.ts，在符号写入 SQLite 后异步生成向量，存入 symbol_embeddings(symbol_id, vector_blob) 表。

首次全量索引时可选择跳过嵌入生成（用 --no-embeddings 标志），之后通过 mini-codegraph embed 命令补建。

增量索引时仅对新增/修改符号生成向量。

MCP 工具 mini_cg_semantic_search 处理流程：

调用本地 embedding 模型生成查询向量。
若使用内存索引，直接计算余弦相似度；若使用 sqlite-vss，执行向量 SQL 查询。
返回 top 10 结果，附带符号 ID，Agent 可用 mini_cg_node 进一步获取详情。
挑战：

模型加载会增加内存（约 150MB），启动时间延长。可使用懒加载，仅在首次语义搜索请求时初始化。

多语言代码注释混用，嵌入质量可能下降；可通过收集项目语料微调模型（高级选项）。

预估工作量：2-3 周

16.2 动态调用推断（降低反射/动态代理盲区）
目标：Java 中大量使用 Spring AOP、动态代理、Class.forName、策略模式等，静态分析难以捕获真实的调用关系。此优化旨在通过启发式规则补充一部分动态调用边。

实现思路：

Spring Bean 注入推断：分析 @Autowired、@Resource、构造函数注入的字段或参数，将接口类型与其已知实现类关联（通过 @Service、@Component 及 @Bean 定义）。如果只有一个实现类，则直接建立调用边。

工厂/策略模式识别：检测 switch 或 if-else 块中根据类型创建不同服务实例的模式，提取所有可能的目标类型。

反射调用标记升级：当发现 Method.invoke、Class.forName 等反射调用时，尝试解析第一个参数是否为字符串常量，若是则建立目标符号引用。

AOP 切面识别：解析 @Aspect 和 @Around 等注解，提取切入点表达式（如 execution(* com.example..*.*(..))），将被切入的方法与切面通知方法建立潜在调用关系，标注 provenance: aop。

开发细节：

在 Spring 提取器中增加 bean-resolution.ts：收集所有 Bean 定义及其实现类，构建接口→实现的映射表。对于每个注入点，若接口只有唯一实现，则自动生成一条 references 边，标记 dynamic: inferred。

反射解析：在 tree-sitter 查询中匹配 method.invoke 等模式，提取字符串参数，去匹配符号名称。

AOP 解析：新增 extractors/spring-aop.ts，解析切面类，提取 @Pointcut 表达式，通过正则展开包路径，在索引后处理中批量建立关联。

所有推断边均带有低置信度标记，Agent 可据此决定是否进一步验证。

挑战：

推断可能产生假阳性，需要提供配置开关，让用户选择是否启用。

切入点表达式完整展开需要解析类路径，对大型项目可能较慢，可限制展开范围。

预估工作量：2-3 周

16.3 Git 历史分析（追踪函数演进）
目标：Agent 能理解“这个函数最近被谁修改过、为什么修改”，提供变更上下文。

实现思路：

集成 Git 命令行或使用 simple-git 库读取本地 Git 仓库信息。

为每个符号记录 last_modified_commit、author、recent_changes 等信息。

工具 mini_cg_history(symbolId)：返回该符号的最近 N 次变更记录（commit message、diff 摘要、作者、时间）。

额外提供 mini_cg_blame(file, line)，返回行的最近修改者。

开发细节：

索引时存储 symbols 表中增加 git_metadata JSON 字段，记录 commit hash 和时间戳。

首次全量索引后，运行 mini-codegraph git-index 遍历所有文件，调用 git log -L <symbol_start>,<symbol_end>:<file> 获取历史，存储到独立的 git_history 表。

增量索引时仅对修改文件的符号更新 Git 元数据。

对于重命名，利用 git log --follow 追踪。

挑战：

大型仓库的 Git 操作可能较慢，需限制历史深度（默认 10 条）并缓存结果。

若工作区不完整（浅克隆），历史信息可能缺失。

预估工作量：2 周

16.4 测试影响分析（增量测试选择）
目标：基于代码图，快速找出受代码变更影响的测试文件，供本地运行或 CI 使用。

实现思路：

建立“源代码 → 测试文件”依赖图。通过分析测试代码中的 import 和直接调用，将测试与被测代码关联。

当用户修改一组文件后，通过 mini_cg_affected_tests --files <list> 找出所有需要运行的测试文件。

可结合 mini_cg_impact 进一步扩展，将间接影响的测试也包含在内。

开发细节：

在索引阶段识别测试文件（默认通过文件路径包含 test、spec、Test.java、test.ts 等模式）。

建立反向引用索引：对于每个测试文件，记录它直接引用的所有生产代码符号。

工具实现：输入变更文件列表 → 查询这些文件定义/修改的符号 → 查询哪些测试引用了这些符号 → 输出测试文件路径列表。

结果可用于 vitest --related 或自定义脚本。

挑战：

动态测试关联（如通过依赖注入运行的集成测试）可能难以静态分析，需要补充配置文件关联或手动标记。

预估工作量：1-2 周

16.5 架构规则校验（自动违规检测）
目标：用户可以定义分层架构、模块边界、依赖方向等规则，由 Mini-CodeGraph 自动检测违规并提示。

实现思路：

支持用户编写规则文件（.mini-codegraph/rules.yml），定义：

包/模块分组（如 domain, application, infrastructure）

允许的依赖方向（如 domain 不能依赖 infrastructure）

循环依赖检测（最大环大小）

提供 mini_cg_lint 命令，扫描全局图并报告违规项。

开发细节：

规则引擎使用图遍历：根据组映射将符号归类，然后遍历 references 和 external_references 表，检查边是否违反规则。

报告格式包含违规位置、违规类型、建议。

可集成到 MCP 工具，Agent 询问“当前架构有哪些问题”时调用。

挑战：

灵活的规则定义需要设计合理的 DSL，初期可采用 YAML + 正则。

大型项目遍历可能耗时，需限制范围或增量运行。

预估工作量：2 周

16.6 可视化导出（依赖关系图）
目标：生成可交互的全局依赖图，帮助开发者和 Agent 直观理解服务拓扑。

实现思路：

输出 DOT 格式（Graphviz）或 D3.js 可渲染的 JSON。

命令：mini-codegraph visualize --format dot|html --output graph.html

可过滤：只看某个服务、只看 RPC 调用、只看 MQ 拓扑等。

开发细节：

从 external_symbols 和 external_references 表聚合边，以服务为节点，生成 digraph。

对于单仓库内部调用，可输出文件级或函数级图。

使用模板引擎生成简单 HTML 内嵌 D3 力导向图，零依赖。

挑战：

超大项目图可能杂乱，需要提供节点折叠和过滤选项。

不引入 Web 服务，仅生成静态文件。

预估工作量：1 周

16.7 性能自监控（内部指标面板）
目标：为开发者和高级用户提供 Mini-CodeGraph 自身的性能指标，便于调优。

实现思路：

收集内部指标：索引时间、增量次数、缓存命中率、Worker 利用率、内存使用等。

通过 MCP 工具 mini_cg_metrics 返回 JSON 指标，或启动时可选的本地 Web 仪表盘（仅 localhost）。

开发细节：

在核心模块中嵌入 EventEmitter，记录关键事件时间戳。

将指标存储在内存循环缓冲区，避免磁盘 I/O。

工具 mini_cg_metrics 直接返回最近 1 小时内的统计摘要。

挑战：

需注意指标收集本身的开销，设计为轻量级。

预估工作量：1 周

Mini-CodeGraph 通过当前架构已能解决 90% 的 Agent 理解与导航问题，上述未来优化方向将逐步填补剩余的静态分析盲区，并向开发者提供更多主动智能，最终成为微服务开发的必备基础设施。