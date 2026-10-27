use codex_kanban::work_service::WorkService;
use serde_json::{json, Value};
use std::sync::Arc;
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

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let service = WorkService::spawn(Arc::new(move || {
                let _ = handle.emit("workbench/changed", ());
            }))
            .map_err(std::io::Error::other)?;
            app.manage(service);
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
        .build(tauri::generate_context!())
        .expect("启动 Codex Thread Kanban 失败");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<WorkService>().shutdown();
            codex_kanban::browser_bridge::shutdown_all();
        }
    });
}
