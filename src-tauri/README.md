# Tauri 主进程骨架

这个目录按 `codex-thread-kanban-view` PRD 预留桌面端边界：

- `services/ThreadSync.rs`：只读同步入口，只允许 `thread/list`、`thread/read`、`thread/status/changed`。
- `services/ProjectMatcher.rs`：项目识别，首要规则是 cwd 最长路径优先。
- `services/BoardStatusMapper.rs`：Codex runtime status 到看板状态的保守映射。
- `db/001_init.sql`：本地 SQLite schema，目标数据库为 `~/.codex-kanban/app.db`。

当前前端原型使用 mock 数据，后续接 Tauri command 时保持“不调用 Codex 执行写操作”的边界。
