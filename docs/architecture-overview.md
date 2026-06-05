# Mini-CodeGraph 架构总览

## 整体架构图

```mermaid
graph TB
  subgraph Agent["Agent Layer"]
    AGENT["Claude Code / opencode / IDE Agent"]
  end

  subgraph MCP["MCP Server Layer"]
    MCP_SERVER["mini-codegraph MCP Server<br/>(stdio)"]
    TOOLS["MCP Tools<br/>mini_cg_search / callers / callees<br/>impact / explore / node / files<br/>dispatch / config / workspace_status"]
  end

  subgraph WORKSPACE["Workspace Layer"]
    SCANNER["Workspace Scanner<br/>detectProject()"]
    SYNC["WorkspaceSync<br/>增量刷新 / hash缓存"]
    GRAPH_BUILDER["WorkspaceGraphBuilder<br/>provides/consumes匹配<br/>external_symbols/references"]
    
    subgraph EXTRACTORS["Framework Extractors (IExtractor)"]
      SC_EX["SpringCloudExtractor<br/>@FeignClient / @RequestMapping<br/>application name"]
      GW_EX["GatewayExtractor<br/>routes.yml / RouteLocator Java"]
      MQ_EX["RabbitMQExtractor<br/>@RabbitListener / convertAndSend<br/>application.yml bindings"]
      RD_EX["RedisExtractor<br/>@Cacheable / redis hash"]
      DB_EX["DatabaseExtractor<br/>JPA / MongoDB / MyBatis / SQL"]
      FE_EX["FrontendExtractor<br/>Vue api_mapping / backend routes"]
    end
  end

  subgraph EXTRACTION["Extraction Engine (48+ Extractors)"]
    ORCH["Orchestrator<br/>多Worker线程池<br/>树遍历 → 符号/边提取"]
    GRAMMAR["GrammarLoader<br/>tree-sitter WASM"]
    
    subgraph LANG_PARSERS["Language Parsers"]
      JAVA_P["Java<br/>(Spring AOP, JPA,<br/>Lombok, MapStruct)"]
      TS_P["TypeScript/JS<br/>(React, Vue, Nest)"]
      VUE_P["Vue SFC<br/>(template/script/style)"]
      KT_P["Kotlin"]
      PY_P["Python"]
    end

    subgraph EXTRACTORS2["Specialized Extractors"]
      AOP["AOP Extractor<br/>@Aspect @Pointcut @Around<br/>切入点解析"]
      JPA["JPA Extractor<br/>@Entity @Table @Column"]
      MYB["MyBatis Extractor<br/>XML Mapper解析"]
      MONGO["MongoDB Extractor<br/>@Document"]
      SEC["Security Extractor<br/>@PreAuthorize @Secured"]
      CACHE["Cache Extractor<br/>@Cacheable @CacheEvict"]
      TX["Transaction Extractor<br/>@Transactional propagation"]
      BATCH["Batch Extractor<br/>@EnableBatchProcessing"]
      RESILIENCE["Resilience Extractor<br/>@Retry @CircuitBreaker"]
      GRAPHQL["GraphQL Extractor<br/>@QueryMapping"]
      WS["WebSocket Extractor<br/>@MessageMapping"]
      GRPC["gRPC Parser<br/>proto files"]
      OPENAPI["OpenAPI Parser<br/>swagger docs"]
      DOCKER["Docker Parser"]
      K8S["K8s Parser<br/>(network policy)"]
      LOMBOK["Lombok Extractor<br/>@Data @Builder"]
      MAPSTRUCT["MapStruct Extractor"]
      GATEWAY["Gateway Parser<br/>路由定义"]
      ASYNC["Async Extractor<br/>@Async @Scheduled"]
      TEST["Test Extractor<br/>@Test @SpringBootTest"]
      PROFILE["Profile Extractor"]
      I18N["Vue i18n Extractor"]
      PINIA["Pinia Store Extractor"]
      REACT["React Extractor"]
      CONFIG["Config Extractor<br/>@ConfigurationProperties"]
      CLOUDCFG["Cloud Config Extractor<br/>bootstrap.yml"]
      LBCLIENT["LoadBalancer Extractor"]
      STREAM["Stream Function Extractor"]
      INTERCEPTOR["Interceptor Extractor"]
      CTRL_ADVICE["ControllerAdvice Extractor"]
      SEC_FILTER["SecurityFilterChain Extractor"]
      K8S_NET["K8s Network Extractor"]
      SQL["SQL Extractor"]
      MQ_PARSER["MQ Parser"]
      TRACE["Trace Analyzer"]
      VUE_API["Vue-API Mapper"]
    end
  end

  subgraph RESOLUTION["Resolution Layer"]
    DISPATCH_INF["Dispatch Inference Engine"]
    CONDITION_MATCHER["ConditionMatcher<br/>@ConditionalOnProperty<br/>@Profile @ConditionalOnExpression"]
    CONFIG_READER["ConfigReader<br/>application.yml/properties<br/>profile合并 → FlatConfig"]
    IMPORT_RESOLVER["Import Resolver"]
    NAME_MATCHER["Name Matcher"]
    CB_SYNTH["Callback Synthesizer"]
    
    subgraph DETECTORS["7 Dispatch Detectors"]
      AOP_DET["AOP Detector<br/>execution() within() @annotation()"]
      STRAT_DET["Strategy Detector<br/>Map.get() runtime dispatch<br/>data-source-driven"]
      PROXY_DET["Proxy Detector<br/>InvocationHandler candidates"]
      FACT_DET["Factory Detector<br/>return-type-to-impl mapping"]
      REFL_DET["Reflection Detector<br/>Class.forName + ServiceLoader"]
      SPI_DET["SPI Detector"]
      COND_BEAN["ConditionalBean Detector"]
    end

    VARIABLE_TRACER["Variable Tracer<br/>cross-method tracing<br/>data source detection<br/>DB / HTTP / SysProp / Config"]
  end

  subgraph STORE["Storage Layer"]
    DB_CONN["SQLite Connection<br/>WAL mode"]
    SCHEMA["Schema<br/>nodes / edges / files<br/>annotations / templates<br/>modules / unresolved_refs<br/>external_symbols / references<br/>nodes_fts (FTS5)"]
    QUERIES["QueryManager<br/>复合索引 / 分页"]
  end

  subgraph CORE_INFRA["Core Infrastructure"]
    WORKER_POOL["Worker Pool<br/>CPU-1 threads<br/>2000队列上限"]
    FULL_INDEX["Full Indexer<br/>5000条/2s批量写入<br/>DROP/CREATE索引策略"]
    INC_INDEX["Incremental Indexer<br/>mtime检测 / 局部更新"]
    WATCHER["File Watcher<br/>chokidar原生事件<br/>debounce 2s"]
    LRU["LRU Cache<br/>最近500查询"]
  end

  subgraph UI_CLI["CLI & Visualization"]
    CLI["CLI (commander)<br/>init / index / serve / visualize"]
    MERMAID["Mermaid Diagram Generator<br/>arch / dep / sequence / trace<br/>cache / tx / gateway"]
  end

  AGENT -- "MCP stdio" --> MCP_SERVER
  MCP_SERVER --> TOOLS
  TOOLS --> QUERIES
  TOOLS --> GRAPH_BUILDER

  SCANNER --> SYNC
  SYNC --> GRAPH_BUILDER
  SYNC --> EXTRACTORS
  GRAPH_BUILDER --> QUERIES

  ORCH --> GRAMMAR
  ORCH --> LANG_PARSERS
  ORCH --> EXTRACTORS2
  ORCH --> WORKER_POOL
  ORCH --> FULL_INDEX
  ORCH --> INC_INDEX
  INC_INDEX --> WATCHER
  FULL_INDEX --> QUERIES
  INC_INDEX --> QUERIES

  QUERIES --> DB_CONN
  DB_CONN --> SCHEMA
  QUERIES --> LRU

  RESOLUTION --> EXTRACTION
  DISPATCH_INF --> DETECTORS
  DISPATCH_INF --> VARIABLE_TRACER
  DISPATCH_INF --> CONDITION_MATCHER
  DISPATCH_INF --> CONFIG_READER

  CLI --> ORCH
  CLI --> WORKSPACE
  CLI --> MERMAID
  CLI --> MCP_SERVER
```

