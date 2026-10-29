## Context

现有 studio.css 多层覆盖，表单 31–42px 混用；原生 select 与项目/筛选自绘菜单风格分离。已有 Radix Select 可复用。用户进一步明确要求选择框与其它控件等高，展开列表也必须统一，直接落地；整改前证据见 docs/verification/2026-10-28-ui-consistency/audit.md。

## Goals / Non-Goals

**Goals:** 保留白灰蓝工作台骨架，统一 36px 表单/筛选、32px 紧凑操作、13px 控件、12px 辅助和 14px 阅读正文；建立共享选择组件和样式源，完成实际页面与 macOS 验收。

**Non-Goals:** 不改变业务生命周期、权限授权范围或默认值，不增加后端与依赖，不重做任务管理信息架构或引入主题切换。

## Decisions

1. 新建 StudioSelect，基于现有 components/ui/select（Radix），接受 options/value/onValueChange、id、aria-label、disabled、compact。所有 option 值映射为内部非空 key，兼容默认空值且不与真实值冲突。既有简单 Select 只修复列表可用高度、滚动和层级。
2. 新建控件 token/样式文件，在 studio.css 后导入；portal 使用双类作用域确保优先于入口后加载的 Tailwind 工具类；标准控件收敛到同一规则，移除被替代的重复尺寸定义，不仅继续叠加全局 !important。portal 使用独立 studio-overlay 类共享 token，避免继承 .studio 的整页宽高。
3. Modal 的键盘处理只处理属于自身的事件；选择列表 portal 的 Escape/Tab 交给 Radix，不能把关闭列表变成关闭业务弹窗。
4. Inspector 仅改变分组和排版，保持上下文草稿、任务切换 key、权限版本与原有操作。日期时间本轮统一输入外观、尺寸和状态，沿用当前 datetime-local 的时区、验证与显式保存；不额外引入日历业务功能。
5. 不做纯 CSS 补丁，因为无法统一原生展开列表；不全面换皮，因为本次目标是一致性与阅读效率。保留已有导航、任务树和白灰蓝语义色。

## Risks / Trade-offs

- portal 被 modal/滚动区遮挡 → 层级、边缘、滚动和 Escape 用浏览器及 macOS 实测。
- 空值、异步模型列表和旧策略丢失 → options 保留未知值；回归默认项、旧策略、CAS 和切回预设。
- 视觉收紧导致拥挤 → 同时验证宽窄两档，不通过缩小正文解决空间。
- jsdom 不实现指针捕获/滚动 → 仅测试环境补所需平台空实现；真实交互仍以浏览器和 APP 验收为准。

## Migration Plan

三批：共享选择组件并迁移所有 studio select；整理 token、属性分组及全页样式；全量检查、对比截图和真实 APP 安装。直接在 main 保留之前未提交改动。安装前核对正式活动执行，必要时仅询问具体中断授权。回滚为旧 app 副本，已有存储字段保持兼容。
