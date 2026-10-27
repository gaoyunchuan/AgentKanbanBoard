//! Codex app-server's bidirectional JSONL transport.
//!
//! This module deliberately knows nothing about task completion. Responses, notifications
//! and server requests are different protocol messages; an answered approval is never
//! inferred from a notification that merely removes a pending request.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::thread;
use std::time::Duration;

const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;
const STDERR_TAIL_LINES: usize = 32;
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub enum ServerMessage {
    Event {
        method: String,
        params: Value,
        request_id: Option<Value>,
    },
    Disconnected {
        reason: String,
    },
}

type PendingReply = mpsc::SyncSender<Result<Value, String>>;

struct Transport {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, PendingReply>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    events: mpsc::Sender<ServerMessage>,
    stderr: Mutex<VecDeque<String>>,
}

/// Cloning a handle does not spawn another process. The last handle closes and reaps it.
#[derive(Clone)]
pub struct AppServer {
    transport: Arc<Transport>,
}

impl AppServer {
    pub fn spawn(executable: &Path) -> Result<(Self, mpsc::Receiver<ServerMessage>), String> {
        if executable.as_os_str().is_empty() {
            return Err("Codex 可执行文件路径不能为空".to_string());
        }
        let mut command = Command::new(executable);
        command.arg("app-server");
        if let Some(path) = crate::local_environment::child_path(executable) {
            command.env("PATH", path);
        }
        Self::spawn_command(command)
    }

    pub(crate) fn spawn_command(
        mut command: Command,
    ) -> Result<(Self, mpsc::Receiver<ServerMessage>), String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "无法启动 Codex app-server：{error}。已尝试自动检测本机 Codex；请在设置页查看诊断，不需要复制登录凭证。"
                )
            })?;
        let stdin = child.stdin.take().ok_or("app-server 未提供 stdin")?;
        let stdout = child.stdout.take().ok_or("app-server 未提供 stdout")?;
        let stderr = child.stderr.take().ok_or("app-server 未提供 stderr")?;
        let (events, receiver) = mpsc::channel();
        let transport = Arc::new(Transport {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            events,
            stderr: Mutex::new(VecDeque::new()),
        });

        let weak = Arc::downgrade(&transport);
        thread::Builder::new()
            .name("codex-app-server-output".into())
            .spawn(move || read_messages(BufReader::new(stdout), weak))
            .map_err(|error| format!("无法启动 app-server 读取线程：{error}"))?;
        let weak = Arc::downgrade(&transport);
        thread::Builder::new()
            .name("codex-app-server-stderr".into())
            .spawn(move || {
                let mut reader = BufReader::new(stderr);
                loop {
                    let mut line = String::new();
                    // A broken child must not accumulate an unbounded diagnostic line.
                    match reader.by_ref().take(16 * 1024).read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let Some(transport) = weak.upgrade() else {
                        break;
                    };
                    if let Ok(mut tail) = transport.stderr.lock() {
                        if tail.len() == STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(line.trim_end().to_string());
                    };
                }
            })
            .map_err(|error| format!("无法启动 app-server 日志线程：{error}"))?;

        Ok((Self { transport }, receiver))
    }

    pub fn initialize(&self) -> Result<Value, String> {
        let result = self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "agent-kanban-board",
                    "title": "AgentKanbanBoard",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
        )?;
        self.notify("initialized", json!({}))?;
        Ok(result)
    }

    pub fn is_alive(&self) -> bool {
        self.transport.alive.load(Ordering::Acquire)
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_timeout(method, params, DEFAULT_REQUEST_TIMEOUT)
    }

    pub fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.is_alive() {
            return Err("Codex app-server 已断开，请先恢复连接和任务状态".into());
        }
        let id = format!(
            "akb-{}",
            self.transport.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (send, receive) = mpsc::sync_channel(1);
        self.transport
            .pending
            .lock()
            .map_err(|_| "app-server 请求锁已损坏".to_string())?
            .insert(id.clone(), send);
        if let Err(error) = self.write_message(&json!({
            "id": id,
            "method": method,
            "params": params
        })) {
            self.transport.fail(&error);
            return Err(error);
        }

        match receive.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let error = format!(
                    "Codex 请求 {method} 超时，执行结果未知；连接已停止，请先恢复状态，勿直接重复执行。"
                );
                // A timed-out mutating RPC might already have executed. Do not leave a
                // second producer free to retry it on the same uncontrolled connection.
                self.transport.fail(&error);
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Codex app-server 在返回请求结果前断开".into())
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({"method": method, "params": params}))
    }

    pub fn respond(&self, request_id: Value, result: Value) -> Result<(), String> {
        self.write_message(&json!({"id": request_id, "result": result}))
    }

    pub fn respond_error(&self, request_id: Value, code: i64, message: &str) -> Result<(), String> {
        self.write_message(&json!({
            "id": request_id,
            "error": { "code": code, "message": message }
        }))
    }

    pub fn shutdown(&self) {
        self.transport.fail("Codex app-server 已停止");
    }

    pub fn diagnostics(&self) -> Vec<String> {
        self.transport
            .stderr
            .lock()
            .map(|tail| tail.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Enqueue a host-side control event after all wire events already read. This is
    /// used for asynchronous guard acknowledgements; it never writes to Codex stdin.
    pub(crate) fn enqueue_local_event(&self, method: &str, params: Value) -> Result<(), String> {
        self.transport
            .events
            .send(ServerMessage::Event {
                method: method.to_string(),
                params,
                request_id: None,
            })
            .map_err(|_| "Codex 事件处理器已停止".to_string())
    }

    fn write_message(&self, value: &Value) -> Result<(), String> {
        if !self.is_alive() {
            return Err("Codex app-server 已断开".into());
        }
        let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let mut stdin = self
            .transport
            .stdin
            .lock()
            .map_err(|_| "app-server 输入锁已损坏".to_string())?;
        let writer = stdin.as_mut().ok_or("app-server stdin 已关闭")?;
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("发送 Codex 请求失败：{error}"))
    }
}

