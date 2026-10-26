# 在自己的 Mac 上运行

本项目当前按个人本机使用提供开发构建，使用 **ad-hoc 签名**，不需要 Apple Developer 账号、签名证书或公证凭据。准备好 Node.js 22 与 npm、Rust stable、Python 3 和 Xcode Command Line Tools 后，后续更新只需在仓库中运行下面的命令。

## 构建并打开

先退出已经运行的 **Codex Thread Kanban**，再在已克隆的仓库根目录执行：

```bash
git pull --ff-only && make run-local
```

这个入口会编译并签名应用，用 `ditto` 安装到 **`~/Applications/Codex Thread Kanban.app`**，再用普通 `open` 启动安装好的副本。已有应用会先保存到独立命名的备份位置，路径会显示在输出中。应用采用当前 Mac 的架构，这条路径不生成 DMG，也不需要下载 CI 产物。

只构建和安装、不启动时使用 `make install-local`。安装后可直接从用户 Applications 文件夹打开应用，不需要每次重新编译。

开发调试也可以使用：

```bash
cd src-ui
npm exec tauri dev
```

启动应用后，再按[任务工作台指南](task-workbench.md#快速上手)连接本机 Codex。

## 需要可拷贝的 DMG 时

执行 `make build` 或 `make build-dmg`，产物位于：

```text
src-tauri/target/release/bundle/dmg/Codex Thread Kanban_0.1.0_<arch>_development.dmg
```

`<arch>` 对应构建机器的架构。旁边的 `.sha256` 记录最终文件的校验值，`.verification.json` 记录构建验证结果；它们不表示已经通过 Apple 公证。

## CI 开发制品是什么

GitHub Actions 的 **Build Artifacts** 上传 `codex-thread-kanban-development`。构建验证包括应用签名、DMG 完整性，以及只读挂载最终 DMG 后其中应用的签名。

该制品**未经 Apple 公证**。Ad-hoc 签名描述应用包的完整性，不证明开发者身份，也不保证浏览器下载后的应用会被每台 Mac 接受。Tauri 官方说明了[ad-hoc 签名的用途和限制](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing)。

旧提交 `8c9b3e9` 的打包入口使用 `--no-sign`，且没有验证最终 DMG 内应用的签名。那次 CI 成功证明了代码测试与打包成功，没有证明下载后的启动校验通过；排查时应使用修复后的构建产物。

## 遇到“已损坏”或无法打开

先确认提示针对的是哪个副本：用户 Applications 中新安装的应用、构建目录中的 `.app`、DMG 内的应用，还是系统 Applications 中的旧副本。下面的命令只读取本机安装副本的签名信息，不启动应用或改变安全设置：

```bash
kanban_app="$HOME/Applications/Codex Thread Kanban.app"
codesign --verify --deep --strict --verbose=2 "$kanban_app"
codesign --display --verbose=4 "$kanban_app"
```

本机构建预期可通过完整性验证，并显示 `Signature=adhoc`。如果验证失败，保留错误输出并重新构建；如果验证通过但仍被阻止，需要结合系统提示判断设备策略。仅凭对话框文字不能认定磁盘镜像物理损坏，Apple 的[应用启动提示说明](https://support.apple.com/zh-cn/102445)区分了多种情况。

如果“隐私与安全性”显示**设置由描述文件配置**，普通用户的允许入口可能已受限制。应向设备管理员确认是否允许本机开发应用；本机构建和 ad-hoc 签名不会改变这项限制。Apple 的[设备管理安全设置](https://support.apple.com/guide/deployment/security-payload-settings-dep61dc030/web)允许组织控制应用来源和用户能否自行允许应用。

这里不需要申请正式分发账号。包完整性由构建流程负责，受管理设备的允许范围由相应的组织策略决定。
