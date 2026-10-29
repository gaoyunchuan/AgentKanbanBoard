# 会话浏览器阶段 0 探针

使用固定 `agent-browser 0.40.0` 原生 sidecar 和固定 chromedp/headless-shell 镜像，验证两个真实 Chrome 容器、共享 session 的 CLI/stream、完整 profile 持久化和宿主开发页连接。本目录只含依赖准备和探针，不替代 APP 产品验收。

## 准备依赖

```sh
python3 scripts/session_browser_probe/prepare.py
```

默认写入仓库 `.build/browser/`，不更新全局 CLI。`agent-browser` 从锁定 npm 包中只提取当前平台原生文件；先验证整个包 SHA512，再验证文件 SHA256。默认使用 npm 镜像下载相同固定内容，可加 `--official-npm` 使用官方 registry。已有包可加 `--npm-tarball /绝对路径/agent-browser-0.40.0.tgz`。

Chrome 先按固定 config ID 检查本机缓存。未命中时，宿主下载固定 manifest/config/layers，每个对象都验证 SHA256，再生成 Docker archive 并 `docker load`。这条路径用于 Docker daemon 外网 DNS/大文件下载异常而宿主网络可用的环境。加载后仍核对镜像 config ID；不需要重启 Docker Engine。仅当前平台有真实运行证明，其他平台的内容摘要已经锁定，运行兼容性需在目标系统验收。

依赖锁见 [runtime.json](runtime.json)。准备结果另写 `.build/browser/runtime.json`，其中 `binary` 是本机绝对路径，`chrome.configId` 可直接作为 `docker run` 的不可变镜像引用。无网时已验证缓存可直接复用。

## 执行真实探针

```sh
PROBE_AGENT_BROWSER="$PWD/.build/browser/agent-browser" node scripts/session_browser_probe/probe.mjs
```

默认创建 `/tmp/akb-bp-<随机ID>/test.sqlite` 作为隔离数据库父目录标记；完整 profile 位于同目录的 `session-browser/<owner>/profile`，权限 `0700`，页面恢复信息位于 `pages.json`。`test.sqlite` 仅是路径标记，本探针不调用产品数据库。

宿主系统需 Node 24+（探针依赖原生 WebSocket）及 Python Pillow（帧像素核验）。本机默认 Pillow 解释器使用 Codex bundled runtime，可通过 `PROBE_PYTHON` 覆盖。`PROBE_ROOT`、`PROBE_EVIDENCE`、`PROBE_CHROME_IMAGE` 可覆盖默认值；目录/容器名称必须保持本次运行独占。

探针正常或失败退出都会关闭精确 session、停止并删除自己创建的容器。保留隔离 profile、页面 manifest、trace 和 JPEG 供复核；不会清理用户已有 Docker 资源。每次运行应指定新的 `PROBE_EVIDENCE` 防止覆盖上次证据。

## 固定协议

- Docker：非 root `--user <宿主UID>:<宿主GID>`，profile bind mount，`--memory 2g --cpus 2 --shm-size 256m`。`-p 127.0.0.1::9222` 仅发布宿主回环。镜像 entrypoint 的 socat 将容器 `9222` 转发到 Chrome 回环 `9223`；不挂 Docker socket。
- CLI：仅子进程 `HOME=<数据库父>/agent-home`、`AGENT_BROWSER_SOCKET_DIR=<短运行目录>`、`AGENT_BROWSER_CONFIG=<明确JSON>`。`AGENT_BROWSER_SOCKET_DIR` 不改变 restore-state 目录；状态仍通过子进程 HOME 隔离。主 APP 的 HOME 不改变。
- 所有命令通过 `--session <name> --json batch --bail --omit-command`，stdin 写二维 argv JSON。禁止将网页输入拼为命令字符串；`--cdp http://evil` 文字填入测试已经通过。
- 批量结果：`[{index,success,result,error}]`；`result.tabs[]` 包含 `targetId/tabId/label/title/url/type/active`。切页用真实 `targetId`。
- stream：`ws://127.0.0.1:<stream status.port>/?pacing=ack&maxFps=30`；帧 `{type:"frame",seq,data,metadata}`；最终绘制端发送 `{type:"ack",seq}`。键盘 `input_keyboard/eventType:"char"/text`；鼠标 `input_mouse/eventType:"mousePressed"|"mouseReleased"/x/y/button`。
- 切页关闭旧 WS，等待 CLI 切页完成，再建新 WS。v0.40.0 上游源码在 CDP session 变化时清 frame 缓存；真实红→蓝页面首帧颜色证明了本次切换。旧 WS 的迟到回调仍需产品 epoch 拒绝。

## 三个实际限制

1. headless-shell 未恢复原生页签；由数据库旁 `pages.json` 恢复 URL，完整 profile 保留 Cookie/localStorage/IndexedDB。URL 恢复不代表未提交表单和内存 JS 状态恢复。
2. 镜像在容器内使用 `--no-sandbox`，本探针未改变宿主安全设置。仍需产品限制容器资源、宿主端口和 owner 路由，不能把调试端口公开。
3. 本探针不含 Tauri、真实模型、系统输入法、文件传输或整个 Docker Engine 重启。它们需要各自 APP 入口验收；不能用本探针的 CLI/stream 成功代替。

参考：[官方 streaming 协议](https://agent-browser.dev/streaming)、[固定 v0.40.0 stream 绑定实现](https://github.com/vercel-labs/agent-browser/blob/v0.40.0/cli/src/native/stream/mod.rs)、[固定版本 CLI 批量实现](https://github.com/vercel-labs/agent-browser/blob/v0.40.0/cli/src/main.rs)。
