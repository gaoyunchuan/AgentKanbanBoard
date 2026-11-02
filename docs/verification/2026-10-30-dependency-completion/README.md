# 已完成前置任务仍等待：验证记录

日期：2026-10-30。基线：`b6ec96d`，本次为 main 上未提交修改。

## 根因与修复

实际前置任务已完成，无资源租约，但 4 条交付记录都是 `phase / ready / usable=false`。旧依赖查询额外要求存在 `ready+usable` 结果，否定了人工确认的完成状态。

依赖判断统一读取业务完成状态，并继续检查任务及其人工会话的资源租约。Agent 自动完成前的提交、验收与执行结束约束保持原有逻辑；阶段结果不会被伪造为可用最终交付。

## 验收

| 场景 | 结果与证据 |
| --- | --- |
| 已完成人工任务创建过会话，无交付结果 | 回归通过；旧实现下失败 |
| 已完成任务只有阶段结果 | 回归通过；旧实现下失败，下游由 waiting 转 queued，快照缺失依赖为空 |
| 重新打开、取消、返工 | 下游恢复等待；新增回归及原有返工用例通过 |
| 执行仅结束、交付尚未验收 | 原有工作流和交付来源用例通过，任务不被误标完成 |
| 资源停止不确定 | 原有资源租约及原生命令停止用例通过，继续阻塞 |
| 真实数据首次读取、状态 API、重启 | release sidecar 在隔离副本通过，见 [isolated-replay.json](isolated-replay.json) |
| 正式数据与模型执行 | 隔离验证前后正式任务状态相同，未触发模型；不把隔离验证当成正式应用已生效 |

`make test` 退出码 0：Python 19 条、前端 18 文件 / 181 条、Rust 库 194 条及其他 2 条全部通过。`npm --prefix src-ui run build` 与 release sidecar 构建退出码均为 0。

`rustfmt --edition 2021 --check src-tauri/src/workflow.rs` 与 `git diff --check` 通过。全仓 `cargo fmt --check` 未通过，差异位于本次未修改的历史文件：`session_browser_driver.rs`、`akb_sidecar.rs`、`chat_store.rs`、`lib.rs`、`project_preferences.rs`、`work_runtime.rs`、`main.rs`。

过程日志位于本机 `/tmp/akb-dependency-{make-test,ui-build,sidecar-build,fmt,package}-20261030.log`。本次未修改前端布局，未增加数据库字段或迁移。

## 本机正式应用验证

更新前确认活动工作执行、活动聊天执行、资源租约均为 0。构建并安装 Electron 应用，保留旧应用备份；安装副本通过严格签名完整性校验，安装与构建 sidecar 的 SHA256 相同，见 [installation.json](installation.json)。

已重新启动安装目录下的正式应用，在“任务”页面搜索 `mini`。可访问性树与实际截图均显示：“网关文档发布及SDK对外发布”已完成，“接口调用示例代码及文档说明”进行中，标签为“1 项前置已就绪”。正式数据库只读查询确认下游不再等待 dependencies，见 [live-verification.json](live-verification.json)。下游按原有委派配置继续执行；其最终业务文档交付不属于本次依赖修复验证。
