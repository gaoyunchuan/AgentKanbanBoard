use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::board_status_mapper::{BoardStatusMapper, StatusInput};
use crate::config::AppConfig;
use crate::domain::{BoardStatus, CodexThreadUpsert};
use crate::project_matcher::{ProjectMatcher, ProjectRule, ThreadProjectHint};
use crate::repository::Repository;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncedThread {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub source_kind: String,
    pub codex_status: String,
    pub raw_status: String,
    pub branch: String,
    pub origin_url: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub trait CodexAppServerClient {
    fn call(&self, method: &str) -> Result<Vec<SyncedThread>, String>;
}

pub struct ReadOnlyCodexClient {
    state_db_path: PathBuf,
}

impl ReadOnlyCodexClient {
    pub fn new() -> Self {
        Self {
            state_db_path: default_codex_state_db_path(),
        }
    }

    pub fn with_state_db_path(state_db_path: PathBuf) -> Self {
        Self { state_db_path }
    }
}

impl Default for ReadOnlyCodexClient {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAppServerClient for ReadOnlyCodexClient {
    fn call(&self, method: &str) -> Result<Vec<SyncedThread>, String> {
        if ThreadSync::blocked_methods().contains(&method)
            || !ThreadSync::readonly_methods().contains(&method)
        {
            return Err(format!("禁止调用 Codex 写方法或未知方法：{method}"));
        }

        let connection = rusqlite::Connection::open_with_flags(
            &self.state_db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| {
            format!(
                "无法读取 Codex Desktop state sqlite {}：{error}",
                self.state_db_path.display()
            )
        })?;
        let mut statement = connection
            .prepare(
                "SELECT id,
                        title,
                        substr(preview, 1, 240),
                        cwd,
                        source,
                        CASE WHEN archived = 1 THEN 'archived' ELSE 'idle' END,
                        CASE WHEN archived = 1 THEN 'archived' ELSE 'idle' END,
                        COALESCE(git_branch, ''),
                        git_origin_url,
                        archived,
                        strftime('%Y-%m-%dT%H:%M:%SZ', created_at, 'unixepoch'),
                        strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, 'unixepoch')
                 FROM threads
                 ORDER BY recency_at_ms DESC, updated_at DESC
                 LIMIT 200",
            )
            .map_err(|error| format!("读取 Codex threads 表失败：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(SyncedThread {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    preview: row.get(2)?,
                    cwd: row.get(3)?,
                    source_kind: row.get(4)?,
                    codex_status: row.get(5)?,
                    raw_status: row.get(6)?,
                    branch: row.get(7)?,
                    origin_url: row.get(8)?,
                    archived: row.get::<_, i64>(9)? != 0,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            })
            .map_err(|error| format!("解析 Codex threads 失败：{error}"))?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("解析 Codex thread 行失败：{error}"))
    }
}

