# workspace routing discovery failed 排查与恢复

日期：2026-10-30，时间按 Asia/Shanghai。

- 目标任务：接口调用示例代码及文档说明，`task-30605-1793256079009962000-2`。
- 14:34、14:36 两轮执行在 Codex 模型请求阶段失败，每次重连 5 次后返回 `workspace routing discovery failed`；本轮没有模型回复或工具操作。
- Codex 本地日志同时记录 ChatGPT 插件目录、MCP 初始化和遥测连接失败，HTTP 日志为 `is_connect=true`。失败来自上游网络连接层；尚未证实具体是网络波动、代理、DNS 或其它连接原因，不能据此修改代理或认证配置。
- 排查时原运行时与独立子进程的账户额度查询均成功；独立子进程直连与使用现有系统代理均成功。因此没有改动全局配置、代理、凭证或应用代码。
- 独立临时只读 Thread 使用同一 Codex 程序、同一模型，真实返回 `NETWORK-OK`，`turn.status=completed`。仅做诊断，没有调用工具；该结果不代表业务文档已完成。
- 原任务通过界面“核对后继续”恢复。新执行 `run-18e33b94fafe8460-3` 在 14:43:16 收到模型回复，14:43:21 开始调用 `session_browser`，`last_error=null`。
- 当前任务保存的权限为 `workspace-write + on-request`，停在有效的工具确认请求。没有代替用户批准、扩大权限或将任务标记完成。

证据：[结构化记录](evidence.json)、[恢复后的界面](recovered.png)。原问题在本次验证中已恢复，不能据此保证外部网络不再中断。
