# Testing

## Current Knowledge

### 2026-11-04 绑定 Codex 会话

- `codex_conversations::tests` 覆盖分页协议、主会话过滤、唯一归属与不产生 run/event、目录/状态拒绝、历史去重、原历史提取快照及旧本地协议回退；17MiB 隔离假响应验证历史读取不能断开共享执行连接。
- `CodexBinding.test.tsx` 覆盖非当前任务绑定、搜索/归档/分页复位、失败重试、重复定位及跨任务拒绝、草稿保留与交接门槛、历史去重及迟到读取隔离、连续空页不锁死原历史。
- 真实 Codex 独立 CODEX_HOME 的原 Thread 先保持写锁，安装副本绑定并显示原历史，恢复失败后由持有者归档再成功接续；原 Thread/目录不变，草稿保留，SQLite run/event 均为 0。未发送真实模型 Turn。证据见 `docs/verification/2026-11-04-codex-binding/`。

### 2026-11-02 人工会话独立删除


### 2026-11-02 半自动恢复会话连接

- `ConversationRecovery.test.tsx` 覆盖非当前目标冻结、取消不恢复、原生接口边界、写锁失败重试、成功清错误和不自动发送；前后端测试均验证保留未发送草稿。
- `work_runtime` 的假 app-server 覆盖归档与已释放占用、接续失败重试、Goal 校验，并断言恢复不调用 `turn/start`；写锁拒绝后共享连接仍可读。
- `chat_recovery` 服务测试覆盖异步 recovering 可读、恢复期间发送和结果重试被拒、目标/任务变更围栏、目录互斥、错误清理与成功恢复不产生 run/event。

### 2026-11-02 右侧工具可读性

- `RightDock.test.tsx` 覆盖最后标签关闭收起、无标签不创建资源以及跨会话终端选择；不能用额外 effect 修正 collapsed。
- `WorkspaceTerminal.test.tsx` 覆盖 CJK 字体回退；Rust PTY 测试断言启动环境显式包含 UTF-8 `LANG/LC_CTYPE`，并验证中文写入与回读。
- `WorkspaceFiles.test.tsx` 覆盖 Markdown 默认预览和源码切换，测试中文内容使用 UTF-8→base64，不能调用 Latin-1 `btoa` 生成夹具。
- 原生验收使用真实 PTY 输出“中文终端测试”及 UTF-8 locale，并在侧栏打开真实 Markdown 文件检查多级标题。

- `ConversationDeletion.test.tsx` 覆盖双入口、目标确认与取消、非当前删除不切换、当前及最后会话导航、历史与草稿恢复、排队和主会话拒绝。
- `chat_store::tests::conversation_deletion_*` 覆盖消息/结果/任务保留、旧发送和提取拒绝、版本/资源/执行拒绝、归档任务恢复边界与原 closed 保留；服务测试证明恢复不生成执行。
- `failed_extraction_must_confirm_stop_before_conversation_deletion` 模拟提取已落失败但 actor 未收到停止确认的窗口，存活时拒绝、清理后允许；不得只以 ended_at 判断执行已退出。


### 2026-11-02 首次发送前的模型设置

- `ChatModelDraft.test.tsx` 覆盖无会话记录时模型/强度可保存和重开、取消不修改选择、新聊天与已有会话/任务草稿隔离、任务页进入新聊天后轮询不选回任务、首次发送先保存配置后执行、配置保存失败保留草稿且不发送、失败重试成功清理旧草稿、保存等待期间的新输入与选定模型均保留且重试先保存配置、恢复默认值、已有空闲会话可修改、运行中仍禁用模型保存。使用隔离demo业务API和固定测试模型，不能据此声称真实模型执行通过。

### 2026-11-02 当前任务树排序

- `taskTreeOrder.test.ts` 覆盖待推进优先于已结束置顶、多层已完成祖先含未完成后代、同组置顶/手动顺序、结束与重开后的顺序、筛选/折叠与分页定位一致性；`taskFilters.keyword.test.ts` 的搜索结果沿用此展示顺序。

### 2026-10-30 会话阅读验收

- ChatTranscript/Markdown/transcript/events测试覆盖连续工具及二级展开、阶段/线程归属、无turnId中途补充、多轮、结束自动收起、相对/绝对/带括号链接、Mermaid图/视口占位、安全降级。
- 真Mermaid必须另做浏览器验收：查看实际SVG img及节点连线，不能只依赖mock；800px下检查横向溢出。原生会话还需验证既有消息文件链接与重复点击单例。证据见docs/verification/2026-10-30-conversation-transcript/。


