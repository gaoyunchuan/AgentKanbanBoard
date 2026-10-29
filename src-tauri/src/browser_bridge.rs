//! 本应用拥有的Docker会话浏览器；UI与Agent始终通过同一sidecar/session操作。
use crate::browser_state::{for_owner, BrowserStatePaths, PageManifest, ProfileLease};
use crate::browser_stream::{BrowserInputGate, StreamProxy};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct Configuration {
    root: PathBuf,
    agent: PathBuf,
    scripts: PathBuf,
}
struct Slot {
    value: OnceLock<Result<Arc<Browser>, String>>,
    cancelled: AtomicBool,
    cleanup: Mutex<Option<BrowserStatePaths>>,
}
struct Browser {
    child: Mutex<Child>,
    io: Mutex<(Option<ChildStdin>, mpsc::Receiver<Value>, u64)>,
    endpoint: String,
    upstream: String,
    lease: Arc<ProfileLease>,
    state: Mutex<Value>,
    proxy: Mutex<Option<StreamProxy>>,
    gate: Arc<BrowserInputGate>,
    stopped: AtomicBool,
    upload: Mutex<Option<(crate::browser_files::PendingUpload, u64)>>,
    admitted: AtomicUsize,
}
struct CallPermit<'a>(&'a AtomicUsize);
impl Drop for CallPermit<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
static CONFIG: OnceLock<Mutex<Option<Configuration>>> = OnceLock::new();
static BROWSERS: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
static STATE_DIRECTORIES: Mutex<()> = Mutex::new(());
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static RESIZE_DIAGNOSTICS: AtomicUsize = AtomicUsize::new(0);
fn registry() -> &'static Mutex<HashMap<String, Arc<Slot>>> {
    BROWSERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn configure(root: PathBuf, agent: PathBuf, scripts: PathBuf) -> Result<(), String> {
    if !root.is_absolute() || !agent.is_absolute() || !scripts.is_absolute() {
        return Err("浏览器运行路径必须是绝对路径".into());
    }
    *CONFIG
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "浏览器配置锁异常")? = Some(Configuration {
        root,
        agent,
        scripts,
    });
    SHUTTING_DOWN.store(false, Ordering::Release);
    Ok(())
}
fn configuration() -> Result<Configuration, String> {
    CONFIG
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "浏览器配置锁异常")?
        .clone()
        .ok_or_else(|| "浏览器未绑定当前应用数据库".into())
}
fn node_command() -> Command {
    let mut candidates = Vec::new();
    if let Ok(codex) = crate::local_environment::resolve_codex("codex") {
        if let Some(parent) = codex.parent() {
            candidates.push(parent.join("node"));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&paths)
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
        .map(PathBuf::from),
    );
    for path in candidates {
        if path.is_file() {
            let mut command = Command::new(&path);
            if let Some(paths) = crate::local_environment::child_path(&path) {
                command.env("PATH", paths);
            }
            return command;
        }
    }
    Command::new("node")
}
fn persistent_paths(config: &Configuration, owner: &str) -> Result<BrowserStatePaths, String> {
    let _creation = STATE_DIRECTORIES
        .lock()
        .map_err(|_| "浏览器状态目录锁异常")?;
    let encoded = owner
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if !config.root.join(&encoded).exists() {
        let count = std::fs::read_dir(&config.root)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| {
                        e.path().is_dir()
                            && e.file_name()
                                .to_string_lossy()
                                .chars()
                                .all(|c| c.is_ascii_hexdigit())
                    })
                    .count()
            })
            .unwrap_or(0);
        if count >= 16 {
            return Err("已保存16份浏览器状态，请先明确清理不再需要的会话状态".into());
        }
    }
    for_owner(&config.root, owner)
}
fn read_replies(
    output: impl Read + Send + 'static,
    sender: mpsc::SyncSender<Value>,
    lease: Arc<ProfileLease>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = Vec::new();
            let read = Read::by_ref(&mut reader)
                .take(2_097_153)
                .read_until(b'\n', &mut line);
            if read.ok().filter(|n| *n > 0).is_none() || line.len() > 2_097_152 {
                break;
            }
            let Ok(mut value) = serde_json::from_slice::<Value>(&line) else {
                break;
            };
            if let Some(manifest) = value
                .pointer("/state/manifest")
                .or_else(|| value.get("manifest"))
            {
                let saved = serde_json::from_value::<PageManifest>(manifest.clone())
                    .map_err(|e| e.to_string())
                    .and_then(|m| lease.write_manifest(&m));
                if let Err(error) = saved {
                    value["error"] = json!(format!("页面状态保存失败：{error}"));
                    value["ready"] = json!(false);
                }
            }
            if value.get("event").is_some() {
                continue;
            }
            if sender.send(value).is_err() {
                break;
            }
        }
    })
}
impl Browser {
    fn start(owner: &str, slot: &Slot) -> Result<Arc<Self>, String> {
        let config = configuration()?;
        if !config.agent.is_file() {
            return Err("未准备固定版本浏览器环境，请先准备agent-browser与Docker镜像".into());
        }
        let lease = Arc::new(ProfileLease::acquire(&persistent_paths(&config, owner)?)?);
        *slot.cleanup.lock().map_err(|_| "浏览器清理状态锁异常")? = Some(lease.paths().clone());
        lease.read_manifest()?;
        let mut child = node_command()
            .arg(config.scripts.join("session_browser.mjs"))
            .env("AKB_BROWSER_OWNER_DIR", &lease.paths().root)
            .env("AKB_AGENT_BROWSER_PATH", config.agent)
            .env("AKB_BROWSER_MANIFEST_PATH", &lease.paths().manifest)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法启动浏览器桥接（需要Node.js 22+）：{e}"))?;
        let input = child.stdin.take().ok_or("无法打开浏览器输入")?;
        let output = child.stdout.take().ok_or("无法读取浏览器输出")?;
        let (send, receive) = mpsc::sync_channel(32);
        let reader = read_replies(output, send, lease.clone());
        let first = receive.recv_timeout(Duration::from_secs(60));
        let first = match first {
            Ok(value) if value["ready"] == true && value.get("error").is_none() => value,
            other => {
                let error = match other {
                    Ok(value) => value["error"]
                        .as_str()
                        .unwrap_or("浏览器未就绪")
                        .to_string(),
                    Err(e) => format!("浏览器启动超时：{e}"),
                };
                drop(input);
                wait_child(&mut child, Duration::from_secs(25));
                // stdout已经关闭后汇合读取线程，避免其最后一份lease短暂挡住紧接着的精确清理。
                let _ = reader.join();
                if receive
                    .try_iter()
                    .any(|value| value["cleanup_complete"] == true)
                {
                    slot.cleanup
                        .lock()
                        .map_err(|_| "浏览器清理状态锁异常")?
                        .take();
                    remove_empty_placeholder(lease.paths())?;
                }
                return Err(error);
            }
        };
        let endpoint = first["endpoint"]
            .as_str()
            .filter(|s| s.starts_with("http://127.0.0.1:"))
            .ok_or("无效的Docker浏览器地址")?
            .to_string();
        let upstream = first["stream_url"]
            .as_str()
            .ok_or("浏览器未提供画面流")?
            .to_string();
        let browser = Arc::new(Self {
            child: Mutex::new(child),
            io: Mutex::new((Some(input), receive, 0)),
            endpoint,
            upstream,
            lease,
            state: Mutex::new(first),
            proxy: Mutex::new(None),
            gate: Arc::new(BrowserInputGate::default()),
            stopped: AtomicBool::new(false),
            upload: Mutex::new(None),
            admitted: AtomicUsize::new(0),
        });
        browser.reset_stream()?;
        slot.cleanup
            .lock()
            .map_err(|_| "浏览器清理状态锁异常")?
            .take();
        Ok(browser)
    }
    fn reset_stream(&self) -> Result<(), String> {
        let mut proxy = self.proxy.lock().map_err(|_| "画面连接锁异常")?;
        if let Some(old) = proxy.take() {
            old.stop();
        }
        *proxy = Some(StreamProxy::start(&self.upstream, self.gate.clone())?);
        Ok(())
    }
    fn stop_stream(&self) {
        if let Ok(mut proxy) = self.proxy.lock() {
            if let Some(old) = proxy.take() {
                old.stop();
            }
        }
    }
    fn rpc(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.stopped.load(Ordering::Acquire) && method != "shutdown" {
            return Err("浏览器已停止，状态文件仍保留".into());
        }
        let mut io = self.io.lock().map_err(|_| "浏览器命令锁异常")?;
        io.2 += 1;
        let id = io.2;
        let input = io.0.as_mut().ok_or("浏览器已关闭")?;
        writeln!(
            input,
            "{}",
            json!({"id":id,"method":method,"params":params})
        )
        .and_then(|_| input.flush())
        .map_err(|e| e.to_string())?;
        let deadline =
            Instant::now() + Duration::from_secs(if method == "shutdown" { 35 } else { 20 });
        loop {
            let value =
                io.1.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|e| format!("浏览器未响应，操作不会重放：{e}"))?;
            if value["id"] != id {
                continue;
            }
            if let Some(error) = value["error"].as_str() {
                return Err(error.into());
            }
            if let Some(state) = value.get("state") {
                *self.state.lock().map_err(|_| "页面状态锁异常")? = state.clone();
            }
            return Ok(value["result"].clone());
        }
    }
    fn decorated(&self, mut result: Value) -> Result<Value, String> {
        if !result.is_object() {
            result = json!({"value":result});
        }
        result["stream_url"] = self
            .proxy
            .lock()
            .map_err(|_| "画面连接锁异常")?
            .as_ref()
            .map(|p| json!(p.url))
            .unwrap_or(Value::Null);
        result["human_control"] = json!(self.gate.human.load(Ordering::Acquire));
        result["state_path"] = json!(self.lease.paths().root);
        result["input_interrupted"] = json!(self.gate.input_interrupted.load(Ordering::Acquire));
        Ok(result)
    }
    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let _request = self.admit_call()?;
        if method == "release_control" {
            return self.release_control();
        }
        if method == "open_downloads" {
            crate::browser_files::open_downloads(self.lease.paths())?;
            return Ok(json!({"opened":true}));
        }
        let readonly = matches!(method, "status" | "list_pages" | "snapshot")
            || method == "act"
                && matches!(
                    params["action"].as_str(),
                    Some("get_text" | "get_value" | "console" | "errors")
                );
        let _guard = self.gate.operation.lock().map_err(|_| "浏览器控制锁异常")?;
        let old_target = self.state.lock().map_err(|_| "页面状态锁异常")?["target_id"].clone();
        self.apply_control_gate(method, &params, &old_target, readonly)?;
        let switches = matches!(
            method,
            "new_page" | "open_page" | "select_page" | "activate_page" | "close_page" | "resize"
        ) || params.get("target_id").is_some_and(|t| t != &old_target);
        if method == "resize" && RESIZE_DIAGNOSTICS.fetch_add(1, Ordering::Relaxed) < 32 {
            eprintln!(
                "[browser-manager] resize width={} height={}",
                params["width"], params["height"]
            );
        }
        if switches {
            self.stop_stream();
        }
        // 保留原有短路顺序：准备失败立即返回，RPC 结果则在恢复画面连接后再向上传递。
        let result = match method {
            "upload_begin" => Ok(self.upload_begin(&params)?),
            "upload_chunk" => Ok(self.upload_chunk(&params)?),
            "upload_finish" => {
                self.rpc("upload", self.prepare_upload_finish(&params, &old_target)?)
            }
            "copy_selection" => Ok(self.copy_selection()?),
            "pick_upload" => match self.prepare_picked_upload(&params, &old_target)? {
                Some(request) => self.rpc("upload", request),
                None => Ok(json!({"cancelled":true})),
            },
            _ => self.rpc(method, params),
        };
        self.refresh_stream_after_call(switches, &old_target)?;
        self.decorate_call_result(method, result?)
    }

    fn admit_call(&self) -> Result<CallPermit<'_>, String> {
        // 人的连续点击不能堆积无界阻塞任务；关闭/回收不经过这份许可，始终可救援。
        self.admitted
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 9).then_some(n + 1)
            })
            .map_err(|_| "当前浏览器操作较多，请等待正在进行的操作完成后重试")?;
        Ok(CallPermit(&self.admitted))
    }

    fn release_control(&self) -> Result<Value, String> {
        let _guard = self.gate.operation.lock().map_err(|_| "浏览器控制锁异常")?;
        if self.gate.input_interrupted.load(Ordering::Acquire) {
            return Err("上次按键释放未确认，请先重新连接浏览器并核对输入状态".into());
        }
        self.gate.human.store(false, Ordering::Release);
        self.decorated(self.state.lock().map_err(|_| "页面状态锁异常")?.clone())
    }

    fn apply_control_gate(
        &self,
        method: &str,
        params: &Value,
        old_target: &Value,
        readonly: bool,
    ) -> Result<(), String> {
        let agent = params["_caller"] == "agent";
        if agent
            && self.gate.human.load(Ordering::Acquire)
            && (!readonly || params.get("target_id").is_some_and(|t| t != old_target))
        {
            return Err(
                "用户正在手动操作本会话浏览器，请等待交还控制；页面列表和当前页只读仍可用".into(),
            );
        }
        if !readonly && method != "resize" && !agent {
            self.gate.human.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn upload_begin(&self, params: &Value) -> Result<Value, String> {
        let mut upload = self.upload.lock().map_err(|_| "文件上传锁异常")?;
        if upload.is_some() {
            return Err("已有文件正在上传，请先完成或取消".into());
        }
        let name = params["name"].as_str().ok_or("缺少上传文件名")?;
        let size = params["size"].as_u64().ok_or("缺少上传文件大小")?;
        *upload = Some((
            crate::browser_files::PendingUpload::begin(self.lease.paths(), name, size)?,
            0,
        ));
        Ok(json!({"uploading":true}))
    }

    fn upload_chunk(&self, params: &Value) -> Result<Value, String> {
        let values = params["bytes"]
            .as_array()
            .filter(|a| a.len() <= 65536)
            .ok_or("上传块不能超过64KiB")?;
        let bytes: Vec<u8> =
            serde_json::from_value(Value::Array(values.clone())).map_err(|_| "上传块格式无效")?;
        let mut upload = self.upload.lock().map_err(|_| "文件上传锁异常")?;
        let (pending, received) = upload.as_mut().ok_or("上传已取消或尚未开始")?;
        if let Err(error) = pending.append(&bytes) {
            upload.take();
            return Err(error);
        }
        *received += bytes.len() as u64;
        Ok(json!({"received":*received}))
    }

    fn prepare_upload_finish(&self, params: &Value, old_target: &Value) -> Result<Value, String> {
        let kind = params["kind"].as_str().unwrap_or("input");
        if !["input", "drop", "paste"].contains(&kind) {
            return Err("文件发送方式无效".into());
        }
        let (upload, _) = self
            .upload
            .lock()
            .map_err(|_| "文件上传锁异常")?
            .take()
            .ok_or("上传已取消或尚未开始")?;
        let path = upload.finish()?;
        Ok(
            json!({"path":path,"kind":kind,"x":params["x"],"y":params["y"],"target_id":params.get("target_id").unwrap_or(old_target)}),
        )
    }

    fn copy_selection(&self) -> Result<Value, String> {
        let selected = self.rpc("act", json!({"action":"evaluate","value":"(()=>{const e=document.activeElement;return e&&typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd):String(window.getSelection()||'')})()"}))?;
        let text = selected["result"].as_str().ok_or("无法读取网页选区")?;
        crate::browser_files::copy_to_clipboard(text)?;
        Ok(json!({"copied":true}))
    }

    fn prepare_picked_upload(
        &self,
        params: &Value,
        old_target: &Value,
    ) -> Result<Option<Value>, String> {
        match crate::browser_files::pick_upload(self.lease.paths())? {
            Some(path) => Ok(Some(
                json!({"path":path,"selector":params["selector"],"target_id":old_target}),
            )),
            None => Ok(None),
        }
    }

    fn refresh_stream_after_call(&self, switches: bool, old_target: &Value) -> Result<(), String> {
        let new_target = self.state.lock().map_err(|_| "页面状态锁异常")?["target_id"].clone();
        if switches || old_target != &new_target {
            self.reset_stream()?;
        }
        Ok(())
    }

    fn decorate_call_result(&self, method: &str, result: Value) -> Result<Value, String> {
        if matches!(
            method,
            "status"
                | "list_pages"
                | "new_page"
                | "open_page"
                | "select_page"
                | "activate_page"
                | "close_page"
                | "navigate"
                | "resize"
                | "reload"
                | "back"
                | "forward"
        ) {
            self.decorated(result)
        } else {
            Ok(result)
        }
    }

    fn shutdown(&self) -> Result<(), String> {
        let _operation = self.gate.operation.lock().map_err(|_| "浏览器控制锁异常")?;
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        self.stop_stream();
        self.upload.lock().map_err(|_| "文件上传锁异常")?.take();
        // Docker停止未确认时保留进程和归属；下一次关闭继续真实核对，不能误报成功。
        self.confirm_shutdown()?;
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut io) = self.io.lock() {
            io.0.take();
        }
        if let Ok(mut child) = self.child.lock() {
            wait_child(&mut child, Duration::from_secs(25));
        }
        crate::browser_files::clear_staged_uploads(self.lease.paths())?;
        Ok(())
    }

    fn confirm_shutdown(&self) -> Result<(), String> {
        let result = self.rpc("shutdown", json!({}));
        if result.is_ok() {
            return Ok(());
        }
        let exited = self
            .child
            .lock()
            .map_err(|_| "浏览器进程锁异常")?
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exited {
            return result.map(|_| ());
        }
        // 桥接崩溃不等于Chrome退出；仍持有profile锁，以精确身份重新核对容器。
        confirm_container_cleanup(self.lease.paths())
    }
}
fn wait_child(child: &mut Child, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}
impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}
fn browser(key: &str) -> Result<Arc<Browser>, String> {
    if SHUTTING_DOWN.load(Ordering::Acquire) {
        return Err("应用正在退出，浏览器状态保留".into());
    }
    let slot = {
        let mut all = registry().lock().map_err(|_| "浏览器登记锁异常")?;
        if SHUTTING_DOWN.load(Ordering::Acquire) {
            return Err("应用正在退出，浏览器状态保留".into());
        }
        if let Some(slot) = all.get(key) {
            slot.clone()
        } else {
            if all.len() >= 4 {
                return Err("最多同时运行4个会话浏览器，请先关闭不使用的浏览器".into());
            }
            let slot = Arc::new(Slot {
                value: OnceLock::new(),
                cancelled: AtomicBool::new(false),
                cleanup: Mutex::new(None),
            });
            all.insert(key.into(), slot.clone());
            slot
        }
    };
    let result = slot
        .value
        .get_or_init(|| Browser::start(key, &slot))
        .clone();
    if result.is_err() {
        if slot
            .cleanup
            .lock()
            .map_err(|_| "浏览器清理状态锁异常")?
            .is_none()
        {
            remove_slot(key, &slot)?;
        }
        return result;
    }
    if slot.cancelled.load(Ordering::Acquire) {
        return Err("浏览器正在关闭，请重试关闭后再打开".into());
    }
    result
}

