//! 应用进程内的会话浏览器 MCP HTTP 网关。
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::io::{BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_HEADER: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;
const MAX_RESULT: usize = 512 * 1024;
const MAX_OWNER: usize = 512;
const WORKERS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const PROTOCOLS: [&str; 3] = ["2025-03-26", "2025-06-18", "2025-11-25"];
const OPERATIONS: [&str; 6] = [
    "list_pages",
    "open_page",
    "select_page",
    "close_page",
    "snapshot",
    "act",
];
type BrowserCall = dyn Fn(&str, &str, Value) -> Result<Value, String> + Send + Sync;
static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();

struct Server {
    address: SocketAddr,
    secret: [u8; 32],
    stopped: Arc<AtomicBool>,
    acceptor: Option<JoinHandle<()>>,
    workers: Vec<JoinHandle<()>>,
}

// 一个应用仅持有一个监听器；配置生成不触碰 Docker、Chrome 或历史会话注册表。
pub fn server_config(owner: &str) -> Result<Value, String> {
    if owner.is_empty() || owner.len() > MAX_OWNER {
        return Err("浏览器会话标识为空或超长".into());
    }
    let mut slot = SERVER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "浏览器 MCP 服务锁异常")?;
    if slot.is_none() {
        *slot = Some(Server::start(Arc::new(crate::browser_bridge::call))?);
    }
    let server = slot.as_ref().ok_or("浏览器 MCP 服务未启动")?;
    Ok(json!({
        "url": server.owner_url(owner), "enabled": true, "required": false,
        "startup_timeout_sec": 10, "tool_timeout_sec": 60
    }))
}

pub fn shutdown() {
    if let Some(slot) = SERVER.get() {
        if let Ok(mut slot) = slot.lock() {
            if let Some(mut server) = slot.take() {
                server.stop();
            }
        }
    }
}

impl Server {
    fn start(call: Arc<BrowserCall>) -> Result<Self, String> {
        let mut secret = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut secret))
            .map_err(|error| format!("无法生成浏览器 MCP 凭据：{error}"))?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("无法监听浏览器 MCP：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let stopped = Arc::new(AtomicBool::new(false));
        // 许可同时覆盖排队与执行，避免线程调度间隙误拒绝请求；总连接严格不超过 32。
        let admitted = Arc::new(AtomicUsize::new(0));
        let (sender, receiver) = mpsc::sync_channel::<Connection>(WORKERS);
        let receiver = Arc::new(Mutex::new(receiver));
        let mut server = Self {
            address,
            secret,
            stopped: stopped.clone(),
            acceptor: None,
            workers: Vec::new(),
        };
        for index in 0..WORKERS {
            let receiver = receiver.clone();
            let call = call.clone();
            let worker = thread::Builder::new()
                .name(format!("browser-mcp-{index}"))
                .spawn(move || {
                    worker_loop(receiver, address, secret, call);
                });
            match worker {
                Ok(worker) => server.workers.push(worker),
                Err(error) => {
                    drop(sender);
                    server.stop();
                    return Err(format!("无法启动浏览器 MCP 工作线程：{error}"));
                }
            }
        }
        server.acceptor = Some(
            thread::Builder::new()
                .name("browser-mcp-listen".into())
                .spawn(move || {
                    accept_loop(listener, sender, stopped, admitted);
                })
                .map_err(|error| format!("无法启动浏览器 MCP 监听线程：{error}"))?,
        );
        Ok(server)
    }

    fn owner_url(&self, owner: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC 接受固定长度密钥");
        mac.update(owner.as_bytes());
        format!(
            "http://{}/mcp/{}/{}",
            self.address,
            hex_encode(owner.as_bytes()),
            hex_encode(&mac.finalize().into_bytes())
        )
    }

    fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(acceptor) = self.acceptor.take() {
            let _ = acceptor.join();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

struct Connection {
    stream: TcpStream,
    admitted: Arc<AtomicUsize>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.admitted.fetch_sub(1, Ordering::AcqRel);
    }
}

