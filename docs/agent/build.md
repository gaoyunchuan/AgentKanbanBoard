# Build

## Current Knowledge

- 桌面包仍沿用 `Codex Thread Kanban` 名称，产品能力已扩展为个人任务工作台；构建与许可证入口保持不变。
- Codex CLI/app-server、账户登录、Chrome 和 Node.js/npx 是运行环境依赖，不随应用安装包打包。仅旧只读导入看板不需要应用拥有 app-server 会话。
- 可通过工作台连接设置保存 Codex 可执行文件路径；`CODEX_APP_SERVER_PATH` 仅作为尚未保存配置时的默认路径。传入程序路径，不能把 `app-server` 参数拼进路径字段。
- 浏览器 opt-in 使用固定版本 Playwright MCP，首次可能通过 npx 下载；需要 Node.js 18+ 和 Chrome，目标桌面进程必须能找到 npx。Thread/MCP 启动成功不等于已经完成真实 Chrome 验收。
- 自动化测试需要 Python 3 来运行假 app-server 子进程。Linux 缺少 GTK/WebKit 等 Tauri 系统库时，不能把只编译独立 Rust harness 的结果描述成完整桌面构建通过。
- `make test` 与 `make build-dmg` 可验证代码和包装；真实 Codex 账户、权限和浏览器仍需独立验收，具体见 `docs/task-workbench.md`。

- macOS 安装包使用 `make build` 构建；该目标先执行 `npm --prefix src-ui ci`，再运行 Tauri release 构建，最后生成 `src-tauri/target/release/bundle/dmg/Codex Thread Kanban_<版本>_<架构>.dmg`。
- `src-ui/package-lock.json` 的 `packages` 中每个非根节点都必须包含非空 `version`。Tauri CLI 的可选平台包应记录为带完整版本、下载地址、完整性、CPU 和 OS 条件的顶层节点；残缺的 `node_modules/@tauri-apps/cli/node_modules/...` 节点会导致 npm 11 的 Arborist 报 `Invalid Version`。
- `npm ci` 还必须覆盖 npm 10 与 npm 11 的兼容性：Vitest 的嵌套 Vite 8 可选 peer 需要对应的 esbuild 及平台包锁节点。只补齐缺失节点并将镜像 resolved URL 换为同版本 npmjs URL，保留既有版本、integrity 和平台条件；不要用整体升级依赖掩盖锁文件缺失。
- 修复或重建锁文件时，先用 `npm --prefix src-ui install --package-lock-only --ignore-scripts`，审查依赖版本差异，再依次运行 `npm --prefix src-ui ci` 和 `make build`。macOS 上使用 `hdiutil verify <dmg>` 校验最终镜像。

## Update Notes

- 2026-10-26: 补充 npm 10/11 对 Vitest 嵌套 Vite 8 的 esbuild 可选 peer 锁节点验证要求。
- 2026-10-26: 记录任务工作台的运行时依赖、固定浏览器 MCP 与真实桌面验收边界；保留现有 DMG 命名和构建入口。
- 2026-08-05: 记录 macOS DMG 构建链路、npm 锁文件完整性约束和验收命令。
