## Why
任务列表不应展示会话工具，当前available包含tasks视图导致右栏与顶栏按钮占用空间。

## What Changes
- 右侧工具栏和内容区仅在conversationVisible时启用。
- 非会话工具请求明确提示并忽略，不在返回会话时重放。
- 保持工具挂载与展开状态，任务列表的固定任务属性继续显示。

## Capabilities
### New Capabilities
- `conversation-tools-scope`: 工具只在会话可见。

## Impact
前端可用性门控及回归，不改变工具资源生命周期和业务执行。