fn remove_slot(key: &str, expected: &Arc<Slot>) -> Result<(), String> {
    let mut all = registry().lock().map_err(|_| "浏览器登记锁异常")?;
    if all.get(key).is_some_and(|slot| Arc::ptr_eq(slot, expected)) {
        all.remove(key);
    }
    Ok(())
}

fn stop_browser(key: &str) -> Result<(), String> {
    let slot = registry()
        .lock()
        .map_err(|_| "浏览器登记锁异常")?
        .get(key)
        .cloned();
    let Some(slot) = slot else {
        return Ok(());
    };
    slot.cancelled.store(true, Ordering::Release);
    // 与正在初始化的同一slot汇合；启动一半时不能提前释放profile锁或启动第二个容器。
    let value = slot.value.get_or_init(|| Err("浏览器启动已取消".into()));
    if let Ok(browser) = value {
        browser.shutdown()?;
    } else {
        cleanup_failed_start(&slot)?;
    }
    remove_slot(key, &slot)
}

fn cleanup_failed_start(slot: &Slot) -> Result<(), String> {
    let mut pending = slot.cleanup.lock().map_err(|_| "浏览器清理状态锁异常")?;
    let Some(paths) = pending.as_ref() else {
        return Ok(());
    };
    let lease = ProfileLease::acquire(paths)?;
    confirm_container_cleanup(paths)?;
    remove_empty_placeholder(lease.paths())?;
    pending.take();
    Ok(())
}

