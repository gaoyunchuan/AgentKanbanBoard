# 会话浏览器资源核验（2026-10-29）

当前允许在隔离数据库/自有fixture下继续本机验收。正式容量结论仍为 **BLOCK**：完整profile及普通下载永久保留，但尚无持久盘硬配额；不能把16个目录或2GiB容器内存当成20GiB磁盘上界。用户要求升级/重启不能丢已存状态，禁止用自动删profile补容量缺口。

| 资源 | 当前实际约束 | 证据/剩余边界 |
| --- | --- | --- |
| Chrome运行 | 活跃owner≤4；2CPU、2GiB RAM、256PID/容器；tmpfs128MiB、shm256MiB；合计容器RAM配置≤8GiB | 真机Docker VM 12598894592字节、14CPU；已测2容器，未测4容器×16页满载。启动最多4份，不宣称串行启动1份 |
| 页面 | 显式新建拒绝第17页，当前列表超过16页报错；持久owner目录≤16 | 网页自行popup不是严格16页硬隔离；容器cgroup提供进程/内存边界，不把列表检查说成浏览器原生硬quota |
| 帧与本机桥 | 每owner一个观看端；单WS消息≤2MiB；最终绘制后ACK，保留最新帧；MCP32连接/worker、请求1MiB、结果512KiB | 不宣称WK总RSS≤32MiB或独立JPEG≤1MiB；没有持续保存帧历史。HMAC按owner/进程计算，无历史票据表，不需要新增TTL票据服务 |
| 命令和输入 | owner变更串行，入口最多9请求（1执行+8等待），清理绕过许可；CLI动作不自动重试 | UI发送缓冲守卫正在随键盘修复验证；未实施120事件/s节流，不宣称已有限速/鼠标合并 |
| 上传暂存 | 64MiB/文件、64KiB/块，单owner单上传；暂存≤256MiB/128文件，4活跃owner≤1GiB暂存 | 这只约束 .uploads；普通网页下载不受此配额。已跑PNG input/drop/paste真实字节比对 |
| 永久状态 | manifest≤256KiB×16=4MiB；完整profile/下载按实际DB文件名及owner隔离，原子写/文件锁 | profile和普通下载的总字节数、文件数无硬上界；关闭/升级保留，不自动清理。恢复失败保持原清单原字节 |
| 日志/缓存 | Docker每容器2份×2m日志；stream诊断每进程≤128条，resize摘要≤32条 | 镜像/OCI可重建缓存跨版本清理未验证；未实现5份×2MiB或7天清理，不作已落地保证 |

磁盘算式：`总量 = Σ(profile实际大小 + 普通下载实际大小) + 上传暂存 + manifest + 可重建运行缓存`。前两项目前无quota，不能计算有限20GiB上界。当前低用量不是未来安全证明。

## 待补证及发布条件

- C01：真实WK的100次输入p95与动画fps/RSS尚未采样；当前只证明ACK背压和连接恢复，不宣称p95≤200ms、动画≥20fps。
- C02：4容器/每容器16页的满载边界尚未实测；当前仅本机2容器隔离与语义恢复通过。
- C03：系统拼音输入已到达真实网页；普通回车、快捷键的完整CDP字段正在复验。文件内容在真实产品协议链已验证，APP所有原生文件入口仍需单列。
- C04：正常关闭、stop/rm失败重试、启动失败清理、桥接崩溃与APP升级均有独立证据；整个Docker Engine重启未执行，避免影响用户其它容器。
- C05：持久盘缺硬quota及低空间守卫。建议先增加用量可见和低空间拒绝写入作为实用保护；轮询保护不等于数学硬quota，正式发布需目标存储配额能力或有明确owner/reason/expires_at/scope的外部例外。不得为通过门禁擅自删除用户状态。

实现/测试：[browser_bridge.rs](../../../src-tauri/src/browser_bridge.rs)、[browser_state.rs](../../../src-tauri/src/browser_state.rs)、[browser_files.rs](../../../src-tauri/src/browser_files.rs)、[产品真实trace](../../verification/2026-10-29-session-browser/product/trace.json)。
