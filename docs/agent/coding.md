# Coding

## Current Knowledge

### 2026-10-28 任务筛选和延时启动

- TypeScript 模块基础名（去扩展名）不得只靠大小写区分；macOS 的无扩展名导入可能先命中另一 `.ts` 文件。筛选组件用 `TaskFilterBar.tsx`，工具用 `taskFilters.ts`。

- `task_schedule.rs` 管理最早自动启动时间，单独存 `task_preferences.scheduled_start_at`；不复用旧 date-only `todo_tasks.start_date`。时间均为规范 UTC 秒，界面显示本地时区。
- 调度刷新与事务 claim 双重检查时间，等待原因 `scheduled` 不属于人工待办。不得因到点唤醒 paused、human/environment wait 或 terminal task。人工附加会话不走该自动门槛。
- 全局任务树查询与侧栏查询分离；状态/项目多选，周视图取滚动 168 小时。所有条件在同节点上取交集，再补祖先；本机持久化条件/折叠/分页/滚动，而非冻结任务数据。
- `config/read` 是只读连接预检，不创建 Thread。自动检测仅切换到通过同一配置预检的候选，不删改配置、不换凭据目录。显式 override 只验证该程序。
- 错误分类依据实际 RPC；配置解析失败不得一律拼接 dynamicTools 提示。丢弃不属于当前连接的事件，包括所有候选均失败后的迟到 EOF。


### 2026-10-27 验收修订（优先于下方历史记录）

- 当前任务工作区规则以 `docs/review-fixes-2026-10-27.md` 为准。旧看板入口和旧 UI 已删除，旧数据库迁移和数据仍保留。不要恢复被删除的旧页面命令或在文档中要求回到旧版。
- `local_environment.rs` 统一解析可执行文件和绝对工作目录；`project_preferences.rs` 管理排除设置与真实执行前的项目绑定；`task_editing.rs` 事务化层级操作。不得把空目录交给 app-server，也不得修改已有真实 Thread 的目录。
- 主导航与详情保持任务视角：两列树、独立侧栏检索、根置顶、右键菜单/状态、原位编辑快捷键、常驻可调详情、上下文结果合页、右侧多标签。新增交互测试替代对应已删除旧 UI 测试。
- Codex 自动发现后由原生进程读取既有 HOME/CODEX_HOME 凭据，禁止把 token 放入前端/数据库/日志；仅无有效账户时提供登录。排除目录按路径组件过滤所有项目选择入口，不删除历史。
- 浏览器标签对应真实 CDP target。Agent 关闭当前标签后画面能恢复到其他存在页面；禁止通过网络/验证码绕过制造验收通过。


### 聊天优先工作区（2026-10-27）

- 默认入口 `src-ui/src/studio/ChatApp.tsx`；旧 App 只经设置打开。生产调用失败不得回退演示数据。
- `chat_conversations` 不得冒充 `todo_tasks` 子节点；自动主会话使用原 task_id，人工会话运行键为 `chat:<conversation_id>`，隔离总结键为 `extract:<run_id>`。
- 任务行依赖菜单、等待标签与属性面板共用同树选择器；写入后端校验自身、祖先、缺失、跨树和隐式父子等待环。运行中改依赖通过 pending change 先停止再应用。
- 自动结果只来自明确交接工具；人工总结使用固定来源快照与独立只读 Thread。结果追加保存，来源任务/会话/执行/消息范围固定，不跟随当前选中项。
- 任务状态与会话管理状态、运行状态分开；任务置顶与会话置顶 OR；取消任务置顶不覆盖独立会话设置。
- Markdown 先作为纯文本存储，渲染禁止原生 HTML 与 javascript URL。删除是软删除，迁移不重写旧历史；设置提供旧看板入口。
- 浏览器使用独立 Chrome 与 loopback CDP；UI 和 Playwright MCP 共用 endpoint，不给远程页面 Tauri IPC。禁止使用日常用户 Chrome profile；Linux 容器测试标志不得传入桌面启动。
- 参考 `docs/chat-workspace.md` 做本机验收。自动验收只核对交付/执行条件，不声称能独立证明所有业务事实。


### 个人任务工作台

