## Why

Codex Desktop 中的 threads 分散在不同项目和会话中，运行状态、待审核事项和归档状态缺少一个统一的注意力管理视图。这个变更要把本地 Codex threads 聚合成一个只读同步、项目化、可筛选、可归档的 Kanban view，让用户快速发现正在运行和需要人工审核的工作。

## What Changes

- 新增 Codex Thread Kanban View，用于展示从 Codex Desktop 同步来的 thread 列表。
- 新增项目注册表和项目识别规则，通过 thread cwd、origin URL、目录别名把 thread 归属到项目。
- 新增看板状态流转：未分类、运行中、待人工审核、已审核、已归档。
- 新增运行中聚焦视图和待人工审核聚焦视图，作为一级入口。
- 新增固定字段标签和筛选，包括 priority、owner、reviewer、task_type、module、sprint、risk_level、review_state。
- 新增归档与恢复归档能力，归档后默认从活跃视图隐藏。
- 新增 Codex Desktop deep link 操作，用于打开项目入口和打开已有 thread 详情。
- 明确不接管 Codex 执行：不调用 thread/start、turn/start、approval 相关写操作，不替代 Codex Desktop 任务详情页。

## Capabilities

### New Capabilities

- `thread-sync`: 从 Codex app-server 只读同步 threads，并维护本地 thread 元数据。
- `project-classification`: 根据本地项目注册表自动识别 thread 所属项目。
- `kanban-status`: 将 Codex thread runtime 状态映射到看板状态，并支持人工审核和归档状态。
- `thread-fields-filtering`: 为 thread 维护固定字段标签、筛选条件和内置聚焦视图。
- `codex-deeplink-navigation`: 从看板视图通过 Codex deep link 打开项目和 thread 详情。

### Modified Capabilities

- 无。

## Impact

- 需要新增桌面端前端视图、同步 worker、本地持久化模型和 Codex app-server 只读客户端。
- 需要持久化 projects、codex_threads、thread_events、filter_presets 等数据。
- 需要支持 SQLite 本地存储，并预留 Tauri/React/TypeScript 桌面应用结构。
- 需要定义只读同步边界，避免执行 Codex thread、turn 或 approval 写操作。
