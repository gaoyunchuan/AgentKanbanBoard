## 根因证据
14:02、15:15、16:08、16:29 正式应用主进程同栈 SIGTRAP。匹配版本 Framework 反汇编包含 electron.v8-oom.detail 和 Last few GCs，进入 OOM 路径。现场启动约5分钟时双方128条TCP；重复160次大段会话旧实现堆5.2MB→85.4MB、160连接，新实现约5MB、0连接。

## 方案
一次性 RPC 统一 finish：清 timer/pending/buffer、socket.destroy 后才 resolve/reject。end 只是半关闭，不能用作完成清理。启动 ready 独立处理 error/exit/close 和120秒期限；处理早期拒绝但不吞调用错误。后端 ClientConnection 注册广播 writer，Drop 按连接 peer 精确解除。

## 上界与失败
16个在途RPC、每次32MiB累计响应、120秒请求期限；超限拒绝而不排队、不自动重放。广播注册64条、写超时5秒，异常/正常返回均释放。限制的是传输内存，不占Agent项目并发、不互斥终端进程。详见 docs/data-safety/sidecar-rpc/resources.json。

## 三个风险及补救
1. 强制关闭可能误伤未完成写操作：只在收到对应完整响应或明确失败时关闭，不重试，断流提示核对结果。
2. 部分帧/通知可能错配响应：保留分块解析、校验本请求ID，通知跳过；分别回归。
3. 超长历史可能超过32MiB：拒绝传输并呈现错误，不删除历史、不重启任务；大记录分页属于后续能力，本次真实会话低于该限额。

## 验证
失败回归→生命周期修复→完整Rust与Node测试→签名安装→真实页面连续读取/连接数量和RSS采样→清理可再生制品。
