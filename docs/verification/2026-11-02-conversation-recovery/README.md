# 半自动恢复会话连接验收

## 范围

用户在 Codex 手动归档目标会话；Kanban 负责打开原 Thread、恢复归档、接续连接。恢复只管理连接，不发送业务消息、不复制历史、不改变任务状态。

## 自动化证据

- `npm --prefix src-ui test`：29 个测试文件、247 项通过。
- `cargo test --offline --manifest-path src-tauri/Cargo.toml`：全量通过。
- `openspec validate recover-codex-conversation --strict`：通过。
- `rustfmt --edition 2021 --check` 检查本次后端文件：通过；`git diff --check`：通过。
- 隔离 app-server 实测写锁释放序列：持有者归档、独立连接恢复归档并 resume 成功；恢复连接流程不调用 `turn/start`。

## 原生验收

- 安装路径 `/Users/gaoyunchuan/Applications/Codex Thread Kanban.app`，`codesign --verify --deep --strict` 通过；旧版独立备份保留。
- 安装副本与构建产物的 `akb_sidecar` SHA-256 一致；前端只保留当前 `index-*.js`，无旧 hash 残留。
- 原会话菜单显示“恢复会话连接”；已完成且关闭的人工会话会提示先重新打开会话，避免恢复动作隐式改写任务完成状态。
