## ADDED Requirements
### Requirement: 一次性 RPC 必须释放所有临时资源
系统 SHALL 在对应响应完成、协议错误、断流、超时和子进程终止时释放socket、计时器、pending及接收缓冲，不依赖下一次广播触发清理。

#### Scenario: 连续读取历史
- **WHEN** 多次读取大段会话记录
- **THEN** 完成请求的连接归零，响应不随请求数累计保留

#### Scenario: 服务端半关闭
- **WHEN** 服务端持有写端克隆且没有发送FIN
- **THEN** 客户端仍主动销毁本次RPC连接

### Requirement: 后端连接注册跟随原连接
系统 SHALL 在serve退出时立即移除对应广播writer。

#### Scenario: 请求完成后没有新事件
- **WHEN** 原连接断开且没有后续广播
- **THEN** 注册表已移除此连接

### Requirement: 异常与资源背压有界且不重放
系统 SHALL 限制16个在途RPC、32MiB累计响应、120秒启动/请求期限；启动前error、exit、close均结束等待。超限或失败 SHALL 返回可解释错误且不自动重放业务操作。

#### Scenario: 端口发布前启动失败
- **WHEN** spawn发出error但没有exit
- **THEN** 已有及后续调用都及时拒绝

#### Scenario: 分块与状态通知
- **WHEN** 响应被拆成多段并穿插状态通知
- **THEN** 仅匹配本请求ID的完整响应可以完成本次调用
