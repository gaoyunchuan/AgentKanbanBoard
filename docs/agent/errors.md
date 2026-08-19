# Known Errors

## Current Knowledge

### To Do 周视图首次启用仍显示全部旧任务

- 场景：旧版本保存完整 To Do 快照时会刷新快照内所有任务的 `updated_at`，随后升级到按单任务变动筛选的周视图。
- 现象：启用周视图后任务数量没有明显变化，大量很久以前的任务仍被识别为过去 168 小时内有变动。
- 根因：代码虽然已停止继续污染时间，但数据库中所有历史任务已有同一近期 `updated_at`，直接复用该字段无法区分真实变动。
- 处理：新增内部 `activity_at` 作为周视图的业务变动时间；老库首次迁移以 `created_at` 初始化，字段存在后不再重置，后续仅在任务持久化字段实际变化时刷新。
- 经验：修正时间字段的写入语义时，还必须为已污染历史数据设计一次性基线迁移；仅修复未来写入不能修复当前筛选结果。

### To Do 中间插入任务后周视图出现大量旧任务

- 场景：在同级任务中间插入、删除或拖拽任务，保存完整 To Do 快照。
- 现象：大量未编辑的旧任务在同一秒进入周视图，命中任务的位置通常形成连续区间。
- 根因：`position` 被同时用于排序持久化和业务变动判定；单条任务造成的兄弟位置连带重排刷新了所有受影响任务的 `activity_at`。
- 处理：继续持久化 `position`，但前后端业务活动判定均排除纯位置变化；父子层级和任务内容变化仍刷新 `activity_at`。已经污染的数据需要备份后按明确批次恢复到迁移基线。
- 经验：界面结构字段与业务活动字段必须分开建模；批量归一化字段不应默认代表每个实体都发生了业务变化。

### Thread Kanban 看板窗口间歇性消失

- 场景：前台渲染关键路径或高频轮询路径直接等待重同步。
- 现象：看板间歇性消失，Codex Desktop 窗口随之变宽；稍后看板恢复。
- 根因：UI 渲染/刷新链路等待同步式外部数据同步、扫描或重建完成；本例是 `useBoardData` 定时器等待 `sync_codex_threads()` / `refresh_board_data(true)`。
- 处理：同步改为 `start_codex_sync()` 后台 `spawn_blocking` 单飞执行；`load_board_data()` 只做只读加载。
- 经验：凡是会影响前台渲染、窗口布局或周期刷新的路径，都不能同步等待重同步；同步式强制同步只适合显式入口、离线任务或非渲染关键路径。

### To Do 拖放在浏览器可用、桌面应用无效

- 场景：前端使用 HTML5 `draggable` 与 `dragstart/dragover/drop`，Chrome 预览和组件测试均通过，但 Tauri macOS 应用无法开始拖动。
- 现象：拖拽手柄可见，鼠标拖动没有排序反馈，快照也不会保存。
- 根因：Tauri 窗口未显式设置 `dragDropEnabled: false`，默认启用的内部文件拖放处理器会独占拖放并阻止 WKWebView DOM 拖放事件。
- 处理：在 `tauri.conf.json` 的窗口配置中设置 `"dragDropEnabled": false`，并用独立 bundle identifier、临时 HOME 和测试数据库的真实 `.app` 验证 UI 与 SQLite 顺序同时变化。
- 经验：桌面交互不能只用 Chromium 验收；涉及 WebView 平台能力时必须在目标 Tauri 壳中验证原生事件链。

### To Do 状态菜单在组件测试可用、真实浏览器瞬间关闭

- 场景：菜单打开后通过 `useEffect` 在 document 注册点击外部关闭监听器，菜单触发按钮的点击继续向上冒泡。
- 现象：Testing Library 中点击“设置”可以看到菜单，但真实 Chrome 中菜单在同一次点击内立即消失，置顶等菜单操作无法选择。
- 根因：React 处理离散事件时可能在该点击完成冒泡前执行 effect；新注册的 document 监听器于是把打开菜单的点击误判为外部点击。测试环境的 effect 与事件调度顺序没有复现这一时序。
- 处理：菜单触发按钮在更新打开状态前调用 `event.stopPropagation()`；菜单外后续点击仍由 document 监听器关闭。
- 经验：使用 document 级外部点击监听器的弹层不能只靠组件测试验收；需要真实浏览器点击触发器，确认菜单在事件完成后仍然存在并可操作。

### npm ci 报 `Invalid Version`

- 场景：使用 npm 11 执行 `npm --prefix src-ui ci` 或 `make build`。
- 现象：依赖安装立即失败，仅报告 `npm error Invalid Version:`；调试日志栈位于 Arborist 的 `Node.canDedupe` / `PlaceDep`。
- 根因：`package-lock.json` 中存在没有 `version` 的 Tauri CLI 可选平台包节点；这些包被错误记录在 CLI 的嵌套 `node_modules` 下。
- 处理：删除残缺节点，用 `npm --prefix src-ui install --package-lock-only --ignore-scripts` 补全为顶层平台包节点；确认既有依赖版本未变化后，重新运行 `npm ci` 和 `make build`。
- 经验：遇到没有包名的 `Invalid Version` 时，应程序化扫描锁文件的空版本节点，并在干净依赖目录中复现；不要直接升级依赖或手工猜测版本。

## Update Notes

- 2026-07-04: 沉淀 Thread Kanban 间歇性消失问题的症状、定位边界和最终修复约束。
- 2026-07-04: 按 `/learn` 新版错误知识格式，将记录整理为独立小章节并补充可复用经验。
- 2026-07-04: 压缩错误记录，只保留问题本质和可复用经验。
- 2026-07-13: 记录 Tauri 内部拖放处理器阻止 macOS WKWebView DOM 拖放的问题与验证方式。
- 2026-08-05: 记录 React 离散事件中菜单触发点击被新挂载 document 监听器立即关闭的问题。
- 2026-08-05: 记录 Tauri 可选平台包残缺锁节点导致 npm 11 Arborist 报空版本错误的问题。
- 2026-08-06: 记录旧版快照统一刷新时间导致 To Do 周视图命中全部历史任务的问题及独立变动时间迁移方案。
- 2026-08-19: 记录 To Do 同级位置连带重排污染周视图业务活动时间的问题。
