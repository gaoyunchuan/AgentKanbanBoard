## Why

工作台的原生下拉、自绘菜单及多轮 CSS 覆盖造成控件大小、字体和展开列表不协调。用户要求直接统一下拉触发器与展开列表，并整体改善页面的一致性和品味。

## What Changes

- 使用已有 Radix Select 提供统一的工作台选择组件，覆盖任务筛选、状态、验收、项目、模型和权限设置；触发器与相邻表单等高，展开列表统一样式。
- 收敛控件、字号、颜色、圆角与间距；整理任务属性分组，改善窄窗口布局。
- 保留选择值、权限版本保护、业务状态、时间转换和显式保存行为；验证鼠标、键盘、弹窗层级、长列表与真实 macOS APP。

## Capabilities

### New Capabilities

- `workbench-control-consistency`：统一控件外观、选择交互、层级与响应式验收。

### Modified Capabilities

无既有业务规格变更。

## Impact

涉及 src-ui 的 studio、components/ui/select 与测试；复用现有依赖，无后端或数据库迁移。保持 main 开发，保留已有未提交修复，不自动提交或推送。
