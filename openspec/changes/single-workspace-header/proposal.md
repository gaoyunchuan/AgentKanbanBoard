## Why

窗口原生标题、应用品牌条和页面工具栏叠加，浪费垂直空间。用户明确要求类似 Codex 的单层 header，承载标题与较多操作。

## What Changes

- 合并为全窗口唯一顶栏，保留侧栏开关、当前页面标题和上下文操作。
- macOS 原生窗口按钮嵌入同一高度，标题栏留白可拖动，操作按钮可点击。
- 页面内容不再重复渲染工具栏；长标题省略，窄窗口操作保持可达。

## Capabilities

### New Capabilities
- `single-workspace-header`: 跨页面单层窗口工具栏与窗口控制。

### Modified Capabilities

无。

## Impact

Electron 窗口选项与 preload 的平台标识，React 工作区顶栏、页面头部及其样式。无数据库或业务状态变更，保留本会话任务权限改动。
