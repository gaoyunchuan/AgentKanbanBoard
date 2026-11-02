//! 人工交互终端独立于 Agent 调度，不领取目录租约或并发名额。
use crate::app_server::AppServer;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
const TERMINAL_LIMIT: usize = 8;
const OUTPUT_LIMIT: usize = 1024 * 1024;
#[derive(Default)]
struct OutputBuffer {
    bytes: VecDeque<u8>,
    total: u64,
}
impl OutputBuffer {
    fn append(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        let tail = &bytes[bytes.len().saturating_sub(OUTPUT_LIMIT)..];
        self.bytes.extend(tail);
        let excess = self.bytes.len().saturating_sub(OUTPUT_LIMIT);
        self.bytes.drain(..excess);
    }
    fn start(&self) -> u64 {
        self.total - self.bytes.len() as u64
    }
    fn read(&self, after: u64) -> (u64, Vec<u8>) {
        let start = after.max(self.start()).min(self.total);
        (
            start,
            self.bytes
                .iter()
                .skip((start - self.start()) as usize)
                .copied()
                .collect(),
        )
    }
}
struct Session {
    owner: String,
    workspace: String,
    output: OutputBuffer,
    exited: bool,
    exit_code: Option<i64>,
    error: Option<String>,
}
pub struct TerminalManager {
    server: AppServer,
    sessions: Mutex<HashMap<String, Session>>,
    settled: Condvar,
    next: AtomicU64,
    prefix: String,
}
impl TerminalManager {
    pub fn new(server: AppServer) -> Arc<Self> {
        Arc::new(Self {
            server,
            sessions: Mutex::new(HashMap::new()),
            settled: Condvar::new(),
            next: AtomicU64::new(1),
            prefix: format!(
                "pty-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
        })
    }
    pub fn start(
        self: &Arc<Self>,
        owner: &str,
        workspace: &str,
        sandbox: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let workspace = crate::local_environment::workspace_directory(workspace)?
            .to_string_lossy()
            .to_string();
        Self::validate_size(cols, rows)?;
        let id = format!(
            "{}-{}",
            self.prefix,
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        let mut sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        if sessions.len() >= TERMINAL_LIMIT {
            return Err("最多同时打开 8 个终端，请先关闭不需要的终端".into());
        }
        sessions.insert(
            id.clone(),
            Session {
                owner: owner.into(),
                workspace: workspace.clone(),
                output: OutputBuffer::default(),
                exited: false,
                exit_code: None,
                error: None,
            },
        );
        let shell = if cfg!(windows) {
            vec!["powershell.exe", "-NoLogo"]
        } else if cfg!(target_os = "macos") {
            // 受限沙箱不能让启动脚本先写 HOME 缓存；完全访问时保留用户初始化配置。
            vec![
                "/bin/zsh",
                if sandbox == "danger-full-access" {
                    "-l"
                } else {
                    "-f"
                },
            ]
        } else {
            vec!["/bin/sh", "-i"]
        };
        let params = json!({"command":shell,"processId":id,"cwd":workspace,"tty":true,"streamStdin":true,"streamStdoutStderr":true,"disableTimeout":true,"outputBytesCap":OUTPUT_LIMIT,"size":{"cols":cols,"rows":rows},"env":{"TERM":"xterm-256color","COLORTERM":"truecolor"},"sandboxPolicy":crate::work_runtime::sandbox_policy(sandbox,&workspace)});
        // 同步写入启动请求后才返回身份，避免关闭请求先于启动请求发送。
        let reply = match self.server.request_background("command/exec", params) {
            Ok(reply) => reply,
            Err(error) => {
                sessions.remove(&id);
                return Err(error);
            }
        };
        drop(sessions);
        let manager = Arc::clone(self);
        let process = id.clone();
        std::thread::spawn(move || {
            let result = reply
                .recv()
                .unwrap_or_else(|_| Err("终端连接已断开".into()));
            manager.finish(&process, result);
        });
        Ok(id)
    }
    fn finish(&self, id: &str, result: Result<Value, String>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.get_mut(id) {
                session.exited = true;
                match result {
                    Ok(value) => session.exit_code = value["exitCode"].as_i64(),
                    Err(error) => session.error = Some(error),
                }
            }
            self.settled.notify_all();
        }
    }
    fn validate_size(cols: u16, rows: u16) -> Result<(), String> {
        if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
            Err("终端尺寸超出范围".into())
        } else {
            Ok(())
        }
    }
    fn check_owner(&self, owner: &str, id: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        let session = sessions.get(id).ok_or("终端不存在或已关闭")?;
        if session.owner != owner {
            return Err("终端不属于当前工作区".into());
        }
        if session.exited {
            return Err("终端已退出，请新建终端".into());
        }
        Ok(())
    }
    pub fn write(&self, owner: &str, id: &str, text: &str) -> Result<(), String> {
        self.check_owner(owner, id)?;
        if text.len() > 16 * 1024 {
            return Err("单次终端输入超过 16 KiB，请分段输入".into());
        }
        self.server.request(
            "command/exec/write",
            json!({"processId":id,"deltaBase64":BASE64.encode(text.as_bytes())}),
        )?;
        Ok(())
    }
    pub fn resize(&self, owner: &str, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.check_owner(owner, id)?;
        Self::validate_size(cols, rows)?;
        self.server.request(
            "command/exec/resize",
            json!({"processId":id,"size":{"cols":cols,"rows":rows}}),
        )?;
        Ok(())
    }
    pub fn read(&self, owner: &str, id: &str, after: u64) -> Result<Value, String> {
        let sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        let session = sessions.get(id).ok_or("终端不存在或已关闭")?;
        if session.owner != owner {
            return Err("终端不属于当前工作区".into());
        }
        let (start, bytes) = session.output.read(after);
        Ok(
            json!({"id":id,"workspace":session.workspace,"start":start,"offset":session.output.total,"dataBase64":BASE64.encode(bytes),"exited":session.exited,"exitCode":session.exit_code,"error":session.error}),
        )
    }
    pub fn accept_output(&self, method: &str, params: &Value) -> bool {
        if method != "command/exec/outputDelta" {
            return false;
        }
        let Some(id) = params["processId"].as_str() else {
            return false;
        };
        let Ok(mut sessions) = self.sessions.lock() else {
            return false;
        };
        let Some(session) = sessions.get_mut(id) else {
            return false;
        };
        if let Some(text) = params["deltaBase64"].as_str() {
            match BASE64.decode(text) {
                Ok(bytes) => session.output.append(&bytes),
                Err(_) => session.error = Some("终端输出解码失败".into()),
            }
        } else if let Some(text) = params["delta"].as_str() {
            session.output.append(text.as_bytes())
        }
        true
    }
    pub fn disconnect(&self, reason: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for session in sessions.values_mut() {
                if !session.exited {
                    session.exited = true;
                    session.error = Some(reason.into())
                }
            }
            self.settled.notify_all();
        }
    }
    pub fn close(&self, owner: &str, id: &str) -> Result<(), String> {
        let running = {
            let sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
            let Some(session) = sessions.get(id) else {
                return Ok(());
            };
            if session.owner != owner {
                return Err("终端不属于当前工作区".into());
            }
            !session.exited
        };
        if running {
            self.server
                .request("command/exec/terminate", json!({"processId":id}))?;
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut sessions = self.sessions.lock().map_err(|_| "终端状态锁异常")?;
        while sessions.get(id).is_some_and(|session| !session.exited) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("终端尚未确认退出，请稍后重试关闭".into());
            }
            sessions = self
                .settled
                .wait_timeout(sessions, remaining)
                .map_err(|_| "终端状态锁异常")?
                .0;
        }
        sessions.remove(id);
        Ok(())
    }
    pub fn shutdown(&self) {
        let ids = self
            .sessions
            .lock()
            .map(|values| {
                values
                    .iter()
                    .filter(|(_, s)| !s.exited)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // 同时请求全部 PTY 结束，以一个总期限收尾，避免每个终端串行等待阻塞退出。
        for id in ids {
            let _ = self
                .server
                .request_background("command/exec/terminate", json!({"processId":id}));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        if let Ok(mut sessions) = self.sessions.lock() {
            while sessions.values().any(|s| !s.exited) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match self.settled.wait_timeout(sessions, remaining) {
                    Ok(value) => sessions = value.0,
                    Err(_) => break,
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::ServerMessage;
    use std::process::Command;
    #[test]
    fn two_pty_sessions_share_a_project_without_sharing_input_or_close() {
        let script = r#"
import sys,json,base64
running={}
for line in sys.stdin:
 v=json.loads(line);m=v.get('method');p=v.get('params',{});i=v.get('id');pid=p.get('processId')
 if m=='command/exec':
  if sys.platform=='darwin':assert p['command']==['/bin/zsh','-f'],p['command']
  running[pid]=i
  print(json.dumps({'method':'command/exec/outputDelta','params':{'processId':pid,'stream':'stdout','deltaBase64':base64.b64encode(p['cwd'].encode()).decode()}}),flush=True)
  continue
 if m=='command/exec/write':print(json.dumps({'method':'command/exec/outputDelta','params':{'processId':pid,'stream':'stdout','deltaBase64':p['deltaBase64']}}),flush=True)
 if m=='command/exec/terminate':print(json.dumps({'id':running.pop(pid),'result':{'exitCode':0}}),flush=True)
 print(json.dumps({'id':i,'result':{}}),flush=True)
"#;
        let mut command = Command::new("python3");
        command.args(["-u", "-c", script]);
        let (server, events) = AppServer::spawn_command(command).unwrap();
        let manager = TerminalManager::new(server.clone());
        let weak = Arc::downgrade(&manager);
        std::thread::spawn(move || {
            while let Ok(event) = events.recv() {
                if let ServerMessage::Event { method, params, .. } = event {
                    if let Some(manager) = weak.upgrade() {
                        manager.accept_output(&method, &params);
                    }
                }
            }
        });
        let first = manager.start("one", "/tmp", "read-only", 80, 24).unwrap();
        let second = manager.start("one", "/tmp", "read-only", 80, 24).unwrap();
        let extra = (0..6)
            .map(|_| manager.start("one", "/tmp", "read-only", 80, 24).unwrap())
            .collect::<Vec<_>>();
        assert!(manager
            .start("one", "/tmp", "read-only", 80, 24)
            .unwrap_err()
            .contains("8"));
        assert!(manager
            .write("one", &first, &"x".repeat(16 * 1024 + 1))
            .is_err());
        manager.write("one", &first, "中文输入").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let snap = manager.read("one", &first, 0).unwrap();
            let bytes = BASE64.decode(snap["dataBase64"].as_str().unwrap()).unwrap();
            if String::from_utf8_lossy(&bytes).contains("中文输入") {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(manager.read("other", &first, 0).is_err());
        manager.close("one", &first).unwrap();
        assert!(!manager.read("one", &second, 0).unwrap()["exited"]
            .as_bool()
            .unwrap());
        manager.close("one", &second).unwrap();
        for id in extra {
            manager.close("one", &id).unwrap();
        }
        server.shutdown();
    }
    #[test]
    fn output_history_is_bounded_and_old_offsets_are_reported() {
        let mut output = OutputBuffer::default();
        output.append(&vec![b'a'; OUTPUT_LIMIT + 100]);
        assert_eq!(output.bytes.len(), OUTPUT_LIMIT);
        assert_eq!(output.start(), 100);
        assert_eq!(output.read(0).0, 100);
    }
}