- 本地RPC生命周期回归：`node --expose-gc --test scripts/test_electron_sidecar.js scripts/test_electron_browser_tabs.js`。故意保留服务端半关闭，检查客户端连接归零、160次大响应heap稳定、失败路径清理、启动前error无exit、在途/字节上限。Rust sidecar测试验证没有后续广播时writer也立即移除。真实验收读取现有detail，不能以恢复业务任务来做读压力测试。

### 2026-10-30 顶栏分区

- ChatApp 回归验证工具标签位于唯一 banner、任务详情不在工具 tabs、提取结果/会话属性属于中间 toolbar、会话属性默认收起及任务树属性不能收起；原文件/多终端/草稿/权限回归继续执行。
- 连续宽度 1440→1024→800→1600→1440 比对工具头和正文 x/width，验证任务树属性上下排列及导航收起；原生应用实际读 go.mod、收起恢复文件与终端、原生网页及新建菜单。截图与 AX 证据区分见 `docs/verification/2026-10-30-header-regions/`。

### 2026-10-30 右侧工作区

- `dockTabs`、`RightDock`、`WorkspaceFiles`、`WorkspaceTerminal` 回归工具单例、多终端、项目归属冻结、跨会话选中项恢复、失败启动关闭、StrictMode 清理、目录收起和迟到读取隔离。
- `scripts/test_electron_browser_tabs.js` 覆盖后台页面不抢显示、跨会话仅一个原生 view、最后页关闭后状态查询不复活网页。菜单遮挡需在真实 Electron 中打开菜单并选择工具验证。
- 新窗口回归必须模拟 Electron 38 的 guest 身份约束、无 guest 导航分支和可选构造参数校验；Node mock 通过后仍需在真实 Electron 点击 target blank、中键、window.open、空白页后跳转和 POST 表单。原生验证见 `docs/verification/2026-10-30-browser-popup/`。
- `BrowserPane.test.tsx` 覆盖窗口缩放只改变原生槽位 x 时同步最新矩形，以及隐藏、恢复、卸载后的监听清理。连续缩放验收必须保持部分档位右栏宽高不变，不能只比较两个静态截图；矩形回调镜像与原生像素截图需要明确区分，证据见 `docs/verification/2026-10-30-browser-resize/`。
- `workspace_terminal::tests` 验证同目录双 PTY、输入隔离、归属、单独关闭、1 MiB 环形缓存与受限 Shell 初始化；workflow 服务测试确认人工命令不占 Agent 并发身份，并保留 Agent 停止/资源确认约束。
- 真实 release sidecar 的隔离双 Shell 验收、原生标签 AX 记录及 1440/800 布局图见 `docs/verification/2026-10-30-right-workspace/`；隔离 fixture 不执行模型、不更改业务任务。


### 2026-10-30 单层顶栏

- `ChatApp.test.tsx` 验证任务与项目切换后仅一个工作区 banner，侧栏、新建任务、添加项目仍可操作；真实布局需额外检查会话定位/标题/操作同行、切换菜单未裁剪及窄窗口无页面横向溢出。
- macOS 已安装版本的单层原生窗口按钮与正式属性权限截图见 `docs/verification/2026-10-30-single-header/`；未量化物理拖拽位移，Windows/Linux 仍需对应平台实机验证，不能把浏览器 demo 当成原生窗口验证。

### 2026-10-30 任务执行权限

- `task_permissions::tests` 覆盖完全访问首次委托、等待中修改后领取、历史自定义权限迁移/重启幂等、过期保存拒绝、自动会话同步和独立人工会话隔离、父当前回合权限对子任务的继承。
- `service_task_permission_change_is_applied_only_to_the_next_turn_start` 通过真实假 app-server 子进程抓取两次 `turn/start`，断言旧回合保持审批、新回合为 `never + dangerFullAccess`；不冒充真实模型验收。
- `ChatApp.test.tsx` 覆盖无会话的任务属性权限、自动会话双入口同步、旧草稿冲突；宽窄界面及真实 release sidecar 隔离副本证据见 `docs/verification/2026-10-30-task-permissions/`。

