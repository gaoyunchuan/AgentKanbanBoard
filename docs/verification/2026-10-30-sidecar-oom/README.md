# 会话执行中应用意外退出：排查与修复

## 结论

正式应用的4次退出是 Electron 主进程 V8 OOM。根因是本地RPC连接生命周期泄漏：客户端使用end()半关闭，Rust又把广播writer克隆保存在全局CLIENTS。旧socket及其error回调保留已完成Promise和大响应，轮询次数越多，堆占用越高。

这与之前workspace routing discovery failed上游请求失败不同，也不把更新重启算作这4次崩溃。11:39的Task Permission Validation隔离验收进程不在正式应用4次统计中。

## 现场证据

- `crash-summary.json`：14:02、15:15、16:08、16:29正式应用主线程同栈SIGTRAP，Electron 38.8.6，Framework UUID一致。
- `akb-native-disassembly.log`、`akb-v8-oom-disassembly.log`：栈偏移附近含electron.v8-oom.detail与Last few GCs；原ips的ares_dns/sqlite符号只是剥离二进制的最近导出符号，不是DNS/SQLite故障证据。
- 新启动旧版本约5分钟客户端/后端各128个TCP，更新退出前各434个。读取RPC本应是一次性的，双方均随轮询累积。

## 先失败后修复

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| 40次TCP响应后客户端连接 | 40 | 0 |
| 160次大段记录后连接 | 160 | 0 |
| 同负载JS堆 | 5.23MB→85.44MB | 约5MB保持稳定 |
| serve结束且无新广播 | 残留1条writer | 0 |
| 端口发布前spawn error但无exit | 请求一直pending | 已有和后续调用均拒绝 |

证据：rpc-red.log、memory-red.log、writer-red.log、startup-red.log、node-tests.log。内存压力测试是可控本地TCP，没有触发业务任务。

## 修改

- `desktop/main.js`：统一finish释放socket、pending、timer、buffer；正确处理完整响应、服务错误、损坏JSON、提前断流、超时、子进程退出；启动前error/close也结束ready，避免早期未处理拒绝。所有错误不自动重放业务。
- `src-tauri/src/bin/akb_sidecar.rs`：ClientConnection RAII按原连接peer移除广播writer，正常或异常退出均清理，不等下一次广播。
- 资源背压：16个在途RPC、32MiB累计响应、120秒启动/请求期限；后端最多64条广播注册、写超时5秒。这是传输资源约束，不占Agent项目并发，不互斥终端执行。容量与生命周期见`docs/data-safety/sidecar-rpc/resources.json`。

## 验证

- Node 13项通过，包含7项既有浏览器回归与6项连接/内存/异常回归。
- Rust完整208项通过（205库测试、sidecar/main/集成各1项）；局部rustfmt之后sidecar再验证通过。
- 独立审查发现的启动前失败悬挂已按失败回归修复，二次审查通过。
- Release、UI构建、OpenSpec strict、git diff --check通过。全仓已有格式差异未在本轮展开整理。
- 真实原会话连续80次只读detail：每次4,024,672字节、2,273个事件；heap在17.15MB上下保持稳定，见real-history-probe.json。没有执行文档操作或恢复业务任务。
- 原生应用保持原会话自动刷新，连续180秒、13次采样：主进程RSS约133–145MiB，TCP为监听+瞬时请求1–2条，未出现新崩溃；记录见native-summary.json及native-observation.json；native-readonly.ax.txt确认加载的是安装副本的原会话。
- 签名安装、源码/二进制SHA核对见installation.json及installed-processes.json。安装前保留旧APP；更新中止了当时的GPU任务执行，本次没有自动重放它。
- 清理4个可再生目录，释放约2.98GiB；清理后安装副本签名仍有效，见cleanup.json。

## 风险与限制

1. **关闭连接会不会丢业务操作？** 只在完整匹配响应或明确失败时清理。断流意味着结果需要核对，不自动重发写操作，避免重复业务效果。
2. **分块响应/状态通知会不会错配？** JSONL保留分块，通知跳过，响应ID必须等于本次ID；对应回归已通过。
3. **很长历史仍可能很大。** 32MiB以上响应明确失败，不静默截断、不删历史。当前真实会话约4MiB，未触及此限制；更大历史的分页是后续能力。

本次覆盖可复现的连接/堆泄漏、真实历史重复读取和数分钟原生自动刷新；不宣称已验证数小时或所有其它崩溃类型。
