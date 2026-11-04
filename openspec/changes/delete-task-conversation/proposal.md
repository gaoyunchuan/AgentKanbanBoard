## Why
误建的人工会话无法独立删除，现有收起功能仍保留在完成分组，任务内会话下拉也没有管理入口。

## What Changes
- 任务内下拉每行提供会话菜单，侧栏同步删除入口。
- 人工会话软删除、确认、恢复；消息、任务、结果来源保留。
- 自动主会话、运行及提取中会话禁止删除；删除当前会话后合理导航。

## Capabilities
### New Capabilities
- `conversation-deletion`: 人工会话独立删除与恢复。
### Modified Capabilities
无。

## Impact
React 会话入口、弹窗、导航、隔离演示；Rust 会话持久化与服务；SQLite 新增可空删除时间。不新增依赖。本机安装验收，不提交推送。