### 2026-10-30 前置任务完成与依赖等待

- `workflow::tests::completed_dependency_with_only_phase_results_releases_downstream` 覆盖历史阶段结果仍不可用时，业务完成释放排队下游、快照缺失依赖清空，以及重新打开和取消重新阻塞；`manually_completed_dependency_releases_without_review_note` 覆盖已有会话、无结果的人工完成。保持原有自动交付验收、资源不确定和返工回归。
- 正式数据只能只读排查；本轮 release sidecar 回放使用隔离副本，停用其他执行并为目标设置未来时间门槛，不调用真实模型。证据见 `docs/verification/2026-10-30-dependency-completion/`。

### 2026-10-27 验收修订（优先于下方历史记录）

- 当前任务工作区规则以 `docs/review-fixes-2026-10-27.md` 为准。旧看板入口和旧 UI 已删除，旧数据库迁移和数据仍保留。不要恢复被删除的旧页面命令或在文档中要求回到旧版。
- `local_environment.rs` 统一解析可执行文件和绝对工作目录；`project_preferences.rs` 管理排除设置与真实执行前的项目绑定；`task_editing.rs` 事务化层级操作。不得把空目录交给 app-server，也不得修改已有真实 Thread 的目录。
- 主导航与详情保持任务视角：两列树、独立侧栏检索、根置顶、右键菜单/状态、原位编辑快捷键、常驻可调详情、上下文结果合页、右侧多标签。新增交互测试替代对应已删除旧 UI 测试。
- Codex 自动发现后由原生进程读取既有 HOME/CODEX_HOME 凭据，禁止把 token 放入前端/数据库/日志；仅无有效账户时提供登录。排除目录按路径组件过滤所有项目选择入口，不删除历史。
- 浏览器标签对应真实 CDP target。Agent 关闭当前标签后画面能恢复到其他存在页面；禁止通过网络/验证码绕过制造验收通过。


### 聊天优先工作区

- 完整测试包括 `src-ui/src/studio` 和 `chat_store::tests`；不可只验收静态截图。场景覆盖多会话不产生子任务、运行中置顶不改配置、依赖同树与循环、来源冻结、提取去重、迁移幂等和停止确认。
- 依赖修改、任务完成必须先收敛现有执行；旧绑定不能清除 stopping，新运行不能被旧结果完成。
- 视觉验证桌面 1440×960、1024×768、800×720；任务行等待标签直接打开选择器，空聊天不是配置表单，侧栏不遮挡主交互。
- 浏览器桥可用独立 Chromium + 本地自有测试文档验证截图/点击/中文输入/CDP 共用。不得关闭系统受管安全策略；该验证不冒充真实账号或 Mac 端到端测试。


### macOS 本机构建验证

- `make test` 包含 `make test-local-tools`，运行 Python 构建/安装助手回归；应覆盖 `run-local` 只在安装成功后启动、`install-local` 不启动、安装前保存旧副本的独立备份，以及本机 app 路径不依赖生成 DMG。用户安装与验证都应针对同一副本。
- `make build` / `make build-dmg` 使用显式 ad-hoc 签名。验证 `codesign --verify --deep --strict` 与签名详情；开发制品应明确记录 `Signature=adhoc`，不能仅凭签名校验退出码描述为受信任开发者发布包。
- 对最终交付的 DMG 执行镜像完整性校验，并只读挂载后验证其中 app 的签名；挂载后的副本才是用户实际取得的内容。脚本退出时必须卸载测试挂载点。
- CI artifact 为 `codex-thread-kanban-development`，未公证属性需进入制品说明。开发包不以 `spctl` 返回接受作为成功门槛，也不得在测试中关闭 Gatekeeper、清除 quarantine 或修改设备管理策略来制造通过结果。
- macOS 的“已损坏”对话框只提供故障线索；需要分别记录镜像校验、签名完整性及设备是否受管理。真实启动验收只在允许此类开发应用的目标 Mac 上进行。

### 任务工作台验证

