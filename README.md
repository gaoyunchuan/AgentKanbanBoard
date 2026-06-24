# Codex Thread Kanban

## 本地构建

在仓库根目录执行：

```bash
make build
```

该命令会安装前端依赖，并通过 Tauri 构建 macOS dmg 安装包。生成路径：

```text
src-tauri/target/release/bundle/dmg/
```

如需先运行校验：

```bash
make test
```

## GitHub 自动构建

仓库包含 GitHub Actions workflow：

```text
.github/workflows/build-artifacts.yml
```

触发方式：

- 推送到 `main`
- 创建或更新 Pull Request
- 在 GitHub Actions 页面手动执行 `Build Artifacts`

workflow 会在 macOS runner 上运行测试，构建 dmg，并上传名为 `codex-thread-kanban-dmg` 的构建制品。