pub struct ThreadSync {
    client: Box<dyn CodexAppServerClient>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncVisibility {
    Foreground,
    Background,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncReport {
    pub upserted: usize,
    pub events: usize,
}

impl ThreadSync {
    pub fn new(client: Box<dyn CodexAppServerClient>) -> Self {
        Self { client }
    }

    pub fn sync_recent(&self) -> Result<Vec<SyncedThread>, String> {
        self.client.call("thread/list")
    }

    pub fn sync_recent_into(
        &self,
        repository: &Repository,
        projects: &[ProjectRule],
        config: &AppConfig,
        now: &str,
    ) -> Result<SyncReport, String> {
        let threads = self.sync_recent()?;
        let mut events = 0;

        for thread in &threads {
            let previous = repository
                .get_thread(&thread.id)
                .map_err(|error| error.to_string())?;
            let project_id = ProjectMatcher::match_thread(
                &ThreadProjectHint {
                    cwd: Some(thread.cwd.clone()),
                    origin_url: thread.origin_url.clone(),
                },
                projects,
            )
            .map(|project| project.id.clone())
            .unwrap_or_else(|| "unknown".to_string());

            repository
                .upsert_thread(CodexThreadUpsert {
                    id: thread.id.clone(),
                    project_id: Some(project_id),
                    title: thread.title.clone(),
                    preview: thread.preview.clone(),
                    cwd: thread.cwd.clone(),
                    branch: thread.branch.clone(),
                    source_kind: thread.source_kind.clone(),
                    codex_status: thread.codex_status.clone(),
                    codex_sub_status: String::new(),
                    created_at: thread.created_at.clone(),
                    updated_at: thread.updated_at.clone(),
                    raw_json: serde_json::to_value(thread)
                        .unwrap_or_else(|_| serde_json::json!({})),
                })
                .map_err(|error| error.to_string())?;

            if thread.archived || thread.codex_status == "archived" {
                if repository
                    .set_synced_archived_if_changed(&thread.id, "codex_archived")
                    .map_err(|error| error.to_string())?
                {
                    events += 1;
                }
                continue;
            }

            if is_stale_thread(&thread.updated_at, now) {
                if repository
                    .set_synced_archived_if_changed(&thread.id, "stale_30_days")
                    .map_err(|error| error.to_string())?
                {
                    events += 1;
                }
                continue;
            }

            let current = repository
                .get_thread(&thread.id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("同步后未找到 thread：{}", thread.id))?;
            let is_running = is_running_status(&thread.codex_status);
            repository
                .update_runtime_markers(&thread.id, is_running, now)
                .map_err(|error| error.to_string())?;
            let refreshed = repository
                .get_thread(&thread.id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("同步状态标记后未找到 thread：{}", thread.id))?;

            let has_running_history = is_running
                || previous
                    .as_ref()
                    .and_then(|record| record.last_seen_running_at.as_ref())
                    .is_some()
                || refreshed.last_seen_running_at.is_some();
            let status = BoardStatusMapper::map_runtime(StatusInput {
                codex_status: &thread.codex_status,
                previous_status: current.board_status,
                has_running_history,
                is_archived: current.board_status == BoardStatus::Archived,
                manual_status_override: current.manual_status_override,
                last_seen_completed_at: refreshed.last_seen_completed_at.as_deref(),
                now,
                config,
            });

            if repository
                .set_auto_status_if_changed(&thread.id, status, "sync_runtime")
                .map_err(|error| error.to_string())?
            {
                events += 1;
            }
        }

        Ok(SyncReport {
            upserted: threads.len(),
            events,
        })
    }

    pub fn handle_status_changed_into(
        &self,
        thread_id: &str,
        repository: &Repository,
        projects: &[ProjectRule],
        config: &AppConfig,
        now: &str,
    ) -> Result<SyncReport, String> {
        if thread_id.trim().is_empty() {
            return Err("runtime status event 缺少 thread id".to_string());
        }

        self.sync_recent_into(repository, projects, config, now)
    }

    pub fn readonly_methods() -> &'static [&'static str] {
        &["thread/list", "thread/read", "thread/status/changed"]
    }

    pub fn blocked_methods() -> &'static [&'static str] {
        &[
            "thread/start",
            "turn/start",
            "approval/approve",
            "approval/reject",
            "shell/command",
            "thread/delete",
            "thread/archive",
            "thread/unarchive",
            "thread/metadata/update",
        ]
    }
}

pub fn refresh_interval_seconds(visibility: SyncVisibility, config: &AppConfig) -> u64 {
    match visibility {
        SyncVisibility::Foreground => config.foreground_sync_interval_seconds,
        SyncVisibility::Background => config.background_sync_interval_seconds,
    }
}

fn is_running_status(value: &str) -> bool {
    matches!(
        value,
        "running" | "active" | "waiting_approval" | "waiting approval" | "typing"
    )
}

fn is_stale_thread(updated_at: &str, now: &str) -> bool {
    seconds_between(updated_at, now)
        .map(|age| age >= 30 * 24 * 60 * 60)
        .unwrap_or(false)
}

fn seconds_between(start: &str, end: &str) -> Option<i64> {
    Some(parse_utc_seconds(end)? - parse_utc_seconds(start)?)
}

fn parse_utc_seconds(value: &str) -> Option<i64> {
    let (date, time) = value.trim_end_matches('Z').split_once('T')?;
    let mut date_parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let year = date_parts.next()??;
    let month = date_parts.next()??;
    let day = date_parts.next()??;
    let mut time_parts = time.split(':').map(|part| part.parse::<i64>().ok());
    let hour = time_parts.next()??;
    let minute = time_parts.next()??;
    let second = time_parts.next()??;

    Some((((year * 12 + month) * 31 + day) * 24 + hour) * 3600 + minute * 60 + second)
}

fn default_codex_state_db_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| {
                let mut path = PathBuf::from(home);
                path.push(".codex");
                path
            })
        })
        .unwrap_or_else(|| PathBuf::from(".codex"))
        .join("state_5.sqlite")
}
