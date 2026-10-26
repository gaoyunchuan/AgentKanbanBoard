# AgentKanbanBoard

[English](README.md) | 简体中文

AgentKanbanBoard 是一个基于现有 To Do 任务树和 **Codex app-server** 的个人任务工作台。你给出目标、工作目录、验收要求和依赖，再把任务交给 Agent；执行、提问、审批、交付和返工都围绕同一个任务进行。

工作台会创建和恢复自己管理的 Codex 会话，这条执行路径只需要本产品与 Codex app-server。原有的 Codex Desktop thread 看板继续保留，用于只读导入、标注和查看历史。安装包目前仍使用 **Codex Thread Kanban** 名称。

本项目以 [MIT License](LICENSE) 开源。完整用法、状态规则和运行边界见[任务工作台指南](docs/task-workbench.md)。

## 主要功能

- **可执行的任务树**：沿用现有 To Do 层级、快捷编辑、日期、排序和扩展信息，直接委派任务节点。
- **明确的归属与前置条件**：设置委托人、受理 Agent、工作目录、角色指令、验收要求和 `Blocked by`。树形关系组织工作，依赖关系决定何时可以执行。
- **自动调度**：符合条件的任务自动启动 Codex 会话。最多同时执行两个 Agent 任务；相同或互相包含的工作目录串行。手动终端也占用工作目录，避免与 Agent 同时写入。
- **任务内执行详情**：查看流式消息、工具输出和代码变更，浏览工作区文件，附加本地图片路径，通过 app-server 执行或停止明确输入的终端命令。
- **需要人时集中处理**：“需要我”区域汇总审批、问题、验收和执行异常。每个回复对应具体任务与执行，过期审批不能用于新的执行。
- **按交付推进状态**：普通最终回答或 `turn/completed` 不会直接完成任务。Agent 必须明确提交结果和证据；默认由人验收，也可选择在有效提交且执行正常结束后自动完成。
- **有上限的自动续跑**：正常结束但尚未完成交接的执行最多再自动续跑两轮。真实阻塞等待依赖完成、人的回答或环境修复，不反复调用模型轮询。
- **子任务与持久消息**：Agent 可以创建子任务、等待结果，并向同一任务树内已委派的任务发送上下文。消息在后续符合条件的执行中读取，不会越过暂停或依赖。
- **保留历史的返工**：给出具体反馈后启动同一任务的新执行，旧结果、旧执行与反馈仍可追溯。
- **可选浏览器操作**：启用固定版本的 Playwright MCP，通过独立、可见的 Chrome 窗口工作。需要本机 Node.js 与 Chrome，并在首次创建会话前配置。
- **保留原有 thread 看板**：继续支持 Codex Desktop thread 导入、标注、项目归类、筛选、归档和 Thread / Task 关联；导入链路仍然只读。

## 跑通第一个任务