fn accept_loop(
    listener: TcpListener,
    sender: mpsc::SyncSender<Connection>,
    stopped: Arc<AtomicBool>,
    admitted: Arc<AtomicUsize>,
) {
    while !stopped.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // macOS 的 accept 可能继承监听器非阻塞标志，必须恢复阻塞才能应用 socket 超时。
                if stream.set_nonblocking(false).is_err() {
                    continue;
                }
                let permitted = admitted
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                        (current < WORKERS).then_some(current + 1)
                    })
                    .is_ok();
                if permitted {
                    let _ = sender.try_send(Connection {
                        stream,
                        admitted: admitted.clone(),
                    });
                } else {
                    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
                    let _ = write_response(
                        &mut stream,
                        503,
                        json!({"error":"浏览器 MCP 并发已满，请稍后重试"}),
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(_) => break,
        }
    }
}

fn worker_loop(
    receiver: Arc<Mutex<mpsc::Receiver<Connection>>>,
    address: SocketAddr,
    secret: [u8; 32],
    call: Arc<BrowserCall>,
) {
    loop {
        let stream = match receiver.lock() {
            Ok(receiver) => receiver.recv(),
            Err(_) => return,
        };
        let Ok(mut connection) = stream else { return };
        let stream = &mut connection.stream;
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
        let response = handle_http(stream, address, &secret, call.as_ref());
        let (status, body) = match response {
            Ok(response) => response,
            Err((status, error)) => (status, json!({"error":error})),
        };
        let _ = write_response(stream, status, body);
    }
}

type HttpError = (u16, String);
struct Request {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn handle_http(
    stream: &mut TcpStream,
    address: SocketAddr,
    secret: &[u8; 32],
    call: &BrowserCall,
) -> Result<(u16, Value), HttpError> {
    let request = read_request(stream)?;
    validate_headers(&request, address)?;
    let owner = authenticate_owner(&request.path, secret).map_err(|error| (403, error))?;
    if request.method != "POST" {
        return Err((405, "此 MCP 端点仅支持 POST；不提供 GET/SSE".into()));
    }
    if !request.headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return Err((415, "MCP 请求需要 application/json".into()));
    }
    let message: Value = match serde_json::from_slice(&request.body) {
        Ok(message) => message,
        Err(_) => return Ok((400, rpc_error(Value::Null, -32700, "MCP JSON 解析失败"))),
    };
    Ok(match dispatch_message(&owner, message, call) {
        Some(response) => (200, response),
        None => (202, Value::Null),
    })
}

fn read_request(stream: &mut TcpStream) -> Result<Request, HttpError> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut reader = BufReader::new(stream);
    let head = read_header(&mut reader, deadline)?;
    let mut request = parse_request_head(&head)?;
    request.body = read_body(&mut reader, &request.headers, deadline)?;
    Ok(request)
}

fn read_header(
    reader: &mut BufReader<&mut TcpStream>,
    deadline: Instant,
) -> Result<Vec<u8>, HttpError> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEADER {
            return Err((431, "MCP 请求头超过 16 KiB".into()));
        }
        prepare_read(reader, deadline)?;
        let mut byte = [0u8];
        reader.read_exact(&mut byte).map_err(read_error)?;
        head.push(byte[0]);
    }
    Ok(head)
}

fn prepare_read(reader: &BufReader<&mut TcpStream>, deadline: Instant) -> Result<(), HttpError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or((408, "MCP 请求读取超时".into()))?;
    if reader.buffer().is_empty() {
        reader
            .get_ref()
            .set_read_timeout(Some(remaining))
            .map_err(read_error)?;
    }
    Ok(())
}

fn parse_request_head(head: &[u8]) -> Result<Request, HttpError> {
    let text = std::str::from_utf8(head).map_err(|_| (400, "HTTP 请求头编码无效".into()))?;
    let mut lines = text.split("\r\n");
    let (method, path) = parse_request_line(lines.next().unwrap_or(""))?;
    let headers = parse_headers(lines.filter(|line| !line.is_empty()))?;
    Ok(Request {
        method,
        path,
        headers,
        body: Vec::new(),
    })
}

