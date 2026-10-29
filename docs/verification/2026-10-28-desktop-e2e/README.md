# 真实桌面验收与修复记录

日期：2026-10-28。状态：八个核心场景通过，最终本机安装版已完成复核。

用户确认了 8 个核心场景，授权本机编译、安装、启动新版 APP，并在确认的范围内持续验证和修复。

## 验收边界

- 真实 macOS Tauri APP、真实 Codex 账号与模型、真实本地文件及独立 Chrome。
- 安装副本：`~/Applications/Codex Thread Kanban.app`。
- 隔离数据：`/Users/gaoyunchuan/workspace/agent-kanban-e2e-20261028/app.db`；通过 `AGENT_KANBAN_DB_PATH` 指定，不改变 HOME/CODEX_HOME。
- 正式数据库原有 319 个任务、2 个工作任务、4 个会话，已通过 SQLite backup 备份到测试目录。测试不操作这些业务任务。
- `0.139.0` CLI 不能加载当前 agents 配置；ChatGPT.app 内置 `0.164.0-alpha.11.1` 已实测可加载同一配置并识别已有登录。
- 难以稳定构造的重复、迟到协议事件另用真实 JSONL 子进程模拟补测，不冒充真实模型验收。

## 当前进度

| 场景 | 已取得的真实证据 | 尚待完成 |
| --- | --- | --- |
| 01 基础会话与项目继承 | 读取两份日志、生成 diagnosis.md；无项目发送保留草稿；先建子会话后绑定父项目，继承目录并启动 | 已返回 INHERITED-OK；三项独立任务各一轮真实交付，CHECK-1/2/3 文件一致 |
| 02 自动执行与交付 | 不补发开始即自动执行；真实报告人工验收完成；预约任务显式 Auto 后自动完成 | 已通过；见最终执行记录与构建检查 |
| 03 多会话及来源 | A 返回 CONTEXT-ALPHA-1028 SESSION-A，B 返回 SESSION-B；两个来源分别提取；跨页面、重启后保留 | 重复同一来源提示已有记录，没有新增摘要执行 |
| 04 人工交接 | 业务问题进入需要你，回答后自动续跑；真实浏览器工具批准、拒绝均生效；退出后旧审批 expired | 已通过；见最终执行记录与构建检查 |
| 05 依赖推进 | A 待验收时 B 的 run_count=0、thread_id=null；验收后 B 自动启动并引用 A；循环依赖不可选 | 父 Agent 真实创建唯一子任务、等待验收后恢复；child.txt/parent.txt 均验证通过 |
| 06 预约开始 | 只设时间未委托，到点 run_count=0；已委托到点启动一次；人工暂停越过新开始时间后仍 paused、run_count=1 | 明确恢复后总计两轮，完成状态；未到点运行与重复运行均未出现 |
| 07 上下游返工 | A 旧报告保留；A 第二版依据 correction.log 改变结论；B 未被自动重开；独立任务无变化；明确返工 B 后新执行启动 | B 新版引用 A 第二次有效交付和 correction.log，人工重新验收完成，旧版 usable=false |
| 08 工具及恢复 | 浏览器中文提交、同实例页面同步、多标签关闭恢复；Agent 占目录时终端被拒绝；停止后终端输出 TERMINAL-OK；退出期间旧请求失效、不重放 | 停止修复后 90 秒命令在约 18 秒终止，5 次采样稳定；显式续聊返回 STOP-RESUME-OK，没有重放命令 |

## 已定位的故障与修复

