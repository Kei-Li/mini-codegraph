# Mini-CodeGraph 开发计划

## 当前状态

| 功能域 | 状态 |
|--------|------|
| 5 语言 AST 解析 (Java/Kotlin/TS/Python/Vue) | ✅ |
| 25+ 文件级提取器 | ✅ |
| 8 个工作区提取器 | ✅ |
| 21 个 MCP 工具 | ✅ |
| SQLite + FTS5 + WAL + 批量写入 | ✅ |
| Worker 线程池 + 安全防护 + 文件锁 | ✅ |
| 增量同步 + Git hooks + Mermaid 可视化 | ✅ |
| F1-F10 Spring Boot 3.x 企业级 gaps | ✅ 已修复 |

---

## 需求冲突说明

| 冲突 | 涉及项目 | 问题 | 解法 |
|------|----------|------|------|
| **R2DBC vs JPA 的 @Table** | I5 ↔ 已有 jpa-extractor | R2DBC `@Table` 和 JPA `@Table` 的 guard 关键词完全一样，无法区分。各自独立提取器会导致同一张表被索引两次 | 新 R2DBC 提取器优先匹配 `import org.springframework.data.relational`，排除 JPA import 的文件 |
| **CSS/HTML/GraphQL 共享集成路径** | I8 ↔ I9 ↔ I10 | 三者都需要：SUPPORTED_LANGUAGES 加条目、tree-sitter WASM、parser 函数、语言路由 | 一次做完，共享模式 |
| **Kotlin 阻塞全局** | I1 ↔ 所有提取器 | Kotlin 不走 extractor → 不存注解 → 所有 DB 查询型提取器查不到 Kotlin 服务的任何数据 | 先修 I1 |
| **JobRunr 与 @Async 叠加** | I7 ↔ async-extractor | `@JobRunr` 和 `@Scheduled`/`@Async` 可能同时出现在同一方法，annotation 节点会重复建 | 统一放 async-extractor，按 annotation name 区分 |

---

## 迭代计划

### Iter 1 — Kotlin 修复 + JobRunr ✅

| # | 项目 | 内容 | 改动文件 | 状态 |
|---|------|------|----------|------|
| I1 | Kotlin 文件加入 extractor 管道 | orchestrator.ts + parse-worker.ts 添加 kotlin 语言路由；`(lang.name === 'java' \|\| lang.name === 'kotlin')` | orchestrator.ts | ✅ |
| I7 | JobRunr 检测 | 合并到 async-extractor，按 `@Job` / `@Recurring` / `@Async` / `@Scheduled` 分四种注解记录 | async-extractor.ts, EXTRACTOR_GUARDS | ✅ |

### Iter 2 — 企业中间件 ✅

| # | 项目 | 内容 | 改动文件 | 状态 |
|---|------|------|----------|------|
| I2 | Spring Integration | `@MessageEndpoint`, `@ServiceActivator`, `@Router`, `@Splitter`, `@Aggregator`, `@Transformer`, `@Filter`, `@InboundChannelAdapter`, `@OutboundChannelAdapter`, `@BridgeFrom`, `@BridgeTo` + channel 边 | spring-integration-extractor.ts (新), orchestrator.ts | ✅ |
| I3 | Spring LDAP | `@Entry`, `@LdapRepository`, `ldapTemplate` 操作 | spring-ldap-extractor.ts (新), orchestrator.ts | ✅ |
| I4 | Spring Session | `@EnableRedisHttpSession`, `@EnableJdbcHttpSession`, `@EnableMongoHttpSession`, `@EnableHazelcastHttpSession` | spring-session-extractor.ts (新), orchestrator.ts | ✅ |
| I5 | R2DBC | 新提取器，仅含 `org.springframework.data.relational` import 时激活，不与 JPA @Table 冲突 | r2dbc-extractor.ts (新), orchestrator.ts | ✅ |
| I6 | jOOQ | `DSLContext` table 访问、SQL dialect 检测 | jooq-extractor.ts (新), orchestrator.ts | ✅ |

### Iter 3 — 前端深度

| # | 项目 | 内容 | 改动文件 |
|---|------|------|----------|
| I8+I9+I10 | CSS/SCSS + HTML + GraphQL 解析 | SUPPORTED_LANGUAGES + 下载 WASM + parser 函数 + 语言路由 | types.ts, 3 个 parser 文件, orchestrator |
| I11 | SSR 框架检测 | scanner.ts 识别 Next.js App Router / Nuxt server 目录结构 | workspace/scanner.ts |

### Backlog

| # | 项目 | 优先级 |
|---|------|--------|
| I14 | 语义搜索（向量嵌入 + ONNX 离线推理） | low |
| I15 | 架构规则校验（YAML 定义分层/依赖规则 → `mini_cg_lint`） | low |
| I16 | Git 历史分析（`git log -L` 符号级别变更追踪） | low |
| I17 | D3.js 可视化导出（力导向图 HTML） | low |
| I12 | ~~`--fast` 模式（仅索引签名+导入）~~ | 已移除 |
| I13 | ~~>500KB 部分解析（超大文件仅提取顶层符号）~~ | 已移除 |

---

## 开发流程

每个迭代完成后：

```
npm run build && npm test
skill: mini-codegraph-review
# review PASS 后 commit
```
