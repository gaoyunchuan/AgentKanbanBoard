# Known Errors

## Current Knowledge

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
