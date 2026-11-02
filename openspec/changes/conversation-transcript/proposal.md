## Why
会话工具调用平铺卡片使正文难读；当前渲染丢失阶段信息、本地Markdown链接不显示、Mermaid仅显示源码。

## What Changes
- 连续工具调用合并为无边框文本行，默认收起，图标/颜色区分类别，点击逐层查看具体调用。
- 保留协议commentary/final_answer，执行中显示过程，结束折叠为Worked for时长，分隔线下保留结果。
- Markdown标准解析，支持网页和本地链接；Mermaid惰性渲染为安全SVG图片。
- 会话正文保持文本行，无输入框式边框，命令展开内容才有细边界。

## Capabilities
### New Capabilities
- `conversation-transcript`: 分层会话阅读与富文本。

## Impact
前端事件投影、ChatSurface及Markdown组件，工作区链接打开；不改变任务状态和后端执行权限。