1. 安装 [Codex CLI](https://github.com/openai/codex#installing-and-running-codex-cli)，例如执行 `npm install -g @openai/codex`。确认 `codex --version` 和 `codex app-server --help` 可运行；所用 app-server 需要支持工作台使用的实验性动态工具。
2. 按下文开发或构建说明启动 Tauri 桌面应用。普通 Vite 浏览器预览只展示界面，不执行真实任务。
3. 打开 **To Do List**（`Cmd+2`），展开 **Codex 连接与账户**，点击 **连接**。如果桌面进程找不到 `codex`，填入可执行文件的绝对路径。需要时使用界面的 ChatGPT 登录流程，完成后刷新账户与模型。
4. 新建任务，点击 **交给 Agent**。填写已存在的绝对工作目录、具体目标、验收要求和受理 Agent。首次使用保留 **提交结果后由我验收**，点击 **委派并启动**。
5. 在任务中查看会话和变更，处理当前审批或问题。Agent 提交交付且执行结束后，点击 **验收通过**，或填写具体反馈并选择 **反馈并返工**。

建议先使用一个临时目录，要求 Agent 创建单个 `hello.md`、读回并给出验证结果。再建立一个依赖它的任务，确认前置交付验收后，后续任务才会自动启动。

## 任务状态与执行状态

| 任务状态 | 含义 |
| --- | --- |
| `queued` 排队中 | 已满足启动条件，等待执行名额和工作目录可用。 |
| `running` 执行中 | 一次执行正在推进任务。 |
| `waiting` 等待中 | 等待依赖、审批、回答或环境修复。 |
| `review` 待验收 | Agent 已明确提交结果，尚未完成验收。 |
| `completed` 已完成 | 交付已由人或配置的 Auto 策略接受。 |
| `paused` 已暂停 | 等待明确恢复。 |
| `cancelled` 已取消 | 当前任务节点已取消。 |
| `attention` 需要处理 | 失败、不确定的恢复状态或续跑上限需要人的判断。 |

执行记录另外维护运行、等待审批、本轮结束、失败和中断等状态。**本轮执行结束，不等于业务任务完成。** Auto 会检查提交结构、依赖和执行结果；它不等于独立验证所有验收条件，也不会让 Reviewer Agent 自动代替人批准。

暂停与取消只作用于当前业务任务节点，不级联操作业务子任务。返工会保留旧记录，不自动回滚文件，也不自动重开所有下游任务；需要根据影响显式选择后续返工范围。

## 数据与运行边界

- 应用本地库默认位于 `~/.codex-kanban/app.db`，保存任务树、委派配置、依赖、执行记录、交互、交付，以及旧看板的本地标注。
- 执行由本应用启动的 app-server 进程负责，使用 Codex 账户与工作区权限。默认审批策略为 `on-request`，沙箱为 `workspace-write`。
- 旧导入读取 `~/.codex/state_5.sqlite` 和本地 thread 名称索引。导入、标注或关联 Desktop thread，不会恢复该会话、批准请求，也不会把执行权交给任务调度器。
- 旧 Desktop thread 链接仍可通过 `codex://` 打开；工作台任务使用本应用自己管理的 app-server 会话。
- **没有后台常驻服务。** 关闭详情面板不影响执行；退出桌面应用会停止它拥有的运行时。下次启动时，之前结果不确定的执行需要检查后明确重试，不会悄悄重复运行。
- 第一期只面向个人与人工创建的任务，不提供团队服务、海量业务回调接入或自由拖拽工作流编辑器，也不宣称已完整覆盖 Codex Desktop 的全部功能。

## 技术栈

- 桌面壳：Tauri 2
- 后端：Rust、rusqlite、SQLite
- 前端：React 18、TypeScript、Vite
- UI：Tailwind CSS、Radix UI、lucide-react
- 测试：Vitest、Rust unit tests
- 构建产物：macOS `.dmg`

## 本地开发

前置依赖：

- Node.js 22 或兼容版本
- npm
- Rust stable
- Python 3，用于 macOS 构建/安装助手和假 app-server 子进程协议测试
- macOS 的 Xcode Command Line Tools；构建 DMG 还会使用系统自带的 `hdiutil`

安装前端依赖：

```bash
npm --prefix src-ui ci
```

只调试前端界面时，可以启动 Vite：

```bash
npm --prefix src-ui run dev
```

运行完整桌面应用时，使用 Tauri 开发模式。该命令会根据 Tauri 配置自动启动前端开发服务：

```bash
cd src-ui
npm exec tauri dev
```

## 测试

在仓库根目录执行：

```bash
make test
```

该命令会运行：

- `make test-local-tools`（Python 构建/安装助手测试）
- `npm --prefix src-ui run test`
- `cargo test --manifest-path src-tauri/Cargo.toml`

协议测试使用假 app-server，不登录 Codex，也不调用真实模型。真实账户、权限和浏览器需要单独进行[桌面验收](docs/task-workbench.md#真实桌面验收边界)。

## 本地构建

只在自己的 Mac 上使用时，先退出已经运行的 **Codex Thread Kanban**，再进入已克隆的仓库根目录执行：

```bash
git pull --ff-only && make run-local
```

`make run-local` 会编译并做 **ad-hoc 签名**，使用 `ditto` 安装到 `~/Applications/Codex Thread Kanban.app`，然后打开安装好的副本。已有副本会先保存在独立命名的备份位置，安装命令会显示该路径。这个入口不需要生成 DMG，也不需要 Apple Developer 账号；只构建和安装、不启动时使用 `make install-local`。

需要可拷贝的开发 DMG 时再执行：

```bash
make build
```

`make build-dmg` 是等价的打包入口。校验后的文件位于 `src-tauri/target/release/bundle/dmg/Codex Thread Kanban_0.1.0_<arch>_development.dmg`，旁边附有 `.sha256` 和 `.verification.json` 文件。

这些是未经 Apple 公证的开发版本。Ad-hoc 签名用于保证应用包完整性，不提供受信任开发者身份，也不改变受管理 Mac 的应用策略。若系统阻止打开，见[本机 macOS 运行与启动检查](docs/macos-local.md)。

## GitHub 自动构建

仓库包含 GitHub Actions workflow：

```text
.github/workflows/build-artifacts.yml
```

触发方式：

- 推送到 `main`
- 创建或更新 Pull Request
- 在 GitHub Actions 页面手动执行 `Build Artifacts`

workflow 会在 macOS runner 上运行测试，以 ad-hoc 签名构建，校验最终 DMG 和其中的应用，再上传 **`codex-thread-kanban-development`**。该制品是未经 Apple 公证的开发版本；CI 通过不代表下载后一定符合每台 Mac 的应用策略。

本机使用优先按上文从源码构建。当前构建流程不要求配置 Developer ID 证书、Apple 账号或公证服务。

## 项目结构

```text
.
├── src-ui/        # React + TypeScript 前端
├── src-tauri/     # Tauri / Rust、任务调度、app-server、本地 SQLite 与旧导入
├── openspec/      # 功能设计与变更规格
├── docs/          # 工作台指南、工程约束与文档截图
├── Makefile       # 测试、本机安装与 DMG 构建入口
├── LICENSE        # MIT License
├── README.md      # 英文文档
└── README_zh.md   # 简体中文文档
```

## 许可证

Copyright (c) 2026 gaoyunchuan

本项目基于 [MIT License](LICENSE) 开源。你可以自由使用、复制、修改、合并、发布、分发、再许可或销售本软件的副本，但必须在软件副本或主要部分中保留原始版权声明和许可声明。

## 当前状态

个人任务工作台与原有 thread 看板持续迭代中。运行时使用 app-server 的实验性动态工具，需要核对本机 Codex 版本的兼容性。自动化状态机和协议测试不代表已通过真实账户的桌面验收。浏览器操作需要主动启用并单独安装 Chrome；仓库不内置 Codex、账户、Chrome 或后台常驻服务。
