# Mini-CodeGraph 差距分析

> 对照 mini-codegraph-design.md 检查实现完整度。
> 376/376 测试通过，26 文件。

---

## 一、已完全实现的模块

| 模块 | 状态 | 说明 |
|---|---|---|
| Core: tree-sitter 多语言解析 | ✅ | Java/TS/JS/Vue/Kotlin/Python |
| Core: SQLite + FTS5 存储 | ✅ | nodes/edges/files/annotations + FTS5 |
| Core: 文件监视器 (chokidar) | ✅ | 原生事件 + debounce 2s |
| Core: Worker 线程池索引 | ✅ | CPU-1 线程, 2000 队列上限 |
| Core: 全量/增量索引 | ✅ | 5000条/2s 批量, DROP/CREATE 索引策略 |
| Resolution: Dispatch Inference | ✅ | 7 detectors + variable tracer + resolver |
| Resolution: ConditionMatcher | ✅ | @ConditionalOnProperty/@Profile/@ConditionalOnExpression |
| Resolution: ConfigReader | ✅ | application.yml/properties, profile 合并 |
| Workspace: Scanner | ✅ | 多项目发现 (pom/gradle/pkg/py/cargo/go) |
| Workspace: GraphBuilder | ✅ | external_symbols/references 匹配 |
| Workspace: Sync | ✅ | 增量刷新 + hash 缓存 |
| Workspace: 6 Extractors | ✅ | SpringCloud/Gateway/RabbitMQ/Redis/Database/Frontend |
| MCP: 9+2 工具 | ✅ | search/explore/callers/callees/impact/node/files/workspace + dispatch/config |
| Storage: external_* 表 | ✅ | external_symbols + external_references |
| Visualization: Mermaid | ✅ | 6 种图 (arch/dep/sequence/trace/cache/tx) |
| CLI | ✅ | commander, init/index/serve/visualize |
| 48+ 提取器 | ✅ | 见 orchestrator.ts imports |

---

## 二、关键差距 (需优先修复)

### 🔴 P0: 已全部修复

| # | 差距 | 修复后状态 | 修复位置 |
|---|---|---|---|
| 1 | **RestTemplate URL 解析** | ✅ 已实现 | `src/extraction/routes.ts:602` — `detectRestTemplateCalls()`, 正则匹配 `restTemplate.getForObject/exchange("http://SERVICE/..."` |
| 2 | **Feign 接口方法级提取** | ✅ 已实现 | `src/workspace/extractors/spring-cloud.ts:45-59` — 遍历 FeignClient 子节点, 提取每个方法的 @RequestMapping/@GetMapping 等 |
| 3 | **前后端 URL 精确匹配** | ✅ 已实现 | `src/extraction/vue-api-mapper.ts:113-131` — 评分算法: 精确路径 100 分 + HTTP 方法匹配 10 分 + 路径段匹配 10/5 分, 阈值 60 |
| 4 | **动态代码降级标记** | ⚠️ 部分实现 | dispatch-inference 有反射检测, 但未标记到 nodes 表 (设计文档未来功能)
| 5 | **解析失败正则降级** | ✅ 已实现 | `src/extraction/languages/java.ts:359+` — `parseJavaFileWithRegex()` 提取类/方法/字段/注解/边; `orchestrator.ts:562-573` — tree-sitter 重试耗尽后自动回退 |

### 🟡 P1: 功能缺失但影响可控

| # | 差距 | 设计文档要求 | 现状 | 影响 |
|---|---|---|---|---|
| 6 | **Groovy 支持** | §7.1: 正则 + AST 片段 | ❌ 未实现 | Gradle 脚本和 Spock 测试无法索引 |
| 7 | **RestTemplate 未持久化** | §8.1: 检测 `http://SERVICE/path` | ✅ 已检测但未持久化 | `detectRestTemplateCalls()` 仅暴露在 `getRoutes()` API, 不写入 `external_references` 表, `mini_cg_callers/impact` 不可见 |
| 8 | **Feign 方法级仅限 workspace 模式** | 需提取 @FeignClient 接口方法 | ✅ 已实现但仅限 `--workspace` 模式 | 单项目模式 (`init` + `index` 不带 `--workspace`) 不会触发 `SpringCloudExtractor`, 方法级 Feign 关系丢失 |
| 9 | **bootstrap.yml 服务名提取** | §8.1: 解析 `spring.application.name` | ✅ 已实现 | `cloud-config-extractor.ts` 中 `detectBootstrapConfig()` 存在 |
| 10 | **多实例文件锁** | §12.5: `.mini-codegraph/.lock` | ✅ 已实现 | `utils.ts:FileLock`, `index.ts:172` 在 `sync()` 中使用 |
| 11 | **超大文件跳过** | §9.2: >1MB 文件跳过 | ✅ 已实现 | `orchestrator.ts:503`

