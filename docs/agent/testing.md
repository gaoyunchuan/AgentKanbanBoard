# Testing

## Current Knowledge

- 修改 Thread Kanban 同步、刷新、评论加载或 Tauri command 时，至少运行 `npm test -- --run`、`npm run build`、`cargo test`、在 `src-tauri` 下运行 `cargo fmt --check`，并运行 `git diff --check`。
- 后端需要覆盖 command 同步语义，确保 `load_board_data` 保持只读、`sync_codex_threads` 保持显式强制同步、后台 `start_codex_sync` 不会并发启动多个同步任务。
- 前端需要覆盖常驻工具栏不再显示停止同步、停止刷新、停止解析、只读轮询、关闭评论等旧诊断开关，确保这些开关不会被误恢复。
- 涉及评论加载时，需要覆盖评论懒加载和 BoardData merge 行为，确认最新评论异步展示不会进入周期刷新主链路，已加载评论在数据刷新后能按 thread id 保留。
- 修改 To Do List 时，需要覆盖 SQLite 快照 upsert 与 `created_at` 保留、树结构展开、Enter/Cmd+Enter/Tab/Shift+Tab、三段拖放、父子状态独立、完成日期、行内日期编辑、扩展信息逐条编辑、Markdown 命名链接协议白名单和每页 50 条分页。
- 修改视图快捷键或禅模式时，需要覆盖输入控件聚焦下的 `Cmd+1`/`Cmd+2`、非目标修饰键、To Do List 禅模式入口、跨视图保持禅模式以及退出后的导航恢复。
- To Do List 的视觉交付需要在 1440 × 1024 检查主状态，并至少补充一次 1024 × 768 窄窗口检查；普通浏览器预览控制台不应出现 Tauri bridge 错误。

## Update Notes

- 2026-07-04: 记录 Thread Kanban 同步/刷新问题修复后的回归测试范围。
- 2026-07-08: 前端列表行新增最新评论异步展示后，测试重点改为可见行后台加载评论且不调用阻塞式 `sync_codex_threads`。
- 2026-07-11: 新增 To Do List 持久化、树交互、日期、命名链接和浏览器视觉验收范围。
- 2026-07-11: 增加 To Do 快照创建时间、逐条编辑、Cmd+Enter 与 50 条分页回归范围。
- 2026-07-11: 增加全局视图快捷键与跨视图禅模式的前端回归范围。
