# Codex 任务会话名称验证

## 结果

显式命名已接入自动任务和手动会话；恢复时使用当轮业务名称。4 个历史关联任务会话已通过受支持的 Codex 标题接口更名，并通过 read_thread 回读确认，见 `renamed-threads.json`。

## 验收证据

| 场景 | 结果与证据 |
| --- | --- |
| 原始缺陷 | `regression-red.log`：预期 1 次命名请求，实际 0 次，断言失败 |
| 新建中文任务、恢复并更新名称 | `focused-final.log`：请求目标 Thread 和名称精确一致，且先于 turn/start |
| 临时摘要和空名称 | 同测试断言无命名请求 |
| 命名被拒绝 | 同测试模拟真实协议错误，业务仍进入 Turn |
| 业务层传参 | `rust-tests.log`：工作流子进程要求每个持久 Thread 在 Turn 前带名称，覆盖自动和手动入口 |
| 完整 Rust 回归 | 205 个库测试、1 个主程序测试、1 个集成测试通过，共 207 项 |
| 协议实测 | 应用实际使用的内置 Codex：thread/start → thread/name/set 中文标题成功 → thread/archive 成功；验证 Thread 为 `01a18c02-0300-77a2-8697-eb6145650595`，没有启动模型 Turn |
| 构建与规格 | Release sidecar、UI 构建及 OpenSpec strict 验证通过 |
| 独立审查 | 只读审查命名增量，未发现缺陷；复跑新增测试通过 |

## 范围与限制

- 旧会话处理仅限应用数据库关联的 4 个执行 Thread，未修改未关联的 Codex 聊天。
- 恢复时业务标题作为名称来源，会覆盖在 Codex 中单独修改的同一会话名称；符合任务名称同步的本次要求。
- 名称协议拒绝只记录诊断；若连接本身超时失效，仍遵循原有保守恢复规则，不因命名绕过连接失败。
- 全仓 cargo fmt --check 仍报告既有 minified 文件格式差异（例如 examples/session_browser_driver.rs）；本轮新增方法和命名测试已局部 rustfmt，git diff --check 通过。
- 全量回归之后只做了局部代码格式整理，聚焦命名测试与 Release 构建再次通过；未运行真实业务任务来验证命名，以免触发额外业务操作。

安装重启与清理结果见 installation.json、cleanup.json。
