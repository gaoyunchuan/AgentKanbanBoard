//! Isolated browser owned by this app. The UI and Playwright MCP share exactly
//! one loopback CDP endpoint; remote pages never get the Tauri IPC bridge.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

struct Browser {
    child: Mutex<Child>,
    io: Mutex<(Option<ChildStdin>, mpsc::Receiver<Value>, u64)>,
    endpoint: String,
}
static BROWSERS: OnceLock<Mutex<HashMap<String, Arc<Browser>>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Arc<Browser>>> {
    BROWSERS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn node_command() -> Command {
    let mut candidates = Vec::new();
    if let Ok(codex) = crate::local_environment::resolve_codex("codex") {
        if let Some(parent) = codex.parent() {
            candidates.push(parent.join("node"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .map(|p| p.join("node")),
        );
    }
    candidates.extend(
        [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        .into_iter()
        .map(std::path::PathBuf::from),
    );
    for path in candidates {
        if path.is_file() {
            let mut command = Command::new(&path);
            if let Some(path) = crate::local_environment::child_path(&path) {
                command.env("PATH", path);
            }
            return command;
        }
    }
    Command::new("node")
}

impl Browser {
    fn start() -> Result<Arc<Self>, String> {
        let mut child = node_command()
            .args([
                "--input-type=module",
                "-e",
                include_str!("../../scripts/browser_bridge.mjs"),
            ])
            .env_remove("AKB_BROWSER_CONTAINER_TEST")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法启动侧边浏览器。需要本机 Node.js 22 与 Chrome：{e}"))?;
        let input = child.stdin.take().ok_or("无法打开浏览器输入")?;
        let output = child.stdout.take().ok_or("无法读取浏览器输出")?;
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                match line {
                    Ok(s) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&s) {
                            if send.send(v).is_err() {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let first = match receive.recv_timeout(Duration::from_secs(20)) {
            Ok(v) => v,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("浏览器初始化失败：{e}"));
            }
        };
        let endpoint = first
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|s| s.starts_with("http://127.0.0.1:"));
        if first["ready"] != true || endpoint.is_none() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(first["error"].as_str().unwrap_or("浏览器未就绪").into());
        }
        Ok(Arc::new(Self {
            child: Mutex::new(child),
            io: Mutex::new((Some(input), receive, 0)),
            endpoint: endpoint.unwrap().into(),
        }))
    }
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut io = self.io.lock().map_err(|_| "浏览器连接锁异常")?;
        io.2 += 1;
        let id = io.2;
        writeln!(
            io.0.as_mut().ok_or("浏览器已关闭")?,
            "{}",
            json!({"id":id,"method":method,"params":params})
        )
        .map_err(|e| e.to_string())?;
        io.0.as_mut()
            .ok_or("浏览器已关闭")?
            .flush()
            .map_err(|e| e.to_string())?;
        loop {
            let value =
                io.1.recv_timeout(Duration::from_secs(12))
                    .map_err(|e| format!("浏览器未响应：{e}"))?;
            if value["id"] != id {
                continue;
            }
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                return Err(error.into());
            }
            return Ok(value["result"].clone());
        }
    }
}
impl Drop for Browser {
    fn drop(&mut self) {
        if let Ok(io) = self.io.get_mut() {
            io.0.take();
        }
        if let Ok(child) = self.child.get_mut() {
            for _ in 0..25 {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
pub fn ensure(key: &str) -> Result<String, String> {
    let mut all = registry().lock().map_err(|_| "浏览器登记锁异常")?;
    if let Some(existing) = all.get(key) {
        let alive = existing
            .child
            .lock()
            .map_err(|_| "浏览器进程锁异常")?
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none();
        if alive {
            return Ok(existing.endpoint.clone());
        }
        // Replacing a browser mid-thread would invalidate the frozen MCP endpoint.
        return Err(
            "本会话浏览器进程已经结束。请新建会话重新连接，避免 Agent 使用失效的浏览器。".into(),
        );
    }
    let browser = Browser::start()?;
    let endpoint = browser.endpoint.clone();
    all.insert(key.into(), browser);
    Ok(endpoint)
}
pub fn endpoint(key: &str) -> Option<String> {
    registry().lock().ok()?.get(key).map(|b| b.endpoint.clone())
}
pub fn call(key: &str, method: &str, params: Value) -> Result<Value, String> {
    if ![
        "status",
        "new_page",
        "close_page",
        "activate_page",
        "frame",
        "navigate",
        "reload",
        "back",
        "forward",
        "click",
        "wheel",
        "text",
        "key",
    ]
    .contains(&method)
    {
        return Err("不允许的浏览器操作".into());
    }
    ensure(key)?;
    let browser = registry()
        .lock()
        .map_err(|_| "浏览器登记锁异常")?
        .get(key)
        .cloned()
        .ok_or("浏览器不存在")?;
    browser.call(method, params)
}
pub fn shutdown_all() {
    if let Ok(mut all) = registry().lock() {
        all.clear();
    }
}
