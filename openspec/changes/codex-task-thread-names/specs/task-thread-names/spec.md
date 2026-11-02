## ADDED Requirements
### Requirement: 持久会话显式使用业务名称
系统 SHALL 在新建或恢复本应用的持久 Codex 会话后、首次发送本轮消息前，通过命名协议设置业务名称。自动任务使用当前任务标题，手动会话使用当前会话标题。

#### Scenario: 新任务首次执行
- **WHEN** 中文标题任务创建真实 Thread
- **THEN** Thread 的显式名称等于任务标题，Task ID 仍用于内部归属

#### Scenario: 旧会话恢复
- **WHEN** 已关联 Thread 的任务以最新名称继续执行
- **THEN** 在 Turn 前同步最新业务名称

### Requirement: 命名隔离与失败处理
系统 SHALL 跳过临时摘要及空名称；服务端拒绝命名时保留诊断并继续业务执行。

#### Scenario: 摘要提取
- **WHEN** 为结果提取启动 ephemeral Thread
- **THEN** 不发送命名请求

#### Scenario: 协议拒绝
- **WHEN** 活跃连接返回命名拒绝
- **THEN** 记录命名诊断且仍发送业务 Turn
