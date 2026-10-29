# Electron 原生浏览器 PoC

目的：验证“面板内原生 Chromium + 同一页面 CDP 可被 Agent 操作”的可行性，替代 Tauri 的系统 WKWebView 与 Docker 图像流。

## 形态

- Electron 38 主进程创建窗口，左侧读取现有 ~/.codex-kanban/app.db 的会话清单（只读，不写业务数据）。
- 每个会话一个 WebContentsView，使用 persist:akb-poc-<id>-<hash> 独立持久分区；切换会话时挂载/卸载对应视图。
- 窗口启动即打开 remote-debugging-port，agent-browser --cdp http://127.0.0.1:<port> 可直接看到窗口和所有内嵌页面（同一批 target）。
- 页面由内嵌 Chromium 原生渲染，滚动、选择、Cmd+C、输入法走系统原生路径；不再有 JPEG 帧与解码。

## 运行

    cd poc/electron
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
    npm start                     # 默认读取 ~/.codex-kanban/app.db
    npm start -- --db=/path/app.db --debug-port=9333

## 测试

    npm test         # 会话映射、分区唯一性、地址校验
    npm run test:e2e # 真实 Electron + fixture 页面：原生 DOM、Cookie 分区隔离、agent-browser CDP 读取

tests/e2e.mjs 会启动真实 Electron 窗口，用 CDP 验证内嵌页面 #text 原生存在、A/B 分区 Cookie 隔离，并调用 agent-browser tab list 确认 Agent 工具链能读取内嵌 target。

## 已验证与未覆盖

- 已验证：原生 DOM 渲染、视图在窗口内可见、中文字形、独立持久分区、重启后登录态保留、CDP 目标可见、agent-browser 读取内嵌页面。
- 未覆盖：完整 Kanban UI 迁移、任务执行 sidecar、登录态迁移、权限弹窗/下载/文件选择、正式签名与更新、多窗口布局。

