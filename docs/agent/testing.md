# Testing

## Current Knowledge

- 修改 Thread 来源解析或列表过滤时，需要覆盖有标题的 subagent、空标题主 thread、无效来源 JSON、通用同步客户端、Codex state SQLite 只读客户端和历史项目库过滤。
- 修改 Thread 名称同步时，需要覆盖索引名称覆盖 SQLite 标题、无名称不回退、重复记录最后一条生效、无效 JSONL 行容错，以及空名称主 Thread 与临时 subagent 的展示边界。
- 修改 Thread Kanban 同步、刷新、评论加载或 Tauri command 时，至少运行 `npm test -- --run`、`npm run build`、`cargo test`、在 `src-tauri` 下运行 `cargo fmt --check`，并运行 `git diff --check`。
- 后端需要覆盖 command 同步语义，确保 `load_board_data` 保持只读、`sync_codex_threads` 保持显式强制同步、后台 `start_codex_sync` 不会并发启动多个同步任务。
- 前端需要覆盖常驻工具栏不再显示停止同步、停止刷新、停止解析、只读轮询、关闭评论等旧诊断开关，确保这些开关不会被误恢复。
- 涉及评论加载时，需要覆盖评论懒加载和 BoardData merge 行为，确认最新评论异步展示不会进入周期刷新主链路，已加载评论在数据刷新后能按 thread id 保留。
- 修改 To Do List 时，需要覆盖 SQLite 快照 upsert 与 `created_at` 保留、树结构展开、Enter/Cmd+Enter/Cmd+Shift+Enter/Tab/Shift+Tab、拖拽手柄常显、同级任务上/下半区排序且不改变层级、`dragDropEnabled: false` 的 Tauri 配置、父子状态独立、完成日期、行内日期编辑、扩展信息逐条编辑、Markdown 命名链接协议白名单和每页 200 条分页。
- 修改视图快捷键或禅模式时，需要覆盖输入控件聚焦下的 `Cmd+1`/`Cmd+2`、非目标修饰键、To Do List 禅模式入口、跨视图保持禅模式以及退出后的导航恢复。
- To Do List 的视觉交付需要在 1440 × 1024 检查主状态，并至少补充一次 1024 × 768 窄窗口检查；普通浏览器预览控制台不应出现 Tauri bridge 错误。
- To Do 拖放交付必须额外在真实 Tauri macOS `.app` 中验证 DOM 顺序和 SQLite `position` 同时变化；使用独立 bundle identifier、临时 HOME 和测试数据库，禁止操作用户正式任务数据。
- 修改 Thread/Task 关联时，需要覆盖一个 Thread 只能关联一个 Task、一个 Task 可关联多个 Thread、子 Task 路径、候选状态过滤、终态对象仍可发起、已有关联直接迁移、删除级联清理和状态变化不自动解绑。
- 关联状态管理需要覆盖同一 Thread 串行、不同 Thread 并行、提交失败回滚并重载、重载失败后队列仍释放、5 秒撤销以及 Task 快照删除后的关系对账。
- Thread/Task 关联视觉交付需要在 650px 内容宽度检查折叠态、展开态、下拉候选、双向定位、迁移与撤销；页面不得横向溢出，普通浏览器 demo 流程不得调用 Tauri，控制台错误应为 0。
- To Do 完成度排序需要覆盖顶层树三档顺序、取消视为完成、父子树不拆分、同组 `position` 稳定、跨组拖拽无效、搜索筛选分页和跨视图定位使用同一展示顺序。
- To Do 日期布局需要覆盖根任务、子任务、前插和后插四种新建入口默认本地明天及跨月跨年；覆盖 `created_at` 本地只读展示、起始日期 UI 消失但快照保留、两个结束日期列完整显示和继续可编辑。
- To Do 关联 Thread 点击回归需要覆盖折叠标签和展开详情均调用正确 `codex://threads/<session-id>`、点击后保持 To Do 页面、无效 session 不调用 Tauri、普通浏览器预览不调用 Tauri，以及 Thread → Task 反向定位不受影响。关联列表仍需覆盖无关联、加载中、加载失败重试、进入页面只加载一次且五秒轮询不重复加载，并在约 650px 内容宽度检查多标签换行无横向溢出。
- 修改 To Do List 五列宽度时，需要检查一般窄屏下任务和关联 Thread 均不小于 `140px`，日期列和操作列先分别压缩至 `64px`、`44px`；在不超过 `520px` 的极窄视口检查前两列等权继续收缩，并在两档视口确认页面无横向溢出、浏览器控制台错误为 `0`。

## Update Notes

- 2026-07-13: 新增 Codex Thread 名称索引覆盖、无回退和 JSONL 容错的回归范围。
- 2026-07-13: 新增 subagent 结构化来源解析、同步入口和历史项目库过滤的回归测试范围。
- 2026-07-04: 记录 Thread Kanban 同步/刷新问题修复后的回归测试范围。
- 2026-07-08: 前端列表行新增最新评论异步展示后，测试重点改为可见行后台加载评论且不调用阻塞式 `sync_codex_threads`。
- 2026-07-11: 新增 To Do List 持久化、树交互、日期、命名链接和浏览器视觉验收范围。
- 2026-07-11: 增加 To Do 快照创建时间、逐条编辑、Cmd+Enter 与 50 条分页回归范围。
- 2026-07-11: 增加全局视图快捷键与跨视图禅模式的前端回归范围。
- 2026-07-12: 增加 `Cmd+Shift+Enter` 向前创建同级任务的顺序、层级与聚焦回归范围。
- 2026-07-13: 增加 Thread/Task 双向关联的数据约束、并发队列、迁移撤销和 650px 窄屏回归范围。
- 2026-07-13: 将 To Do 拖放回归范围调整为手柄常显、上/下半区同级排序、层级保持、Tauri 配置检查和真实 WKWebView 验收。
- 2026-07-13: 增加 To Do 顶层树完成度排序、默认次日、添加日期、紧凑结束日期列和折叠行 Thread 标签的回归范围。
- 2026-07-14: To Do 关联 Thread 点击回归改为直接打开 Codex、保持 To Do 页面并覆盖普通浏览器 Tauri 边界。
- 2026-07-22: 增加 To Do List 两阶段列宽收缩规则的自动化与浏览器回归要求。
- 2026-07-22: To Do List 默认分页大小从 50 调整为 200，回归边界改为 200/201 条并覆盖关联定位第二页。
