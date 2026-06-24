use codex_kanban::deeplink::{ensure_codex_deeplink, project_deeplink, thread_deeplink};

#[tauri::command]
fn build_thread_deeplink(thread_id: String) -> Result<String, String> {
    thread_deeplink(&thread_id)
}

#[tauri::command]
fn build_project_deeplink(path: String, prompt: Option<String>) -> Result<String, String> {
    project_deeplink(&path, prompt.as_deref())
}

#[tauri::command]
fn open_codex_deeplink(target: String) -> Result<String, String> {
    ensure_codex_deeplink(&target)?;

    // deep link 只负责跳转，执行和审批仍由 Codex Desktop 接管。
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(&target).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(&target).status()
    }
    .map_err(|error| format!("打开 Codex deep link 失败：{error}"))?;

    if !status.success() {
        return Err("系统未能打开 Codex deep link".to_string());
    }

    Ok(target)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            build_thread_deeplink,
            build_project_deeplink,
            open_codex_deeplink
        ])
        .run(tauri::generate_context!())
        .expect("启动 Codex Thread Kanban 失败");
}
