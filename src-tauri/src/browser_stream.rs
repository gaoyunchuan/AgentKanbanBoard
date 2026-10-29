//! 仅在本机转发同一浏览器会话的画面和输入。

use std::fs::File;
use std::io::{self, Read};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex, TryLockError,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tungstenite::{
    handshake::{
        server::{Request, Response},
        HandshakeError, HandshakeRole,
    },
    http::{StatusCode, Uri},
    Message, WebSocket,
};

static DIAGNOSTIC_LINES: AtomicUsize = AtomicUsize::new(0);

const UPSTREAM_PATH: &str = "/?pacing=ack&maxFps=30";
const MAX_MESSAGE: usize = 2 * 1024 * 1024;
const MAX_CONTROL: usize = 16 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(200);
const WRITE_TIMEOUT: Duration = Duration::from_millis(20);

#[derive(Default)]
pub struct BrowserInputGate {
    pub operation: Mutex<()>,
    pub human: AtomicBool,
    /// 断连时无法确认已释放按键，管理器必须先恢复输入状态再交回 Agent。
    pub input_interrupted: AtomicBool,
}

pub struct StreamProxy {
    pub url: String,
    state: Arc<ProxyState>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct ProxyState {
    active: AtomicBool,
    sockets: Mutex<Vec<TcpStream>>,
}

impl ProxyState {
    fn register(&self, sockets: &[&TcpStream]) -> io::Result<()> {
        let copies = sockets
            .iter()
            .map(|socket| socket.try_clone())
            .collect::<io::Result<Vec<_>>>()?;
        let mut registered = self
            .sockets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *registered = copies;
        if !self.active.load(Ordering::SeqCst) {
            for socket in registered.iter() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
        Ok(())
    }

    fn shutdown(&self) {
        if self.active.swap(false, Ordering::SeqCst) {
            emit_diagnostic("proxy_stop_requested", "none");
        }
        let registered = self
            .sockets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for socket in registered.iter() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

impl StreamProxy {
    pub fn start(upstream: &str, gate: Arc<BrowserInputGate>) -> Result<Self, String> {
        let address = upstream_address(upstream)?;
        let path = random_path().map_err(|error| format!("生成画面连接令牌失败：{error}"))?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("启动画面代理失败：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let url = format!(
            "ws://{}{}",
            listener.local_addr().map_err(|error| error.to_string())?,
            path
        );
        let state = Arc::new(ProxyState {
            active: AtomicBool::new(true),
            sockets: Mutex::new(Vec::new()),
        });
        let worker_state = state.clone();
        let endpoint = format!("ws://{address}{UPSTREAM_PATH}");
        let worker = thread::Builder::new()
            .name("browser-stream".into())
            .spawn(move || {
                serve(listener, &path, &endpoint, address, &worker_state, &gate);
            })
            .map_err(|error| format!("启动画面线程失败：{error}"))?;
        Ok(Self {
            url,
            state,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn stop(&self) {
        self.state.shutdown();
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl Drop for StreamProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

fn upstream_address(endpoint: &str) -> Result<SocketAddr, String> {
    let uri: Uri = endpoint.parse().map_err(|_| "浏览器画面地址无效")?;
    let authority = uri.authority().ok_or("浏览器画面地址缺少端口")?;
    let port = authority
        .port_u16()
        .filter(|port| *port != 0)
        .ok_or("浏览器画面地址缺少有效端口")?;
    if uri.scheme_str() != Some("ws")
        || authority.as_str() != format!("127.0.0.1:{port}")
        || !matches!(
            uri.path_and_query().map(|path| path.as_str()),
            Some("/" | UPSTREAM_PATH)
        )
    {
        return Err("浏览器画面仅允许本机固定 streaming 地址".into());
    }
    Ok(SocketAddr::from(([127, 0, 0, 1], port)))
}

fn random_path() -> io::Result<String> {
    let mut bytes = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(format!(
        "/{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn socket_config(control: bool) -> tungstenite::protocol::WebSocketConfig {
    tungstenite::protocol::WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_MESSAGE + 32)
        .max_message_size(Some(if control { MAX_CONTROL } else { MAX_MESSAGE }))
        .max_frame_size(Some(if control { MAX_CONTROL } else { MAX_MESSAGE }))
}

fn trusted_origin(origin: Option<&str>) -> bool {
    matches!(
        origin,
        Some(
            "tauri://localhost"
                | "http://tauri.localhost"
                | "https://tauri.localhost"
                | "http://127.0.0.1:5173"
                | "http://127.0.0.1:5178"
        )
    )
}

fn accept_ui(
    stream: TcpStream,
    path: &str,
    state: &ProxyState,
) -> Result<WebSocket<TcpStream>, String> {
    stream
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let check = |request: &Request, response: Response| {
        let origin = request
            .headers()
            .get("Origin")
            .and_then(|value| value.to_str().ok());
        if request.uri().path_and_query().map(|path| path.as_str()) == Some(path)
            && trusted_origin(origin)
        {
            Ok(response)
        } else {
            Err(tungstenite::http::Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Some("画面连接来源或令牌无效".into()))
                .unwrap())
        }
    };
    finish_handshake(
        tungstenite::accept_hdr_with_config(stream, check, Some(socket_config(true))),
        state,
    )
}

// 握手可能分多次读取；非阻塞续跑同时保证绝对截止，避免慢连接反复刷新超时。
fn finish_handshake<Role: HandshakeRole>(
    mut result: Result<Role::FinalResult, HandshakeError<Role>>,
    state: &ProxyState,
) -> Result<Role::FinalResult, String> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        match result {
            Ok(value) => return Ok(value),
            Err(HandshakeError::Failure(error)) => return Err(error.to_string()),
            Err(HandshakeError::Interrupted(handshake)) => {
                if !state.active.load(Ordering::SeqCst) || Instant::now() >= deadline {
                    return Err("画面连接握手超时或已停止".into());
                }
                thread::sleep(Duration::from_millis(2));
                result = handshake.handshake();
            }
        }
    }
}

fn serve(
    listener: TcpListener,
    path: &str,
    endpoint: &str,
    address: SocketAddr,
    state: &ProxyState,
    gate: &BrowserInputGate,
) {
    let mut pair: Option<ConnectionPair> = None;
    while state.active.load(Ordering::SeqCst) {
        if let Ok((stream, _)) = listener.accept() {
            let current = pair
                .as_ref()
                .map(|pair| vec![pair.ui.get_ref(), pair.upstream.get_ref(), &stream])
                .unwrap_or_else(|| vec![&stream]);
            if state.register(&current).is_ok() {
                if let Ok(ui) = accept_ui(stream, path, state) {
                    if pair.is_some() {
                        emit_diagnostic("replaced_by_new_ui", "none");
                    }
                    close_pair(&mut pair, state, gate);
                    pair = match ConnectionPair::connect(ui, endpoint, address, state) {
                        Ok(pair) => {
                            emit_diagnostic("connected", "none");
                            Some(pair)
                        }
                        Err(_) => {
                            emit_diagnostic("upstream_connect_failed", "redacted");
                            None
                        }
                    };
                }
            }
            register_pair(&pair, state);
        }
        if pair
            .as_mut()
            .is_some_and(|pair| pair.tick(state, gate).is_err())
        {
            close_pair(&mut pair, state, gate);
            register_pair(&pair, state);
        }
        thread::sleep(Duration::from_millis(3));
    }
    if pair.is_some() {
        emit_diagnostic("proxy_stopped", "none");
    }
    close_pair(&mut pair, state, gate);
}

fn register_pair(pair: &Option<ConnectionPair>, state: &ProxyState) {
    let sockets = pair
        .as_ref()
        .map(|pair| vec![pair.ui.get_ref(), pair.upstream.get_ref()])
        .unwrap_or_default();
    let _ = state.register(&sockets);
}

fn close_pair(pair: &mut Option<ConnectionPair>, state: &ProxyState, gate: &BrowserInputGate) {
    if let Some(mut pair) = pair.take() {
        pair.close(state, gate);
    }
}

struct ConnectionPair {
    ui: WebSocket<TcpStream>,
    upstream: WebSocket<TcpStream>,
    ui_pending: bool,
    pending_input: Option<Message>,
    pressed: Vec<serde_json::Value>,
}

impl ConnectionPair {
    fn connect(
        ui: WebSocket<TcpStream>,
        endpoint: &str,
        address: SocketAddr,
        state: &ProxyState,
    ) -> Result<Self, String> {
        let stream = TcpStream::connect_timeout(&address, HANDSHAKE_TIMEOUT)
            .map_err(|error| error.to_string())?;
        state
            .register(&[ui.get_ref(), &stream])
            .map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(WRITE_TIMEOUT))
            .map_err(|error| error.to_string())?;
        stream
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let (upstream, _) = finish_handshake(
            tungstenite::client::client_with_config(endpoint, stream, Some(socket_config(false))),
            state,
        )?;
        ui.get_ref()
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        upstream
            .get_ref()
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            ui,
            upstream,
            ui_pending: false,
            pending_input: None,
            pressed: Vec::new(),
        })
    }

    fn tick(&mut self, state: &ProxyState, gate: &BrowserInputGate) -> Result<(), ()> {
        self.forward_control(state, gate)?;
        self.flush_ui()?;
        if !self.ui_pending {
            match self.upstream.read() {
                Ok(Message::Close(frame)) => {
                    diagnose_close("upstream_close", frame.as_ref());
                    return Err(());
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Ok(message) => self.send_ui(message)?,
                Err(error) if would_block(&error) => {}
                Err(error) => {
                    diagnose_error("upstream_read", &error);
                    return Err(());
                }
            }
        }
        Ok(())
    }

    fn forward_control(&mut self, state: &ProxyState, gate: &BrowserInputGate) -> Result<(), ()> {
        let message = if let Some(message) = self.pending_input.take() {
            message
        } else {
            match self.ui.read() {
                Ok(Message::Close(frame)) => {
                    diagnose_close("ui_close", frame.as_ref());
                    return Err(());
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => return Ok(()),
                Ok(message) => message,
                Err(error) if would_block(&error) => return Ok(()),
                Err(error) => {
                    diagnose_error("ui_read", &error);
                    return Err(());
                }
            }
        };
        let Message::Text(text) = &message else {
            emit_diagnostic("ui_control_not_text", "none");
            return Err(());
        };
        let value: serde_json::Value = serde_json::from_str(text.as_str()).map_err(|_| {
            emit_diagnostic("ui_control_invalid_json", "none");
        })?;
        let input = matches!(
            value.get("type").and_then(|value| value.as_str()),
            Some("input_mouse" | "input_keyboard" | "input_touch")
        );
        if input {
            let _operation = match gate.operation.try_lock() {
                Ok(guard) => guard,
                Err(TryLockError::WouldBlock) => {
                    self.pending_input = Some(message);
                    return Ok(());
                }
                Err(TryLockError::Poisoned(_)) => {
                    emit_diagnostic("input_gate_poisoned", "none");
                    return Err(());
                }
            };
            if !state.active.load(Ordering::SeqCst) {
                return Err(());
            }
            gate.human.store(true, Ordering::SeqCst);
            self.track_pressed(&value).map_err(|_| {
                emit_diagnostic("pressed_input_limit", "none");
            })?;
            let result = self.send_upstream(message);
            if result.is_err() {
                gate.input_interrupted.store(true, Ordering::SeqCst);
            }
            result
        } else if state.active.load(Ordering::SeqCst) {
            self.send_upstream(message)
        } else {
            Err(())
        }
    }

    fn send_upstream(&mut self, message: Message) -> Result<(), ()> {
        // 上游控制写入使用短超时；一旦部分写失败立即断开，禁止在失去变更锁后补发输入。
        self.upstream
            .get_ref()
            .set_nonblocking(false)
            .map_err(|_| ())?;
        let result = self.upstream.send(message).map_err(|error| {
            diagnose_error("upstream_send", &error);
        });
        self.upstream
            .get_ref()
            .set_nonblocking(true)
            .map_err(|_| ())?;
        result
    }

    fn send_ui(&mut self, message: Message) -> Result<(), ()> {
        match self.ui.send(message) {
            Ok(()) => Ok(()),
            Err(error) if would_block(&error) => {
                self.ui_pending = true;
                Ok(())
            }
            Err(error) => {
                diagnose_error("ui_send", &error);
                Err(())
            }
        }
    }

    fn flush_ui(&mut self) -> Result<(), ()> {
        if !self.ui_pending {
            return Ok(());
        }
        match self.ui.flush() {
            Ok(()) => {
                self.ui_pending = false;
                Ok(())
            }
            Err(error) if would_block(&error) => Ok(()),
            Err(error) => {
                diagnose_error("ui_flush", &error);
                Err(())
            }
        }
    }

    fn track_pressed(&mut self, value: &serde_json::Value) -> Result<(), ()> {
        let kind = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let event = value
            .get("eventType")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let identity = |pressed: &serde_json::Value| {
            pressed.get("type") == value.get("type")
                && match kind {
                    "input_keyboard" => {
                        pressed.get("key") == value.get("key")
                            && pressed.get("code") == value.get("code")
                    }
                    "input_mouse" => pressed.get("button") == value.get("button"),
                    _ => true,
                }
        };
        match event {
            "keyDown" | "mousePressed" | "touchStart" => {
                if !self.pressed.iter().any(identity) {
                    let limit = if kind == "input_keyboard" { 32 } else { 8 };
                    if self
                        .pressed
                        .iter()
                        .filter(|pressed| pressed.get("type") == value.get("type"))
                        .count()
                        >= limit
                    {
                        return Err(());
                    }
                    self.pressed.push(value.clone());
                }
            }
            "keyUp" | "mouseReleased" | "touchEnd" => {
                self.pressed.retain(|pressed| !identity(pressed))
            }
            _ => {}
        }
        Ok(())
    }

    fn close(&mut self, state: &ProxyState, gate: &BrowserInputGate) {
        if !self.pressed.is_empty() {
            let operation = gate.operation.try_lock();
            let can_release = state.active.load(Ordering::SeqCst) && operation.is_ok();
            let mut released = can_release;
            for mut input in std::mem::take(&mut self.pressed) {
                let event = match input.get("type").and_then(|kind| kind.as_str()) {
                    Some("input_keyboard") => "keyUp",
                    Some("input_mouse") => "mouseReleased",
                    _ => {
                        input["touchPoints"] = serde_json::json!([]);
                        "touchEnd"
                    }
                };
                input["eventType"] = event.into();
                if can_release
                    && self
                        .send_upstream(Message::text(input.to_string()))
                        .is_err()
                {
                    released = false;
                }
            }
            if !released {
                gate.input_interrupted.store(true, Ordering::SeqCst);
            }
        }
        let _ = self.ui.get_ref().shutdown(Shutdown::Both);
        let _ = self.upstream.get_ref().shutdown(Shutdown::Both);
    }
}

// 只记录固定阶段、错误类别和数值，不输出地址、令牌、页面内容或上游错误原文。
// 每个进程最多 128 条诊断及一次上限提示，防止连续重连或无效输入使日志无界增长。
fn emit_diagnostic(stage: &'static str, detail: &str) {
    let count = DIAGNOSTIC_LINES.fetch_add(1, Ordering::Relaxed);
    if count < 128 {
        eprintln!(
            "[browser-stream] thread={:?} stage={stage} detail={detail}",
            thread::current().id()
        );
    } else if count == 128 {
        eprintln!("[browser-stream] diagnostic_limit_reached");
    }
}

fn diagnose_close(stage: &'static str, frame: Option<&tungstenite::protocol::CloseFrame>) {
    let code = frame.map(|frame| u16::from(frame.code));
    emit_diagnostic(stage, &format!("close_code={code:?}"));
}

fn diagnose_error(stage: &'static str, error: &tungstenite::Error) {
    use tungstenite::error::{CapacityError, ProtocolError};
    let detail = match error {
        tungstenite::Error::Io(error) => format!(
            "io_kind={:?},os_code={:?}",
            error.kind(),
            error.raw_os_error()
        ),
        tungstenite::Error::Capacity(CapacityError::MessageTooLong { size, max_size }) => {
            format!("message_too_long,size={size},max={max_size}")
        }
        tungstenite::Error::Capacity(_) => "capacity".into(),
        tungstenite::Error::Protocol(ProtocolError::ResetWithoutClosingHandshake) => {
            "reset_without_close_handshake".into()
        }
        tungstenite::Error::Protocol(_) => "protocol".into(),
        tungstenite::Error::WriteBufferFull(message) => {
            format!("write_buffer_full,size={}", message.len())
        }
        tungstenite::Error::ConnectionClosed => "connection_closed".into(),
        tungstenite::Error::AlreadyClosed => "already_closed".into(),
        tungstenite::Error::Utf8(_) => "invalid_utf8".into(),
        tungstenite::Error::AttackAttempt => "attack_attempt".into(),
        tungstenite::Error::Http(response) => format!("http_status={}", response.status().as_u16()),
        _ => "other".into(),
    };
    emit_diagnostic(stage, &detail);
}

fn would_block(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tungstenite::{client::IntoClientRequest, Message, WebSocket};

    fn client(url: &str, origin: Option<&str>) -> tungstenite::Result<WebSocket<TcpStream>> {
        let mut request = url.into_client_request()?;
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("Origin", origin.parse().unwrap());
        }
        let stream = TcpStream::connect(request.uri().authority().unwrap().as_str())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        tungstenite::client(request, stream)
            .map(|(socket, _)| socket)
            .map_err(|error| match error {
                tungstenite::HandshakeError::Failure(error) => error,
                _ => unreachable!(),
            })
    }

    fn fixture() -> (TcpListener, StreamProxy, Arc<BrowserInputGate>) {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let gate = Arc::new(BrowserInputGate::default());
        let proxy = StreamProxy::start(
            &format!("ws://{}/", upstream.local_addr().unwrap()),
            gate.clone(),
        )
        .unwrap();
        (upstream, proxy, gate)
    }

    fn upstream(listener: &TcpListener) -> WebSocket<TcpStream> {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(150)))
            .unwrap();
        tungstenite::accept(stream).unwrap()
    }

    #[test]
    fn forwards_frames_without_acknowledging_before_ui_draws() {
        let (listener, proxy, gate) = fixture();
        let mut ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
        let mut agent = upstream(&listener);
        let frame = Message::text(r#"{"type":"frame","data":"jpeg","seq":7}"#);
        agent.send(frame.clone()).unwrap();
        assert_eq!(ui.read().unwrap(), frame);
        assert!(
            matches!(agent.read(), Err(tungstenite::Error::Io(error)) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut))
        );
        let ack = Message::text(r#"{"type":"ack","seq":7}"#);
        ui.send(ack.clone()).unwrap();
        assert_eq!(agent.read().unwrap(), ack);
        let input = Message::text(r#"{"type":"input_keyboard","eventType":"keyDown","key":"a"}"#);
        ui.send(input.clone()).unwrap();
        assert_eq!(agent.read().unwrap(), input);
        assert!(gate.human.load(Ordering::SeqCst));
        proxy.stop();
        let _ = ui.send(Message::text(
            r#"{"type":"input_mouse","eventType":"mousePressed"}"#,
        ));
        assert!(agent.read().is_err());
        assert!(gate.input_interrupted.load(Ordering::SeqCst));
        assert!(client(&proxy.url, Some("tauri://localhost")).is_err());
    }

    #[test]
    fn rejects_untrusted_origin_missing_origin_and_wrong_token() {
        let (_listener, proxy, _) = fixture();
        for origin in [
            None,
            Some("null"),
            Some("https://evil.example"),
            Some("http://127.0.0.1:51730"),
            Some("https://tauri.localhost.evil.example"),
        ] {
            assert!(client(&proxy.url, origin).is_err(), "origin: {origin:?}");
        }
        assert!(client(&format!("{}wrong", proxy.url), Some("tauri://localhost")).is_err());
    }

    #[test]
    fn websocket_heartbeat_does_not_drop_the_control_connection() {
        let (listener, proxy, _) = fixture();
        let mut ui = client(&proxy.url, Some("http://127.0.0.1:5178")).unwrap();
        let mut agent = upstream(&listener);
        ui.send(Message::Ping(vec![1, 2, 3].into())).unwrap();
        assert_eq!(ui.read().unwrap(), Message::Pong(vec![1, 2, 3].into()));
        ui.send(Message::text(r#"{"type":"ack","sessionId":1}"#))
            .unwrap();
        assert_eq!(
            agent.read().unwrap(),
            Message::text(r#"{"type":"ack","sessionId":1}"#)
        );
    }

    #[test]
    fn oversized_ui_control_never_reaches_the_browser() {
        let (listener, proxy, _) = fixture();
        let mut ui = client(&proxy.url, Some("https://tauri.localhost")).unwrap();
        let mut agent = upstream(&listener);
        ui.send(Message::text("x".repeat(16 * 1024 + 1))).unwrap();
        assert!(agent.read().is_err());
        assert!(ui.read().is_err());
    }

    #[test]
    fn oversized_upstream_frame_closes_instead_of_buffering_it() {
        let (listener, proxy, _) = fixture();
        let mut ui = client(&proxy.url, Some("http://tauri.localhost")).unwrap();
        let mut agent = upstream(&listener);
        let _ = agent.send(Message::Binary(vec![0; 2 * 1024 * 1024 + 1].into()));
        assert!(ui.read().is_err());
    }

    #[test]
    fn reconnect_replaces_old_transport_and_releases_held_keys() {
        let (listener, proxy, gate) = fixture();
        let mut ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
        let mut agent = upstream(&listener);
        ui.send(Message::text(r#"{"type":"input_keyboard","eventType":"keyDown","key":"a","code":"KeyA","modifiers":0}"#)).unwrap();
        agent.read().unwrap();
        for iteration in 0..12 {
            let next_ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
            let next_agent = upstream(&listener);
            if iteration == 0 {
                assert_eq!(
                    agent.read().unwrap(),
                    Message::text(
                        r#"{"code":"KeyA","eventType":"keyUp","key":"a","modifiers":0,"type":"input_keyboard"}"#
                    )
                );
            }
            assert!(agent.read().is_err());
            assert!(ui.read().is_err());
            ui = next_ui;
            agent = next_agent;
        }
        assert!(!gate.input_interrupted.load(Ordering::SeqCst));
        agent
            .send(Message::text(
                r#"{"type":"status","url":"https://example.com","tabs":[]}"#,
            ))
            .unwrap();
        assert_eq!(
            ui.read().unwrap(),
            Message::text(r#"{"type":"status","url":"https://example.com","tabs":[]}"#)
        );
    }

    #[test]
    fn stop_while_manager_holds_operation_lock_does_not_deadlock_or_send_pending_input() {
        let (listener, proxy, gate) = fixture();
        let mut ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
        let mut agent = upstream(&listener);
        let _operation = gate.operation.lock().unwrap();
        ui.send(Message::text(
            r#"{"type":"input_mouse","eventType":"mousePressed","x":1,"y":2,"button":"left"}"#,
        ))
        .unwrap();
        assert!(agent.read().is_err());
        let start = std::time::Instant::now();
        proxy.stop();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(!gate.human.load(Ordering::SeqCst));
        assert!(agent.read().is_err());
    }

    #[test]
    fn stalled_frame_consumer_does_not_starve_human_input() {
        let (listener, proxy, gate) = fixture();
        let mut ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
        let mut agent = upstream(&listener);
        agent
            .get_ref()
            .set_write_timeout(Some(Duration::from_millis(150)))
            .unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (input_tx, input_rx) = std::sync::mpsc::channel();
        let producer = std::thread::spawn(move || {
            // UI 故意不读取画面，真实 TCP 写入背压后再验证反向输入仍可到达。
            let frame = Message::Binary(vec![1; 1024 * 1024].into());
            let mut blocked = false;
            for _ in 0..64 {
                if let Err(error) = agent.send(frame.clone()) {
                    blocked = would_block(&error);
                    break;
                }
            }
            ready_tx.send(blocked).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match agent.read() {
                    Ok(message) => {
                        input_tx.send(message).unwrap();
                        return;
                    }
                    Err(error) if would_block(&error) => {}
                    Err(_) => return,
                }
            }
        });
        assert!(ready_rx.recv_timeout(Duration::from_secs(3)).unwrap());
        let input = Message::text(r#"{"type":"input_mouse","eventType":"mouseMoved","x":4,"y":8}"#);
        ui.send(input.clone()).unwrap();
        assert_eq!(
            input_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            input
        );
        assert!(gate.human.load(Ordering::SeqCst));
        proxy.stop();
        producer.join().unwrap();
    }

    #[test]
    fn fragmented_valid_handshake_remains_open_until_headers_complete() {
        use std::io::{Read, Write};
        let (_listener, proxy, _) = fixture();
        let uri: tungstenite::http::Uri = proxy.url.parse().unwrap();
        let mut socket = TcpStream::connect(uri.authority().unwrap().as_str()).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        socket
            .write_all(format!("GET {} HTTP/1.1\r\n", uri.path()).as_bytes())
            .unwrap();
        // 刻意把一次有效握手拆成两段，覆盖非阻塞 socket 的 Interrupted 状态。
        std::thread::sleep(Duration::from_millis(40));
        let headers = format!("Host: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: tauri://localhost\r\n\r\n", uri.authority().unwrap());
        socket.write_all(headers.as_bytes()).unwrap();
        let mut response = [0_u8; 1024];
        let count = socket.read(&mut response).unwrap();
        assert!(String::from_utf8_lossy(&response[..count]).starts_with("HTTP/1.1 101"));
    }

    #[test]
    fn incomplete_handshake_has_an_absolute_deadline() {
        let (listener, proxy, _) = fixture();
        let mut ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
        let mut agent = upstream(&listener);
        let uri: tungstenite::http::Uri = proxy.url.parse().unwrap();
        let mut slow = TcpStream::connect(uri.authority().unwrap().as_str()).unwrap();
        slow.set_write_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let dripper = std::thread::spawn(move || {
            use std::io::Write;
            for (index, byte) in b"GET / HTTP/1.1\r\n".iter().enumerate() {
                if slow.write_all(&[*byte]).is_err() {
                    break;
                }
                if index == 1 {
                    let _ = ready_tx.send(());
                }
                std::thread::sleep(Duration::from_millis(75));
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let expected = Message::text(r#"{"type":"ack","sessionId":3}"#);
        ui.send(expected.clone()).unwrap();
        agent
            .get_ref()
            .set_read_timeout(Some(Duration::from_millis(650)))
            .unwrap();
        assert_eq!(agent.read().unwrap(), expected);
        proxy.stop();
        dripper.join().unwrap();
    }

    #[test]
    fn upstream_requests_ack_pacing_with_a_fixed_frame_limit() {
        let (listener, proxy, _) = fixture();
        let _ui = client(&proxy.url, Some("tauri://localhost")).unwrap();
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut requested = String::new();
        let _agent = tungstenite::accept_hdr(stream, |request: &Request, response: Response| {
            requested = request.uri().to_string();
            Ok(response)
        })
        .unwrap();
        assert_eq!(requested, "/?pacing=ack&maxFps=30");
    }

    #[test]
    fn rejects_nonlocal_or_unexpected_upstream_endpoints() {
        for url in [
            "ws://example.com:3000/",
            "wss://127.0.0.1:3000/",
            "ws://localhost:3000/",
            "ws://127.0.0.1:3000/unknown",
            "ws://127.0.0.1:3000/?target=evil",
            "ws://127.0.0.1:0/",
        ] {
            assert!(
                StreamProxy::start(url, Arc::default()).is_err(),
                "url: {url}"
            );
        }
    }
}
