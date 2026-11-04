# Codex 会话绑定与接续验收

已安装到 `/Users/gaoyunchuan/Applications/Codex Thread Kanban.app`，重启并完成真实桌面验收。正常数据已恢复，任务树显示 327 项；没有将任何业务会话绑定到其他任务。

## 使用流程

1. 在全部任务中右击目标任务，选择「绑定 Codex 会话」。可搜索、翻页或切换已归档范围。
2. 选择原会话，点击「绑定并查看历史」。绑定保留原 Thread 和目录，此时可以阅读历史、保留草稿。
3. 点击「归档交接并接续」，去 Codex 核对执行结束并归档原会话，回来确认「已归档，恢复连接」。成功后自行发送下一条消息。

重复选择同任务会打开原记录；其他任务已有的绑定不可覆盖。失败时保留原绑定与草稿，处理占用后重试。

## 已验证

| 范围 | 结果 | 证据 |
| --- | --- | --- |
| 前端全量 | 30 文件、257 项通过 | frontend-tests.log |
| Rust 全量 | 223 项库测试及 3 项其他测试通过 | rust-tests.log |
| 安装助手 | 19 项通过 | local-tools.log |
| Electron | 13 项通过 | electron-tests.log |
| 构建与签名 | UI、release sidecar、Electron 打包完成；安装副本 deep/strict 签名通过，ad-hoc | installed-manifest.json |
| 原生正常数据 | 右键入口、真实 Codex 列表、第二页、名称搜索分页复位、归档范围通过 | production-restored.json |
| 真实写锁交接 | 未归档拒绝；持有者归档后同 Thread 恢复，原历史可见、草稿保留 | real-handoff.json |
| 无隐式执行 | 隔离数据库 run=0、event=0，任务仍待办；没有发送模型消息 | real-handoff.json |
| 规范 | OpenSpec strict、diff 空白检查、新增 Rust 模块 rustfmt 通过 | 本次命令输出 |

真实交接使用独立 CODEX_HOME 与测试工作目录，历史是自建的两条中文测试消息。持有者和 Kanban 均使用正式 Codex 二进制。归档通过隔离持有者的协议完成，未归档任何用户业务会话，也未执行真实业务 Turn。图像截图偶有白图，功能判断同时使用原生 AX 状态、协议返回与数据库断言。

全量 Rust 首次复测出现已有 browser_bridge 清理状态锁冲突，随后三个共用测试因 mutex poison 失败；无代码修改的全量复跑 223+3 全通过，两份日志保留。仓库全量 `cargo fmt --check` 仍报告现有多文件格式差异，本次没有批量重排无关源码；新增模块格式检查通过。

## 独立 review 与修复

review 提出三项 Important，均已修复并回归：原历史必须进入显式提取来源；超大历史不能断开执行连接；过滤后的空页不能消耗展示容量。额外现场兼容修复为旧本地历史接口回退，先复现失败再新增回归。

## 安装与回退

退出前已检查未发送草稿为 0、活动执行为 0。原有一条 uncertain 资源记录原样保留，未清除或重新执行。安装使用现有 `scripts/electron_local.py` 的构建、签名、备份与安装函数。

安装副本与构建前端 65 个资源及后端 SHA-256 一致，进程从安装目录运行。确认无构建进程和打开的构建文件后，已清理 `src-ui/dist`、`desktop/ui`、`desktop/dist-electron`、`src-tauri/target`；清理后原生任务树仍显示 327 项且 Codex 已连接，记录见 `cleanup.json`。

旧版备份保留在：

- `/Users/gaoyunchuan/Applications/Codex Thread Kanban.backup-73bb988e-669b-487d-adf4-e08ed16025d3.app`
- `/Users/gaoyunchuan/Applications/Codex Thread Kanban.backup-a9a7b9ff-69df-49e9-bcf7-3467f245c09d.app`

回退时正常退出当前应用，再从独立备份恢复 APP；保留数据库、浏览器状态、下载和账户配置。新增关联表为增量迁移，旧版不识别待交接标记；回退后不要在旧版发送本次新绑定且尚未交接的会话。正常数据库本轮没有新增外部绑定。

## 边界

历史最多保留 800 条实际记录，单项展示最多 16KiB。旧本地协议回退受 16MiB 响应上限约束，超过时明确提示到 Codex 查看。显式提取不静默截断：超过 20 页或总来源 600,000 字节会拒绝。首次实际模型回复与权限执行未在本轮触发。
