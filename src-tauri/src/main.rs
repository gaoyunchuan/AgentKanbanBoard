#[tauri::command]
fn open_codex_deeplink(target: String) -> Result<String, String> {
    if !target.starts_with("codex://") {
        return Err("只允许打开 codex:// deep link".to_string());
    }

    Ok(target)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_codex_deeplink])
        .run(tauri::generate_context!())
        .expect("启动 Codex Thread Kanban 失败");
}