- 产品执行路径是个人 To Do 任务树 + 自有调度器 + Codex app-server；原有 Desktop thread 导入仍是只读边界。两条路径不得混用会话所有权，导入或关联旧 thread 不得隐式启动它。
- `workflow.rs` 是业务状态与持久化的唯一入口，`work_service.rs` actor 负责调度和目录占用，`work_runtime.rs` 负责任务/执行/Thread/Turn 绑定，`app_server.rs` 只负责子进程与协议。UI 不得通过轮询模型驱动流程。
- 一个 WorkRun 对应一个 Turn。`turn/completed` 只结束执行；有效 `task_submit_result` 后 Human 等人工验收，Auto 还要等本轮正常结束。提交后继续实质工具操作会使交付失效，不能靠最终文本或未读状态猜测完成。
- 未完成交接的正常结束最多自动续跑两轮；依赖、业务问题、环境阻塞不消费模型轮询。默认 `on-request` + `workspace-write`，Agent 创建的业务子任务继承父级权限、目录、交付与浏览器策略。
- 树形父子关系不等于启动依赖；`blocked_by` 需校验自依赖、重复、缺失与循环。父任务提交需直接子任务已完成或明确取消；被取消的前置任务不满足完成依赖。
- 暂停、取消和返工先隔离持久执行，再请求运行时停止；只操作当前业务节点，不能偷偷级联业务子任务或回滚文件。对不确定副作用的断连恢复必须需要明确重试。
- 审批只允许当前有效的 task/run/request 组合消费一次；`serverRequest/resolved` 是失效通知，不是批准。业务问题可跨 Turn 等待，native server request 不能跨执行重放。
- 原生 subagent 按 parentThreadId 路由输出和审批；其结束不完成父业务任务。父 Turn 完成须等待已知活动子 Agent 停止确认，未确认不得接受成功或释放目录。复用 child thread 时，新旧 Turn 的归属必须保持正确。
- 本产品调度器是唯一续跑控制者。暂停托管 Thread 的 active native Goal，异步处理 Goal pause ACK，并按原始事件顺序检查隐藏 Turn；不得让异步 ACK 越过隐藏执行而释放业务成功。
- 最多两个 Agent 任务并发；规范化后相同或重叠的工作目录串行。手动终端须先通过调度 actor 占用同一目录，不能绕开互斥直接调用 runtime；终端事件 run_id 为空，只做展示。
- 线程启动、文件/终端操作不得阻塞 UI；浏览器 MCP 启动允许较长超时，必须放在 worker。取消尚未启动的任务不能让排队 worker 后续继续启动；已发出的未知结果不能直接重试。
- Playwright MCP 为显式 opt-in，固定 `@playwright/mcp@0.0.83 --isolated --browser chrome`，required=true。已有 Thread 的工作目录、Agent、角色指令与浏览器配置冻结；warm resume 不承诺重新应用启动 config。不要使用用户已有浏览器会话代替独立 Chrome。
- 退出桌面应用停止它拥有的 app-server；没有 daemon。关闭详情面板不停止调度。恢复旧的不确定活动执行时不得自动重放。
- 产品说明、操作入口和真实运行边界以 `docs/task-workbench.md` 为准；不得将假协议测试描述成真实模型、账号或 Chrome 端到端验收，也不得宣称完整 Desktop 功能对等。

### 旧导入与既有列表

