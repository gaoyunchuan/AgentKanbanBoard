# 右侧工具、终端中文与 Markdown 预览验收

## 自动化

- 前端全量：29 个文件、250 项测试通过。
- 后端全量：通过。
- `openspec validate improve-workspace-tools --strict`：通过。
- 本次修改的 Rust 文件 `rustfmt --check` 与 `git diff --check`：通过。

## 真实桌面

- 终端实际输出“中文终端测试”；环境为 `LANG=en_US.UTF-8`、`LC_CTYPE=en_US.UTF-8`。中文字符作为 UTF-8 字节完整回读。
- 打开 `docs/deploy/cmp-customer-guide/客户版正文.md`，右侧显示一级至三级标题、代码段，并提供“查看 Markdown 源码”。
- 关闭唯一终端标签后，右侧工作区和标签栏隐藏，顶部保留“打开右侧工具”。
- 安装副本签名通过，后端二进制与构建产物一致，旧 UI hash 文件未被带入。
