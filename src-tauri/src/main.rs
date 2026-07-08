use codex_kanban::config::AppConfig;
use codex_kanban::deeplink::{ensure_codex_deeplink, project_deeplink, thread_deeplink};
use codex_kanban::domain::{
    FilterQuery, ProjectInput, ProjectRecord, TaskType, ThreadCommentInput, ThreadCommentRecord,
    ThreadRecord,
};
use codex_kanban::project_matcher::ProjectRule;
use codex_kanban::repository::Repository;
use codex_kanban::thread_sync::{CodexAppServerClient, ReadOnlyCodexClient, ThreadSync};
use codex_kanban::time::current_utc_text;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};

#[derive(Debug, Serialize)]
struct BoardData {
    threads: Vec<ThreadRecord>,
    projects: Vec<ProjectRecord>,
    sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SyncStatus {
    in_progress: bool,
    last_started_at: Option<String>,
    last_finished_at: Option<String>,
    last_error: Option<String>,
}

const LOAD_BOARD_DATA_FORCE_SYNC: bool = false;
const SYNC_CODEX_THREADS_FORCE_SYNC: bool = true;
static SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static SYNC_STATUS: OnceLock<Mutex<SyncStatus>> = OnceLock::new();

#[tauri::command]
fn load_board_data() -> Result<BoardData, String> {
    refresh_board_data(LOAD_BOARD_DATA_FORCE_SYNC)
}

#[tauri::command]
fn sync_codex_threads() -> Result<BoardData, String> {
    refresh_board_data(SYNC_CODEX_THREADS_FORCE_SYNC)
}

#[tauri::command]
fn start_codex_sync() -> Result<SyncStatus, String> {
    if SYNC_IN_PROGRESS
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(current_sync_status());
    }

    let started_at = current_utc_text();
    update_sync_status(|status| {
        status.in_progress = true;
        status.last_started_at = Some(started_at.clone());
        status.last_error = None;
    })?;

    tauri::async_runtime::spawn_blocking(move || {
        let result = run_background_codex_sync();
        let finished_at = current_utc_text();
        let last_error = result.err();
        if let Err(error) = update_sync_status(|status| {
            status.in_progress = false;
            status.last_finished_at = Some(finished_at);
            status.last_error = last_error;
        }) {
            eprintln!("更新 Codex sync 状态失败：{error}");
        }
        SYNC_IN_PROGRESS.store(false, Ordering::Release);
    });

    Ok(current_sync_status())
}