fn parse_request_line(line: &str) -> Result<(String, String), HttpError> {
    let mut parts = line.split_whitespace();
    let (Some(method), Some(path), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err((400, "HTTP 请求行无效".into()));
    };
    if version != "HTTP/1.1" {
        return Err((400, "仅支持 HTTP/1.1".into()));
    }
    Ok((method.into(), path.into()))
}

fn parse_headers<'a>(
    lines: impl Iterator<Item = &'a str>,
) -> Result<BTreeMap<String, String>, HttpError> {
    let mut headers = BTreeMap::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or((400, "HTTP 请求头无效".into()))?;
        let name = name.to_ascii_lowercase();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || headers.insert(name, value.trim().to_string()).is_some()
        {
            return Err((400, "HTTP 请求头重复或无效".into()));
        }
    }
    Ok(headers)
}

fn read_body(
    reader: &mut BufReader<&mut TcpStream>,
    headers: &BTreeMap<String, String>,
    deadline: Instant,
) -> Result<Vec<u8>, HttpError> {
    if headers.contains_key("transfer-encoding") {
        return Err((400, "不支持 HTTP 分块请求".into()));
    }
    let length = headers
        .get("content-length")
        .map(|value| value.parse::<usize>())
        .transpose()
        .map_err(|_| (400, "Content-Length 无效".into()))?
        .unwrap_or(0);
    if length > MAX_BODY {
        return Err((413, "MCP 请求体超过 1 MiB".into()));
    }
    let mut body = vec![0; length];
    let mut read = 0;
    while read < length {
        prepare_read(reader, deadline)?;
        let count = reader.read(&mut body[read..]).map_err(read_error)?;
        if count == 0 {
            return Err((400, "MCP 请求体不完整".into()));
        }
        read += count;
    }
    Ok(body)
}

fn read_error(error: std::io::Error) -> HttpError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        (408, "MCP 请求读取超时".into())
    } else {
        (400, "MCP 请求读取失败".into())
    }
}

fn validate_headers(request: &Request, address: SocketAddr) -> Result<(), HttpError> {
    let host = address.to_string();
    if request.headers.get("host") != Some(&host) {
        return Err((403, "MCP Host 不受信任".into()));
    }
    if let Some(origin) = request.headers.get("origin") {
        if origin != &format!("http://{host}") {
            return Err((403, "MCP Origin 不受信任".into()));
        }
    }
    if let Some(version) = request.headers.get("mcp-protocol-version") {
        if !PROTOCOLS.contains(&version.as_str()) {
            return Err((400, "MCP 协议版本不受支持".into()));
        }
    }
    Ok(())
}

fn authenticate_owner(path: &str, secret: &[u8; 32]) -> Result<String, String> {
    let mut parts = path.split('/');
    let (Some(""), Some("mcp"), Some(owner), Some(signature), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err("浏览器 MCP 凭据无效".into());
    };
    let owner = hex_decode(owner)
        .filter(|bytes| !bytes.is_empty() && bytes.len() <= MAX_OWNER)
        .ok_or("浏览器 MCP 凭据无效")?;
    let signature = hex_decode(signature).ok_or("浏览器 MCP 凭据无效")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| "浏览器 MCP 凭据无效")?;
    mac.update(&owner);
    mac.verify_slice(&signature)
        .map_err(|_| "浏览器 MCP 凭据无效")?;
    String::from_utf8(owner).map_err(|_| "浏览器 MCP 凭据无效".into())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 15) as usize] as char);
    }
    output
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|bytes| {
            let high = (bytes[0] as char).to_digit(16)?;
            let low = (bytes[1] as char).to_digit(16)?;
            Some((high * 16 + low) as u8)
        })
        .collect()
}

fn dispatch_message<F>(owner: &str, message: Value, browser_call: F) -> Option<Value>
where
    F: Fn(&str, &str, Value) -> Result<Value, String>,
{
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    if !message.is_object()
        || message["jsonrpc"] != "2.0"
        || !message["method"].is_string()
        || (!id.is_null() && !id.is_string() && !id.is_number())
    {
        return Some(rpc_error(id, -32600, "JSON-RPC 请求无效"));
    }
    // 无状态 HTTP 不分配每客户端 Session；通知不执行浏览器副作用。
    if message.get("id").is_none() {
        return None;
    }
    let response = match message["method"].as_str().unwrap_or("") {
        "initialize" => initialize_result(&message["params"]).map_err(|error| (-32602, error)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":[browser_tool()]})),
        "tools/call" => {
            call_tool(owner, &message["params"], browser_call).map_err(|error| (-32602, error))
        }
        _ => Err((-32601, "MCP 方法不存在".into())),
    };
    Some(match response {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, message)) => rpc_error(id, code, &message),
    })
}

