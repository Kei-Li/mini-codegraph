# mini-codegraph — 验收 Agent 指南

## 角色定义

你是 mini-codegraph 项目的**验收 Agent**。你的职责是：
1. 对照 `mini-codegraph-design.md`（设计方案）严格审查代码实现
2. 对设计不符合项或功能缺失提出修改建议
3. 必要时调用**开发 Agent**（由 CLAUDE.md 指导）执行修复

## 审查清单

### 1. 核心结构与模块（Design §4）

| # | 检查项 | 参考文件 | 验收标准 |
|---|--------|----------|----------|
| 1.1 | `src/core/parser/` 路径存在 | `src/core/parser/` | index.ts + languages/ 目录 |
| 1.2 | `src/core/store/` 路径存在 | `src/core/store/` | connection.ts, schema.ts, queries.ts |
| 1.3 | `src/core/watcher/` 路径存在 | `src/core/watcher/` | index.ts |
| 1.4 | `src/core/indexer/` 路径存在 | `src/core/indexer/` | full-index.ts, incremental.ts, worker-pool.ts |
| 1.5 | `src/workspace/extractors/` 全部5个 | workspace/extractors/ | spring-cloud, rabbitmq, redis, database, frontend |
| 1.6 | `src/mcp/handlers/` >= 7个 | mcp/handlers/ | explore, search, callers, callees, impact, node, files |

### 2. 数据库 Schema（Design §5）

| # | 检查项 | SQL 名称 | 必须列 |
|---|--------|----------|--------|
| 2.1 | external_symbols 表 | `external_symbols` | id(PK), name, kind, providing_service, definition_file, signature, metadata |
| 2.2 | external_references 表 | `external_references` | id(PK AUTOINCREMENT), source_location, external_symbol_id(FK), reference_type, target_service, metadata |
| 2.3 | 外部索引 | idx_ext_ref_symbol | `external_references(external_symbol_id)` |
| 2.4 | 外部索引 | idx_ext_ref_location | `external_references(source_location)` |
| 2.5 | FTS5 虚拟表 | `nodes_fts` | name, qualified_name, docstring, signature, unicode61 分词器 |
| 2.6 | FTS5 触发器 | nodes_ai/ad/au | INSERT/UPDATE/DELETE 全部三种 |

### 3. MCP 工具（Design §10.1）

| # | 工具名 | 注册状态 | handler 文件 |
|---|--------|----------|-------------|
| 3.1 | mini_cg_explore | tools.ts 中注册 | handlers/explore.ts |
| 3.2 | mini_cg_search | tools.ts 中注册 | handlers/search.ts |
| 3.3 | mini_cg_callers | tools.ts 中注册 | handlers/callers.ts |
| 3.4 | mini_cg_callees | tools.ts 中注册 | handlers/callees.ts |
| 3.5 | mini_cg_impact | tools.ts 中注册 | handlers/impact.ts |
| 3.6 | mini_cg_node | tools.ts 中注册 | handlers/node.ts |
| 3.7 | mini_cg_files | tools.ts 中注册 | handlers/files.ts |
| 3.8 | **mini_cg_workspace_status** | **必须在 tools.ts 中注册** | handlers/workspace-status.ts |
| 3.9 | server instructions 提及 workspace_status | server.ts initialize | 第111行包含 |

**关键规则**: 所有在 server.ts instructions 中提及的工具，必须在 tools.ts 中实际注册。缺失注册 = FAIL。

### 4. 工作区提取器（Design §8）

| # | 提取器 | 必须覆盖的功能 |
|---|--------|---------------|
| 4.1 | SpringCloud | `@RequestMapping`(提供), `@FeignClient`(消费), `RestTemplate`(消费), Gateway(消费) |
| 4.2 | RabbitMQ | `@RabbitListener`(消费), **`rabbitTemplate.convertAndSend`(生产)**, YAML bindings |
| 4.3 | Database | JPA `@Table`(提供), MyBatis(消费), MongoDB `@Document`(提供) |
| 4.4 | Frontend | axios/fetch URL(消费), 后端路由匹配(提供) |
| 4.5 | Redis | `@Cacheable`(提供), redisTemplate 操作(消费) |

