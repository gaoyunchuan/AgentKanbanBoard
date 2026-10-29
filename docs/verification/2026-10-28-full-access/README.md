# 完全访问权限修复验收

日期：2026-10-28。代码、独立桌面测试及正式安装验证通过。用户明确确认停止等待批准的目标执行后，已确认暂停、安装并重新启动新版，权限窗口已打开；当前权限保留按需确认，未重放旧操作。

## 改动与使用方式

点击会话输入框下方权限按钮，在“权限模式”中选择“完全访问”，保存后从下一轮生效。预设同时设置 `sandbox_mode=danger-full-access` 和 `approval_policy=never`；只保存当前会话，自动主会话同步其工作任务配置，已有 Thread 和工作目录不变。

“按需确认”恢复 `workspace-write + on-request`；“只读”使用 `read-only + on-request`。原有自定义组合保留在高级设置中；没有修改的历史审批值不重提给当前接口。权限标签按沙箱与审批的组合显示，不能把“无沙箱但仍询问”误标成完全访问。

权限表单捕获打开时的 ID、配置与 revision，另一窗口收紧权限后，旧弹窗保存会因版本冲突被拒绝，不会悄悄恢复完全访问。

## 根因与实现边界

旧界面将沙箱与审批拆为两个下拉选项，只选择 danger-full-access 不能关闭 on-request 的 MCP 操作批准。截图对应会话的配置确实仍是 workspace-write / on-request。

使用 Codex 0.164.0-alpha.11.1 原生审批策略实现；没有在 APP 中批量代点 MCP 允许，也没有改用户的 config.toml。业务信息、登录、验证请求不由本功能代填或伪造为已完成。组织强制配置仍由 Codex 自身校验。

参考：[官方权限说明](https://learn.chatgpt.com/docs/agent-approvals-security)、[MCP 配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 可复核结果

| 场景 | 结果 |
| --- | --- |
| 新 Thread：同一受控 MCP 强制 prompt | on-request 一次批准；never 零批准，两者均实际调用一次并成功 |
| 同一 Thread：按需 → 完全 → 按需 | 请求数 1 → 0 → 1；Thread ID 保持不变，每轮工具实际调用一次 |
| 真实 Tauri APP：按需 | 出现与用户截图相同的空表单操作批准，允许后工具完成 |
| 真实 Tauri APP：完全访问 | 输入框显示完全访问，已保存 danger-full-access / never；MCP 完成一次，批准为零，真实模型返回 PERMISSION-CHECK-OK |
| 非权限故障 | 首次完整回复遇到 serverOverloaded 容量错误，工具已执行；失败留档，明确新执行重试后成功，没有把失败计作成功 |
| 旧配置、其它会话、只读恢复与并发收紧 | 前端行为回归通过，旧 on-failure 原样保存不报错，远端收紧后旧弹窗不能覆盖 |

自动检查：85 条前端、136 条 Rust 库、main 1 条、Rust 集成 1 条、Python 18 条，共 241 条通过。`make build-app` 的 TypeScript 编译、Rust/打包、本机 ad-hoc 签名核验通过。最初 TS 将可选字段传给字符串 state 的错误已修正后重新构建成功。`git diff --check` 通过。独立审查发现的旧值与并发覆盖问题均已修复复核。

## 证据与隔离

- `evidence/native-new-threads.json`：原生协议对照。
- `evidence/native-same-thread.json`：相同 Thread 切换后 1 / 0 / 1 的操作批准。
- `evidence/ui-on-request.ax.txt`、`ui-full-access.ax.txt`：真实 APP 控件与执行结果。
- `evidence/desktop-runs.json`：按运行统计工具完成、批准数量、错误和结束状态。
- `evidence/checks.json`：测试与构建摘要。

测试使用 `/tmp/agent-kanban-permissions-20261028/app.db` 和独立 bundle `local.codex.thread-kanban.permissions-test`，沿用当前登录。夹具仅暴露本地静态 MCP 工具，禁用 shell/unified exec、原生多 Agent、Apps 和其它已配置 MCP；不连接生产数据库，也不改全局凭据/配置。

本轮没有提交或推送。正式 APP 安装状态以最终交付回复及门禁记录为准。

- `evidence/build.json`：本机包签名、测试包去签名后代码一致、安装与构建二进制 SHA256 一致。
- 用户选择“现在停止并安装新版”，已执行；新旧配置 schema 不变。