fn initialize_result(params: &Value) -> Result<Value, String> {
    let requested = params["protocolVersion"]
        .as_str()
        .ok_or("initialize 缺少 protocolVersion")?;
    let version = if PROTOCOLS.contains(&requested) {
        requested
    } else {
        PROTOCOLS[PROTOCOLS.len() - 1]
    };
    Ok(
        json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"agentkanban-browser","version":env!("CARGO_PKG_VERSION")},"instructions":"使用 session_browser 操作当前会话的独立浏览器；工具失败时向用户报告，不切换到其他浏览器。"}),
    )
}

fn browser_tool() -> Value {
    let mut properties = serde_json::Map::new();
    properties.insert(
        "operation".into(),
        json!({"type":"string","enum":OPERATIONS}),
    );
    for field in [
        "target_id",
        "url",
        "action",
        "selector",
        "value",
        "direction",
        "key",
    ] {
        properties.insert(field.into(), json!({"type":"string"}));
    }
    for field in ["x", "y", "amount"] {
        properties.insert(field.into(), json!({"type":"number"}));
    }
    json!({"name":"session_browser","description":"列出、打开、选择、关闭当前会话网页，读取页面快照或执行点击、输入、滚动等操作。操作对象与应用内当前会话浏览器一致。","inputSchema":{"type":"object","properties":properties,"required":["operation"],"additionalProperties":false}})
}

fn call_tool<F>(owner: &str, params: &Value, browser_call: F) -> Result<Value, String>
where
    F: Fn(&str, &str, Value) -> Result<Value, String>,
{
    if params["name"] != "session_browser" {
        return Err("未知浏览器工具".into());
    }
    let mut args = params["arguments"]
        .as_object()
        .cloned()
        .ok_or("工具 arguments 必须是对象")?;
    let schema = browser_tool();
    let fields = schema["inputSchema"]["properties"]
        .as_object()
        .ok_or("工具 schema 无效")?;
    for (key, value) in &args {
        let field = fields
            .get(key)
            .ok_or("浏览器工具参数不允许指定 owner、session、CDP 或其他未知字段")?;
        let valid = match field["type"].as_str() {
            Some("number") => value.is_number(),
            _ => value.is_string(),
        };
        if !valid {
            return Err(format!("浏览器参数 {key} 类型无效"));
        }
    }
    let operation = args
        .remove("operation")
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|operation| OPERATIONS.contains(&operation.as_str()))
        .ok_or("浏览器 operation 无效")?;
    // 调用方标识由可信网关注入，模型无法冒充人工接管页面的 UI。
    args.insert("_caller".into(), json!("agent"));
    Ok(match browser_call(owner, &operation, Value::Object(args)) {
        Ok(value) => tool_result(value),
        Err(error) => tool_error(&error),
    })
}

fn tool_result(value: Value) -> Value {
    let text = value.to_string();
    if text.len() > MAX_RESULT / 2 {
        return tool_error("浏览器结果超过 512 KiB，请缩小操作范围");
    }
    let structured = if value.is_object() {
        value
    } else {
        json!({"result":value})
    };
    let result = json!({"content":[{"type":"text","text":text}],"structuredContent":structured,"isError":false});
    if result.to_string().len() + 128 > MAX_RESULT {
        return tool_error("浏览器结果超过 512 KiB，请缩小操作范围");
    }
    result
}