- 旧导入 Thread 列表必须根据 Codex 的结构化来源排除 subagent，禁止使用空标题作为判定条件；同步边界负责阻止新增 subagent，仓储列表负责隐藏历史已导入数据，历史记录本身不删除。
- Thread 看板名称只使用 Codex `session_index.jsonl` 中的 `thread_name`，不回退到 `state_5.sqlite.threads.title`；缺失名称保持为空，名称不得参与 subagent 判定。
- Thread Kanban 的 UI 轮询路径必须保持轻量：`load_board_data` 只能读取现有 board data，不应触发 Codex Desktop thread 同步、解析或本地扫描。
- 需要主动同步 Codex thread 时，前端应调用后台化的 `start_codex_sync`，再通过 `load_board_data(false)` 刷新 UI；不要在 5 秒自动刷新链路里调用阻塞式 `sync_codex_threads`。
- `sync_codex_threads` 保留为显式强制同步命令；修改时不要把它重新接回前端周期刷新主路径。
- Thread comments 必须继续懒加载，不应进入 `list_threads -> BoardData -> React state -> 周期刷新` 主链路；列表视图可对已渲染行异步调用 `load_thread_comments` 预取最新评论，展开评论时也按 thread id 加载完整评论。
- `thread_comments` 查询使用 `WHERE thread_id = ? ORDER BY created_at DESC, id DESC`，数据库 schema 需要保持 `thread_comments(thread_id, created_at, id)` 方向的索引。
- 前端自动刷新相关诊断开关（停止同步、停止刷新、停止解析、只读轮询、关闭评论）已从工具栏移除；定位刷新类问题时需要通过测试、日志或临时代码排查，不应把这些开关重新作为常驻 UI。
- 筛选面板保留项目、状态和“仅未绑定任务”；状态是多选，默认选中待审核和挂起；类型、Sprint、显示归档不应作为常驻筛选控件。
- Thread 行操作列包含打开 Codex、打开 VS Code、复制 session id、审核/归档等图标按钮；打开 VS Code 通过 Tauri command 先执行 `code <项目目录>`，macOS 上失败时 fallback 到 `open -a "Visual Studio Code" <项目目录>`；前端优先使用项目路径，没有项目路径时使用 thread cwd。
- 左侧导航支持展开、图标栏、完全隐藏三态；窄窗口下可通过完全隐藏释放列表操作列宽度，隐藏后应在主标题栏保留展开导航入口。
- 禅模式按钮位于同步按钮前；开启时临时隐藏左侧导航和“同步与队列概览”，退出后恢复原有显示状态。
- 应用内全局视图快捷键使用 `Cmd+1` 打开“全部活跃”、`Cmd+2` 打开 To Do List；监听只更新 `view`，必须保留禅模式和导航状态，且 To Do List 顶栏也必须提供禅模式按钮。
- To Do List 使用独立 `todo_tasks` 表，不复用 `codex_threads`；树结构由 `parent_id + position` 表达，任务状态与父子状态必须保持独立。
- To Do List 默认每页展示 `200` 条可见任务；页数、列表切片和关联 Task 定位必须共用同一页大小，超过 `200` 条时继续使用现有分页。
- To Do 扩展信息保存 Markdown 兼容文本；命名链接仅把 `http://` 或 `https://` 渲染为可点击链接，不使用 `dangerouslySetInnerHTML`，外部打开 command 也必须保持协议白名单。
- To Do 任务收起且过程跟踪或结果复盘存在非空记录时，标题下按“过程跟踪在前、结果复盘在后”的固定顺序展示单行摘要；同字段记录以 ` · ` 拼接、字段间以 ` ｜ ` 拼接，超宽省略。摘要必须位于五列网格第一格内部，展开时隐藏，并继续复用 HTTP(S) Markdown 命名链接安全边界。
- To Do UI 使用 before/after 差异保存：只合并用户实际修改的字段，保留后台新增子任务和最新业务状态；冲突需刷新重试。原有仓储快照 upsert 接口保留创建时间，不能全表删除重插。已委派任务状态只能通过业务动作修改；不能用旧快照勾选完成或删除活动任务。
- To Do 周视图使用内部业务变动时间筛选滚动 168 小时，前端接口仍命名为 `updated_at` 但后端来源为 `activity_at`，且不得展示该字段；老库首次迁移以 `created_at` 建立无污染基线，完整快照只有实际变化任务可刷新时间，子任务命中时保留祖先但不补兄弟或后代。
- To Do 的 `position` 变化必须持久化，但不得刷新周视图业务变动时间；插入、删除和拖拽可能连带重排大量兄弟任务，只有父子层级或任务内容变化才刷新 `activity_at`。
- To Do 扩展信息按非空行逐条编辑；普通文本与完整行 Markdown 命名链接均支持双击原位编辑，链接单击与双击必须避免误跳转。逐条替换必须保留其他原始行和空行；URL 需同时满足 HTTP(S)、有效主机、无空白且可被 Markdown 链接解析。
- To Do 任务标题使用 `Cmd+Enter` 在当前任务后创建同级任务，使用 `Cmd+Shift+Enter` 在当前任务前创建同级任务；两种方式创建后都必须自动聚焦新任务并沿用现有快照持久化流程。
- 空标题 To Do 任务按 `Backspace` 删除后，上一可见任务必须获得焦点且光标折叠在标题末尾，避免再次退格时清空整段标题；菜单删除以及新建、缩进、导航等其他聚焦场景保持原有选区语义。
- To Do 拖放仅用于同级排序：拖拽手柄必须常显，目标行上半区表示插入到目标之前，下半区表示插入到目标之后；创建子任务继续使用 `Tab` 或“子任务”按钮，拖放不得改变任务层级。Tauri 窗口必须设置 `dragDropEnabled: false`，否则内部文件拖放处理器会阻止 macOS WKWebView 的 HTML5 DOM 拖放事件。
- 普通 Vite 浏览器预览没有 Tauri bridge，不应启动 BoardData 加载、周期同步或真实工作台执行；桌面壳与测试环境继续保留 Tauri 调用。
- Thread 与 To Do Task 的关联使用独立 `thread_task_links` 表；`thread_id` 唯一，因此一个 Thread 最多关联一个 Task，一个 Task 可以关联多个 Thread，Task 删除时依靠外键级联清理关系。
- 关联关系必须保持懒加载，不得进入 `BoardData` 或 5 秒轮询主链路；Thread/Task 状态变化只影响新增候选，不自动解除既有关联。
- Thread 的“仅未绑定任务”默认关闭，以 `thread_task_links` 是否存在关联为准，与项目、状态、搜索取交集；开启时按需读取关联，加载中或失败时不得把空 Map 当成未绑定结果，失败需提供重试入口。
- Thread 端候选仅包含未完成、进行中的 Task，并支持子 Task 粒度；Task 端候选仅包含待审核、挂起的 Thread，但所有状态的发起对象都允许操作。
- Task 端选择已关联其他 Task 的 Thread 时直接迁移到当前 Task；前端按 Thread 串行提交、不同 Thread 可并行，失败后回滚并重新加载，成功反馈提供 5 秒撤销。
- 普通 Vite 浏览器预览需要提供可交互的 Thread/Task demo 数据，但不得调用 Tauri command，便于在窄窗口完成双向关联视觉验收。
- To Do List 的顶层任务树按完成度派生排序：没有完成态节点、完成与未完成混合、全部为完成态依次展示；`completed` 和 `cancelled` 都视为完成态，同组内保持持久化 `position`，子任务不单独分组。
- To Do List 折叠行第二列和展开详情展示全部旧导入关联 Thread；点击任一关联 Thread 都直接打开 Codex Desktop 对应会话并保持 To Do 页面，不再切换到应用内 Thread 列表；普通浏览器预览不得调用 Tauri。进入 To Do 页面时单独加载一次关联并提供失败重试，但关联仍不得进入 `BoardData` 或五秒轮询链路。
- To Do List 五列布局使用运行时计算宽度：压缩开始时冻结任务和关联 Thread 的实际宽度，按操作、实际结束日期、预期结束日期的顺序压缩并完整隐藏尾列；尾列全部隐藏后，关联 Thread 先压缩至 `180px`，任务再压缩至 `240px`，随后两列按 `4:3` 同步缩小。隐藏列不得残留网格轨道或产生横向滚动。
- To Do List 不再展示或编辑起始日期，但必须继续在快照中保留历史 `start_date`；展开详情显示只读的本地添加日期，新建任务的预期结束日期默认为本地日历下一天。
- To Do 置顶状态只属于 root 任务并显式持久化；置顶 root 变成子任务时必须清除自身置顶并将其当前所属的新 root 置顶。置顶任务树优先于完成度分组，多个置顶 root 保持 `position`；图钉只能嵌入现有任务单元格，不得新增表格列，浅绿色背景只应用于置顶 root 的主任务行。

