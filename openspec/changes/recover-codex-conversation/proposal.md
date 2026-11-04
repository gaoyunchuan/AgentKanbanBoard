## Why

Codex 持有会话写锁时，Kanban 恢复原 Thread 被拒绝。用户已选择半自动方案：自行在 Codex 归档，Kanban 提供定位、恢复归档和接续入口。

## What Changes

- 会话菜单和失败提示提供“恢复会话连接”。
- 引导打开原 Codex 会话并手动归档，确认后恢复原 Thread，不自动发送消息。
- 冻结恢复目标，拒绝活动执行、资源未释放、版本变化和并发恢复；恢复失败允许重试。
- 写锁冲突保留具体错误，不因此关闭其他会话共用的 app-server。

## Capabilities

### New Capabilities
- `conversation-connection-recovery`: 半自动恢复被外部持有的会话连接。

### Modified Capabilities
无。

## Impact

涉及会话菜单、恢复弹窗、工作服务调度和 Codex 协议。新增操作不执行归档，不使用辅助功能，不终止 Codex，不复制会话，不改变任务完成状态。
