# Testing

## Current Knowledge

- 修改 Thread Kanban 同步、刷新、评论加载或 Tauri command 时，至少运行 `npm test -- --run`、`npm run build`、`cargo test`、在 `src-tauri` 下运行 `cargo fmt --check`，并运行 `git diff --check`。
- 后端需要覆盖 command 同步语义，确保 `load_board_data` 保持只读、`sync_codex_threads` 保持显式强制同步、后台 `start_codex_sync` 不会并发启动多个同步任务。
- 前端需要覆盖常驻工具栏不再显示停止同步、停止刷新、停止解析、只读轮询、关闭评论等旧诊断开关，确保这些开关不会被误恢复。
- 涉及评论加载时，需要覆盖评论懒加载和 BoardData merge 行为，确认最新评论异步展示不会进入周期刷新主链路，已加载评论在数据刷新后能按 thread id 保留。

## Update Notes

- 2026-07-04: 记录 Thread Kanban 同步/刷新问题修复后的回归测试范围。
- 2026-07-08: 前端列表行新增最新评论异步展示后，测试重点改为可见行后台加载评论且不调用阻塞式 `sync_codex_threads`。
