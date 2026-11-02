## Context

现有权限存在 work_tasks 和 chat_conversations 的配置内，task_preferences 尚无权限。调度器每轮已复制配置后交给执行 worker；权限仅在下一轮生效的基础存在。

## Goals / Non-Goals

**Goals:** 未委托任务也能显示并调整权限；新任务冻结创建时默认值；自动执行和属性显示一致。

**Non-Goals:** 不自动改变当前审批，不重放工具，不批量更改历史独立人工会话权限。

## Decisions

1. task_preferences 增加可空 execution_permissions JSON，保存 sandbox_mode 与 approval_policy 两项，以保留旧自定义组合。历史无值时优先既有 work config、自动主会话 config，否则当前默认值；初始化后不随全局设置变化。
2. 用任务级 set_task_permissions 命令按旧值比较保存，事务同步 work_tasks 和自动主会话；人工会话从任务权限初始化，后续保留独立权限。自动会话旧入口也同步回任务，避免两个配置源漂移。
3. 属性面板直接选择并显式保存；显示“每轮开始时使用已保存设置；当前执行不变”。只增加入口而继续在首次委托读取全局默认不符合创建时确定默认值的要求；全局覆盖历史执行也不符合本轮范围。
4. 每轮从同步后的 work config 启动，worker 持有启动时快照。Agent 子任务沿用父任务执行权限，不采用可能更宽的全局默认。

## Risks / Trade-offs

- 历史权限被放宽 → 优先迁入原执行配置，保留非预设组合。
- 保存时运行状态改变 → 只更改下轮配置，不停止或代答当前请求。
- 两个入口互相覆盖 → 任务旧值比较、会话 revision 保护，事务中同步自动会话与执行配置。

## Migration Plan

先通过真实 SQLite 回归，再全量测试及 Electron 构建；当前有实际执行时先准备更新包，切换前检查活动执行并按已有授权处理。新增字段旧版忽略；回退应用须暂停在途任务并核对实际效果。