## 核心数据流

```mermaid
sequenceDiagram
  participant Agent as Agent
  participant MCP as MCP Server
  participant Workspace as Workspace Layer
  participant Ext as Extraction Engine
  participant Res as Resolution Layer
  participant Store as SQLite Store

  Note over Agent,Store: 初始化流程
  Workspace->>Workspace: scan() — 发现所有子项目
  Workspace->>Ext: 对每个项目调 extractAll()
  Ext->>Ext: tree-sitter 解析 → 符号/边/注解
  Ext->>Res: 解析后处理 (dispatch inference, AOP matching)
  Res->>Store: 写入 nodes / edges / annotations / ...
  Workspace->>Store: 写入 external_symbols / references

  Note over Agent,Store: 查询流程
  Agent->>MCP: mini_cg_callers("OrderService.createOrder")
  MCP->>Store: 本地调用者查询 (references + symbols)
  MCP->>Store: 外部调用者查询 (external_references + external_symbols)
  Store-->>MCP: 合并结果 (internal + external)
  MCP-->>Agent: 完整调用链 (标注 provenance)

  Note over Agent,Store: 增量同步
  Ext->>Ext: 文件变更 → 局部重解析
  Ext->>Store: 增量更新 nodes / edges
  Workspace->>Workspace: 检测其他服务接口变更
  Workspace->>Store: 增量更新 external_* 表
```

## Spring Boot 企业项目数据流