- 标准命令是仓库根目录 `make test`；前端还需 `npm --prefix src-ui run build`，Rust 需 `cargo fmt --manifest-path src-tauri/Cargo.toml --check` 和 `git diff --check`。后端依赖本机 Tauri 平台库，假 app-server 协议测试使用 Python 3。
- SQLite 状态机覆盖 claim/revision/generation 隔离、Human/Auto 的提交和最终成功门槛、未交接的两轮续跑上限、循环/缺失依赖、前置完成后唤醒、子任务交付限制、业务问题跨 Turn、当前节点暂停取消、返工历史及异常恢复。
- To Do 差异保存覆盖旧 UI 快照与后台 Agent 新建子任务/状态更新并发，避免覆盖或隐式删除；已委派任务不可绕过工作流直接改状态或删除活动记录。
- app-server 测试应启动真实假子进程并经过 JSONL 管道，覆盖双向 request/response、EOF、超时、请求归属、重复或过期回应、早到/迟到事件、Thread 创建成功但 Turn 启动失败的恢复绑定。
- 父子 Agent 停止确认等时序用例使用显式协议握手推进，不用固定 sleep 搭配很短的 watchdog 模拟成功路径；缩短 watchdog 只用于验证超时分支，避免 CI 调度延迟造成误失败。
- 并发回归覆盖启动前取消、启动中未知 Turn ID 的停止、原生 child 跨 Run 复用、父完成等待子停止确认、子停止缺失时不能释放成功。Goal pause ACK 必须按事件队列顺序处理，隐藏 Turn 或 pause 失败不得被误判为业务成功。
- 调度测试覆盖最多两个 Agent 执行、相同/互相包含/规范化别名目录串行，以及手动终端和 Agent 双向互斥；终端事件没有 run_id，不能触发业务完成。
- 前端覆盖任务详情切换不串数据、当前审批/问题过滤、输入/权限/elicitation 回复形状、交付必须等执行结束才能验收、文本/文件/图片上下文、工具与图片输出、base64 文件和终端流的 UTF-8 边界。
- 浏览器配置测试覆盖默认关闭、固定 Playwright MCP 版本与 required/isolated/chrome 参数、Thread 首次创建后启动配置不可修改，以及 MCP 较长启动时间不会阻塞调度 actor。
- 视觉验证使用 1440 × 1024 与 1024 × 768，覆盖 To Do 与详情同时显示、需要我入口、配置、会话、审批、交付/返工与工作区；检查横向溢出和控制台错误。Vite 预览不得调用真实 Tauri。
- 假服务测试、组件测试、截图和构建成功都不能证明真实 Codex 登录、模型执行、沙箱或 Chrome 工具可用。发布验收需另按 `docs/task-workbench.md` 的真实桌面验收步骤，用测试工作目录完成连接、审批、交付、依赖、终端互斥、返工、退出恢复和独立浏览器流程。

### 既有功能回归