1. 自动发现遗漏 ChatGPT.app 内置 Codex，错误选择无法解析用户配置的旧 CLI。补全系统及用户 Applications 候选，仍进行同配置只读预检，不改用户配置。
2. 临时摘要 Thread 不支持 Goal API，却被统一查询并导致共享连接关闭。摘要启动跳过 Goal 查询，持久会话仍保留核对。
3. 委托前只有占位任务，后台创建主会话后页面不自动跟随，需重开任务才能看到执行。仅在未明确选定会话时补齐选择，不抢占人工会话。
4. 已完成任务缺少反馈返工入口；验收关闭主会话后，后台返工仍被 closed 标志抑制。补充属性控制区，返工仅恢复自动主会话。
5. 已委托任务改回待办，实际仍重新排队。改回待办保持 paused；提供明确暂停、恢复入口，覆盖预约等待。
6. 新控制区与开始时间组件的 React key 重复，真实切换任务时字段重复。改为不同 key，并加入连续切换回归。
7. 子任务创建弹窗沿用了当前选中任务项目，可能与右键指定父任务无关。新建子任务默认继承真实父任务项目，回归通过。
8. 占位任务切换到新自动主会话时，草稿仍留在任务键下。现在连同附件、项目及导入标记迁移，双方都有草稿则保留原选择，不覆盖。
9. 显式恢复已关闭主会话后仍不能调度。恢复/重试与返工一致，仅重开自动主会话。
10. 界面暂停后 native unified exec 命令继续写入。新增按运行和连接归属的停止占用：停止意图持久保留，等待子 Turn 与 Goal 收敛，分页终止原生终端并再次查询为空才释放；失败、超时、断线、重启保留 uncertain 占用，不放行验收或下游。人工核对后才可按原运行解除。普通完成保留有意后台服务原行为。

## 关键证据

- `evidence/checkpoint-1615.json`：基础会话、摘要修复后结果、工作与执行记录。
- `evidence/before-accept-a.json`：A 待验收时 B 无执行，预约任务也未提前启动。
- `evidence/dependency-checkpoint.json`：B 的真实执行 prompt 中固定了 A 的有效交付来源。
- `evidence/context-checkpoint.json`：两个会话分别留存结果及 source boundary。
- `evidence/scheduled-checkpoint.json`：第一次预约的开始及结束时间。
- `evidence/06-paused-after-deadline.json`：16:42 开始时间已过，16:55 仍人工暂停，执行次数未增加。
- `evidence/07-rework-a-start.json`：A 返工后，已完成的 B 和独立任务没有被自动重开。
- `evidence/08-browser-submitted.ax.txt`：原生 APP 标签和画面标题同步为 SUBMITTED:浏览器联动通过。
- `evidence/08-before-exit-approval.ax.txt`：真实待审批请求及同目录终端拒绝信息。
- `evidence/08-after-restart.ax.txt`：中断恢复提示，旧审批不再可操作。

原生截图工具当前返回白图，未将白图计作视觉验收通过；使用 APP 可访问性树、真实文件、持久状态及协议记录交叉核对。

## 最后验证与边界

- `make test`：前端 81 条，Rust 库最终 136 条、main 1 条、集成 1 条，Python 18 条通过；包含停止迟到事件补测；详见最终门禁记录。
- `cargo fmt --check`、额外 include 源文件 rustfmt、`git diff --check` 通过。
- 目录占用的容量及生命周期见 `docs/data-safety/desktop-native-stop.md`、`resources.json`。未知进程状态不能按时间自动消失。
- `evidence/08-live-command-stop.json` 保留修复前 FAIL；`08-live-command-stop-after-fix.json` 为修复后常规路径通过，不能混用。
- `evidence/03-duplicate-extract.ax.txt` 为重复来源提示，`08-explicit-resume.ax.txt` 为明确续聊结果。
- `evidence/final-task-state.json` 汇总真实任务、执行次数、有效结果和来源；`formal-data-unchanged.json` 比较正式表逐行内容，与测试前备份完全一致。
- 未将断网、迟到事件、极限分页模拟描述为真实网络故障演练。应用关闭/电脑休眠不执行；没有后台 daemon。
- 没有执行截图中的真实业务排障，也没有自动恢复原来两项失败的业务执行。测试只访问隔离项目。

- 最终安装版再次停止：`evidence/08-final-installed-stop.json`，约 47 秒提前中断，11715 B 五次采样稳定；`evidence/case-results.json` 八项断言全部通过。
- 最终检查说明：`docs/deploy/desktop-core-flows/mr-review-gate.md`。
