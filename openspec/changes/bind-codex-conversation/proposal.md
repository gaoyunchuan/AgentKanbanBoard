## Why

部分工作在 Codex 中开始，用户需要从全部任务绑定原会话并在本应用继续。现有半自动恢复只适用于已经登记的会话，缺少选择、绑定与历史阅读。

## What Changes

- 全部任务右键新增绑定 Codex 会话，支持搜索、活动/归档切换和分页。
- 绑定保持原 Thread 与目录；显示原消息与工具记录，历史按页读取并去重。
- 新绑定会话明确待交接，复用手动归档与恢复连接，完成前禁止发送。

## Capabilities

### New Capabilities
- `codex-conversation-binding`：外部会话选择、唯一绑定、历史阅读与交接接续。

### Modified Capabilities
无。

## Impact

涉及 Rust 会话仓储与服务、Codex 只读协议、任务菜单、绑定弹窗及历史组件。新增少量关联元数据，不复制 Codex 历史到 SQLite，不改任务状态，不自动创建 Turn；沿用本机 Electron 安装流程。