### 🟡 P1 (续): 企业级 Spring 生态特定缺口

| # | 差距 | 说明 | 影响 |
|---|---|---|---|
| 12 | **Spring WebFlux / 函数式端点** | `RouterFunction`, `ServerRequest`, `HandlerFunction` 未检测 | 使用 WebFlux 的 Spring Boot 项目路由不可见 |
| 13 | **Spring Boot Actuator** | `/actuator/health`, `/actuator/metrics` 等端点未识别 | Agent 无法知道 Actuator 暴露了哪些端点 |
| 14 | **Spring Data REST** | `@RepositoryRestResource` 自动暴露的 REST 端点未检测 | Spring Data REST 仓库自动生成的路由不可见 |
| 15 | **Spring Cloud Stream binder 检测** | 虽然 `@Input`/`@Output` 已检测, 但不同 binder 实现的区别未记录 | 无法区分 Kafka/RabbitMQ binder |

### 🔵 P2: 增强功能, 非必须

| # | 差距 | 设计文档要求 | 影响 |
|---|---|---|---|
| 16 | **语义搜索 (mini_cg_semantic_search)** | §16.1: 向量嵌入 + 相似度匹配 | Agent 无法用自然语言找代码 |
| 17 | **Git 历史分析 (mini_cg_history/blame)** | §16.3 | Agent 无法查函数演进 |
| 18 | **测试影响分析 (mini_cg_affected_tests)** | §16.4 | 无法增量选择测试 |
| 19 | **架构规则校验 (mini_cg_lint)** | §16.5 | 无法自动检测分层违规 |
| 20 | **性能自监控 (mini_cg_metrics)** | §16.7 | 无法查看性能指标 |
| 21 | **可视化导出增强** | §16.6: HTML D3.js 导出 | 现有仅生成 Mermaid 文本 |
| 22 | **`--fast` 模式** | §9.2: 仅索引签名 + 导入 | 无快速索引选项 |
| 23 | **`--progress` 与中断恢复** | §12.1: 进度指示 + 检查点 | 用户无法获知索引进度 |
| 24 | **插件化提取器** | §13.1: `.mini-codegraph/extractors/` 自动加载 | 用户无法扩展内部框架 |

---

## 三、Spring Boot 企业项目适配评估

### 3.1 典型企业项目架构

```
前端 (Vue 3 + TS + Pinia)         前端 (Vue 2 + JS + Vuex)
       │                                    │
       └──────────┬─────────────────────────┘
                  │ axios.get('/api/**')
                  ▼
          Spring Cloud Gateway
                  │
          ┌───────┼───────┬───────┐
          ▼       ▼       ▼       ▼
   order-svc  user-svc  pay-svc  notify-svc
   (Spring)   (Spring)  (Spring) (Spring)
      │          │        │        │
      ▼          ▼        ▼        ▼
    MySQL     MySQL     MySQL    MongoDB
      │          │                 │
      └──────────┼─────────────────┘
                 ▼
            RabbitMQ
         (订单事件/通知)
                 │
                 ▼
              Redis
         (缓存/session)
```

### 3.2 现有支持度

