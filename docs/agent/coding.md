# Coding

## Current Knowledge

- Thread 列表必须根据 Codex 的结构化来源排除 subagent，禁止使用空标题作为判定条件；同步边界负责阻止新增 subagent，仓储列表负责隐藏历史已导入数据，历史记录本身不删除。
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
- 应用内全局视图快捷键使用 `Cmd+1` 打开“全部活跃”、`Cmd+2` 打开 To Do List；监听只更新 `view`，必须保留禅模式和导航状态，且 To Do List 顶栏也必须提供禅模式按钮。
- To Do List 使用独立 `todo_tasks` 表，不复用 `codex_threads`；前端保存完整任务快照，树结构由 `parent_id + position` 表达，任务状态与父子状态必须保持独立。
- To Do 扩展信息保存 Markdown 兼容文本；命名链接仅把 `http://` 或 `https://` 渲染为可点击链接，不使用 `dangerouslySetInnerHTML`，外部打开 command 也必须保持协议白名单。
- To Do 快照保存必须 upsert 当前任务并删除快照外任务；更新已有任务时保留 `created_at`，只更新 `updated_at`，不得通过全表删除重插改写创建时间。
- To Do 扩展信息按非空行逐条编辑；普通文本与完整行 Markdown 命名链接均支持双击原位编辑，链接单击与双击必须避免误跳转。逐条替换必须保留其他原始行和空行；URL 需同时满足 HTTP(S)、有效主机、无空白且可被 Markdown 链接解析。
- To Do 任务标题使用 `Cmd+Enter` 在当前任务后创建同级任务，使用 `Cmd+Shift+Enter` 在当前任务前创建同级任务；两种方式创建后都必须自动聚焦新任务并沿用现有快照持久化流程。
- To Do 拖放仅用于同级排序：拖拽手柄必须常显，目标行上半区表示插入到目标之前，下半区表示插入到目标之后；创建子任务继续使用 `Tab` 或“子任务”按钮，拖放不得改变任务层级。Tauri 窗口必须设置 `dragDropEnabled: false`，否则内部文件拖放处理器会阻止 macOS WKWebView 的 HTML5 DOM 拖放事件。
- 普通 Vite 浏览器预览没有 Tauri bridge，不应启动 BoardData 加载和周期同步；桌面壳与测试环境继续保留 Tauri 调用。
- Thread 与 To Do Task 的关联使用独立 `thread_task_links` 表；`thread_id` 唯一，因此一个 Thread 最多关联一个 Task，一个 Task 可以关联多个 Thread，Task 删除时依靠外键级联清理关系。
- 关联关系必须保持懒加载，不得进入 `BoardData` 或 5 秒轮询主链路；Thread/Task 状态变化只影响新增候选，不自动解除既有关联。
- Thread 端候选仅包含未完成、进行中的 Task，并支持子 Task 粒度；Task 端候选仅包含待审核、挂起的 Thread，但所有状态的发起对象都允许操作。
- Task 端选择已关联其他 Task 的 Thread 时直接迁移到当前 Task；前端按 Thread 串行提交、不同 Thread 可并行，失败后回滚并重新加载，成功反馈提供 5 秒撤销。
- 普通 Vite 浏览器预览需要提供可交互的 Thread/Task demo 数据，但不得调用 Tauri command，便于在窄窗口完成双向关联视觉验收。

## Update Notes

- 2026-07-13: 新增基于结构化来源的 subagent thread 双层过滤约束，兼顾未来同步与历史数据。
- 2026-07-04: 记录 Thread Kanban 同步/刷新链路约束，避免再次把重同步放回 UI 周期轮询路径。
- 2026-07-06: 调试用的同步/刷新/解析/只读轮询/评论开关从前端常驻工具栏移除。
- 2026-07-08: 列表行允许异步加载并展示可见 thread 的最新评论，但评论仍不得进入 BoardData 主刷新链路。
- 2026-07-08: 筛选面板状态改为多选并默认待审核/挂起，移除类型、Sprint、显示归档控件。
- 2026-07-08: 操作列新增打开 VS Code 和复制 session id。
- 2026-07-08: 左侧导航新增完全隐藏状态，窄视图可释放横向空间。
- 2026-07-08: 工具栏新增禅模式，用于临时隐藏菜单和同步概览。
- 2026-07-11: 新增独立 To Do List 的持久化、树结构、Markdown 命名链接与浏览器预览边界。
- 2026-07-11: To Do 快照改为保留 `created_at` 的 upsert，并补充扩展信息逐条编辑约束。
- 2026-07-11: 新增 `Cmd+1`/`Cmd+2` 全局视图切换，并要求 To Do List 与看板跨视图保持禅模式。
- 2026-07-12: 新增 `Cmd+Shift+Enter` 在当前任务前创建同级任务，并保留 `Cmd+Enter` 向后创建语义。
- 2026-07-13: 新增 Thread 与 To Do Task 的双向懒加载关联、直接迁移、失败回滚和 5 秒撤销约束。
- 2026-07-13: 恢复 To Do 同级拖放排序，手柄改为常显并取消拖放改层级语义；关闭 Tauri 内部拖放处理器以允许 WKWebView DOM 拖放。
