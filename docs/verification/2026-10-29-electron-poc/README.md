# Electron 原生浏览器 PoC 验收（2026-10-29）

范围：验证“面板内原生 Chromium + Agent 通过 CDP 操作同一页面”的路线，作为 Tauri + Docker 图像流的替代候选。PoC 位于 poc/electron，未改动现有应用的运行路径。

## 结论

- 内嵌 Chromium 的 WebContentsView 能在 Electron 窗口中原生渲染网页：E2E 直接读到页面 DOM（#text 占位符），并断言视图在窗口内占据可见区域（bounds 宽高 > 100），不依赖截图或像素流。
- 中文字形渲染验证通过：canvas 绘制“中/文”得到不同且非空字形（不是缺字方框）。
- 每个会话使用独立 persist 分区：A 设置的 Cookie 在 B 中为空。
- 持久化通过：关闭后用同一 profile 目录重启，A 的持久 Cookie 仍在，B 仍隔离。
- Agent 工具链复用：agent-browser --cdp 能列出 Electron 窗口与两个内嵌页面 target，可直接操作。
- 首屏速度：E2E 从启动 Electron 到页面 ready 约 0.6–1.0 秒；对比 Docker 图像流（单页签约 2.8 秒，多标签 5.25 秒）。

## 验证命令与结果

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| PoC 单元 | cd poc/electron && node --test tests/sessions.test.mjs | 3 项通过 |
| PoC E2E | cd poc/electron && node tests/e2e.mjs | 通过：原生 DOM、CJK 字形、A/B 隔离、重启持久化、agent-browser 读取 |
| 前端回归 | npm --prefix src-ui test | 18 文件 / 181 项通过 |
| Rust 回归 | cargo test --offline --manifest-path src-tauri/Cargo.toml | 193 项通过 |
| Node 核心 | node --test scripts/session_browser_core.test.mjs | 9 项通过 |
| 打包助手 | python3 -m unittest discover -s scripts -p test_macos_local.py | 19 项通过 |
| 真实产品链路 | node scripts/test_session_browser.mjs | 通过（隔离、MCP、容器重建、文件、整段粘贴、失败注入） |

## 历史问题对照

| 之前出现过的问题 | PoC 中的处理 |
| --- | --- |
| 图像流滚动闪烁 | 原生 Chromium 渲染，无帧重建；E2E 断言页面是真实 DOM |
| 中文乱码 | 使用 macOS 系统字体与原生字形；canvas 字形哈希校验 |
| 长文本粘贴被 CDP char 限制丢弃 | 粘贴走系统原生输入，不经过 CDP char 事件 |
| 输入法确认键误发 | 原生输入法链路，无隐藏输入框桥接 |
| Cmd+C 需自建复制桥 | 选区与复制由 Chromium 原生完成 |
| 首次打开慢（Docker 启动 + 串行恢复页面） | 无 Docker；E2E 首屏 0.6–1.0 秒 |
| 登录态重启丢失 | persist 分区 + E2E 重启持久化断言 |
| 权限默认值/依赖释放回归 | 现有后端与前端未改动，全量回归通过 |

## 边界

- PoC 只移植“会话列表 + 侧边浏览器 + Agent CDP”三块，尚未迁移任务执行、对话、权限弹窗、文件选择、下载、签名与更新。
- 尚未把现有 React UI 接入 Electron；当前 PoC 用独立的最小渲染层验证浏览器内核与隔离。
- 原生滚动/选区的流畅度依赖 Electron 内置 Chromium，未做帧率采样，但已消除图像帧路径。