- 修改 Thread 来源解析或列表过滤时，需要覆盖有标题的 subagent、空标题主 thread、无效来源 JSON、通用同步客户端、Codex state SQLite 只读客户端和历史项目库过滤。
- 修改 Thread 名称同步时，需要覆盖索引名称覆盖 SQLite 标题、无名称不回退、重复记录最后一条生效、无效 JSONL 行容错，以及空名称主 Thread 与临时 subagent 的展示边界。
- 修改 Thread Kanban 同步、刷新、评论加载或 Tauri command 时，至少运行 `npm test -- --run`、`npm run build`、`cargo test`、在 `src-tauri` 下运行 `cargo fmt --check`，并运行 `git diff --check`。
- 后端需要覆盖 command 同步语义，确保 `load_board_data` 保持只读、`sync_codex_threads` 保持显式强制同步、后台 `start_codex_sync` 不会并发启动多个同步任务。
- 前端需要覆盖常驻工具栏不再显示停止同步、停止刷新、停止解析、只读轮询、关闭评论等旧诊断开关，确保这些开关不会被误恢复。
- 涉及评论加载时，需要覆盖评论懒加载和 BoardData merge 行为，确认最新评论异步展示不会进入周期刷新主链路，已加载评论在数据刷新后能按 thread id 保留。
- 修改 To Do List 时，需要覆盖 SQLite 快照 upsert 与 `created_at` 保留、树结构展开、Enter/Cmd+Enter/Cmd+Shift+Enter/Tab/Shift+Tab、拖拽手柄常显、同级任务上/下半区排序且不改变层级、`dragDropEnabled: false` 的 Tauri 配置、父子状态独立、完成日期、行内日期编辑、扩展信息逐条编辑、Markdown 命名链接协议白名单和每页 200 条分页。
- 修改 To Do 折叠摘要时，需要覆盖双字段与单字段、多条记录顺序、空白值、展开隐藏、编辑后即时更新、HTTP(S) 命名链接和危险协议；确认摘要仍位于第一列、网格保持五个直接子元素、无摘要任务保持紧凑行高，并在 1440 × 1024 与 1024 × 768 检查单行省略、列对齐和横向溢出。
- 修改 To Do 周视图或更新时间语义时，需要覆盖 168 小时双边界、无效/未来时间、搜索与状态组合、祖先补全、分页复位、导航清除、会话内即时命中、仓储未变化任务不刷新时间、纯 `position` 变化仍持久化但不刷新活动时间，以及老库被统一刷新的 `updated_at` 会迁移为以 `created_at` 初始化的独立业务变动基线。
- 修改 To Do 标题聚焦逻辑时，需要覆盖空标题任务按 `Backspace` 删除后上一任务获得焦点、选区折叠在标题末尾，并确认再次退格只删除末尾字符而不会清空整段标题。
- 修改视图快捷键或禅模式时，需要覆盖输入控件聚焦下的 `Cmd+1`/`Cmd+2`、非目标修饰键、To Do List 禅模式入口、跨视图保持禅模式以及退出后的导航恢复。
- To Do List 的视觉交付需要在 1440 × 1024 检查主状态，并至少补充一次 1024 × 768 窄窗口检查；普通浏览器预览控制台不应出现 Tauri bridge 错误。
- To Do 拖放交付必须额外在真实 Tauri macOS `.app` 中验证 DOM 顺序和 SQLite `position` 同时变化；使用独立 bundle identifier、临时 HOME 和测试数据库，禁止操作用户正式任务数据。
- 修改 Thread/Task 关联时，需要覆盖一个 Thread 只能关联一个 Task、一个 Task 可关联多个 Thread、子 Task 路径、候选状态过滤、终态对象仍可发起、已有关联直接迁移、删除级联清理和状态变化不自动解绑。
- 关联状态管理需要覆盖同一 Thread 串行、不同 Thread 并行、提交失败回滚并重载、重载失败后队列仍释放、5 秒撤销以及 Task 快照删除后的关系对账。
- 修改“仅未绑定任务”筛选时，需要覆盖按需加载且五秒轮询不重复、与项目/状态/搜索取交集、关闭和清空恢复、加载中不误显示、加载失败重试，以及绑定移出和撤销恢复；普通浏览器模式同样需要区分未加载与成功读取空关联。
- Thread/Task 关联视觉交付需要在 650px 内容宽度检查折叠态、展开态、下拉候选、双向定位、迁移与撤销；页面不得横向溢出，普通浏览器 demo 流程不得调用 Tauri，控制台错误应为 0。
- To Do 完成度排序需要覆盖顶层树三档顺序、取消视为完成、父子树不拆分、同组 `position` 稳定、跨组拖拽无效、搜索筛选分页和跨视图定位使用同一展示顺序。
- To Do 日期布局需要覆盖根任务、子任务、前插和后插四种新建入口默认本地明天及跨月跨年；覆盖 `created_at` 本地只读展示、起始日期 UI 消失但快照保留、两个结束日期列完整显示和继续可编辑。
- To Do 关联 Thread 点击回归需要覆盖折叠标签和展开详情均调用正确 `codex://threads/<session-id>`、点击后保持 To Do 页面、无效 session 不调用 Tauri、普通浏览器预览不调用 Tauri，以及 Thread → Task 反向定位不受影响。关联列表仍需覆盖无关联、加载中、加载失败重试、进入页面只加载一次且五秒轮询不重复加载，并在约 650px 内容宽度检查多标签换行无横向溢出。
- 修改 To Do List 五列宽度时，需要从宽屏自然布局开始连续缩小视口，检查任务和关联 Thread 在尾列消失前保持捕获宽度，操作、实际结束日期、预期结束日期依次压缩并完整隐藏；尾列全部隐藏后检查关联 Thread 先到 `180px`、任务再到 `240px`、随后按 `4:3` 同步缩小。每个阶段都必须确认表头与任务行对齐、隐藏列计算宽度为 `0`、页面无横向溢出且浏览器控制台错误为 `0`，并反向放大确认恢复顺序。
- 修改 To Do 置顶时，需要覆盖旧库 `pinned` 默认值、快照往返、仅 root 菜单可操作、取消置顶、多个置顶 root 的顺序、完成态置顶优先、Tab 与跨层级移动后的新 root 转移，以及子任务不得保留置顶。视觉交付必须在 1440 × 1024 和 1024 × 768 确认没有新增置顶列，图钉只占现有任务单元格的一个图标位，浅绿色覆盖完整置顶 root 主行但不覆盖子任务或展开详情，且页面无横向溢出、控制台错误为 0。

