use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

use crate::domain::{
    BoardStatus, CodexThreadUpsert, FilterPreset, FilterQuery, ProjectInput, ProjectRecord,
    TaskType, ThreadEventInput, ThreadRecord,
};
use crate::project_matcher::{ProjectMatcher, ProjectRule, ThreadProjectHint};

const INIT_SQL: &str = include_str!("../db/001_init.sql");

pub struct Repository {
    connection: Connection,
}

impl Repository {
    pub fn open_default() -> rusqlite::Result<Self> {
        let path = default_app_db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        }
        Self::open_path(&path)
    }

    pub fn open_path(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(INIT_SQL)?;
        Ok(Self { connection })
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch(INIT_SQL)?;
        Ok(Self { connection })
    }

    pub fn upsert_project(&self, input: ProjectInput) -> rusqlite::Result<()> {
        let now = now_text();
        let aliases_json = serde_json::to_string(&input.aliases)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;

        self.connection.execute(
            "INSERT INTO projects (id, name, path, origin_url, aliases_json, active, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               path = excluded.path,
               origin_url = excluded.origin_url,
               aliases_json = excluded.aliases_json,
               active = excluded.active,
               updated_at = excluded.updated_at",
            params![
                input.id,
                input.name,
                input.path,
                input.origin_url,
                aliases_json,
                bool_to_i64(input.active),
                now
            ],
        )?;

        Ok(())
    }

    pub fn list_projects(&self, include_inactive: bool) -> rusqlite::Result<Vec<ProjectRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, path, origin_url, aliases_json, active, created_at, updated_at
             FROM projects
             WHERE ?1 = 1 OR active = 1
             ORDER BY name ASC",
        )?;

        let rows = statement.query_map(params![bool_to_i64(include_inactive)], |row| {
            let aliases_json: String = row.get(4)?;
            Ok(ProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                origin_url: row.get(3)?,
                aliases: serde_json::from_str(&aliases_json).unwrap_or_default(),
                active: int_to_bool(row.get(5)?),
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;

        rows.collect()
    }

    pub fn upsert_thread(&self, input: CodexThreadUpsert) -> rusqlite::Result<()> {
        let now = now_text();
        let raw_json = serde_json::to_string(&input.raw_json)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let current_status = self.current_board_status(&input.id)?;
        let board_status = current_status.unwrap_or(BoardStatus::Untriaged);
        let project_id = input.project_id.unwrap_or_else(|| "unknown".to_string());

        self.connection.execute(
            "INSERT INTO codex_threads (
               id, project_id, title, preview, cwd, branch, source_kind, codex_status,
               raw_status, codex_sub_status, board_status, first_seen_at, created_at, updated_at,
               last_synced_at, raw_json
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?14, ?11, ?12, ?14, ?13)
             ON CONFLICT(id) DO UPDATE SET
               project_id = excluded.project_id,
               title = excluded.title,
               preview = excluded.preview,
               cwd = excluded.cwd,
               branch = excluded.branch,
               source_kind = excluded.source_kind,
               codex_status = excluded.codex_status,
               raw_status = excluded.raw_status,
               codex_sub_status = excluded.codex_sub_status,
               updated_at = excluded.updated_at,
               last_synced_at = excluded.last_synced_at,
               raw_json = excluded.raw_json",
            params![
                input.id,
                project_id,
                input.title,
                input.preview,
                input.cwd,
                input.branch,
                input.source_kind,
                input.codex_status,
                input.codex_sub_status,
                board_status.as_str(),
                input.created_at,
                input.updated_at,
                raw_json,
                now
            ],
        )?;

        Ok(())
    }

    pub fn update_thread_fields(
        &self,
        thread_id: &str,
        task_type: Option<TaskType>,
        module: &str,
        sprint: &str,
        notes: &str,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE codex_threads
             SET task_type = ?2, module = ?3, sprint = ?4, notes = ?5, updated_at = ?6
             WHERE id = ?1",
            params![
                thread_id,
                task_type
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default(),
                module,
                sprint,
                notes,
                now_text()
            ],
        )?;
        Ok(())
    }

    pub fn mark_reviewed(&self, thread_id: &str) -> rusqlite::Result<()> {
        self.set_status(thread_id, BoardStatus::Reviewed, true, "manual_reviewed")
    }

    pub fn archive_thread(&self, thread_id: &str) -> rusqlite::Result<()> {
        let previous = self.current_board_status(thread_id)?;
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = 'archived',
                 manual_status_override = 1,
                 archived_at = ?2,
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, now_text()],
        )?;
        self.insert_event(ThreadEventInput {
            thread_id: thread_id.to_string(),
            event_type: "archive".to_string(),
            from_status: previous,
            to_status: Some(BoardStatus::Archived),
            reason: "manual_archive".to_string(),
        })?;
        Ok(())
    }

    pub fn unarchive_thread(&self, thread_id: &str) -> rusqlite::Result<()> {
        let previous = self.current_board_status(thread_id)?;
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = 'review_pending',
                 manual_status_override = 0,
                 archived_at = NULL,
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, now_text()],
        )?;
        self.insert_event(ThreadEventInput {
            thread_id: thread_id.to_string(),
            event_type: "unarchive".to_string(),
            from_status: previous,
            to_status: Some(BoardStatus::ReviewPending),
            reason: "manual_unarchive".to_string(),
        })?;
        Ok(())
    }

    pub fn seed_builtin_presets(&self) -> rusqlite::Result<()> {
        let presets = [
            (
                "running",
                "Running",
                serde_json::json!({ "board_status": "running", "include_archived": false }),
            ),
            (
                "review_pending",
                "Review Pending",
                serde_json::json!({ "board_status": "review_pending", "include_archived": false }),
            ),
            (
                "untriaged",
                "Untriaged",
                serde_json::json!({ "board_status": "untriaged", "include_archived": false }),
            ),
            (
                "archived",
                "Archived",
                serde_json::json!({ "board_status": "archived", "include_archived": true }),
            ),
        ];

        for (id, name, filters_json) in presets {
            let filters_json = serde_json::to_string(&filters_json)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            let now = now_text();
            self.connection.execute(
                "INSERT INTO filter_presets (id, name, builtin, filters_json, created_at, updated_at)
                 VALUES (?1, ?2, 1, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   filters_json = excluded.filters_json,
                   updated_at = excluded.updated_at",
                params![id, name, filters_json, now],
            )?;
        }

        Ok(())
    }

    pub fn list_filter_presets(&self) -> rusqlite::Result<Vec<FilterPreset>> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, builtin, filters_json FROM filter_presets ORDER BY name ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let filters_json: String = row.get(3)?;
            Ok(FilterPreset {
                id: row.get(0)?,
                name: row.get(1)?,
                builtin: int_to_bool(row.get(2)?),
                filters_json: serde_json::from_str(&filters_json).unwrap_or(Value::Null),
            })
        })?;

        rows.collect()
    }

    pub fn list_threads(&self, query: FilterQuery) -> rusqlite::Result<Vec<ThreadRecord>> {
        let mut records = self.load_all_threads()?;
        records.retain(|thread| {
            (query.include_archived || thread.board_status != BoardStatus::Archived)
                && query
                    .project_id
                    .as_ref()
                    .map(|value| thread.project_id.as_ref() == Some(value))
                    .unwrap_or(true)
                && query
                    .board_status
                    .map(|value| thread.board_status == value)
                    .unwrap_or(true)
                && query
                    .codex_status
                    .as_ref()
                    .map(|value| thread.codex_status == *value)
                    .unwrap_or(true)
                && query
                    .task_type
                    .map(|value| thread.task_type == Some(value))
                    .unwrap_or(true)
                && query
                    .module
                    .as_ref()
                    .map(|value| thread.module == *value)
                    .unwrap_or(true)
                && query
                    .sprint
                    .as_ref()
                    .map(|value| thread.sprint == *value)
                    .unwrap_or(true)
                && query
                    .updated_from
                    .as_ref()
                    .map(|value| thread.updated_at >= *value)
                    .unwrap_or(true)
                && query
                    .updated_to
                    .as_ref()
                    .map(|value| thread.updated_at <= *value)
                    .unwrap_or(true)
        });
        records.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(records)
    }

    pub fn get_thread(&self, thread_id: &str) -> rusqlite::Result<Option<ThreadRecord>> {
        Ok(self
            .list_threads(FilterQuery {
                include_archived: true,
                ..FilterQuery::default()
            })?
            .into_iter()
            .find(|thread| thread.id == thread_id))
    }

    pub fn update_runtime_markers(
        &self,
        thread_id: &str,
        is_running: bool,
        observed_at: &str,
    ) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE codex_threads
             SET last_seen_running_at = CASE WHEN ?2 = 1 THEN ?3 ELSE last_seen_running_at END,
                 last_seen_completed_at = CASE
                   WHEN ?2 = 1 THEN NULL
                   ELSE COALESCE(last_seen_completed_at, ?3)
                 END
             WHERE id = ?1",
            params![thread_id, bool_to_i64(is_running), observed_at],
        )?;
        Ok(())
    }

    pub fn set_auto_status_if_changed(
        &self,
        thread_id: &str,
        status: BoardStatus,
        reason: &str,
    ) -> rusqlite::Result<bool> {
        let previous = self.current_board_status(thread_id)?;
        if previous == Some(status) {
            return Ok(false);
        }

        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = ?2,
                 manual_status_override = CASE WHEN ?2 = 'running' THEN 0 ELSE manual_status_override END,
                 updated_at = ?3
             WHERE id = ?1",
            params![thread_id, status.as_str(), now_text()],
        )?;
        self.insert_event(ThreadEventInput {
            thread_id: thread_id.to_string(),
            event_type: "status_changed".to_string(),
            from_status: previous,
            to_status: Some(status),
            reason: reason.to_string(),
        })?;
        Ok(true)
    }

    pub fn set_synced_archived_if_changed(
        &self,
        thread_id: &str,
        reason: &str,
    ) -> rusqlite::Result<bool> {
        let previous = self.current_board_status(thread_id)?;
        let changed = previous != Some(BoardStatus::Archived);
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = 'archived',
                 manual_status_override = 0,
                 archived_at = COALESCE(archived_at, ?2),
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, now_text()],
        )?;

        if changed {
            self.insert_event(ThreadEventInput {
                thread_id: thread_id.to_string(),
                event_type: "status_changed".to_string(),
                from_status: previous,
                to_status: Some(BoardStatus::Archived),
                reason: reason.to_string(),
            })?;
        }

        Ok(changed)
    }

    pub fn count_thread_events(&self, thread_id: &str) -> rusqlite::Result<i64> {
        self.connection.query_row(
            "SELECT COUNT(*) FROM thread_events WHERE thread_id = ?1",
            params![thread_id],
            |row| row.get(0),
        )
    }

    pub fn reclassify_unarchived_threads(
        &self,
        projects: &[ProjectRule],
    ) -> rusqlite::Result<usize> {
        let threads = self.list_threads(FilterQuery::default())?;
        let mut changed = 0;

        for thread in threads {
            let next_project_id = ProjectMatcher::match_thread(
                &ThreadProjectHint {
                    cwd: Some(thread.cwd.clone()),
                    origin_url: None,
                },
                projects,
            )
            .map(|project| project.id.clone())
            .unwrap_or_else(|| "unknown".to_string());

            if thread.project_id.as_deref() == Some(next_project_id.as_str()) {
                continue;
            }

            self.connection.execute(
                "UPDATE codex_threads SET project_id = ?2, updated_at = ?3 WHERE id = ?1",
                params![thread.id, next_project_id, now_text()],
            )?;
            changed += 1;
        }

        Ok(changed)
    }

    pub fn insert_event(&self, input: ThreadEventInput) -> rusqlite::Result<()> {
        self.connection.execute(
            "INSERT INTO thread_events (thread_id, event_type, from_status, to_status, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.thread_id,
                input.event_type,
                input.from_status.map(|value| value.as_str().to_string()),
                input.to_status.map(|value| value.as_str().to_string()),
                input.reason,
                now_text()
            ],
        )?;
        Ok(())
    }

    fn set_status(
        &self,
        thread_id: &str,
        status: BoardStatus,
        manual: bool,
        reason: &str,
    ) -> rusqlite::Result<()> {
        let previous = self.current_board_status(thread_id)?;
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = ?2,
                 manual_status_override = ?3,
                 updated_at = ?4
             WHERE id = ?1",
            params![thread_id, status.as_str(), bool_to_i64(manual), now_text()],
        )?;
        self.insert_event(ThreadEventInput {
            thread_id: thread_id.to_string(),
            event_type: "status_changed".to_string(),
            from_status: previous,
            to_status: Some(status),
            reason: reason.to_string(),
        })?;
        Ok(())
    }

    fn current_board_status(&self, thread_id: &str) -> rusqlite::Result<Option<BoardStatus>> {
        self.connection
            .query_row(
                "SELECT board_status FROM codex_threads WHERE id = ?1",
                params![thread_id],
                |row| {
                    let status: String = row.get(0)?;
                    Ok(BoardStatus::parse(&status).unwrap_or(BoardStatus::Untriaged))
                },
            )
            .optional()
    }

    fn load_all_threads(&self) -> rusqlite::Result<Vec<ThreadRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, title, preview, cwd, branch, source_kind, codex_status,
                    codex_sub_status, board_status, task_type, module, sprint, notes,
                    first_seen_at, last_seen_running_at, last_seen_completed_at,
                    manual_status_override, archived_at, created_at, updated_at
             FROM codex_threads",
        )?;
        let rows = statement.query_map([], |row| {
            let board_status: String = row.get(9)?;
            let task_type: String = row.get(10)?;
            Ok(ThreadRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                cwd: row.get(4)?,
                branch: row.get(5)?,
                source_kind: row.get(6)?,
                codex_status: row.get(7)?,
                codex_sub_status: row.get(8)?,
                board_status: BoardStatus::parse(&board_status).unwrap_or(BoardStatus::Untriaged),
                task_type: TaskType::parse(&task_type),
                module: row.get(11)?,
                sprint: row.get(12)?,
                notes: row.get(13)?,
                first_seen_at: row.get(14)?,
                last_seen_running_at: row.get(15)?,
                last_seen_completed_at: row.get(16)?,
                manual_status_override: int_to_bool(row.get(17)?),
                archived_at: row.get(18)?,
                created_at: row.get(19)?,
                updated_at: row.get(20)?,
            })
        })?;

        rows.collect()
    }
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn int_to_bool(value: i64) -> bool {
    value != 0
}

fn now_text() -> String {
    "2026-06-24T00:00:00Z".to_string()
}

fn default_app_db_path() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".codex-kanban")
        .join("app.db")
}
