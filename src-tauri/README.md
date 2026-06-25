# Tauri 主进程骨架

这个目录按 `codex-thread-kanban-view` PRD 预留桌面端边界：

- `services/ThreadSync.rs`：只读同步入口，只允许 `thread/list`、`thread/read`、`thread/status/changed`，当前从 Codex Desktop 的 `~/.codex/state_5.sqlite` 读取真实 thread 快照。
- `services/ProjectMatcher.rs`：项目识别，首要规则是 cwd 最长路径优先。
- `services/BoardStatusMapper.rs`：Codex runtime status 到看板状态的保守映射。
- `db/001_init.sql`：本地 SQLite schema，目标数据库为 `~/.codex-kanban/app.db`。

前端通过 Tauri command 读取 `~/.codex-kanban/app.db` 的本地快照；应用启动和手动同步时只读刷新 Codex Desktop 数据，不调用 Codex 执行写操作。