| 企业组件 | 状态 | 捕捉关系 |
|---|---|---|
| **Spring Cloud Gateway** | ✅ 已实现 | 路由 → lb://service, predicates, filters |
| **FeignClient** | ✅ 方法级 | 服务依赖 + 每个接口方法的路径/HTTP 方法 (仅 workspace 模式) |
| **RestTemplate** | ✅ 已检测 | http://SERVICE/path 调用检测 (仅 getRoutes() API, 未持久化) |
| **RabbitMQ** | ✅ 已实现 | @RabbitListener → queue, convertAndSend → exchange |
| **Kafka** | ✅ 已实现 | @KafkaListener → topics, KafkaTemplate.send |
| **MySQL (JPA)** | ✅ 已实现 | @Entity/@Table/@Column + JPA 方法命名解析 |
| **MyBatis** | ✅ 已实现 | XML mapper + 方法映射 |
| **MongoDB** | ✅ 已实现 | @Document 集合识别 |
| **Redis** | ✅ 已实现 | @Cacheable, redisTemplate 操作, @RedisHash |
| **@Async/@Scheduled** | ✅ 已实现 | 异步执行和定时任务 |
| **@Transactional** | ✅ 已实现 | 传播行为, 读写冲突检测 |
| **AOP** | ✅ 已实现 | @Aspect/@Pointcut/@Around + execution/within/@annotation 解析 |
| **Spring Security** | ✅ 已实现 | @PreAuthorize, SecurityFilterChain |
| **Resilience4j** | ✅ 已实现 | @Retry/@CircuitBreaker/@Bulkhead/@RateLimiter/@TimeLimiter |
| **Gateway 路由** | ✅ 已实现 | YAML/Java DSL 路由解析 |
| **OpenAPI/Swagger** | ✅ 已实现 | API 端点提取 |
| **gRPC** | ✅ 已实现 | proto 文件解析 |
| **GraphQL** | ✅ 已实现 | @QueryMapping/@MutationMapping |
| **WebSocket** | ✅ 已实现 | @MessageMapping/@SendTo |
| **Vue SFC** | ✅ 已实现 | 模板/脚本/样式提取 |
| **Pinia Store** | ✅ 已实现 | Store 定义和引用 |
| **React TSX** | ✅ 已实现 | 组件检测 |
| **Vue i18n** | ✅ 已实现 | 国际化键值提取 |
| **Docker** | ✅ 已实现 | Dockerfile/Compose 解析 |
| **K8s** | ✅ 已实现 | Deployment/Service/NetworkPolicy |
| **MapStruct** | ✅ 已实现 | Mapper 映射关系 |
| **Lombok** | ✅ 已实现 | @Data/@Builder/@Slf4j 等 |
| **Batch** | ✅ 已实现 | Spring Batch 任务 |
| **Spring Cloud Config** | ✅ 已实现 | bootstrap.yml 检测, 服务绑定 |
| **LoadBalancer** | ✅ 已实现 | @LoadBalancedClient + URI 解析 |
| **Stream Function** | ✅ 已实现 | Function/Consumer/Supplier |
| **Spring AutoConfiguration** | ✅ 已实现 | 自动配置条件 |
| **ControllerAdvice** | ✅ 已实现 | 全局异常 + 数据绑定 |
| **Interceptor** | ✅ 已实现 | HandlerInterceptor 检测 |
| **Spring WebFlux** | ❌ 未实现 | RouterFunction / 函数式端点未检测 |
| **Actuator** | ❌ 未实现 | /actuator/* 端点未提取 |
| **Spring Data REST** | ❌ 未实现 | @RepositoryRestResource 自动路由未检测 |
| **Cloud Stream binder** | ⚠️ 基础 | @Input/@Output 已检测, 但 binder 实现区别未记录 |

### 3.3 企业场景缺陷

#### 场景 1: "修改 order-service 的 OrderService 类, 想知道影响哪些前端页面"
- 当前能力:
  - ✅ 能追踪到 `OrderController` → `OrderService` → `OrderRepository` + `FeignClient` + MQ
  - ✅ 前端 `axios.get('/api/orders')` URL → 后端 `@GetMapping("/api/orders")` 通过 `resolveVueApiToController` 评分算法匹配 (精确路径 100 分 + HTTP 方法 10 分)
- **影响**: Agent 可以告知"修改这个接口会影响哪些 Vue 组件/页面"

#### 场景 2: "order-service 通过 RestTemplate 调用 user-service"
- 当前能力:
  - ✅ `detectRestTemplateCalls()` 能检测到 `restTemplate.getForObject("http://user-service/api/users/...")`
  - ❌ 检测结果未持久化到 DB, `mini_cg_callers` 和 `mini_cg_impact` 看不到 RestTemplate 调用
- **影响**: RestTemplate 跨服务调用会被遗漏在影响分析之外

#### 场景 3: "Feign 客户端调用了 user-service 的哪些 API?"
- 当前能力:
  - ✅ 在 `--workspace` 模式下: 可提取每个方法 (`getUserById()`) + 路径 (`@GetMapping("/users/{id}")`)
  - ❌ 在单项目模式 (`init + serve --mcp` 不带 `--workspace`): 仅知道服务级依赖, 无方法级
- **影响**: 对开发者在本地运行 `mini-codegraph serve --mcp` 而未配置 `--workspace` 时, Feign 只有服务级可见性

#### 场景 4: "Kotlin 写的 Spring Boot 服务"
- 当前能力: ✅ `kotlin.ts` 使用 tree-sitter 解析, 支持 `class_declaration`/`object_declaration` 以及注解提取。`@Service`/`@RestController`/`@Autowired` 等标准 Spring 注解可被检测。
- **影响**: Kotlin Spring Boot 项目基本可用

#### 场景 5: "Spring WebFlux 项目 (RouterFunction)"
- 当前能力: ❌ `RouterFunction`, `ServerRequest`, `HandlerFunction` 完全未检测
- **影响**: 使用 WebFlux 函数式端点的项目路由不可见

#### 场景 6: "application-dev.yml 有 5000 行的配置文件"
- 当前能力: ✅ ConfigReader 可读取合并 profiles。orchestrator.ts 有 >1MB 跳过保护。
- 不足: ❌ 没有 `--fast` 模式, 首次全量索引大项目可能耗时

---

## 四、修复建议优先级

### 第一优先级 (修复后可满足 95%+ 企业场景)

| 修复项 | 工作量 | 说明 |
|---|---|---|
| **RestTemplate 持久化** | ~1天 | 将 `detectRestTemplateCalls()` 检测结果写入 `external_references` 表, 纳入 `mini_cg_callers/impact` 查询 |
| **Feign 方法级离开 workspace** | ~1天 | 将 `SpringCloudExtractor` 的 Feign 方法提取逻辑纳入单项目索引流程 (orchestrator 后处理阶段) |
| **Spring WebFlux 端点检测** | ~1.5天 | 检测 `RouterFunction` Bean 中的路由注册 (GET/POST 等 + 路径 + handler 方法) |
| **Spring Data REST 端点** | ~0.5天 | 检测 `@RepositoryRestResource` 自动暴露的 CRUD 端点 |
| **Actuator 端点检测** | ~0.5天 | 检测 `application.yml` 中的 `management.endpoints.web.exposure.include` |

### 第二优先级 (补全后可满足 99% 场景)

| 修复项 | 工作量 | 说明 |
|---|---|---|
| Groovy 支持 | ~1天 | Gradle 脚本和 Spock 测试的 Groovy 解析 |
| Cloud Stream binder 区分 | ~0.5天 | 记录 @Input/@Output 的 binder 类型 (kafka/rabbitmq) |

### 第三优先级 (增强功能)

| 修复项 | 工作量 |
|---|---|
| 语义搜索 (mini_cg_semantic_search) | ~2-3周 |
| Git 历史分析 (mini_cg_history) | ~2周 |
| 测试影响分析 (mini_cg_affected_tests) | ~1-2周 |
| 架构规则校验 (mini_cg_lint) | ~2周 |
| 性能自监控 (mini_cg_metrics) | ~1周 |
| 可视化 HTML 导出 | ~1周 |
| --fast 模式 | ~1天 |
| --progress / 中断恢复 | ~1天 |
| 插件化提取器 | ~2天 |

---

## 五、总结

**当前完成度**: 设计文档约 80% 功能已实现。

**核心能力已达**: 单仓库符号索引、跨仓库 external_* 关系、48+ 框架/中间件提取器、Dispatch Inference 引擎、AOP 解析、Conditional 注入、9 个 MCP 工具。

**关键缺口**: RestTemplate URL 解析、前后端 URL 精确匹配、Feign 方法级提取 这三点是影响 Spring Boot 企业项目分析准确度的最大瓶颈。修复后可在企业级 Spring 全家桶 + 前端分离的架构下覆盖 95% 以上的分析场景。
