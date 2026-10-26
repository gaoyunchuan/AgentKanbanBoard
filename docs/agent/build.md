# Build

## Current Knowledge

- 桌面包仍沿用 `Codex Thread Kanban` 名称，产品能力已扩展为个人任务工作台；构建与许可证入口保持不变。
- Codex CLI/app-server、账户登录、Chrome 和 Node.js/npx 是运行环境依赖，不随应用安装包打包。仅旧只读导入看板不需要应用拥有 app-server 会话。
- 可通过工作台连接设置保存 Codex 可执行文件路径；`CODEX_APP_SERVER_PATH` 仅作为尚未保存配置时的默认路径。传入程序路径，不能把 `app-server` 参数拼进路径字段。
- 浏览器 opt-in 使用固定版本 Playwright MCP，首次可能通过 npx 下载；需要 Node.js 18+ 和 Chrome，目标桌面进程必须能找到 npx。Thread/MCP 启动成功不等于已经完成真实 Chrome 验收。
- macOS 构建/安装助手与假 app-server 子进程测试都需要 Python 3；原生构建还需要 Xcode Command Line Tools。Linux 缺少 GTK/WebKit 等 Tauri 系统库时，不能把只编译独立 Rust harness 的结果描述成完整桌面构建通过。
- `make test` 与 `make build-dmg` 可验证代码和包装；真实 Codex 账户、权限和浏览器仍需独立验收，具体见 `docs/task-workbench.md`。

- macOS 本机主入口为 `make run-local`，依赖 `install-local`：通过 Python helper 调用 Tauri 构建 ad-hoc app，使用 `ditto` 安装到 `~/Applications/Codex Thread Kanban.app`，再用普通 `open` 启动；已有副本保留独立命名的备份。`make install-local` 只构建和安装。这两条路径不需要生成 DMG。
- `make build` / `make build-dmg` 生成可拷贝的开发 DMG。所有开发构建显式使用 Tauri ad-hoc 签名身份 `-`，不能再使用 `--no-sign` 跳过整个 app bundle 签名；不需要 Apple Developer 账号或证书。
- Tauri 构建 app，DMG 由 `hdiutil` 包装；构建后必须验证 app 签名、镜像完整性和只读挂载后的 app 签名，确保实际交付容器中的应用也完整；仅验证构建目录内的二进制不足以覆盖最终 DMG。
- CI 制品名称为 `codex-thread-kanban-development`，明确未经 Apple 公证。Ad-hoc 签名、代码测试通过与被目标 Mac 的 Gatekeeper/管理策略允许是不同结果，不能把开发制品描述为已通过正式分发信任校验。
- 构建目录中的 app 位于 `src-tauri/target/release/bundle/macos/Codex Thread Kanban.app`；开发 DMG 位于 `src-tauri/target/release/bundle/dmg/Codex Thread Kanban_<版本>_<架构>_development.dmg`，附 `.sha256` 与 `.verification.json`。实际安装副本位于用户 Applications，诊断时要区分这三个位置。便捷启动和诊断见 `docs/macos-local.md`。
- `src-ui/package-lock.json` 的 `packages` 中每个非根节点都必须包含非空 `version`。Tauri CLI 的可选平台包应记录为带完整版本、下载地址、完整性、CPU 和 OS 条件的顶层节点；残缺的 `node_modules/@tauri-apps/cli/node_modules/...` 节点会导致 npm 11 的 Arborist 报 `Invalid Version`。
- `npm ci` 还必须覆盖 npm 10 与 npm 11 的兼容性：Vitest 的嵌套 Vite 8 可选 peer 需要对应的 esbuild 及平台包锁节点。只补齐缺失节点并将镜像 resolved URL 换为同版本 npmjs URL，保留既有版本、integrity 和平台条件；不要用整体升级依赖掩盖锁文件缺失。
- 修复或重建锁文件时，先用 `npm --prefix src-ui install --package-lock-only --ignore-scripts`，审查依赖版本差异，再依次运行 `npm --prefix src-ui ci` 和 `make build`。macOS 上使用 `hdiutil verify <dmg>` 校验最终镜像。

## Update Notes

- 2026-10-26: 增加 `run-local` / `install-local` 本机入口、用户 Applications 安装与旧副本备份；开发 DMG 使用 development 后缀并附校验记录。保持 ad-hoc、最终 DMG 内 app 校验与受管理设备边界，不引入 Developer ID/公证凭据流程。
- 2026-10-26: 补充 npm 10/11 对 Vitest 嵌套 Vite 8 的 esbuild 可选 peer 锁节点验证要求。
- 2026-10-26: 记录任务工作台的运行时依赖、固定浏览器 MCP 与真实桌面验收边界；保留现有 DMG 命名和构建入口。
- 2026-08-05: 记录 macOS DMG 构建链路、npm 锁文件完整性约束和验收命令。
