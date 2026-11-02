# Agent Maintained Knowledge

This section is maintained by automation. Keep user-authored project instructions outside the managed block.

<agent-maintained-knowledge>

## Project Knowledge

- Coding: `docs/agent/coding.md` — Load when writing, editing, reviewing, refactoring, or explaining code; when adding features or bug fixes; when touching constants, configuration, validation, user-visible errors, or public APIs.
- Environment: `docs/agent/environment.md` — Load when setting up or troubleshooting local development, runtime dependencies, versions, environment variables, containers, or machine-specific behavior.
- Build: `docs/agent/build.md` — Load when compiling, packaging, generating artifacts, changing build scripts, diagnosing build failures, or preparing commands that produce deployable outputs.
- Deploy: `docs/agent/deploy.md` — Load when preparing, executing, reviewing, or troubleshooting releases, rollbacks, traffic shifts, production changes, or deployment commands.
- Known errors: `docs/agent/errors.md` — Load when diagnosing errors, failures, regressions, flaky behavior, confusing logs, or recurring symptoms already seen in this project.
- Infrastructure: `docs/agent/infrastructure.md` — Load when working with machines, networks, storage, middleware, cloud resources, topology, permissions, or environment-level dependencies.
- Testing: `docs/agent/testing.md` — Load when writing, running, selecting, mocking, or debugging tests; when changing test data, fixtures, integration dependencies, or CI test behavior.

## Update Policy

Automatically maintain:

- `docs/agent/coding.md`
- `docs/agent/errors.md`
- `docs/agent/environment.md`
- `docs/agent/build.md`
- `docs/agent/testing.md`
- `AGENTS.md` managed block synchronization only when missing or outdated

Require review:

- `docs/agent/deploy.md`
- `docs/agent/infrastructure.md`
- `AGENTS.md` changes outside managed block synchronization

## Loading Rule

Before starting a task, scan the `Project Knowledge` triggers above and load every detailed knowledge document whose trigger matches the current work. For coding work, always load `docs/agent/coding.md` before editing, reviewing, or explaining code.

</agent-maintained-knowledge>



# AgentKanbanBoard

## 编码约定

- 直接在main开发，不用拉分支

## 默认完成本地安装发布

- 后续凡是修改应用代码、运行配置或界面行为，验证通过后，Agent 必须自动完成本机构建、安装、重启和现场验收，再结束任务。用户已授权此本地流程，无需再次询问是否安装或重启；仅文档修改、只读调查等不影响应用运行的任务无需重新安装。
- 使用现有 Electron 构建安装流程，以 `scripts/electron_local.py` 和 `docs/agent/build.md` 为准。先完成相关测试、构建、打包与签名校验，再正常退出旧应用，安装到 `~/Applications/Codex Thread Kanban.app` 并启动新版。
- 退出前检查未发送输入和运行中的执行，保全草稿并走应用正常退出流程；无法保全时先解决实际阻塞，不直接强制终止进程。安装时保留独立的旧版 APP 备份，保留用户数据库、浏览器状态、下载和账户配置。
- 安装后核对安装副本签名、前端资源及后端程序与构建产物一致，确认新进程从安装目录运行，并在真实桌面界面验证本次变更。测试通过或启动命令成功，不能代替安装后验收；未经授权不通过执行真实业务操作完成验收。
- 验收成功后，确认没有构建进程或程序依赖构建目录，再清理可重新生成的 `src-ui/dist`、`desktop/ui`、`desktop/dist-electron`、`src-tauri/target`。保留已安装应用、旧版备份、源码、用户数据和验收证据。
- 构建、安装或验收失败时，Agent 默认继续排查修复。确实无法完成时，明确报告失败阶段、证据和剩余阻塞，不把“代码已修改”表述为“新版已交付”。最终回复说明安装、重启和现场验收结果。
- 此授权仅限本机应用更新，不包含远程发布、生产部署、代码提交或推送。
