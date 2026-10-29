// 独立后端 sidecar：Electron 外壳通过本地 JSON-RPC 复用同一套数据与调度器。
use codex_kanban::work_service::WorkService;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};

static CLIENTS: OnceLock<Mutex<Vec<TcpStream>>> = OnceLock::new();
fn clients() -> &'static Mutex<Vec<TcpStream>> { CLIENTS.get_or_init(|| Mutex::new(Vec::new())) }

fn broadcast() {
    if let Ok(mut all) = clients().lock() {
        all.retain_mut(|stream| stream.write_all(b"{\"event\":\"workbench/changed\"}\n").and_then(|()| stream.flush()).is_ok());
    }
}

fn external_link(target: &str) -> Result<String, String> {
    let value = target.trim();
    if value.is_empty() || value.len() > 8192 || value.chars().any(|c| c.is_control() || c.is_whitespace()) { return Err("外部链接格式无效".into()); }
    let url = reqwest_stub(value)?;
    Ok(url)
}

fn reqwest_stub(value: &str) -> Result<String, String> {
    if value.starts_with("https://") || value.starts_with("http://") { Ok(value.to_string()) } else { Err("仅支持 HTTP/HTTPS 链接".into()) }
}

fn dispatch(service: &WorkService, method: &str, args: Value) -> Result<Value, String> {
    match method {
        "chat_command" => {
            let name = args["method"].as_str().ok_or("缺少 command method")?;
            service.call(&format!("chat/{name}"), args.get("params").cloned().unwrap_or_else(|| json!({})))
        }
        "workbench_connect" => service.call("connect", json!({"executable": args.get("executable").cloned().unwrap_or(Value::Null)})),
        "workbench_rpc" => {
            let runtime = service.runtime()?;
            let name = args["method"].as_str().ok_or("缺少 RPC 方法")?;
            let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
            match name {
                "account/login/start" => runtime.login_start(),
                "account/login/cancel" => runtime.login_cancel(params.get("loginId").and_then(Value::as_str).ok_or("缺少登录请求")?),
                _ => runtime.rpc_read(name, params),
            }
        }
        "workbench_read_file" => {
            let task = args["taskId"].as_str().ok_or("缺少 taskId")?;
            let config = service.task_config(task)?;
            service.runtime()?.read_workspace_file(&config.workspace, args["path"].as_str().ok_or("缺少 path")?)
        }
        "workbench_list_directory" => {
            let task = args["taskId"].as_str().ok_or("缺少 taskId")?;
            let config = service.task_config(task)?;
            service.runtime()?.list_workspace_directory(&config.workspace, args["path"].as_str().ok_or("缺少 path")?)
        }
        "workbench_execute_command" => {
            let task = args["taskId"].as_str().ok_or("缺少 taskId")?.to_string();
            let command = args["command"].as_str().ok_or("缺少 command")?;
            if command.trim().is_empty() { return Err("终端命令不能为空".into()); }
            let argv = if cfg!(target_os = "windows") {
                vec!["powershell.exe".into(), "-NoProfile".into(), "-Command".into(), command.to_string()]
            } else {
                vec!["/bin/sh".into(), "-lc".into(), command.to_string()]
            };
            service.execute_command(&task, argv, args["timeoutMs"].as_u64().unwrap_or(120_000))
        }
        "workbench_terminate_command" => {
            let task = args["taskId"].as_str().ok_or("缺少 taskId")?;
            service.runtime()?.terminate_workspace_command(task, args["processId"].as_str().ok_or("缺少 processId")?)?;
            Ok(Value::Null)
        }
        "open_external_link" => {
            let target = external_link(args["target"].as_str().ok_or("缺少 target")?)?;
            let status = std::process::Command::new("open").arg(&target).status().map_err(|e| format!("打开外部链接失败：{e}"))?;
            if !status.success() { return Err("系统未能打开外部链接".into()); }
            Ok(json!(target))
        }
        "chat_pick_directory" => {
            let output = std::process::Command::new("osascript")
                .args(["-e", "try\nPOSIX path of (choose folder with prompt \"选择项目工作目录\")\non error number -128\nreturn \"\"\nend try"])
                .output().map_err(|e| e.to_string())?;
            if !output.status.success() { return Err("目录选择器启动失败；可直接输入项目路径".into()); }
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(if path.is_empty() { Value::Null } else { json!(path) })
        }
        other => Err(format!("未知后端命令：{other}")),
    }
}

fn serve(service: WorkService, stream: TcpStream) {
    let writer = match stream.try_clone() { Ok(writer) => writer, Err(_) => return };
    if let Ok(mut all) = clients().lock() { all.push(writer); }
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) { Ok(0) | Err(_) => break, Ok(_) => {} }
        if line.trim().is_empty() { continue; }
        let value: Value = match serde_json::from_str(&line) { Ok(value) => value, Err(error) => { let _ = reader.get_mut().write_all(format!("{}\n", json!({"id":null,"error":format!("请求格式无效：{error}")})).as_bytes()); continue; } };
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let method = value["method"].as_str().unwrap_or("").to_string();
        let args = value.get("params").cloned().unwrap_or_else(|| json!({}));
        let reply = match dispatch(&service, &method, args) { Ok(result) => json!({"id":id,"result":result}), Err(error) => json!({"id":id,"error":error}) };
        if reader.get_mut().write_all(format!("{reply}\n").as_bytes()).is_err() { break; }
    }
}

fn main() {
    let service = WorkService::spawn(Arc::new(broadcast)).expect("启动后台服务失败");
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("监听 sidecar 端口失败");
    let port = listener.local_addr().expect("读取 sidecar 端口失败").port();
    println!("{}", json!({"sidecar": port}));
    for stream in listener.incoming().flatten() {
        let service = service.clone();
        std::thread::spawn(move || serve(service, stream));
    }
}
