## Why
任务会话缺少显式名称，Codex 将提示首行 `Task ID:` 展示为最近会话标题，用户难以辨认。

## What Changes
- 创建及恢复持久会话时，首轮消息前使用 `thread/name/set` 设置业务名称。
- 自动任务用任务标题；手动会话用会话标题；临时摘要不写名称。
- 命名拒绝记录诊断并继续业务；本次将应用关联且未命名的旧任务会话修正为任务名。

## Capabilities
### New Capabilities
- `task-thread-names`: 显式同步 Codex 会话名称。

## Impact
仅后端启动配置及协议调用，无数据库迁移，不改变任务权限和完成判定。