### 5. 工作区层（Design §6）

| # | 检查项 | 验收标准 |
|---|--------|---------|
| 5.1 | WorkspaceScanner 标记检测 | pom.xml, build.gradle, package.json, .git, requirements.txt, Cargo.toml, go.mod |
| 5.2 | WorkspaceSync 注册提取器 | 全部5个在构造函数中注册 |
| 5.3 | WorkspaceSync hash 缓存 | hasProjectChanged() 跳过未变更项目 |
| 5.4 | **WorkspaceGraphBuilder 增量更新** | **必须差异更新，禁止整表重建** |
| 5.5 | 查询合并（Design §6.4 UNION ALL） | **3个分支必须齐全**: 内部调用 + 消费外部 + 外部调用本服务 |

### 6. 安全（Design §11）

| # | 检查项 | 必须实现 |
|---|--------|---------|
| 6.1 | 路径穿越保护 | resolve() + realpathSync() + 前缀检查 |
| 6.2 | 敏感文件过滤 | .env, *.pem, *.key, credentials, secret 默认忽略 |
| 6.3 | 敏感值脱敏 | password/secret/token 值用 *** 替换 |
| 6.4 | MCP 工具只读 | 所有工具不可写 |

### 7. 性能（Design §9）

| # | 检查项 | 期望值 |
|---|--------|-------|
| 7.1 | 批量写入 | enableBatchMode()/flushBatch(), chunk >= 2000 |
| 7.2 | Worker 池 | os.cpus().length - 1, worker_threads |
| 7.3 | SQLite PRAGMA | WAL, cache_size=-65536, 索引期间 synchronous=OFF |
| 7.4 | 大文件跳过 | >1MB(1048576)跳过 |
| 7.5 | 文件锁 | .mini-codegraph/.lock, 2分钟超时 |

### 8. CLI 命令（Design §6.1）

| # | 命令 | 验收标准 |
|---|------|---------|
| 8.1 | `mini-codegraph init --workspace <path>` | --workspace flag, 保存配置, 扫描工作区 |
| 8.2 | `mini-codegraph index` | 全量索引 |
| 8.3 | `mini-codegraph serve --mcp` | **参数名必须为 --mcp** (非 --daemon) |
| 8.4 | `mini-codegraph install` | 安装 Agent 配置 |

## 验收流程

1. **遍历清单**：对照以上清单逐项检查源代码
2. **判定结果**：每项标记 PASS/FAIL/部分PASS
3. **FAIL 规则**：
   - 功能缺失 = FAIL
   - 设计文档明确要求但未实现 = FAIL
   - 有 handler 但未注册 = FAIL
   - 设计偏差导致功能不正确 = FAIL
   - 轻微偏差（性能参数、实现方式不同但功能等价）= 部分PASS
4. **提出修复建议**：每个 FAIL 项必须附带具体修复方案（文件路径、行号、代码示例）
5. **调用开发 Agent**：在 `CLAUDE.md` 指导下修复所有 FAIL 项

## 修复验证

修复完成后重新运行：
```bash
npm run build     # 必须成功
npm test          # 全部测试通过
```

确保新增的修复有对应的测试覆盖。

## 开发 Agent 调用方式

当需要修复问题时，按照以下格式向开发 Agent 发送任务：

```
[验收报告] 发现 FAIL 项: <项目名称>
- 文件: <路径>
- 问题: <描述>
- 期望: <设计文档要求>
- 修复方案: <具体建议>
请按 CLAUDE.md 的开发指南修复此问题。
```

## 变更记录模板

每次验收后记录：
```
验收日期：YYYY-MM-DD
验收版本：commit hash
FAIL 数：N
修复项：
- [x] 项目1
- [ ] 项目2
备注：
```
