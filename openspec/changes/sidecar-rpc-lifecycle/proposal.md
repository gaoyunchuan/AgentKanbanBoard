## Why
正式应用多次 V8 OOM 崩溃。本地 RPC 使用半关闭 socket，后端保留广播 writer，导致已完成请求及响应随连接累积。

## What Changes
- RPC 成功和各类失败都主动销毁连接、清除等待与缓冲，不重放业务。
- 后端广播 writer 跟随原连接作用域回收。
- 启动失败、子进程退出、断流、超时和超量响应快速结清，限制在途与缓冲。

## Capabilities
### New Capabilities
- `sidecar-rpc-lifecycle`: 本地 RPC 连接及响应生命周期。

## Impact
Electron 本地传输和 Rust sidecar 广播连接注册；无数据库迁移，不改变任务验收及 Agent 并发规则。
