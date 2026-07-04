# Coding

## Current Knowledge

- Thread Kanban 的 UI 轮询路径必须保持轻量：`load_board_data` 只能读取现有 board data，不应触发 Codex Desktop thread 同步、解析或本地扫描。
- 需要主动同步 Codex thread 时，前端应调用后台化的 `start_codex_sync`，再通过 `load_board_data(false)` 刷新 UI；不要在 5 秒自动刷新链路里调用阻塞式 `sync_codex_threads`。
- `sync_codex_threads` 保留为显式强制同步命令；修改时不要把它重新接回前端周期刷新主路径。
- Thread comments 必须继续懒加载，不应进入 `list_threads -> BoardData -> React state -> 周期刷新` 主链路；展开评论时再按 thread id 加载。
- `thread_comments` 查询使用 `WHERE thread_id = ? ORDER BY created_at DESC, id DESC`，数据库 schema 需要保持 `thread_comments(thread_id, created_at, id)` 方向的索引。
- 前端自动刷新相关诊断开关包括停止同步、停止刷新、停止解析、只读轮询、关闭评论；定位刷新类问题时优先用这些开关缩小边界。

## Update Notes

- 2026-07-04: 记录 Thread Kanban 同步/刷新链路约束，避免再次把重同步放回 UI 周期轮询路径。
