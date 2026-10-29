## Why

侧边浏览器每900ms截图，操作不流畅；会话工具还可能未接入自己的页面。用户在2026-10-29明确选择简洁方案：本地Docker运行一个或多个headless Chrome，每个会话绑定自己的页面列表，使用Vercel agent-browser streaming展示和操作。

## What Changes

- APP按需为会话启动独立Chrome容器；同会话的UI与Agent共用一个agent-browser session及同一CDP endpoint。
- 使用agent-browser WebSocket streaming替换截图轮询；APP保留地址栏、页面列表和基本导航。
- 复用现有APP后端管理会话归属、容器生命周期与本机工具/stream桥接，修复旧Thread接入。
- 完整Chrome profile和页面恢复信息bind mount到实际数据库目录，跨APP升级、Docker/容器重启保留。
- 只保留真实双向操作、多会话隔离、中文输入与文件、切换恢复、流畅度的验收。

## Capabilities

### New Capabilities
- `session-browser`: 本地Docker会话浏览器、页面管理、streaming交互和Agent工具接入。

## Impact

修改BrowserPane、browser_bridge、会话工具接入与本机Docker编排。保留Tauri/React及任务执行逻辑。替代此前完整云桌面方案；本轮不引入Selkies、远程Linux桌面、WebRTC/TURN、多租户云控制面或公网隧道。Docker结构保留未来迁至云主机的可能，当前交付以本机Docker为准。

用户已确认方案并追加持久状态要求，当前进入实施；不把文档校验当运行验收。