#[tauri::command]
fn load_sync_status() -> Result<SyncStatus, String> {
    Ok(current_sync_status())
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
fn create_thread_comment(
    thread_id: String,
    body: String,
    suspend_until: Option<String>,
) -> Result<BoardData, String> {
    let repository = open_repository()?;
    let body = body.trim();
    if body.is_empty() {
        return Err("评论不能为空".to_string());
    }
    let suspend_until = suspend_until
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    repository
        .add_thread_comment(ThreadCommentInput {
            thread_id,
            author: "我".to_string(),
            body: body.to_string(),
            suspend_until,
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
fn load_thread_comments(thread_id: String) -> Result<Vec<ThreadCommentRecord>, String> {
    let repository = open_repository()?;
    repository
        .list_thread_comments(&thread_id)
        .map_err(|error| error.to_string())
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
    prepare_board_repository(&repository)?;

    let mut sync_error = None;
    let has_threads = !repository
        .list_threads(FilterQuery {
            include_archived: true,
            ..FilterQuery::default()
        })
        .map_err(|error| error.to_string())?
        .is_empty();
    let should_sync = should_refresh_from_codex(force_sync, has_threads);

    if should_sync {
        sync_error = force_refresh_codex_threads(&repository)?;
    }

    read_board_data(&repository, sync_error)
}

fn prepare_board_repository(repository: &Repository) -> Result<(), String> {
    repository
        .wake_due_suspended_threads(&current_utc_text())
        .map_err(|error| error.to_string())?;
    repository
        .seed_builtin_presets()
        .map_err(|error| error.to_string())
}

fn force_refresh_codex_threads(repository: &Repository) -> Result<Option<String>, String> {
    let client = ReadOnlyCodexClient::new();
    match client.call("thread/list") {
        Ok(threads) => {
            seed_projects_from_synced_threads(repository, &threads)?;
            let projects = project_rules(repository)?;
            let sync = ThreadSync::new(Box::new(ReadOnlyCodexClient::new()));
            Ok(sync
                .sync_recent_into(
                    repository,
                    &projects,
                    &AppConfig::default(),
                    &current_utc_text(),
                )
                .err())
        }
        Err(error) => Ok(Some(error)),
    }
}

fn run_background_codex_sync() -> Result<(), String> {
    let repository = open_repository()?;
    prepare_board_repository(&repository)?;
    if let Some(error) = force_refresh_codex_threads(&repository)? {
        return Err(error);
    }
    Ok(())
}

fn should_refresh_from_codex(force_sync: bool, has_threads: bool) -> bool {
    force_sync || !has_threads
}

fn sync_status_store() -> &'static Mutex<SyncStatus> {
    SYNC_STATUS.get_or_init(|| {
        Mutex::new(SyncStatus {
            in_progress: false,
            last_started_at: None,
            last_finished_at: None,
            last_error: None,
        })
    })
}

fn current_sync_status() -> SyncStatus {
    sync_status_store()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| SyncStatus {
            in_progress: SYNC_IN_PROGRESS.load(Ordering::Acquire),
            last_started_at: None,
            last_finished_at: None,
            last_error: Some("sync 状态锁已损坏".to_string()),
        })
}

fn update_sync_status(update: impl FnOnce(&mut SyncStatus)) -> Result<(), String> {
    let mut status = sync_status_store()
        .lock()
        .map_err(|error| format!("sync 状态锁已损坏：{error}"))?;
    update(&mut status);
    Ok(())
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

#[tauri::command]
fn open_project_in_vscode(path: String) -> Result<String, String> {
    let commands = vscode_command_candidates(&path)?;
    let mut errors = Vec::new();

    for command in commands {
        match std::process::Command::new(&command.program)
            .args(&command.args)
            .status()
        {
            Ok(status) if status.success() => return Ok(path),
            Ok(status) => errors.push(format!(
                "{} {:?} 退出状态：{status}",
                command.program, command.args
            )),
            Err(error) => errors.push(format!(
                "{} {:?} 执行失败：{error}",
                command.program, command.args
            )),
        }
    }

    Err(format!(
        "系统未能打开 VS Code，请确认 VS Code 已安装。尝试结果：{}",
        errors.join("；")
    ))
}

#[derive(Debug, PartialEq, Eq)]
struct VscodeCommand {
    program: String,
    args: Vec<String>,
}

fn vscode_command_candidates(path: &str) -> Result<Vec<VscodeCommand>, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("项目目录不能为空".to_string());
    }

    let mut commands = vec![VscodeCommand {
        program: "code".to_string(),
        args: vec![path.to_string()],
    }];

    if cfg!(target_os = "macos") {
        commands.push(VscodeCommand {
            program: "open".to_string(),
            args: vec![
                "-a".to_string(),
                "Visual Studio Code".to_string(),
                path.to_string(),
            ],
        });
    }

    Ok(commands)
}

fn basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/').rsplit('/').next()
}

#[cfg(test)]
mod tests {
    use super::{
        should_refresh_from_codex, vscode_command_candidates, VscodeCommand,
        LOAD_BOARD_DATA_FORCE_SYNC, SYNC_CODEX_THREADS_FORCE_SYNC,
    };

    #[test]
    fn command_sync_modes_keep_load_board_data_read_only() {
        assert!(!LOAD_BOARD_DATA_FORCE_SYNC);
        assert!(SYNC_CODEX_THREADS_FORCE_SYNC);
        assert!(!should_refresh_from_codex(false, true));
        assert!(should_refresh_from_codex(false, false));
        assert!(should_refresh_from_codex(true, true));
    }

    #[test]
    fn vscode_command_uses_code_with_project_path_and_macos_fallback() {
        let commands = vscode_command_candidates("/repo/app").expect("命令参数应该合法");

        assert_eq!(
            commands[0],
            VscodeCommand {
                program: "code".to_string(),
                args: vec!["/repo/app".to_string()]
            }
        );
        if cfg!(target_os = "macos") {
            assert_eq!(
                commands[1],
                VscodeCommand {
                    program: "open".to_string(),
                    args: vec![
                        "-a".to_string(),
                        "Visual Studio Code".to_string(),
                        "/repo/app".to_string()
                    ]
                }
            );
        }
        assert!(vscode_command_candidates("   ").is_err());
    }
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
            start_codex_sync,
            load_sync_status,
            update_thread_fields,
            create_thread_comment,
            update_thread_comment,
            load_thread_comments,
            mark_thread_reviewed,
            archive_thread,
            unarchive_thread,
            build_thread_deeplink,
            build_project_deeplink,
            open_codex_deeplink,
            open_project_in_vscode
        ])
        .run(tauri::generate_context!())
        .expect("启动 Codex Thread Kanban 失败");
}
