# 本地Docker会话浏览器验收

## 边界

真实入口为APP面板和本会话Agent工具；经过真实会话路由、本机桥、agent-browser、Docker Chrome，断言页面内容、target、文件和可见画面。使用隔离APP bundle/数据库、两个独立浏览器容器和确定性fixture；不访问正式业务页面或个人浏览器资料。

fixture含每次随机标记、Cookie、中文表单、选区、拖拽、上传/下载哈希、弹窗、第二页与动画。逻辑回归可用Vitest/假协议；核心双向链路必须用真实容器/agent-browser，真实模型接入单列验证，不把模拟响应当通过。

## 阶段0：先证明三件事

| ID | 操作与必须证明的结果 |
| --- | --- |
| G01 固定依赖 | 固定Docker镜像、agent-browser sidecar版本；在目标macOS与Linux Docker启动Chrome、显式CDP连接；无个人profile/通用浏览器发现 |
| G02 stream契约 | 实际验证来源校验、最终端ACK/maxFps、输入、tabs/URL及切页后帧目标；Tauri WKWebView可经薄桥接工作。缺目标字段不能给旧帧贴标签冒充正确 |
| G03 本机开发页 | 容器打开宿主127.0.0.1开发服务；核对HTTP/重定向/Cookie、WS/HMR、上传，记录确切可复现的宿主路由/有限端口转发 |

## 核心用例

| ID | 用户场景与步骤 | 必须断言 |
| --- | --- | --- |
| B01 人打开→Agent读取 | A面板开两个随机标记页面，让A Agent列页并读取其中一个 | target/URL与面板一致，标记来自页面而非提示词，未访问其它浏览器 |
| B02 Agent操作→人看见 | A Agent填表、点击并新建/切换/关闭页 | DOM、fixture提交、面板画面及页面列表一致；一次操作不重复执行，未另起Chrome |
| B03 双会话隔离 | A/B分别开页、写不同Cookie；切换会话；向A注入B target | 页面列表/登录/输入均隔离，越界target拒绝；同owner并发启动仅一容器 |
| B04 旧会话接入 | 恢复未启用过浏览器的真实旧Thread，在面板开页，再让Agent读取 | Thread ID、历史、目录、权限保留；可读取自己页面，无需新建会话；故意断开后报明确连接错误 |
| B05 页面切换与异常 | 快速切A/B/target、resize；延迟旧帧/旧点击；关当前及最后页，弹新窗口 | 旧画面不覆盖，旧坐标不点错页；关闭最后页有确定空态/新空白页行为；重连不重放提交、不回退日常Chrome |
| B06 常用网页操作 | 真实鼠标点击/滚动/拖选/内部拖拽、中文候选确认、Tab/Enter/快捷键、复制粘贴、select与网页弹窗 | 逐项记录页面值/行为；中文不丢字/重复、不需独立“输入中文”框；选区与剪贴板结果正确 |
| B07 文件 | 本机选择/拖入文件至页面，下载fixture文件；取消/超限/断线 | 网页收到及本机取得的哈希正确；进度/失败明确；文件不串owner；不能用“CLI支持upload”代替APP实际上传 |
| B08 人工接管 | Agent浏览器变更排队时用户接管、编辑，再交还 | 人工期间不派发Agent变更；交还后重读当前页，不补执行旧点击；已发生的副作用如实显示 |
| B09 流畅与生命周期 | 本机确定性动画与100次输入、暂停绘制10s；隐藏面板、关浏览器、退出/崩溃重启；超过4容器/16页 | 无旧帧补播，输入不被画面积压阻塞；本机目标p95输入到呈现≤200ms、动画≥20fps（均待测）；隐藏停流、退出清理自己容器、持久登录不被清理；超限不阻塞聊天；资源回到基线 |

| B10 持久恢复 | 在DB旁状态目录写入Cookie、localStorage、IndexedDB、两页签及当前页；停止并删除容器，再从同目录重建；升级独立APP副本；受控环境重启Docker；换DB override目录与第二DB分别复验 | 状态语义及页面恢复正确，target重新绑定、无旧操作重放；路径来自实际DB，文件非容器层/临时目录；损坏manifest/重复profile锁明确报错且不删原状态；跨DB/会话不串；用户Docker Engine重启须择安全时机，不能用容器重启冒充 |

B01–B10是本轮发布范围。网页音视频、扩展、USB/系统桌面不作为引入额外架构的理由；未测能力不宣称全部原生等价。普通网页右键、拖文件等仍按B06/B07实际结果报告，不能静默删项。

## 自动化、证据与清理

- 真实 Docker 产品链路可运行 `cargo build --offline --manifest-path src-tauri/Cargo.toml --example session_browser_driver`，再运行 `node scripts/test_session_browser.mjs`；证据见 `docs/verification/2026-10-29-session-browser/product/trace.json`。IME 候选确认使用真实系统输入法；fill/粘贴文本不能替代。各项覆盖情况仍需分别核对，不能以脚本存在冒充全部 B01–B10 已通过。
- 按ready/target出现/fixture提交/帧呈现状态等待，均有deadline，不用固定sleep。单测与契约测试进默认CI；真实Docker＋APP用独立有界命令，模型验收限制轮次。
- 每例记录docs/verification/<日期>-session-browser/Bxx.log.md，按动作串联conversation/thread/run/session/container/target/epoch、关键请求响应与断言，并链接截图、fixture记录、资源样本。错误日志不包含Cookie、凭据或剪贴板正文。
- 仅清理本run精确标签的容器、独立持久测试profile、文件和测试数据库；产品退出不得删除持久profile；仅测试清理自身测试目录。禁止close-all、按Chrome名字全杀或清理用户Docker资源。失败保留有界诊断，清理结果可复核。