impl Transport {
    fn fail(&self, reason: &str) {
        if !self.alive.swap(false, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, reply) in pending.drain() {
                let _ = reply.send(Err(reason.to_string()));
            }
        }
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            child.take();
        }
        let _ = self.events.send(ServerMessage::Disconnected {
            reason: reason.to_string(),
        });
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        if let Ok(stdin) = self.stdin.get_mut() {
            stdin.take();
        }
        if let Ok(child) = self.child.get_mut() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn read_messages(mut reader: impl BufRead, transport: Weak<Transport>) {
    loop {
        let mut line = String::new();
        let count = reader
            .by_ref()
            .take(MAX_FRAME_BYTES + 1)
            .read_line(&mut line);
        let Some(transport) = transport.upgrade() else {
            return;
        };
        match count {
            Ok(0) => {
                transport.fail("Codex app-server 输出流已关闭；正在执行的任务需要恢复核对");
                return;
            }
            Ok(bytes) if bytes as u64 > MAX_FRAME_BYTES => {
                transport.fail("Codex app-server 返回的单条消息超过大小限制");
                return;
            }
            Err(error) => {
                transport.fail(&format!("读取 Codex app-server 失败：{error}"));
                return;
            }
            _ => {}
        }
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                transport.fail(&format!("Codex app-server 返回无效 JSONL：{error}"));
                return;
            }
        };
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            let _ = transport.events.send(ServerMessage::Event {
                method: method.to_string(),
                params: value.get("params").cloned().unwrap_or(Value::Null),
                request_id: value.get("id").cloned(),
            });
            continue;
        }
        if let Some(id) = value.get("id") {
            let key = match id {
                Value::String(id) => id.clone(),
                _ => id.to_string(),
            };
            let reply = transport
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&key));
            if let Some(reply) = reply {
                let result = if let Some(error) = value.get("error") {
                    Err(format!("Codex app-server 拒绝请求：{error}"))
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = reply.send(result);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_server(script: &str) -> (AppServer, mpsc::Receiver<ServerMessage>) {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", script]);
        AppServer::spawn_command(command).expect("Python fake app-server should start")
    }

    #[test]
    fn routes_bidirectional_requests_and_responses_independently() {
        let (server, events) = fake_server(
            r#"
import sys, json
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'id':request['id'],'result':{'userAgent':'fake'}}), flush=True)
    elif request.get('method') == 'run':
        print(json.dumps({'id':7,'method':'item/fileChange/requestApproval','params':{'threadId':'thread-a','turnId':'turn-a'}}), flush=True)
        print(json.dumps({'method':'turn/started','params':{'threadId':'thread-a','turn':{'id':'turn-a','status':'inProgress'}}}), flush=True)
        print(json.dumps({'id':request['id'],'result':{'ok':True}}), flush=True)
    elif request.get('id') == 7:
        print(json.dumps({'method':'approvalReply','params':request['result']}), flush=True)
"#,
        );
        server.initialize().unwrap();
        assert_eq!(
            server.request("run", json!({})).unwrap(),
            json!({"ok":true})
        );
        match events.recv_timeout(Duration::from_secs(2)).unwrap() {
            ServerMessage::Event {
                request_id, method, ..
            } => {
                assert_eq!(request_id, Some(json!(7)));
                assert_eq!(method, "item/fileChange/requestApproval");
            }
            message => panic!("unexpected event: {message:?}"),
        }
        server
            .respond(json!(7), json!({"decision":"decline"}))
            .unwrap();
        let _ = events.recv_timeout(Duration::from_secs(2)).unwrap();
        match events.recv_timeout(Duration::from_secs(2)).unwrap() {
            ServerMessage::Event { params, .. } => {
                assert_eq!(params["decision"], "decline");
            }
            message => panic!("unexpected event: {message:?}"),
        }
        server.shutdown();
    }

    #[test]
    fn eof_fails_pending_rpc_and_reports_disconnection() {
        let (server, events) = fake_server("import sys\nsys.stdin.readline()\n");
        let error = server.request("turn/start", json!({})).unwrap_err();
        assert!(error.contains("输出流已关闭"));
        assert!(!server.is_alive());
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            ServerMessage::Disconnected { .. }
        ));
    }

    #[test]
    fn timeout_closes_uncertain_connection_instead_of_retrying() {
        let (server, _) = fake_server("import sys, time\nsys.stdin.readline()\ntime.sleep(20)\n");
        let error = server
            .request_with_timeout("turn/start", json!({}), Duration::from_millis(80))
            .unwrap_err();
        assert!(error.contains("执行结果未知"));
        assert!(!server.is_alive());
        assert!(server.request("turn/start", json!({})).is_err());
    }
}
