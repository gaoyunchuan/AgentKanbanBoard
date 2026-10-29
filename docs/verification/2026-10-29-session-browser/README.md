# 会话浏览器本机验收记录

2026-10-29，Asia/Shanghai。范围为本地 Docker Chrome＋agent-browser streaming 的会话侧边浏览器、本会话 Agent 工具、持久化状态和常用输入。代码位于 main，未提交、未推送；只安装到独立测试 bundle 和临时数据库，未改动正式 APP 数据。

## 可复核结果

| 场景 | 证据与结论 |
| --- | --- |
| 真实产品链路 | `cargo build --offline --manifest-path src-tauri/Cargo.toml --example session_browser_driver` 后用 `node scripts/test_session_browser.mjs` 跑通：A/B 隔离、MCP 正文标记、容器 stop/rm 重建恢复 Cookie/localStorage/IndexedDB、三种文件上传、下载落库旁、失败注入与清单保留、真实整段粘贴。见 product/trace.json。 |
| 旧 Thread 工具接入 | 隔离 APP 中真实 Codex 会话只用 `session_browser` 列出页面、读取页面独有 `DOM-` 标记并点击输入框；没有访问通用 Chrome/Arc。见 native/pre-upgrade-ax.txt。 |
| 跨 APP 升级恢复 | 同数据库从旧候选替换为新 bundle 后，两页签与当前页直接恢复；原 Thread 读回同一 DOM 标记与三种存储值，Thread ID、工作目录、权限配置不变。见 native/before-upgrade.json、upgrade-restored-ax.txt、upgrade-check.json。 |
| 画面闪烁 | 原错误提示把画面挤矮 73px，触发 resize→重连→错误消失→再重连循环（native/resize-flash-red.log 中 715/642px 交替）。提示改为覆盖层后，真实 APP 只发生一次初始 resize 重连并持续显示“实时连接”。 |
| 中文输入与按键 | 系统拼音输入经隐藏输入器到达网页；候选确认不额外发送回车，普通回车生成换行，退格生效。见 native/ime-confirm-green.json、normal-enter-green.json、flash-stable-ax.txt。 |
| 粘贴丢字 | CDP `char` 事件只接受单字符，多字符文本被静默丢弃；整段粘贴改为点击位置的页面级 `insertText`。真实 APP 粘贴“CuaClip验收”、表情与换行均原样到达网页并触发一次 input 事件；产品 E2E 同时断言。修复前后对照见 native/paste-fix.json。 |
| 桌面快捷键 | 浏览器输入聚焦时 Command+Q/H/M 交给宿主 APP，不被映射成远端 Control；浏览器与 Agent 均可继续使用页面。 |
| 生命周期与限额 | 活跃浏览器≤4，每 owner 9 个请求许可；停止失败保留归属并可重试，启动失败确认清理后才释放空占位；APP 退出先停 MCP 再统一清理，桥接进程崩溃仍能精确回收容器。见 cargo browser_bridge 5 项与 product trace 的失败注入。 |

## 自动回归

- 前端：`npm --prefix src-ui test`，178 项通过（含 WebKit 覆盖层尺寸回归、键盘/IME/粘贴/上传/流边界）。
- Rust：`cargo test --offline --manifest-path src-tauri/Cargo.toml` 全量通过；其中 browser_bridge 5 项覆盖停止重试、失败启动、退出清理、桥接崩溃和 owner 许可。
- Node：`node --test scripts/session_browser_core.test.mjs` 8 项通过；打包助手 19 项通过；`npm --prefix src-ui run build` 与 `git diff --check` 通过。
- 构建：`python3 scripts/macos_local.py build-app` ad-hoc 签名校验通过；隔离候选安装后替换升级并启动成功。

## 未覆盖与剩余风险

- 输入到画面的 p95 延迟和动画 fps 未采样；当前只证明 ACK 背压、单连接保活和尺寸稳定，不宣称 p95≤200ms。
- 4 容器×16 页满载、Docker Engine 整体重启、Linux/amd64 宿主回环均未执行。
- 完整 profile 与普通下载没有硬磁盘配额（容量门禁 BLOCK，见 docs/data-safety/session-browser/capacity.md）；用户要求持久保留，禁止用自动删除弥补。
- 网页内原生右键菜单、跨页面拖拽图片等未纳入本轮；文本、图片粘贴、文件输入/拖入、下载已按上述证据覆盖。
