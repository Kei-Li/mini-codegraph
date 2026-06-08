# 验收标准（Acceptance Criteria）

## 阶段一：核心管线重构（P0）

| # | 验收项 | 验证方式 | 状态 |
|---|--------|---------|------|
| 1.1 | `FileScanner` 支持 async generator 流式输出文件路径 | `tsc --noEmit` + 单元测试 | ⬜ |
| 1.2 | `FileScanner` 支持预扫描跳过未变更文件 | 单元测试 | ⬜ |
| 1.3 | `WriteQueue` 支持即时写入 + 自动批量化 | 单元测试 | ⬜ |
| 1.4 | `WriteQueue` 的 `flushSync()` 确保所有数据落盘 | 单元测试 | ⬜ |
| 1.5 | `indexProject` 使用流式管线（不再全量 `toIndexAll[]`） | `tsc --noEmit` + 集成测试 | ⬜ |
| 1.6 | `indexProject` 不再累积 `result.nodes/edges`（仅计数器） | 内存分析 | ⬜ |
| 1.7 | Worker 不再回传 `source` 字段 | `tsc --noEmit` | ⬜ |
| 1.8 | 注解提取（含 @ 文件）支持按需重读源码 | 集成测试 | ⬜ |
| 1.9 | 10 万文件场景峰值内存 < 512MB | 性能测试 | ⬜ |

## 阶段二：Worker Pool 增强（P0）

| # | 验收项 | 验证方式 | 状态 |
|---|--------|---------|------|
| 2.1 | `WorkerPool.submit()` 支持任务排队 | 单元测试 | ⬜ |
| 2.2 | `WorkerPool.pressure` 返回 0~1 背压系数 | 单元测试 | ⬜ |
| 2.3 | Worker 全忙时任务排队等待，不退化为同步主线 | 集成测试 | ⬜ |
| 2.4 | 背压信号反馈给 Scanner，自动调速 | 集成测试 | ⬜ |

## 阶段三：写入优化（P1）

| # | 验收项 | 验证方式 | 状态 |
|---|--------|---------|------|
| 3.1 | 文件 upsert 改为批量 `INSERT OR REPLACE` | 查询日志确认 | ⬜ |
| 3.2 | SQL 构建改为增量拼接，避免大字符串 O(n²) | 代码审查 | ⬜ |
| 3.3 | 定时 `PRAGMA wal_checkpoint(TRUNCATE)` 控制 WAL 大小 | 文件大小检查 | ⬜ |
| 3.4 | 10 万文件写入时间 ≤ 60s | 性能测试 | ⬜ |

## 阶段四：后台化（P2）

| # | 验收项 | 验证方式 | 状态 |
|---|--------|---------|------|
| 4.1 | FTS 重建在后台执行，不阻塞 CLI 返回 | CLI 体验测试 | ⬜ |
| 4.2 | FTS 未就绪时搜索降级为精确搜索 | 集成测试 | ⬜ |
| 4.3 | Post-processing 支持流式触发 | 集成测试 | ⬜ |
| 4.4 | Resolution pipeline 增量式分段处理 | 单元测试 | ⬜ |

## 最终验收（5 分钟索引 10 万文件）

| # | 指标 | 目标 | 验证方式 |
|---|------|------|---------|
| F1 | 索引 10 万文件总时间 | < 300s | `time mini-codegraph index` |
| F2 | 峰值内存 | < 512MB | `--max-old-space-size` 限制测试 |
| F3 | postMessage 数据量 | < 10MB | Worker 通信监控 |
| F4 | 增量同步 100 文件 | < 2s | `mini-codegraph index --changed` |
| F5 | 搜索查询延迟 | < 200ms | `mini-codegraph search` |
