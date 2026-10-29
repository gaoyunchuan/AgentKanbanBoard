# Electron 正式外壳替换记录（2026-10-29）

## 替换内容

- 安装包已从 Tauri 切换为 Electron（desktop/），应用名与 bundle id 保持不变（Codex Thread Kanban / local.codex.thread-kanban）。
- Electron 主进程启动 Rust sidecar（akb_sidecar）复用原 WorkService、数据库与 Codex app-server 逻辑；渲染层加载现有 React UI。
- 侧边浏览器改由 WebContentsView 原生 Chromium 渲染；每个会话独立 persist 分区；Agent 通过本机 MCP 网关（session_browser）操作同一批页面。
- 保留旧安装为 backup；构建/安装入口 `python3 scripts/electron_local.py` 或 `make electron-local`。

## 已验证（安装版）

- 启动后加载真实数据：321+ 任务、7+ 会话、Codex 已连接。
- 侧边浏览器：打开会话 → 原生视图出现 → 地址栏导航 example.com，CDP 目标为 https://example.com/（Example Domain）。
- 聊天：新建会话选择 AgentKanbanBoard 项目，发送“回归冒烟：请只回复 OK”，生成新会话与 Thread，assistant 消息完成。
- 任务视图：树加载 322 任务；设置页显示“委托任务默认权限 = 完全访问”。
- 自动化：src-ui 181 项、Rust 193 项、Node 9 项、打包助手 19 项通过。

## 已知边界（仍需继续收敛）

- MCP 浏览器网关当前作用于“最近激活会话”；多任务并行时 Agent 可能操作到错误会话，需要按 task_id 绑定。
- 原生浏览器的拖拽/粘贴图片上传（upload_begin/chunk/finish）尚未迁移，文件选择上传与下载目录已实现。
- 权限确认弹窗、企业登录、系统级通知等尚未在 Electron 外壳做专项回归。
- Tauri 目录保留为后端库与旧外壳构建入口；DMG 打包仍走 Tauri 脚本，Electron 采用 electron-packager 开发制品。

## 安装位置

- 新版：~/Applications/Codex Thread Kanban.app（Electron）
- 旧版备份：~/Applications/Codex Thread Kanban.backup-5f90a42a-3ab0-43b0-9b78-65b219ecf887.app（Tauri）
