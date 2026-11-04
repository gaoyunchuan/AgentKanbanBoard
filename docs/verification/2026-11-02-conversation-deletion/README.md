# 人工会话删除交付验收

2026-11-02 已完成本机安装、重启与桌面现场验收。入口为任务内会话下拉每行的「⋯ → 删除会话」，会话侧栏菜单同步提供；任务页及设置的「已删除」可以恢复。

## 行为与验收

| 场景 | 结果与证据 |
| --- | --- |
| 误建人工会话删除 | 原生安装副本打开验收会话 B 的下拉菜单，确认框展示 B，确认后自动显示 A |
| 恢复会话 | 原生「已删除」窗口分任务/会话，B 展示所属任务；恢复后窗口显示暂无已删除会话，任务行重新显示 A/B |
| 侧栏入口 | 原生会话侧栏 B 的菜单显示「删除会话」，与下拉复用同一组件 |
| 任务与执行保护 | 隔离库最终为 1 任务、2 会话、0 chat_runs、0 work_runs；见 installation.json |
| 主会话、排队、提取与资源保护 | 仓储、组件与服务回归覆盖；停止窗口测试先复现失败再修复 |
| 历史、结果、草稿与取消 | ConversationDeletion.test.tsx 及 chat_store::tests::conversation_deletion_* 覆盖 |
| 正式数据库恢复 | 新版进程从用户 Applications 启动，正式任务数 324；见 formal-restart.json |

原生验收通过 cua_repl 在安装目录副本操作，使用 `/tmp/akb-conversation-deletion-20261102/fixture.sqlite`，没有发送消息、调用模型或删除真实会话。菜单截图已在会话中展示；仓库记录不包含用户页面截图或凭据。

## 自动验证

- 前端：28 文件、245 测试通过，frontend-tests.log。
- Rust：210 库测试和 3 个其他目标测试通过，backend-tests.log。
- Electron：13 测试通过，electron-tests.log。
- 安装助手：19 测试通过，installer-tests.log。
- release sidecar 隔离 RPC 验证删除、旧发送拒绝和恢复不执行，release-rpc.json。
- OpenSpec 严格校验及 git diff --check 通过。
- 完整 cargo fmt --check 存在 HEAD 原有格式差异，format-baseline.txt 已独立检查未修改 HEAD；未将无关文件的格式变化混入本次改动。新模块按 rustfmt 格式编写。
- 后端重复验证中，既有 `browser_state::tests::lease_excludes_second_user_and_releases_without_deleting_state` 曾有一次释放后取锁断言失败；单独重跑与最终全套均通过，未修改该代码，根因未确认。保留 browser-lease-recheck.log，不将该波动描述为已修复。

## 安装、重启与数据保全

采用 scripts/electron_local.py 的 build_ui、build_sidecar、package_app、install 流程。完整构建和 ad-hoc 签名校验后，等待用户正在进行的真实业务执行结束，点击原生窗口关闭按钮正常退出旧应用，再安装。

预检期间发现用户未发送输入，已暂存；随后用户自行发送且完成业务执行，因此未将已发送内容重复恢复为草稿。原数据与浏览器状态保留，没有重放业务。

安装路径：`~/Applications/Codex Thread Kanban.app`。旧版独立备份：`~/Applications/Codex Thread Kanban.backup-11761958-41b7-4ad1-8bb5-60e1c21b6541.app`。

签名通过 codesign --verify --deep --strict，类型为 adhoc。65 个前端资源与构建副本逐项 SHA-256 一致，后端与 release 产物一致，main.js 与源码一致。详见 installation.json、signature.txt、install.log。隔离原生验收完成后正常关闭，再用普通 open 启动正式数据副本。

确认没有构建进程或构建目录程序依赖后，清理 src-ui/dist、desktop/ui、desktop/dist-electron、src-tauri/target，保留安装副本、旧版备份、用户数据及证据，详见 cleanup.json。

## 限制与回退

- 仅空闲人工会话可删除；自动主会话保留执行历史。删除是可恢复的软删除，不回收消息占用的存储。
- 草稿恢复仅覆盖当前应用进程内的删除/恢复；本功能没有新增跨重启草稿持久化能力。
- 数据库迁移仅新增 nullable deleted_at，旧数据保持可读。旧版应用不识别墓碑，回退后可能重新显示已删除会话；不会丢失历史。优先使用新版「已删除」恢复。
- 未提交、未推送、未远程发布。