## Update Notes

- 2026-10-26: 新增个人任务工作台、执行与交付分离、持久调度、请求归属、目录互斥、浏览器和恢复边界；To Do 保存改为兼容后台写入的差异合并。
- 2026-07-13: Thread 看板名称改为只同步 Codex 名称索引，不再使用 SQLite 首条消息标题作为回退。
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
- 2026-07-13: To Do List 新增顶层任务树完成度排序、折叠行 Thread 标签、只读添加日期和新任务默认次日截止，并隐藏起始日期、压缩结束日期列。
- 2026-07-14: To Do List 的关联 Thread 入口改为直接打开 Codex Desktop，不再跳转应用内 Thread 列表。
- 2026-07-22: 记录 To Do List 窄屏列宽优先级，任务与关联 Thread 优先保留 `140px`，极窄时再等权收缩。
- 2026-07-22: To Do List 默认分页大小从 50 调整为 200，分页与关联定位继续共用同一常量。
- 2026-07-22: 修正 To Do List 窄屏规则：列表容器不超过 `520px` 时完整隐藏日期和操作列，不再保留压缩后的尾部轨道；不超过 `320px` 时才压缩任务与关联 Thread。
- 2026-07-23: To Do List 列宽改为捕获运行时基线并分阶段压缩，移除固定 `520px/320px` 断点和前两列直接等权缩小规则。
- 2026-08-05: 新增 To Do root 任务置顶、层级变化时向新 root 转移、置顶优先排序和单图标浅绿色主行约束。
- 2026-08-06: 空标题 To Do 任务按 Backspace 删除后改为将上一任务的光标折叠在标题末尾。
- 2026-08-06: 新增 To Do 滚动 168 小时周视图，并将 `updated_at` 修正为只记录单个任务的实际变化。
- 2026-08-06: 修正旧版完整快照已污染 `updated_at` 的迁移问题，周视图改用独立 `activity_at` 并以 `created_at` 初始化老任务基线。
- 2026-08-12: 新增 To Do 折叠态过程跟踪与结果复盘单行摘要约束。
- 2026-08-19: 修正 To Do 排序位置连带变化污染周视图业务活动时间的问题。
