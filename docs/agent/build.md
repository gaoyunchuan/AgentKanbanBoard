# Build

## Current Knowledge

- macOS 安装包使用 `make build` 构建；该目标先执行 `npm --prefix src-ui ci`，再运行 Tauri release 构建，最后生成 `src-tauri/target/release/bundle/dmg/Codex Thread Kanban_<版本>_<架构>.dmg`。
- `src-ui/package-lock.json` 的 `packages` 中每个非根节点都必须包含非空 `version`。Tauri CLI 的可选平台包应记录为带完整版本、下载地址、完整性、CPU 和 OS 条件的顶层节点；残缺的 `node_modules/@tauri-apps/cli/node_modules/...` 节点会导致 npm 11 的 Arborist 报 `Invalid Version`。
- 修复或重建锁文件时，先用 `npm --prefix src-ui install --package-lock-only --ignore-scripts`，审查依赖版本差异，再依次运行 `npm --prefix src-ui ci` 和 `make build`。macOS 上使用 `hdiutil verify <dmg>` 校验最终镜像。

## Update Notes

- 2026-08-05: 记录 macOS DMG 构建链路、npm 锁文件完整性约束和验收命令。
