use codex_kanban::work_service::WorkService;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, State};

async fn call_workbench(
    service: WorkService,
    method: &'static str,
    params: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || service.call(method, params))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn chat_command(
    service: State<'_, WorkService>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.call(
            &format!("chat/{method}"),
            params.unwrap_or_else(|| json!({})),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn chat_browser(
    service: State<'_, WorkService>,
    conversation_id: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let owner = service.call(
            "chat/browser_owner",
            json!({"conversation_id":conversation_id}),
        )?;
        let key = owner["key"].as_str().ok_or("会话不存在")?;
        codex_kanban::browser_bridge::call(key, &method, params.unwrap_or_else(|| json!({})))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn chat_pick_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os="macos")]
        {
            let output=std::process::Command::new("osascript").args(["-e","try\nPOSIX path of (choose folder with prompt \"选择项目工作目录\")\non error number -128\nreturn \"\"\nend try"]).output().map_err(|e|e.to_string())?;
            if !output.status.success(){return Err("目录选择器启动失败；可直接输入项目路径".into())}
            let path=String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(if path.is_empty(){None}else{Some(path)})
        }
        #[cfg(not(target_os="macos"))]
        { Err("当前平台请直接输入工作目录绝对路径".into()) }
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
async fn workbench_connect(
    service: State<'_, WorkService>,
    executable: Option<String>,
) -> Result<Value, String> {
    call_workbench(
        service.inner().clone(),
        "connect",
        json!({"executable":executable}),
    )
    .await
}

