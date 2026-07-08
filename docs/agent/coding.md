# Coding

## Current Knowledge

- Thread Kanban 的 UI 轮询路径必须保持轻量：`load_board_data` 只能读取现有 board data，不应触发 Codex Desktop thread 同步、解析或本地扫描。
- 需要主动同步 Codex thread 时，前端应调用后台化的 `start_codex_sync`，再通过 `load_board_data(false)` 刷新 UI；不要在 5 秒自动刷新链路里调用阻塞式 `sync_codex_threads`。
- `sync_codex_threads` 保留为显式强制同步命令；修改时不要把它重新接回前端周期刷新主路径。
- Thread comments 必须继续懒加载，不应进入 `list_threads -> BoardData -> React state -> 周期刷新` 主链路；列表视图可对已渲染行异步调用 `load_thread_comments` 预取最新评论，展开评论时也按 thread id 加载完整评论。
- `thread_comments` 查询使用 `WHERE thread_id = ? ORDER BY created_at DESC, id DESC`，数据库 schema 需要保持 `thread_comments(thread_id, created_at, id)` 方向的索引。
- 前端自动刷新相关诊断开关（停止同步、停止刷新、停止解析、只读轮询、关闭评论）已从工具栏移除；定位刷新类问题时需要通过测试、日志或临时代码排查，不应把这些开关重新作为常驻 UI。
- 筛选面板保留项目和状态；状态是多选，默认选中待审核和挂起；类型、Sprint、显示归档不应作为常驻筛选控件。
- Thread 行操作列包含打开 Codex、打开 VS Code、复制 session id、审核/归档等图标按钮；打开 VS Code 通过 Tauri command 先执行 `code <项目目录>`，macOS 上失败时 fallback 到 `open -a "Visual Studio Code" <项目目录>`；前端优先使用项目路径，没有项目路径时使用 thread cwd。
- 左侧导航支持展开、图标栏、完全隐藏三态；窄窗口下可通过完全隐藏释放列表操作列宽度，隐藏后应在主标题栏保留展开导航入口。
- 禅模式按钮位于同步按钮前；开启时临时隐藏左侧导航和“同步与队列概览”，退出后恢复原有显示状态。

## Update Notes

- 2026-07-04: 记录 Thread Kanban 同步/刷新链路约束，避免再次把重同步放回 UI 周期轮询路径。
- 2026-07-06: 调试用的同步/刷新/解析/只读轮询/评论开关从前端常驻工具栏移除。
- 2026-07-08: 列表行允许异步加载并展示可见 thread 的最新评论，但评论仍不得进入 BoardData 主刷新链路。
- 2026-07-08: 筛选面板状态改为多选并默认待审核/挂起，移除类型、Sprint、显示归档控件。
- 2026-07-08: 操作列新增打开 VS Code 和复制 session id。
- 2026-07-08: 左侧导航新增完全隐藏状态，窄视图可释放横向空间。
- 2026-07-08: 工具栏新增禅模式，用于临时隐藏菜单和同步概览。
