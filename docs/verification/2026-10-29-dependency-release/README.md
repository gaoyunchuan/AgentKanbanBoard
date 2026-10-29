# 依赖等待误判修复（2026-10-29）

## 复现

任务「网关文档发布及SDK对外发布」（`task-30605-1793256011297955000-1`）一直显示 `waiting/dependencies`，其依赖「用户可以主动发起强制恢复」（`task-49726-1793158731184836000-5`）在 `todo_tasks` 中已是 `completed`。

## 根因

`unresolved_dependencies` 的旧条件要求依赖任务同时满足：已完成、无不确定资源租约，并且“有 `ready+usable` 的 `task_results`，或者（从未交给 Agent 且有结果复盘文本）”。该前置任务从未创建会话、没有验收结果、结果复盘为空，因此被永久判为未满足；即便用户勾选完成，下游也不会放行。

## 修复

规则收敛为：人工任务（无 `chat_conversations`）完成即满足依赖；交给 Agent 执行过的任务仍要求 `ready+usable` 的验收结果；不确定资源租约继续阻塞。回归覆盖“人工完成无复盘放行”“Agent 任务缺验收仍阻塞”“取消任务不放行”。

## 验证

- `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib workflow::` 33 项通过（新增 `manually_completed_dependency_releases_without_review_note`）。
- 修复版构建、签名校验通过并已安装到 `~/Applications/Codex Thread Kanban.app`；上一版保留为 `Codex Thread Kanban.backup-7471e755a0884cb2aea83680a293e772.app`。
- 运行中的 APP 仍是重启前的进程；重启后在下一轮调度会释放等待任务并可能立即开始执行其 prompt（其中包含推送 main 的要求）。
