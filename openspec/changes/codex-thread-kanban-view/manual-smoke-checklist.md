# Codex Thread Kanban View 手工 Smoke Checklist

- [ ] 应用启动：Tauri 窗口可打开，首屏进入“全部活跃 Threads”。
- [ ] 初始同步：点击“同步”后列表保持可见，本地人工字段不被清空。
- [ ] 项目注册：进入“项目”，可新增项目、编辑名称/路径/origin URL、启用或禁用项目。
- [ ] 项目识别：cwd 命中项目路径时显示对应项目；无法命中时进入 Unknown/未分类路径。
- [ ] 状态映射：running/waiting approval 显示为运行中；完成并稳定后进入待审核；已审核和已归档不会被普通同步覆盖。
- [ ] Running 聚焦视图：只展示运行中 thread，waiting approval 项优先。
- [ ] Review Pending 聚焦视图：只展示待审核 thread，并可标记已审核或归档。
- [ ] 筛选：项目、类型、Sprint、状态、显示归档可以组合过滤。
- [ ] 字段编辑：展开列表行或看板卡片后，可编辑 task type、module、sprint、notes。
- [ ] 归档行为：归档后默认活跃视图隐藏；归档视图可恢复。
- [ ] Codex deep link：Open in Codex 使用 `codex://threads/<thread-id>`；Open Project 使用 `codex://new?path=<encoded_project_path>`，带 promptTemplate 时追加 prompt。
