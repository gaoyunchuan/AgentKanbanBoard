## 1. 会话目录与绑定

- [x] 1.1 在 `codex_conversations.rs` 先写分页协议、候选过滤、唯一归属、目录/任务校验与不产生执行的失败测试，运行 `cargo test --offline --manifest-path src-tauri/Cargo.toml codex_conversations` 确认失败，再实现并通过。
- [x] 1.2 在 `WorkService::call` actor 外读取、actor 内绑定，新增幂等关联元数据与待交接发送/提取门槛；验证服务与恢复回归通过。

## 2. 绑定、历史与接续界面

- [x] 2.1 先写 `CodexBinding.test.tsx` 交互失败测试，再实现任务右键、冻结目标、搜索分页、重复定位、失败重试与演示数据，验证相关前端用例通过。
- [x] 2.2 先写历史分页去重、切换隔离与交接不发送的失败测试，再实现 `CodexHistory`、待交接提示和恢复入口；验证全部前端测试与构建通过。

## 3. 验证与本机交付

- [x] 3.1 完成全量测试、OpenSpec 严格校验和独立 review；证据保存到 `docs/verification/2026-11-04-codex-binding/`。
- [x] 3.2 检查未发送草稿与运行执行，正常退出、备份安装、签名与文件一致性检查、重启和真实界面验收，确认安装副本独立运行后清理可重建制品。
