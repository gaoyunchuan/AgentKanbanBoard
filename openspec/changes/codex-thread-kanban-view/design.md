## Context

当前项目要构建的是 Codex Thread Kanban View：Codex Desktop 仍然是 thread 创建、执行、审批和详情查看的唯一入口，本系统只负责把本机 Codex threads 同步成项目化、可筛选、可归档、可聚焦的看板视图。

官方 Codex app-server 提供 `thread/list`、`thread/read` 和 `thread/status/changed` 等能力，可用于读取 stored thread 和 runtime status；Codex app deep links 支持通过 `codex://threads/<thread-id>` 打开已有 thread，通过 `codex://new?path=...` 或 `codex://threads/new?...` 打开新 thread 入口。设计必须保持只读同步边界，不调用 `thread/start`、`turn/start`、approval、shell command 等会改变 Codex 执行状态的接口。

推荐首版技术形态是 Tauri + React + TypeScript + SQLite：桌面端能访问本机项目路径、拉起 Codex deep link、运行本地同步 worker，并持久化用户手工字段。

## Goals / Non-Goals

**Goals:**

- 同步 Codex Desktop 本地 threads，生成统一列表和看板视图。
- 根据项目注册表自动识别 thread 所属项目。
- 将 Codex runtime status 映射为 `untriaged`、`running`、`review_pending`、`reviewed`、`archived`。
- 提供 Running 和 Review Pending 两个一级聚焦视图。
- 支持固定字段标签、组合筛选和内置筛选 preset。
- 支持 archive/unarchive，归档后默认隐藏但不删除数据。
- 支持打开 Codex Desktop 项目入口和已有 thread 详情。

**Non-Goals:**

- 不创建、启动、恢复、fork 或执行 Codex thread。
- 不调用 `turn/start`、approval 或 shell command 类写操作。
- 不替代 Codex Desktop 的任务详情页、diff review 或审批流。
- 不做灵活 tag 系统、多人权限、PR/CI 集成或自定义工作流。
- 不在首版实现服务端团队协作存储。

## Decisions

### 1. 本地只读 sidecar 同步

系统启动本地 Codex app-server 连接或连接已存在的 app-server，只调用只读读取能力同步 threads。首屏加载时全量同步最近 100 至 200 条，前台 5 秒轮询，后台 30 秒轮询；如果能订阅 runtime 事件，则用 `thread/status/changed` 加速刷新。

选择这个方案是因为它保留 Codex Desktop 的执行权威，同时能提供足够及时的看板状态。替代方案是直接解析本地 session 文件，但该方式更依赖内部文件结构，难以稳定获取 runtime status。

### 2. SQLite 保存同步快照和人工字段

本地维护以下核心表：

- `projects`：项目注册表，包含 id、name、path、origin_url、aliases_json。
- `codex_threads`：同步来的 thread 快照、项目归属、看板状态、人工字段和归档字段。
- `thread_events`：记录状态变化和同步决策，便于解释自动流转。
- `filter_presets`：保存内置和用户自定义筛选条件。

同步字段和人工字段放在同一 thread 表中，便于列表查询和筛选；自动状态变化通过 event 表审计。替代方案是把人工字段拆成独立 overlay 表，但首版查询复杂度更高。

### 3. 项目识别使用最长路径优先

项目匹配按以下顺序执行：cwd 精确匹配、cwd 子目录匹配、origin URL 匹配、cwd basename 或 aliases 匹配。多个项目命中时选择 path 最长的项目，避免父目录项目覆盖子项目。

这个策略能覆盖本机多仓库和 monorepo 子目录场景。无法识别时归入 `unknown`，由用户后续补充项目配置。

### 4. 看板状态自动流转保守处理

`running` 来自 Codex runtime active 状态或 waiting approval 子状态；`review_pending` 只在 thread 曾经进入 running、当前不再 running、最近 2 分钟没有更新且未归档时自动进入。人工标记 `reviewed` 或 `archived` 后，后续同步不得无条件覆盖；只有 thread 再次进入 running 时才允许回到运行中。

保守规则可以降低历史 thread、纯问答 thread 和刚同步 thread 被误放入待审核的概率。

### 5. 固定字段优先于自由标签

首版字段固定为 priority、owner、reviewer、task_type、module、sprint、risk_level、review_state。这些字段足够支撑待审核、运行中和高优先级等聚焦视图，也便于后续做表格筛选。

自由标签灵活但容易失控，会让首版职责从“注意力管理”扩散为通用任务系统，因此不纳入首版。

### 6. Deep link 只负责跳转

打开项目使用 `codex://new?path=<absolute-path>`，打开已有 thread 使用 `codex://threads/<thread-id>`。系统可生成带 prompt 的项目入口链接，但用户仍需在 Codex Desktop 内确认和执行。

该设计让用户从看板回到官方体验处理详情，避免复制 Codex 执行和审批能力。

## Risks / Trade-offs

- [Risk] Codex app-server 接口和 runtime status 字段可能变化。→ Mitigation：封装 Codex client 层，保留未知状态原始值，UI 对未知状态降级为 `untriaged` 或保持旧状态。
- [Risk] 轮询同步可能带来延迟或重复写入。→ Mitigation：按 `updated_at`、runtime status 和字段 hash 做幂等 upsert，并支持事件订阅加速。
- [Risk] 自动进入 `review_pending` 可能误判。→ Mitigation：要求曾经 running、结束后稳定 2 分钟且没有人工锁定状态。
- [Risk] 项目路径匹配可能误归类。→ Mitigation：最长路径优先，展示 unknown 项目队列，并允许用户补充 aliases 或 origin URL。
- [Risk] 只读边界限制了自动化能力。→ Mitigation：把执行、审批和详情明确交给 Codex Desktop，产品定位保持为 Kanban View 和注意力管理。

## Migration Plan

1. 初始化本地 SQLite schema 和内置筛选 preset。
2. 允许用户维护 projects 注册表。
3. 接入 Codex app-server 只读同步并写入 thread 快照。
4. 启用项目识别和状态映射。
5. 发布 Running、Review Pending、All Active 和 Archived 视图。
6. 增加字段编辑、筛选、归档和 deep link 跳转。

首版本地数据可通过删除 SQLite 数据库回滚；如果 schema 变更，需要提供轻量迁移脚本并保留原始 Codex thread id。

## Open Questions

- Codex runtime status 的具体枚举是否需要适配多个版本。
- 是否需要在首版支持连接已有 app-server，还是由应用自动拉起 sidecar。
- reviewed 默认在活跃视图保留多久，首版可先设为最近 7 天。
