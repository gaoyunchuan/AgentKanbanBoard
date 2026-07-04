# Known Errors

## Current Knowledge

### Thread Kanban 看板窗口间歇性消失

- 场景：前台渲染关键路径或高频轮询路径直接等待重同步。
- 现象：看板间歇性消失，Codex Desktop 窗口随之变宽；稍后看板恢复。
- 根因：UI 渲染/刷新链路等待同步式外部数据同步、扫描或重建完成；本例是 `useBoardData` 定时器等待 `sync_codex_threads()` / `refresh_board_data(true)`。
- 处理：同步改为 `start_codex_sync()` 后台 `spawn_blocking` 单飞执行；`load_board_data()` 只做只读加载。
- 经验：凡是会影响前台渲染、窗口布局或周期刷新的路径，都不能同步等待重同步；同步式强制同步只适合显式入口、离线任务或非渲染关键路径。

## Update Notes

- 2026-07-04: 沉淀 Thread Kanban 间歇性消失问题的症状、定位边界和最终修复约束。
- 2026-07-04: 按 `/learn` 新版错误知识格式，将记录整理为独立小章节并补充可复用经验。
- 2026-07-04: 压缩错误记录，只保留问题本质和可复用经验。