```mermaid
graph LR
  subgraph FRONTEND["前端 (Vue/React/TS)"]
    AXIOS["axios.get('/api/orders')<br/>fetch('...')"]
    VUE_COMP["Vue SFC / React TSX<br/>Pinia Store / Vuex"]
  end

  subgraph GATEWAY["API Gateway"]
    GW_ROUTES["Spring Cloud Gateway<br/>/api/** → lb://order-service<br/>/user/** → lb://user-service"]
  end

  subgraph ORDER_SVC["Order Service (Spring Boot)"]
    CTRL["OrderController<br/>@RestController"]
    SVC["OrderService<br/>@Service"]
    REPO["OrderRepository<br/>JPA @Repository"]
    FEIGN["UserServiceClient<br/>@FeignClient"]
    MQ_PUB["OrderEventPublisher<br/>rabbitTemplate.convertAndSend"]
  end

  subgraph USER_SVC["User Service (Spring Boot)"]
    USER_CTRL["UserController<br/>@RestController"]
    USER_SVC["UserService<br/>@Service"]
    USER_REPO["UserRepository<br/>JPA @Repository"]
    USER_LISTENER["OrderEventListener<br/>@RabbitListener"]
  end

  subgraph MIDDLEWARE["中间件"]
    MYSQL[("MySQL<br/>orders / users")]
    MQ[("RabbitMQ<br/>order.exchange → order.queue")]
    REDIS[("Redis<br/>cache:orders")]
  end

  subgraph MINI_CG["mini-codegraph 分析结果"]
    DEP_GRAPH["跨服务依赖图<br/>Feign: order → user<br/>MQ: order → order_queue → user<br/>DB: order → MySQL<br/>Cache: order → Redis<br/>Frontend: Vue → Gateway → order"]
    DISPATCH["派发推断<br/>策略模式 / AOP / 反射<br/>条件注入 / 运行时选择"]
    IMPACT["影响分析<br/>修改 OrderService →<br/>哪些Controller / MQ / 前端受影响"]
  end

  AXIOS --> GW_ROUTES
  GW_ROUTES --> CTRL
  CTRL --> SVC
  SVC --> REPO
  SVC --> FEIGN
  SVC --> MQ_PUB
  FEIGN --> USER_CTRL
  USER_LISTENER --> MQ
  MQ_PUB --> MQ
  REPO --> MYSQL
  USER_REPO --> MYSQL
  SVC -.->|@Cacheable| REDIS

  MINI_CG --> DEP_GRAPH
  MINI_CG --> DISPATCH
  MINI_CG --> IMPACT
```

## 目录结构

```
src/
├── analysis/                    # 分析工具
├── cli/                         # CLI 入口 (commander)
├── core/                        # 内核 (codegraph 精简)
│   ├── indexer/                 # 索引调度
│   │   ├── full-index.ts        # 全量并行索引
│   │   ├── incremental.ts       # 增量更新
│   │   └── worker-pool.ts       # Worker 线程池
│   ├── parser/                  # tree-sitter 解析
│   │   └── languages/           # 各语言解析器
│   ├── store/                   # SQLite 存储 (v7 schema)
│   └── watcher/                 # 文件监视 (chokidar)
├── db/                          # 数据库访问层
│   ├── connection.ts            # SQLite 连接管理
│   ├── queries.ts               # 查询管理器
│   └── schema.ts                # 表定义 + SQL 语句
├── extraction/                  # 48+ 提取器
│   ├── languages/               # 语言解析器
│   ├── orchestrator.ts          # 提取编排 + 50+ 专业提取器
│   └── routes.ts                # 多框架路由检测
├── graph/                       # 图查询
│   ├── queries.ts               # 图查询管理器
│   └── traversal.ts             # 图遍历
├── mcp/                         # MCP 协议层
│   ├── handlers/                # 9 个 MCP 工具处理
│   ├── server.ts                # MCP Server
│   ├── tools.ts                 # 工具注册
│   └── transport.ts             # 传输层
├── resolution/                  # 解析推理层
│   ├── dispatch-inference/      # 派发推断引擎
│   │   ├── detectors/           # 7 个派发检测器
│   │   ├── variable-tracer.ts   # 跨方法变量追踪
│   │   ├── resolver.ts          # 合并 + 去重
│   │   └── types.ts             # 类型定义
│   ├── condition-matcher.ts     # @Conditional* 评估
│   ├── config-reader.ts         # 配置读取
│   └── frameworks/              # 框架检测
├── visualization/               # 可视化
│   └── mermaid.ts               # 6 种 Mermaid 图生成
├── workspace/                   # 工作区全局关系
│   ├── extractors/              # 7 个框架提取器
│   ├── graph-builder.ts         # provides/consumes 匹配
│   ├── scanner.ts               # 多项目发现
│   └── sync.ts                  # 工作区增量同步
├── ui/
└── shared/                      # 共享工具
```
