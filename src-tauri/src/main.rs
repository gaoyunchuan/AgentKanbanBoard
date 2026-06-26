use codex_kanban::config::AppConfig;
use codex_kanban::deeplink::{ensure_codex_deeplink, project_deeplink, thread_deeplink};
use codex_kanban::domain::{
    FilterQuery, ProjectInput, ProjectRecord, TaskType, ThreadCommentInput, ThreadRecord,
};
use codex_kanban::project_matcher::ProjectRule;
use codex_kanban::repository::Repository;
use codex_kanban::thread_sync::{CodexAppServerClient, ReadOnlyCodexClient, ThreadSync};
use codex_kanban::time::current_utc_text;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct BoardData {
    threads: Vec<ThreadRecord>,
    projects: Vec<ProjectRecord>,
    sync_error: Option<String>,
}

#[tauri::command]
fn load_board_data() -> Result<BoardData, String> {
    refresh_board_data(true)
}

#[tauri::command]
fn sync_codex_threads() -> Result<BoardData, String> {
    refresh_board_data(true)
}

#[tauri::command]
fn update_thread_fields(
    thread_id: String,
    task_type: Option<String>,
    module: String,
    sprint: String,
    notes: String,
) -> Result<BoardData, String> {
    let repository = open_repository()?;
    let parsed_task_type = task_type
        .as_deref()
        .and_then(|value| if value.is_empty() { None } else { Some(value) })
        .map(|value| TaskType::parse(value).ok_or_else(|| format!("不支持的 task_type：{value}")))
        .transpose()?;

    repository
        .update_thread_fields(&thread_id, parsed_task_type, &module, &sprint, &notes)
        .map_err(|error| error.to_string())?;
    read_board_data(&repository, None)
}

#[tauri::command]
fn create_thread_comment(thread_id: String, body: String) -> Result<BoardData, String> {
    let repository = open_repository()?;
    let body = body.trim();
    if body.is_empty() {
        return Err("评论不能为空".to_string());
    }

    repository
        .add_thread_comment(ThreadCommentInput {
            thread_id,
            author: "我".to_string(),
            body: body.to_string(),
        })
        .map_err(|error| error.to_string())?;
    read_board_data(&repository, None)
}

#[tauri::command]
fn update_thread_comment(comment_id: i64, body: String) -> Result<BoardData, String> {
    let repository = open_repository()?;
    let body = body.trim();
    if body.is_empty() {
        return Err("评论不能为空".to_string());
    }

    repository
        .update_thread_comment(comment_id, body)
        .map_err(|error| error.to_string())?;
    read_board_data(&repository, None)
}

#[tauri::command]
fn mark_thread_reviewed(thread_id: String) -> Result<BoardData, String> {
    let repository = open_repository()?;
    repository
        .mark_reviewed(&thread_id)
        .map_err(|error| error.to_string())?;
    read_board_data(&repository, None)
}

#[tauri::command]
fn archive_thread(thread_id: String) -> Result<BoardData, String> {
    let repository = open_repository()?;
    repository
        .archive_thread(&thread_id)
        .map_err(|error| error.to_string())?;
    read_board_data(&repository, None)
}

#[tauri::command]
fn unarchive_thread(thread_id: String) -> Result<BoardData, String> {
    let repository = open_repository()?;
    repository
        .unarchive_thread(&thread_id)
        .map_err(|error| error.to_string())?;
    read_board_data(&repository, None)
}

fn refresh_board_data(force_sync: bool) -> Result<BoardData, String> {
    let repository = open_repository()?;
    repository
        .seed_builtin_presets()
        .map_err(|error| error.to_string())?;

    let client = ReadOnlyCodexClient::new();
    let mut sync_error = None;
    let should_sync = force_sync
        || repository
            .list_threads(FilterQuery {
                include_archived: true,
                ..FilterQuery::default()
            })
            .map_err(|error| error.to_string())?
            .is_empty();

    if should_sync {
        match client.call("thread/list") {
            Ok(threads) => {
                seed_projects_from_synced_threads(&repository, &threads)?;
                let projects = project_rules(&repository)?;
                let sync = ThreadSync::new(Box::new(ReadOnlyCodexClient::new()));
                if let Err(error) = sync.sync_recent_into(
                    &repository,
                    &projects,
                    &AppConfig::default(),
                    &current_utc_text(),
                ) {
                    sync_error = Some(error);
                }
            }
            Err(error) => sync_error = Some(error),
        }
    }

    read_board_data(&repository, sync_error)
}

fn read_board_data(
    repository: &Repository,
    sync_error: Option<String>,
) -> Result<BoardData, String> {
    Ok(BoardData {
        threads: repository
            .list_threads(FilterQuery {
                include_archived: true,
                ..FilterQuery::default()
            })
            .map_err(|error| error.to_string())?,
        projects: repository
            .list_projects(true)
            .map_err(|error| error.to_string())?,
        sync_error,
    })
}

fn seed_projects_from_synced_threads(
    repository: &Repository,
    threads: &[codex_kanban::thread_sync::SyncedThread],
) -> Result<(), String> {
    for thread in threads {
        if thread.cwd.trim().is_empty() {
            continue;
        }
        repository
            .upsert_project(ProjectInput {
                id: project_id_for_path(&thread.cwd),
                name: basename(&thread.cwd).unwrap_or("Codex Project").to_string(),
                path: thread.cwd.clone(),
                origin_url: thread.origin_url.clone(),
                aliases: basename(&thread.cwd)
                    .map(|value| vec![value.to_string()])
                    .unwrap_or_default(),
                active: true,
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn project_rules(repository: &Repository) -> Result<Vec<ProjectRule>, String> {
    Ok(repository
        .list_projects(false)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|project| ProjectRule {
            id: project.id,
            name: project.name,
            path: project.path,
            origin_url: project.origin_url,
            aliases: project.aliases,
            active: project.active,
        })
        .collect())
}

fn open_repository() -> Result<Repository, String> {
    Repository::open_default().map_err(|error| error.to_string())
}

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

fn basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/').rsplit('/').next()
}

fn project_id_for_path(path: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("project-{hash:016x}")
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_board_data,
            sync_codex_threads,
            update_thread_fields,
            create_thread_comment,
            update_thread_comment,
            mark_thread_reviewed,
            archive_thread,
            unarchive_thread,
            build_thread_deeplink,
            build_project_deeplink,
            open_codex_deeplink
        ])
        .run(tauri::generate_context!())
        .expect("启动 Codex Thread Kanban 失败");
}