#[tauri::command]
async fn workbench_rpc(
    service: State<'_, WorkService>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = service.runtime()?;
        let params = params.unwrap_or_else(|| json!({}));
        match method.as_str() {
            "account/login/start" => runtime.login_start(),
            "account/login/cancel" => runtime.login_cancel(
                params
                    .get("loginId")
                    .and_then(Value::as_str)
                    .ok_or("缺少登录请求")?,
            ),
            _ => runtime.rpc_read(&method, params),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workbench_read_file(
    service: State<'_, WorkService>,
    task_id: String,
    path: String,
) -> Result<Value, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = service.task_config(&task_id)?;
        service
            .runtime()?
            .read_workspace_file(&config.workspace, &path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workbench_list_directory(
    service: State<'_, WorkService>,
    task_id: String,
    path: String,
) -> Result<Value, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = service.task_config(&task_id)?;
        service
            .runtime()?
            .list_workspace_directory(&config.workspace, &path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workbench_execute_command(
    service: State<'_, WorkService>,
    task_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let service = service.inner().clone();
    // Explicit user terminal input runs on a separate worker. The scheduler remains
    // responsive to stop/approval messages while a build or test command runs.
    tauri::async_runtime::spawn_blocking(move || {
        if command.trim().is_empty() {
            return Err("终端命令不能为空".into());
        }
        let argv = if cfg!(target_os = "windows") {
            vec![
                "powershell.exe".into(),
                "-NoProfile".into(),
                "-Command".into(),
                command,
            ]
        } else {
            vec!["/bin/sh".into(), "-lc".into(), command]
        };
        service.execute_command(&task_id, argv, timeout_ms.unwrap_or(120_000))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn workbench_terminate_command(
    service: State<'_, WorkService>,
    task_id: String,
    process_id: String,
    run_id: Option<String>,
) -> Result<(), String> {
    let service = service.inner().clone();
    let _ = run_id;
    tauri::async_runtime::spawn_blocking(move || {
        service
            .runtime()?
            .terminate_workspace_command(&task_id, &process_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_external_link(target: String) -> Result<String, String> {
    let target = validate_external_link(&target)?;
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&target).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(&target).status()
    }
    .map_err(|error| format!("打开外部链接失败：{error}"))?;

    if !status.success() {
        return Err("系统未能打开外部链接".to_string());
    }

    Ok(target)
}

fn validate_external_link(target: &str) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("链接不能为空".to_string());
    }
    if !target.starts_with("https://") && !target.starts_with("http://") {
        return Err("仅支持 http 或 https 链接".to_string());
    }
    if target.chars().any(char::is_control) {
        return Err("链接包含非法控制字符".to_string());
    }
    Ok(target.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_external_link;
    #[test]
    fn external_links_keep_scheme_and_control_character_boundary() {
        assert_eq!(
            validate_external_link(" https://example.com/path ").unwrap(),
            "https://example.com/path"
        );
        for value in [
            "javascript:alert(1)",
            "file:///tmp/secret",
            "https://example.com\nfile:///tmp",
            "",
        ] {
            assert!(validate_external_link(value).is_err());
        }
    }
}

// Electron 外壳使用的本地 JSON-RPC sidecar：复用同一套命令、数据库与调度器。
static SIDECAR_CLIENTS: OnceLock<Mutex<Vec<TcpStream>>> = OnceLock::new();

fn sidecar_clients() -> &'static Mutex<Vec<TcpStream>> {
    SIDECAR_CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

fn broadcast_sidecar_changed() {
    if let Ok(mut clients) = sidecar_clients().lock() {
        clients.retain_mut(|stream| stream.write_all(b"{\"event\":\"workbench/changed\"}\n").and_then(|()| stream.flush()).is_ok());
    }
}

fn dispatch_sidecar(handle: &tauri::AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let service = handle.state::<WorkService>().inner().clone();
    let args = params;
    match method {
        "chat_command" => {
            let name = args["method"].as_str().ok_or("缺少 command method")?;
            service.call(&format!("chat/{name}"), args.get("params").cloned().unwrap_or_else(|| json!({})))
        }
        "chat_browser" => {
            let conversation = args["conversationId"].as_str().ok_or("缺少 conversationId")?;
            let name = args["method"].as_str().ok_or("缺少浏览器方法")?;
            let owner = service.call("chat/browser_owner", json!({"conversation_id": conversation}))?;
            let key = owner["key"].as_str().ok_or("会话不存在")?;
            codex_kanban::browser_bridge::call(key, name, args.get("params").cloned().unwrap_or_else(|| json!({})))
        }
        "chat_pick_directory" => {
            #[cfg(target_os = "macos")]
            {
                let output = std::process::Command::new("osascript")
                    .args(["-e", "try\nPOSIX path of (choose folder with prompt \"选择项目工作目录\")\non error number -128\nreturn \"\"\nend try"])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() { return Err("目录选择器启动失败；可直接输入项目路径".into()); }
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                Ok(if path.is_empty() { Value::Null } else { json!(path) })
            }
            #[cfg(not(target_os = "macos"))]
            { Err("当前平台请直接输入工作目录绝对路径".into()) }
        }
        "workbench_connect" => service.call("connect", json!({"executable": args.get("executable").cloned().unwrap_or(Value::Null)})),
        "workbench_rpc" => {
            let runtime = service.runtime()?;
            let name = args["method"].as_str().ok_or("缺少 RPC 方法")?;
            let rpc_params = args.get("params").cloned().unwrap_or_else(|| json!({}));
            match name {
                "account/login/start" => runtime.login_start(),
                "account/login/cancel" => runtime.login_cancel(rpc_params.get("loginId").and_then(Value::as_str).ok_or("缺少登录请求")?),
                _ => runtime.rpc_read(name, rpc_params),
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
        "open_external_link" => open_external_link(args["target"].as_str().ok_or("缺少 target")?.to_string()).map(Value::String),
        other => Err(format!("未知后端命令：{other}")),
    }
}

fn handle_sidecar_client(handle: tauri::AppHandle, stream: TcpStream) -> Result<(), String> {
    let writer = stream.try_clone().map_err(|e| e.to_string())?;
    sidecar_clients().lock().map_err(|_| "sidecar 连接锁异常")?.push(writer);
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 { break; }
        if line.trim().is_empty() { continue; }
        let (id, method, params) = match serde_json::from_str::<Value>(&line) {
            Ok(value) => (value.get("id").cloned().unwrap_or(Value::Null), value["method"].as_str().unwrap_or("").to_string(), value.get("params").cloned().unwrap_or_else(|| json!({}))),
            Err(error) => { let reply = json!({"id":null,"error":format!("请求格式无效：{error}")}); let _ = reader.get_mut().write_all(format!("{reply}\n").as_bytes()); continue; }
        };
        let reply = match dispatch_sidecar(&handle, &method, params) {
            Ok(result) => json!({"id":id,"result":result}),
            Err(error) => json!({"id":id,"error":error}),
        };
        reader.get_mut().write_all(format!("{reply}\n").as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn start_sidecar(handle: tauri::AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("sidecar 监听失败：{e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Electron 主进程读取这一行获取端口；不要混入其它 stdout 输出。
    println!("{}", json!({"sidecar": port}));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handle = handle.clone();
            std::thread::spawn(move || { let _ = handle_sidecar_client(handle, stream); });
        }
    });
    Ok(port)
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let repository = codex_kanban::repository::Repository::open_default()?;
    let root = repository.browser_state_root()?;
    let resources = app.path().resource_dir().ok().map(|p| p.join("browser"))
        .or_else(|| std::env::current_exe().ok().and_then(|p| p.parent()?.parent().map(|p| p.join("Resources/browser"))))
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/missing-resources"));
    let development = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let (agent, scripts) = if resources.join("session_browser.mjs").is_file() {
        (resources.join("agent-browser"), resources)
    } else {
        (development.join(".build/browser/agent-browser"), development.join("scripts"))
    };
    codex_kanban::browser_bridge::configure(root, agent, scripts)?;
    let service = WorkService::spawn(Arc::new(move || {
        let _ = handle.emit("workbench/changed", ());
        broadcast_sidecar_changed();
    }))?;
    app.manage(service);
    Ok(())
}

fn main() {
    let sidecar = std::env::args().any(|value| value == "--sidecar");
    let builder = tauri::Builder::default();
    let context = tauri::generate_context!();
    let app = if sidecar {
        builder
            .setup(|app| {
                setup_app(app)?;
                start_sidecar(app.handle().clone()).map_err(std::io::Error::other)?;
                Ok(())
            })
            .build(context)
            .expect("启动 Codex Thread Kanban sidecar 失败")
    } else {
        builder
        .setup(|app| {
            setup_app(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat_command,
            chat_browser,
            chat_pick_directory,
            workbench_connect,
            workbench_rpc,
            workbench_read_file,
            workbench_list_directory,
            workbench_execute_command,
            workbench_terminate_command,
            open_external_link
        ])
        .build(context)
        .expect("启动 Codex Thread Kanban 失败")
    };
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<WorkService>().shutdown();
            codex_kanban::browser_mcp::shutdown();
            codex_kanban::browser_bridge::shutdown_all();
        }
    });
}
