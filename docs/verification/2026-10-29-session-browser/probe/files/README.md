# 中文文件上传失败诊断

结论：固定 headless-shell 镜像默认 `LANG=en-US.UTF-8`，该 locale 不存在。CDP 用中文路径调用 `DOM.setFileInputFiles` 时返回成功 `{}`，但页面 `input.files=[]`，不触发 input/change，FileReader 没有启动。容器启动明确设置 `LANG=C.UTF-8` 和 `LC_ALL=C.UTF-8` 后，同一个中文文件名与内容完整成功。

推荐产品修正：在 `dockerLaunchArgs` 添加上述两个环境变量，保留中文原文件名；继续检查页面可观测结果，不能把 CDP `{}` 当作业务上传成功。

## 真实执行与证据

1. [产品隔离诊断 trace](trace.json) 经过真实 Rust driver 的 `upload_begin/chunk/finish`。宿主产生 58 字节文件，文件在容器相同路径可见；容器 UID `502`，目录 `0700`、文件 `0600`。输入返回 `{uploaded:true}`，但页面无 file、无 input/change 事件、无 FileReader 结果。证明失败发生在 CDP 设置文件阶段，排除分块写入、挂载和 FileReader 自身失败。

2. 在相同页面直接 CDP 调用，原中文路径、`DOM.enable`、`backendNodeId` 三种方式都返回 `{}` 且 `files=[]`。将同一文件硬链接为 ASCII 名 `diagnostic.txt` 后，保持相同 objectId、命令和内容，立即产生 files、input/change、FileReader 及 `window.received`。这一步将差异缩到文件路径字符。

3. [单变量 locale 矩阵 trace](locale-trace.json) 创建三个独立容器，其他 Docker 参数与产品相同。每个容器都上传同内容的中文/ASCII 文件：

| 容器 locale | 中文 `剪贴板图片.png` | ASCII `ascii.png` |
| --- | --- | --- |
| 原镜像 `en-US.UTF-8` | CDP `{}`，`files=[]` | files/received 成功 |
| `C.UTF-8` | files/received 成功，中文文件名保留 | files/received 成功 |
| `en_US.UTF-8` | CDP `{}`，`files=[]` | files/received 成功 |

4. 镜像 `/usr/bin/locale -a` 实际只列出 `C`、`C.utf8`、`POSIX`；默认环境同时打印 `Cannot set LC_CTYPE ... No such file or directory`。因此 `en_US.UTF-8` 也不是可用替代，使用镜像已有的 `C.UTF-8`。

5. 诊断的 driver、容器和 fixture 均关闭，没有使用 `--hold`。没有修改产品脚本、manager、Rust 实现或共享 fixture。本目录证明根因与修正方向，产品回归结果由主验收记录补充。

## 复现

```sh
node scripts/session_browser_probe/files-diagnostic.mjs
node scripts/session_browser_probe/files-locale.mjs
```

前者要求已编译的产品隔离 driver；后者直接创建精确归属的 Chrome 容器。locale 矩阵显式覆盖三个值，即使产品默认值已修正，仍保留旧值作为失败对照。两脚本只操作自己的临时数据库与容器。

三个需要保留的边界：修正 locale 不能替代上传后文件/字节验证；本次只证明该固定 arm64 镜像，不代表其他镜像 locale 相同；拖入和粘贴也使用文件路径，但仍需产品各入口分别回归。

## 下载路径未落盘的第二个根因

产品 input/drop/paste 修正 locale 后通过，下载出现“fixture 已收到 GET，但数据库旁没有文件”。[下载单变量 trace](download-trace.json) 使用真实产品 driver、同一个 owner/container/fixture，对比结果如下：

| 下载配置 Browser CDP 连接 | 点击结果 | 宿主 downloads |
| --- | --- | --- |
| `setDownloadBehavior` 返回后关闭 WS | fixture GET 成功 | 空 |
| 保持配置 WS，期间仍由产品 CLI 点击 | fixture GET 成功 | `browser-download.txt`，内容 `browser-download-evidence` |
| 再关闭该 WS 后点击 | fixture GET 成功 | 再次为空 |

**确切原因是下载配置连接被关闭，设置被撤销；不是 CLI 每次操作改回默认目录。** Chromium 的 `BrowserHandler::SetDownloadBehavior` 将 override handle 存在该 handler 中，`Disable()` 会清除 `download_behavior_overrides_`。实测与该生命周期一致。

最小修正是由当前 owner 持有一条固定 browser endpoint 的下载 CDP 连接：初始化配置 `/data/downloads`，持续保留到该 Chrome 关闭，并在 owner 清理时关闭。不能继续使用 `withCdp` 的操作后自动关闭，也不能沿用 10 秒短操作连接定时器。无需重做文件传输或下载架构。

固定 agent-browser 0.40.0 能力核对：

- `--download-path` 和 `AGENT_BROWSER_DOWNLOAD_PATH` 真实存在。
- `BrowserManager::connect_cdp_inner` 将 `download_path` 初始化为 `None`；CDP attach 的 actions 分支没有把 launch options 的 download_path 赋回 manager。不能假定设置 env 即可覆盖外连容器 Chrome。
- `download <selector> <path>` 会在 **agent-browser 宿主**执行 `create_dir_all`、canonicalize，再将该路径发给远端 Chrome；本产品宿主数据库路径与容器 `/data/downloads` 路径不同，不能直接套用这个命令来解决普通页面点击下载。
- `wait --download` 对 CDP 连接不会把远端保存路径当作可信宿主文件来移动。这与容器 bind mount 后由 APP 管理下载目录的方式相符。

下载诊断脚本为 `node scripts/session_browser_probe/downloads-diagnostic.mjs`，创建自己的隔离数据库和精确容器并在 finally 关闭。证据只验证上述生命周期；产品修复后的回归由主验收记录补充。

源码：[固定 0.40.0 browser.rs](https://github.com/vercel-labs/agent-browser/blob/v0.40.0/cli/src/native/browser.rs)、[固定 0.40.0 actions.rs](https://github.com/vercel-labs/agent-browser/blob/v0.40.0/cli/src/native/actions.rs)、[Chromium BrowserHandler](https://github.com/chromium/chromium/blob/main/content/browser/devtools/protocol/browser_handler.cc)。