fn tool_error(error: &str) -> Value {
    let error: String = error.chars().take(4096).collect();
    json!({"content":[{"type":"text","text":error}],"isError":true})
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn write_response(stream: &mut TcpStream, status: u16, value: Value) -> std::io::Result<()> {
    let mut body = if status == 202 {
        String::new()
    } else {
        value.to_string()
    };
    if body.len() > MAX_RESULT {
        body = rpc_error(Value::Null, -32000, "MCP 响应超过 512 KiB，请缩小请求范围").to_string();
    }
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    // 一次构造有界响应，避免提前拒绝请求时未读输入导致碎片化响应被 TCP reset 截断。
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nAllow: POST\r\n\r\n{body}", body.len());
    write_with_deadline(stream, response.as_bytes())
}

fn write_with_deadline(stream: &mut TcpStream, mut bytes: &[u8]) -> std::io::Result<()> {
    let timeout = stream.write_timeout()?.unwrap_or(IO_TIMEOUT);
    let deadline = Instant::now() + timeout;
    while !bytes.is_empty() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "MCP 响应写入超时"))?;
        stream.set_write_timeout(Some(remaining))?;
        let written = stream.write(bytes)?;
        if written == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "MCP 响应写入失败",
            ));
        }
        bytes = &bytes[written..];
    }
    stream.flush()
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn request(url: &str, method: &str, body: &str) -> (u16, Value) {
        request_extra(url, method, body, "")
    }

    fn request_extra(url: &str, method: &str, body: &str, extra: &str) -> (u16, Value) {
        let address_path = url.strip_prefix("http://").unwrap();
        let (address, path) = address_path.split_once('/').unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        write!(stream, "{method} /{path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new();
        if let Err(error) = stream.read_to_string(&mut response) {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
            assert!(!response.is_empty());
        }
        let (header, body) = response.split_once("\r\n\r\n").unwrap();
        let status = header.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn raw_request(url: &str, header: &str) -> (u16, Value) {
        let address_path = url.strip_prefix("http://").unwrap();
        let (address, path) = address_path.split_once('/').unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(
            stream,
            "POST /{path} HTTP/1.1\r\nHost: {address}\r\n{header}\r\n"
        )
        .unwrap();
        let mut response = String::new();
        if let Err(error) = stream.read_to_string(&mut response) {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
            assert!(!response.is_empty());
        }
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (
            head.split_whitespace().nth(1).unwrap().parse().unwrap(),
            serde_json::from_str(body).unwrap_or(Value::Null),
        )
    }

    #[test]
    fn http_limits_header_and_body_before_reading_large_payload() {
        let config = server_config("chat:request-limits").unwrap();
        let url = config["url"].as_str().unwrap();
        assert_eq!(raw_request(url, "Content-Length: 1048577\r\n").0, 413);
        assert_eq!(
            raw_request(url, &format!("X-Fill: {}\r\n", "h".repeat(17_000))).0,
            431
        );
        assert_eq!(
            raw_request(url, "Content-Length: 0\r\nContent-Length: 1\r\n").0,
            400
        );
        assert_eq!(raw_request(url, "Transfer-Encoding: chunked\r\n").0, 400);
    }

    #[test]
    fn busy_gateway_is_bounded_and_shutdown_stops_listener() {
        let mut server = Server::start(Arc::new(|_, _, _| panic!("此测试不执行浏览器"))).unwrap();
        let url = server.owner_url("chat:busy");
        let mut clients = Vec::new();
        for _ in 0..32 {
            let mut stream = TcpStream::connect(server.address).unwrap();
            stream.write_all(b"POST ").unwrap();
            clients.push(stream);
        }
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            request(&url, "POST", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).0,
            503
        );
        drop(clients);
        server.stop();
        assert!(TcpStream::connect(server.address).is_err());
    }

    #[test]
    fn initialization_negotiates_supported_versions_instead_of_echoing_unknown_version() {
        let config = server_config("chat:version-negotiation").unwrap();
        let url = config["url"].as_str().unwrap();
        let message = |version: &str| {
            json!({"jsonrpc":"2.0","id":11,"method":"initialize","params":{"protocolVersion":version,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}}).to_string()
        };
        let (status, response) = request_extra(
            url,
            "POST",
            &message("2025-11-25"),
            "MCP-Protocol-Version: 2025-11-25\r\n",
        );
        assert_eq!(status, 200);
        assert_eq!(response["result"]["protocolVersion"], "2025-11-25");
        let (_, response) = request(url, "POST", &message("2099-01-01"));
        assert_eq!(response["result"]["protocolVersion"], "2025-11-25");
        let (_, response) = request(url, "POST", &message("2025-03-26"));
        assert_eq!(response["result"]["protocolVersion"], "2025-03-26");
    }

    #[test]
    fn http_rejects_cross_origin_and_reports_json_rpc_parse_errors() {
        let config = server_config("chat:http-boundary").unwrap();
        let url = config["url"].as_str().unwrap();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert_eq!(
            request_extra(url, "POST", body, "Origin: https://example.com\r\n").0,
            403
        );
        assert_eq!(
            request_extra(url, "POST", body, "MCP-Protocol-Version: 2099-01-01\r\n").0,
            400
        );
        let (status, response) = request(url, "POST", "{");
        assert_eq!(status, 400);
        assert_eq!(response["error"]["code"], -32700);
    }

    #[test]
    fn oversized_json_rpc_id_cannot_expand_response_over_result_limit() {
        let config = server_config("chat:result-boundary").unwrap();
        let url = config["url"].as_str().unwrap();
        let body = json!({"jsonrpc":"2.0","id":"i".repeat(600_000),"method":"ping"}).to_string();
        let (_, response) = request(url, "POST", &body);
        assert!(response.to_string().len() <= 524_288);
        assert!(response.get("error").is_some());
    }

    #[test]
    fn dispatch_binds_owner_and_rejects_model_owner_override() {
        let message = json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"session_browser","arguments":{"operation":"open_page","url":"https://example.com"}}});
        let response = dispatch_message("chat:alice", message.clone(), |owner, operation, args| {
            if owner != "chat:alice"
                || operation != "open_page"
                || args != json!({"url":"https://example.com","_caller":"agent"})
            {
                return Err("浏览器调用边界不正确".into());
            }
            Ok(json!({"target_id":"page-1"}))
        })
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["target_id"],
            "page-1"
        );
        let mut forged = message;
        forged["params"]["arguments"]["owner"] = json!("chat:bob");
        let response = dispatch_message("chat:alice", forged, |_, _, _| {
            panic!("越权参数不得调用浏览器")
        })
        .unwrap();
        assert_eq!(response["error"]["code"], -32602);
    }

    #[test]
    fn browser_failures_and_large_results_are_tool_errors() {
        let message = json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"session_browser","arguments":{"operation":"snapshot"}}});
        let response = dispatch_message("chat:alice", message.clone(), |_, _, _| {
            Err("本会话浏览器不可用".into())
        })
        .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["content"][0]["text"],
            "本会话浏览器不可用"
        );
        let response = dispatch_message("chat:alice", message, |_, _, _| {
            Ok(json!({"large":"x".repeat(600_000)}))
        })
        .unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert!(response.to_string().len() < 524_288);
    }

    #[test]
    fn capability_cannot_be_reused_for_another_owner() {
        let first = server_config("chat:alice").unwrap();
        let second = server_config("chat:bob").unwrap();
        assert_eq!(first, server_config("chat:alice").unwrap());
        let first_url = first["url"].as_str().unwrap();
        let second_url = second["url"].as_str().unwrap();
        let first_prefix = first_url.rsplit_once('/').unwrap().0;
        let second_mac = second_url.rsplit_once('/').unwrap().1;
        let forged = format!("{first_prefix}/{second_mac}");
        assert_eq!(
            request(
                &forged,
                "POST",
                r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#
            )
            .0,
            403
        );
    }

    #[test]
    fn real_http_initialization_and_tools_do_not_start_browser() {
        let config = server_config("chat:test-http").unwrap();
        let url = config["url"].as_str().unwrap();
        let (status, result) = request(url, "POST", &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}).to_string());
        assert_eq!(status, 200);
        assert_eq!(result["result"]["protocolVersion"], "2025-06-18");
        let (_, result) = request(
            url,
            "POST",
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        );
        assert_eq!(result["result"]["tools"][0]["name"], "session_browser");
        assert_eq!(result["result"]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(request(url, "GET", "").0, 405);
        assert_eq!(
            request(
                url,
                "POST",
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            )
            .0,
            202
        );
    }
}
