# 委托任务默认权限（2026-10-29）

## 需求

新委托给 Codex 的任务原来固定为“按需确认”。需要在设置页选择默认权限，之后新建的委托直接采用。

## 实现

- 设置页新增“委托任务默认权限”：按需确认 / 只读 / 完全访问，保存到 `studio_settings.delegation_permission`；值非法时后端拒绝。
- 委托流程仅在任务尚无执行配置时套用默认权限：按需确认=`workspace-write + on-request`，只读=`read-only + on-request`，完全访问=`danger-full-access + never`。
- 已存在的委托、已绑定会话或正在运行的任务保持原权限，重委派不会静默放宽。
- Agent 创建的业务子任务继续继承父任务权限。

## 验证

- Rust：192 项通过；新增 `delegation_permission_defaults_and_rejects_unknown_modes`（含保存后套用）与 `delegation_permission_setting_maps_to_task_config`。
- 前端：179 项通过；新增 `SettingsPage.test.tsx` 覆盖选择完全访问、警告提示与保存参数（含排除目录基线）。
- `git diff --check`、TypeScript/Vite 构建通过；新版已安装到 `~/Applications/Codex Thread Kanban.app`（上一版备份 `Codex Thread Kanban.backup-e8c0b50db782463fafddba1b2e9e97e5.app`）。

## 边界

安装时有一个任务正在执行，因此没有重启进程；运行中的实例还是旧版，重启后可在设置页选择默认权限。已有任务的权限不会因为这项设置自动改变。

## 运行中修改权限（补充）

权限（`approval_policy`/`sandbox_mode`）属于每轮 turn 的启动参数，可在任务运行或等待回答时直接修改：`update_conversation` 对仅权限变更放行，并把自动会话的配置同步到 `work_tasks.config_json`，下一次 turn/run 使用新权限；模型、推理强度、浏览器、项目等其他配置仍要求先停止。正在执行的回合不受影响，无需停止任务。

真实应用验证：任务「网关文档发布及SDK对外发布」处于 `waiting/question` 时打开会话权限改为完全访问并保存成功，`work_tasks` 的 `approval_policy/sandbox_mode` 变为 `never/danger-full-access`，任务保持等待回答。回归见 `pin_and_title_can_change_during_run_and_permission_waits_for_next_turn`、`permission_change_during_auto_run_updates_work_config_for_next_turn` 与 `PermissionDialog.test.tsx`。
