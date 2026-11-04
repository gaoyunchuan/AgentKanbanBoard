## Why

右侧工具区在最后一个标签关闭后仍占用空间；GUI 启动的终端缺少稳定 UTF-8 locale 与中文显示字体；Markdown 文件仅以源码显示，阅读体验与会话结果不一致。

## What Changes

- 最后一个右侧标签关闭后隐藏工作区，并保留顶部工具快捷入口。
- 终端显式设置 UTF-8 locale，xterm 增加 macOS/Windows/Linux 的 CJK 字体回退。
- `.md` 与 `.markdown` 文件默认渲染 Markdown，并提供源码切换。

## Capabilities

### New Capabilities
- `workspace-tool-readability`: 管理右侧工具收起、终端中文和 Markdown 文件阅读。

### Modified Capabilities
无。

## Impact

仅影响右侧工具前端和工作终端启动环境；不改变 Agent 调度、任务状态、文件内容或终端权限。
