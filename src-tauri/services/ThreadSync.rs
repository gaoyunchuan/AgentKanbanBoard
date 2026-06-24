use serde::{Deserialize, Serialize};

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
    pub created_at: String,
    pub updated_at: String,
}

pub trait CodexAppServerClient {
    fn call(&self, method: &str) -> Result<Vec<SyncedThread>, String>;
}

pub struct ReadOnlyCodexClient;

impl ReadOnlyCodexClient {
    pub fn new() -> Self {
        Self
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

        Ok(vec![])
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
                    origin_url: None,
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
                    branch: String::new(),
                    source_kind: thread.source_kind.clone(),
                    codex_status: thread.codex_status.clone(),
                    codex_sub_status: String::new(),
                    created_at: thread.created_at.clone(),
                    updated_at: thread.updated_at.clone(),
                    raw_json: serde_json::to_value(thread)
                        .unwrap_or_else(|_| serde_json::json!({})),
                })
                .map_err(|error| error.to_string())?;

            if !is_known_runtime_status(&thread.codex_status) {
                continue;
            }

            let current = repository
                .get_thread(&thread.id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("同步后未找到 thread：{}", thread.id))?;
            let is_running = is_running_status(&thread.codex_status);
            repository
                .update_runtime_markers(
                    &thread.id,
                    is_running.then_some(now),
                    (!is_running).then_some(now),
                )
                .map_err(|error| error.to_string())?;

            let has_running_history = is_running
                || previous
                    .as_ref()
                    .and_then(|record| record.last_seen_running_at.as_ref())
                    .is_some()
                || current.last_seen_running_at.is_some();
            let status = BoardStatusMapper::map_runtime(StatusInput {
                codex_status: &thread.codex_status,
                previous_status: current.board_status,
                has_running_history,
                is_archived: current.board_status == BoardStatus::Archived,
                manual_status_override: current.manual_status_override,
                last_seen_completed_at: Some(now),
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

fn is_known_runtime_status(value: &str) -> bool {
    matches!(
        value,
        "running"
            | "active"
            | "waiting_approval"
            | "waiting approval"
            | "typing"
            | "idle"
            | "completed"
    )
}

fn is_running_status(value: &str) -> bool {
    matches!(
        value,
        "running" | "active" | "waiting_approval" | "waiting approval" | "typing"
    )
}