## Update Notes

- 2026-10-26: 增加 Python 本机构建/安装助手回归，以及 ad-hoc 签名、最终 DMG 内 app 完整性与未公证/设备策略的独立验证要求。
- 2026-10-26: 新增任务工作台状态机、假子进程协议、原生子 Agent/Goal、目录互斥、浏览器和真实桌面验收范围，不将模拟测试计为真实账户验收。
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
- 2026-07-22: 修正 To Do List 窄屏回归要求：`520px` 档必须验证日期和操作列完整隐藏，`320px` 档才允许任务与关联 Thread 低于 `140px`。
- 2026-07-23: To Do List 列宽回归改为运行时基线下的连续缩放，覆盖三个尾列顺序、`180px/240px` 前列阶段、最终 `4:3` 和反向恢复。
- 2026-08-05: 增加 To Do root 置顶的迁移、持久化、排序、层级转移、菜单权限、单图标布局和浅绿色主行回归范围。
- 2026-08-06: 增加空标题 To Do 任务退格删除后的焦点与末尾光标回归范围。
- 2026-08-06: 增加 To Do 周视图的滚动时间边界、组合筛选、树路径、导航复位和仓储差异更新时间回归范围。
- 2026-08-06: 增加旧 To Do 快照时间污染迁移为独立业务变动基线的回归范围。
- 2026-08-12: 增加 To Do 折叠态扩展摘要的拼接、安全链接、布局与响应式回归范围。
- 2026-08-19: 增加 To Do 纯排序变化不刷新周视图业务活动时间的回归范围。


## 2026-10-28 筛选/时间回归

- taskFilters.test.ts：168 小时边界、未来/无效日期、多维同节点交集、命中后的完整根树、24小时/7天/30天命中深层节点、根命中及多命中去重、折叠不影响整树集合、未命中同树任务定位与分页、缓存损坏与刷新后重新计算。
- taskFilters.keyword.test.ts：根/中间节点/叶子任意关键词命中均定位整棵根树、多树去重、Markdown 上下文大小写搜索；已完成/过期的关键词命中不阻止同树待办节点通过其他筛选；多维条件仍须在各节点上取交集，命中后补全整棵根树，补全节点不计入符合筛选数，无符合节点不显示空树。
- ChatApp.test.tsx：多选状态/项目/周视图离开返回、全部展开折叠、重置与独立侧栏查询；关键词和状态筛选后仍完整展示所在根树、往返导航保留条件与结果；最近7天仅一个子任务更新时显示全部兄弟任务与祖先，区分命中、纳入结果和折叠后数量，标记同树上下文。
- TaskStatusIcon.test.tsx：四种状态不同形状，终态不能被旧依赖覆盖。
- ScheduledStartField.test.tsx：本地时间转 UTC、设置/清空不隐式委派。
- task_schedule.rs：注入时钟验证到点边界、不重复领取、暂停/依赖不被绕过、无效/过期编辑保护、幂等迁移。
- workflow.rs：服务层未来任务无运行/Thread，时间改为已到后无需手动推动即只执行一次（假 app-server）。
- work_runtime.rs：真实子进程传输模拟首个候选配置失败、下个通过；预检无 Thread/Turn/配置写入。

### 2026-10-28 主聊天输入

- Composer.test.tsx 覆盖两种IME确认时序、普通Enter/ShiftEnter、文字粘贴默认行为、图片items/files去重及fallback、预览/移除/纯图发送、异步读取期间保留新字与切换取消、超量/超大/格式整批预检。与ChatApp既有文本附件/草稿迁移一起回归。
- 输入法原生验收必须用实际系统拼音按键，不能用fill或文本粘贴代替；系统图片剪贴板可在隔离WKWebView中用图片右键Copy Image→移除旧附件→Cmd+V检验。证据见 docs/verification/2026-10-28-composer/README.md。