fn confirm_container_cleanup(paths: &BrowserStatePaths) -> Result<(), String> {
    let config = configuration()?;
    let mut child = node_command()
        .arg(config.scripts.join("session_browser.mjs"))
        .arg("--stop-only")
        .env("AKB_BROWSER_OWNER_DIR", &paths.root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法核对未完成的浏览器清理：{e}"))?;
    let output = child.stdout.take().ok_or("无法读取清理结果")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        output.take(65536).read_to_string(&mut text).ok();
        text.lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|value| value["cleanup_complete"] == true)
    });
    wait_child(&mut child, Duration::from_secs(45));
    let success = child
        .try_wait()
        .ok()
        .flatten()
        .is_some_and(|status| status.success());
    if !reader.join().unwrap_or(false) || !success {
        return Err("容器清理尚未确认，请恢复Docker连接后重试关闭；状态文件保留".into());
    }
    Ok(())
}

fn remove_empty_placeholder(paths: &BrowserStatePaths) -> Result<(), String> {
    // 尚未创建任何网页状态的失败启动可以释放占位；完整profile/下载/manifest始终保留。
    if paths.manifest.exists() {
        return Ok(());
    }
    for directory in [&paths.profile, &paths.downloads] {
        if std::fs::read_dir(directory)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Ok(());
        }
    }
    let known = [
        "profile",
        "downloads",
        "profile.lock",
        "agent-home",
        "agent-config.json",
    ];
    for entry in std::fs::read_dir(&paths.root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !known.contains(&entry.file_name().to_string_lossy().as_ref()) {
            return Ok(());
        }
    }
    std::fs::remove_dir_all(&paths.root).map_err(|e| format!("空浏览器占位清理失败：{e}"))
}
fn prepare_environment() -> Result<Value, String> {
    let config = configuration()?;
    let cache = config.root.join("runtime-cache");
    let script = config.scripts.join("session_browser_probe/prepare.py");
    let mut child = Command::new("python3")
        .arg(script)
        .arg("--image-only")
        .arg("--output")
        .arg(cache)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法准备浏览器环境（需要Python3与Docker）：{e}"))?;
    let deadline = Instant::now() + Duration::from_secs(600);
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                Ok(json!({"prepared":true}))
            } else {
                Err("浏览器环境准备失败，请检查Docker连接和镜像网络后重试".into())
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("浏览器环境下载超时，现有会话状态仍保留".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
pub fn ensure(key: &str) -> Result<String, String> {
    Ok(browser(key)?.endpoint.clone())
}
pub fn endpoint(key: &str) -> Option<String> {
    registry()
        .lock()
        .ok()?
        .get(key)?
        .value
        .get()?
        .as_ref()
        .ok()
        .map(|b| b.endpoint.clone())
}
pub fn call(key: &str, method: &str, params: Value) -> Result<Value, String> {
    if method == "upload_cancel" {
        let existing = registry()
            .lock()
            .map_err(|_| "浏览器登记锁异常")?
            .get(key)
            .and_then(|slot| slot.value.get())
            .and_then(|b| b.as_ref().ok())
            .cloned();
        if let Some(browser) = existing {
            browser.upload.lock().map_err(|_| "文件上传锁异常")?.take();
        }
        return Ok(json!({"cancelled":true}));
    }
    if method == "prepare" {
        return prepare_environment();
    }
    if method == "stop" || method == "restart" {
        stop_browser(key)?;
        if method == "stop" {
            return Ok(json!({"stopped":true,"state_preserved":true}));
        }
        return browser(key)?.call("status", json!({}));
    }
    if ![
        "status",
        "list_pages",
        "new_page",
        "open_page",
        "close_page",
        "activate_page",
        "select_page",
        "snapshot",
        "insert_text",
        "navigate",
        "reload",
        "back",
        "forward",
        "act",
        "resize",
        "release_control",
        "copy_selection",
        "pick_upload",
        "open_downloads",
        "upload_begin",
        "upload_chunk",
        "upload_finish",
    ]
    .contains(&method)
    {
        return Err("不允许的浏览器操作".into());
    }
    browser(key)?.call(method, params)
}
pub fn shutdown_all() {
    SHUTTING_DOWN.store(true, Ordering::Release);
    let keys = registry()
        .lock()
        .map(|all| all.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    // 最多四个owner并行回收；失败启动也走同一精确清理，不能直接丢掉登记。
    std::thread::scope(|scope| {
        for key in keys {
            scope.spawn(move || {
                if let Err(error) = stop_browser(&key) {
                    eprintln!("[session-browser] 退出清理未确认：{error}");
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn fake_browser() -> Arc<Browser> {
        let root = std::env::temp_dir().join(format!("akb-stop-test-{}", std::process::id()));
        let lease =
            Arc::new(ProfileLease::acquire(&for_owner(&root, "stop-retry").unwrap()).unwrap());
        let script = "import sys,json\nn=0\nfor line in sys.stdin:\n r=json.loads(line);n+=1\n print(json.dumps({'id':r['id'],'error':'Docker暂不可用'} if n==1 else {'id':r['id'],'result':{'stopped':True}}),flush=True)\n";
        let mut child = Command::new("python3")
            .args(["-u", "-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::sync_channel(32);
        let _reader = read_replies(output, sender, lease.clone());
        Arc::new(Browser {
            child: Mutex::new(child),
            io: Mutex::new((Some(input), receiver, 0)),
            endpoint: String::new(),
            upstream: String::new(),
            lease,
            state: Mutex::new(json!({})),
            proxy: Mutex::new(None),
            gate: Arc::new(BrowserInputGate::default()),
            stopped: AtomicBool::new(false),
            upload: Mutex::new(None),
            admitted: AtomicUsize::new(0),
        })
    }

    #[test]
    fn failed_stop_retains_owner_and_retries_real_shutdown() {
        let _test = TEST_LOCK.lock().unwrap();
        let browser = fake_browser();
        let test_root = browser.lease.paths().root.parent().unwrap().to_path_buf();
        let slot = Arc::new(Slot {
            value: OnceLock::new(),
            cancelled: AtomicBool::new(false),
            cleanup: Mutex::new(None),
        });
        assert!(slot.value.set(Ok(browser.clone())).is_ok());
        registry().lock().unwrap().insert("stop-retry".into(), slot);
        assert!(call("stop-retry", "stop", json!({})).is_err());
        assert!(
            registry().lock().unwrap().contains_key("stop-retry"),
            "停止未确认时不能丢弃容器归属"
        );
        assert!(!browser.stopped.load(Ordering::Acquire));
        assert_eq!(
            call("stop-retry", "stop", json!({})).unwrap()["stopped"],
            true
        );
        assert!(browser.stopped.load(Ordering::Acquire));
        assert!(!registry().lock().unwrap().contains_key("stop-retry"));
        drop(browser);
        std::fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn failed_start_does_not_consume_live_browser_slots() {
        let _test = TEST_LOCK.lock().unwrap();
        for i in 0..6 {
            let key = format!("start-failure-{i}");
            assert!(browser(&key).is_err());
            assert!(
                !registry().lock().unwrap().contains_key(&key),
                "失败启动不能占用活跃名额"
            );
        }
    }

    #[test]
    fn owner_queue_rejects_overload_and_reopens_after_completion() {
        let _test = TEST_LOCK.lock().unwrap();
        let browser = fake_browser();
        let test_root = browser.lease.paths().root.parent().unwrap().to_path_buf();
        let permits = (0..9)
            .map(|_| browser.admit_call().unwrap())
            .collect::<Vec<_>>();
        assert!(
            browser.admit_call().is_err(),
            "执行加等候最多九个请求，不能无限堆积"
        );
        drop(permits);
        assert!(browser.admit_call().is_ok());
        drop(browser);
        std::fs::remove_dir_all(test_root).unwrap();
    }

    #[test]
    fn unconfirmed_start_cleanup_stays_owned_until_explicit_confirmation() {
        let _test = TEST_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!("akb-start-cleanup-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let agent = root.join("agent-browser");
        std::fs::write(&agent, "fixture").unwrap();
        let script = "import fs from 'node:fs';import path from 'node:path';const root=process.env.AKB_BROWSER_OWNER_DIR;if(process.argv.includes('--stop-only')){const ok=fs.existsSync(path.join(root,'..','cleanup-ok'));console.log(JSON.stringify(ok?{cleanup_complete:true}:{error:'Docker停止未确认'}));process.exit(ok?0:1)}else{console.log(JSON.stringify({ready:false,error:'恢复失败且清理未确认'}))}";
        std::fs::write(root.join("session_browser.mjs"), script).unwrap();
        let previous = CONFIG
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap()
            .clone();
        configure(root.clone(), agent, root.clone()).unwrap();
        assert!(browser("failed-cleanup").is_err());
        assert!(registry().lock().unwrap().contains_key("failed-cleanup"));
        assert!(call("failed-cleanup", "stop", json!({})).is_err());
        assert!(registry().lock().unwrap().contains_key("failed-cleanup"));
        std::fs::write(root.join("cleanup-ok"), "confirmed").unwrap();
        assert_eq!(
            call("failed-cleanup", "stop", json!({})).unwrap()["stopped"],
            true
        );
        assert!(!registry().lock().unwrap().contains_key("failed-cleanup"));
        assert!(
            !root
                .join(
                    "failed-cleanup"
                        .as_bytes()
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                )
                .exists(),
            "无数据占位应释放持久名额"
        );
        assert!(browser("failed-on-exit").is_err());
        let exit_paths = registry().lock().unwrap()["failed-on-exit"]
            .cleanup
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        shutdown_all();
        assert!(
            !exit_paths.root.exists(),
            "退出也必须核对失败启动并清理空占位"
        );
        SHUTTING_DOWN.store(false, Ordering::Release);
        *CONFIG.get().unwrap().lock().unwrap() = previous;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn crashed_bridge_uses_owned_cleanup_before_reporting_stopped() {
        let _test = TEST_LOCK.lock().unwrap();
        let browser = fake_browser();
        let test_root = browser.lease.paths().root.parent().unwrap().to_path_buf();
        let expected = serde_json::to_string(&browser.lease.paths().root).unwrap();
        std::fs::write(test_root.join("session_browser.mjs"), format!("if(!process.argv.includes('--stop-only')||process.env.AKB_BROWSER_OWNER_DIR!=={expected})process.exit(1);console.log(JSON.stringify({{cleanup_complete:true}}))")).unwrap();
        let previous = CONFIG
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap()
            .clone();
        configure(
            test_root.clone(),
            test_root.join("agent"),
            test_root.clone(),
        )
        .unwrap();
        {
            let mut child = browser.child.lock().unwrap();
            child.kill().unwrap();
            child.wait().unwrap();
        }
        assert!(
            browser.shutdown().is_ok(),
            "桥接进程崩溃后仍须能够精确关闭自己的容器"
        );
        assert!(browser.stopped.load(Ordering::Acquire));
        *CONFIG.get().unwrap().lock().unwrap() = previous;
        drop(browser);
        std::fs::remove_dir_all(test_root).unwrap();
    }
}
