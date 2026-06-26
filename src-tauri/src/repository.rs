use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

use crate::domain::{
    BoardStatus, CodexThreadUpsert, FilterPreset, FilterQuery, ProjectInput, ProjectRecord,
    TaskType, ThreadCommentInput, ThreadCommentRecord, ThreadEventInput, ThreadRecord,
};
use crate::project_matcher::{ProjectMatcher, ProjectRule, ThreadProjectHint};
use crate::time::current_utc_text;

const INIT_SQL: &str = include_str!("../db/001_init.sql");
const LEGACY_FIXED_NOW_TEXT: &str = "2026-06-24T00:00:00Z";

pub struct Repository {
    connection: Connection,
    clock: Box<dyn Fn() -> String>,
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
        Self::open_path_with_clock(path, Box::new(current_utc_text))
    }

    pub fn open_path_with_clock(
        path: &Path,
        clock: Box<dyn Fn() -> String>,
    ) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(INIT_SQL)?;
        migrate_schema(&connection, &clock())?;
        Ok(Self { connection, clock })
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::open_in_memory_with_clock(Box::new(current_utc_text))
    }

    pub fn open_in_memory_with_clock(clock: Box<dyn Fn() -> String>) -> rusqlite::Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch(INIT_SQL)?;
        migrate_schema(&connection, &clock())?;
        Ok(Self { connection, clock })
    }

    pub fn upsert_project(&self, input: ProjectInput) -> rusqlite::Result<()> {
        let now = self.now_text();
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
        let now = self.now_text();
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
                self.now_text()
            ],
        )?;
        Ok(())
    }

    pub fn add_thread_comment(
        &self,
        input: ThreadCommentInput,
    ) -> rusqlite::Result<ThreadCommentRecord> {
        let now = self.now_text();
        self.connection.execute(
            "INSERT INTO thread_comments (thread_id, author, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![input.thread_id, input.author, input.body, now],
        )?;
        let id = self.connection.last_insert_rowid();
        if let Some(suspend_until) = input.suspend_until.as_deref() {
            self.suspend_thread_until(&input.thread_id, suspend_until)?;
        } else {
            self.touch_thread(&input.thread_id)?;
        }
        self.get_thread_comment(id)
    }

    pub fn update_thread_comment(
        &self,
        comment_id: i64,
        body: &str,
    ) -> rusqlite::Result<ThreadCommentRecord> {
        let now = self.now_text();
        let thread_id: String = self.connection.query_row(
            "SELECT thread_id FROM thread_comments WHERE id = ?1",
            params![comment_id],
            |row| row.get(0),
        )?;
        self.connection.execute(
            "UPDATE thread_comments
             SET body = ?2, updated_at = ?3, edited_at = ?3
             WHERE id = ?1",
            params![comment_id, body, now],
        )?;
        self.touch_thread(&thread_id)?;
        self.get_thread_comment(comment_id)
    }

    pub fn list_thread_comments(
        &self,
        thread_id: &str,
    ) -> rusqlite::Result<Vec<ThreadCommentRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id, thread_id, author, body, created_at, updated_at, edited_at
             FROM thread_comments
             WHERE thread_id = ?1
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = statement.query_map(params![thread_id], thread_comment_from_row)?;
        rows.collect()
    }

    pub fn mark_reviewed(&self, thread_id: &str) -> rusqlite::Result<()> {
        self.set_status(thread_id, BoardStatus::Reviewed, true, "manual_reviewed")
    }

    pub fn wake_due_suspended_threads(&self, now: &str) -> rusqlite::Result<usize> {
        let mut statement = self.connection.prepare(
            "SELECT id FROM codex_threads
             WHERE board_status = 'suspended'
               AND suspended_until IS NOT NULL
               AND suspended_until <= ?1",
        )?;
        let thread_ids = statement
            .query_map(params![now], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);

        for thread_id in &thread_ids {
            let previous = self.current_board_status(thread_id)?;
            self.connection.execute(
                "UPDATE codex_threads
                 SET board_status = 'review_pending',
                     manual_status_override = 0,
                     manual_status_updated_at = NULL,
                     suspended_until = NULL,
                     archived_at = NULL,
                     updated_at = ?2
                 WHERE id = ?1",
                params![thread_id, now],
            )?;
            self.insert_event(ThreadEventInput {
                thread_id: thread_id.clone(),
                event_type: "status_changed".to_string(),
                from_status: previous,
                to_status: Some(BoardStatus::ReviewPending),
                reason: "suspend_wake_time_due".to_string(),
            })?;
        }

        Ok(thread_ids.len())
    }

    pub fn archive_thread(&self, thread_id: &str) -> rusqlite::Result<()> {
        let previous = self.current_board_status(thread_id)?;
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = 'archived',
                 manual_status_override = 1,
                 manual_status_updated_at = ?2,
                 suspended_until = NULL,
                 archived_at = ?2,
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, self.now_text()],
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
                 manual_status_updated_at = NULL,
                 suspended_until = NULL,
                 archived_at = NULL,
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, self.now_text()],
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
                "suspended",
                "Suspended",
                serde_json::json!({ "board_status": "suspended", "include_archived": false }),
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
            let now = self.now_text();
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
                 manual_status_updated_at = CASE WHEN ?2 = 'running' THEN NULL ELSE manual_status_updated_at END,
                 suspended_until = CASE WHEN ?2 IN ('running', 'review_pending') THEN NULL ELSE suspended_until END,
                 archived_at = CASE WHEN ?2 = 'running' THEN NULL ELSE archived_at END,
                 updated_at = ?3
             WHERE id = ?1",
            params![thread_id, status.as_str(), self.now_text()],
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

    pub fn reopen_for_updated_thread(
        &self,
        thread_id: &str,
        reason: &str,
    ) -> rusqlite::Result<bool> {
        let previous = self.current_board_status(thread_id)?;
        let changed = previous != Some(BoardStatus::ReviewPending);
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = 'review_pending',
                 manual_status_override = 0,
                 manual_status_updated_at = NULL,
                 suspended_until = NULL,
                 archived_at = NULL,
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, self.now_text()],
        )?;

        if changed {
            self.insert_event(ThreadEventInput {
                thread_id: thread_id.to_string(),
                event_type: "status_changed".to_string(),
                from_status: previous,
                to_status: Some(BoardStatus::ReviewPending),
                reason: reason.to_string(),
            })?;
        }

        Ok(changed)
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
                 manual_status_updated_at = NULL,
                 suspended_until = NULL,
                 archived_at = COALESCE(archived_at, ?2),
                 updated_at = ?2
             WHERE id = ?1",
            params![thread_id, self.now_text()],
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
                params![thread.id, next_project_id, self.now_text()],
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
                self.now_text()
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
                 manual_status_updated_at = CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END,
                 suspended_until = CASE WHEN ?2 = 'suspended' THEN suspended_until ELSE NULL END,
                 updated_at = ?4
             WHERE id = ?1",
            params![
                thread_id,
                status.as_str(),
                bool_to_i64(manual),
                self.now_text()
            ],
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

    fn suspend_thread_until(&self, thread_id: &str, suspend_until: &str) -> rusqlite::Result<()> {
        let previous = self.current_board_status(thread_id)?;
        let now = self.now_text();
        self.connection.execute(
            "UPDATE codex_threads
             SET board_status = 'suspended',
                 manual_status_override = 1,
                 manual_status_updated_at = ?3,
                 suspended_until = ?2,
                 archived_at = NULL,
                 updated_at = ?3
             WHERE id = ?1",
            params![thread_id, suspend_until, now],
        )?;
        self.insert_event(ThreadEventInput {
            thread_id: thread_id.to_string(),
            event_type: "status_changed".to_string(),
            from_status: previous,
            to_status: Some(BoardStatus::Suspended),
            reason: "comment_suspend".to_string(),
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
                    manual_status_override, manual_status_updated_at, suspended_until,
                    archived_at, created_at, updated_at
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
                manual_status_updated_at: row.get(18)?,
                suspended_until: row.get(19)?,
                archived_at: row.get(20)?,
                created_at: row.get(21)?,
                updated_at: row.get(22)?,
                comments: Vec::new(),
            })
        })?;

        let mut records = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for record in &mut records {
            record.comments = self.list_thread_comments(&record.id)?;
        }
        Ok(records)
    }

    fn now_text(&self) -> String {
        (self.clock)()
    }

    fn touch_thread(&self, thread_id: &str) -> rusqlite::Result<()> {
        self.connection.execute(
            "UPDATE codex_threads SET updated_at = ?2 WHERE id = ?1",
            params![thread_id, self.now_text()],
        )?;
        Ok(())
    }

    fn get_thread_comment(&self, comment_id: i64) -> rusqlite::Result<ThreadCommentRecord> {
        self.connection.query_row(
            "SELECT id, thread_id, author, body, created_at, updated_at, edited_at
             FROM thread_comments
             WHERE id = ?1",
            params![comment_id],
            thread_comment_from_row,
        )
    }
}

fn thread_comment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadCommentRecord> {
    Ok(ThreadCommentRecord {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        author: row.get(2)?,
        body: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        edited_at: row.get(6)?,
    })
}

fn migrate_schema(connection: &Connection, now: &str) -> rusqlite::Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(codex_threads)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_manual_status_updated_at = columns
        .iter()
        .any(|column| column == "manual_status_updated_at");
    let has_suspended_until = columns.iter().any(|column| column == "suspended_until");

    if !has_manual_status_updated_at {
        connection.execute(
            "ALTER TABLE codex_threads ADD COLUMN manual_status_updated_at TEXT",
            [],
        )?;
    }

    if !has_suspended_until {
        connection.execute(
            "ALTER TABLE codex_threads ADD COLUMN suspended_until TEXT",
            [],
        )?;
    }

    let codex_threads_sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_threads'",
        [],
        |row| row.get(0),
    )?;
    if !codex_threads_sql.contains("'suspended'") {
        rebuild_codex_threads_with_suspended_status(connection)?;
    }

    connection.execute(
        "UPDATE codex_threads
         SET manual_status_updated_at = ?1
         WHERE manual_status_override = 1
           AND manual_status_updated_at = ?2",
        params![now, LEGACY_FIXED_NOW_TEXT],
    )?;

    Ok(())
}

fn rebuild_codex_threads_with_suspended_status(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "DROP TABLE IF EXISTS codex_threads_legacy_migration;
         ALTER TABLE codex_threads RENAME TO codex_threads_legacy_migration;
         CREATE TABLE codex_threads (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           title TEXT NOT NULL,
           preview TEXT NOT NULL DEFAULT '',
           cwd TEXT NOT NULL DEFAULT '',
           branch TEXT NOT NULL DEFAULT '',
           source_kind TEXT NOT NULL DEFAULT 'codex',
           codex_status TEXT NOT NULL DEFAULT 'unknown',
           raw_status TEXT NOT NULL DEFAULT 'unknown',
           codex_sub_status TEXT NOT NULL DEFAULT '',
           board_status TEXT NOT NULL DEFAULT 'untriaged'
             CHECK (board_status IN ('untriaged', 'running', 'review_pending', 'reviewed', 'suspended', 'archived')),
           task_type TEXT NOT NULL DEFAULT ''
             CHECK (task_type IN ('', 'feature', 'bugfix', 'review', 'docs', 'ops')),
           module TEXT NOT NULL DEFAULT '',
           sprint TEXT NOT NULL DEFAULT '',
           notes TEXT NOT NULL DEFAULT '',
           first_seen_at TEXT NOT NULL,
           last_seen_running_at TEXT,
           last_seen_completed_at TEXT,
           manual_status_override INTEGER NOT NULL DEFAULT 0,
           manual_status_updated_at TEXT,
           suspended_until TEXT,
           archived_at TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           last_synced_at TEXT NOT NULL DEFAULT '',
           raw_json TEXT NOT NULL DEFAULT '{}'
         );
         INSERT INTO codex_threads (
           id, project_id, title, preview, cwd, branch, source_kind, codex_status,
           raw_status, codex_sub_status, board_status, task_type, module, sprint, notes,
           first_seen_at, last_seen_running_at, last_seen_completed_at,
           manual_status_override, manual_status_updated_at, suspended_until, archived_at,
           created_at, updated_at, last_synced_at, raw_json
         )
         SELECT
           id, project_id, title, preview, cwd, branch, source_kind, codex_status,
           raw_status, codex_sub_status, board_status, task_type, module, sprint, notes,
           first_seen_at, last_seen_running_at, last_seen_completed_at,
           manual_status_override, manual_status_updated_at, suspended_until, archived_at,
           created_at, updated_at, last_synced_at, raw_json
         FROM codex_threads_legacy_migration;
         DROP TABLE codex_threads_legacy_migration;
         CREATE INDEX IF NOT EXISTS idx_codex_threads_project ON codex_threads(project_id);
         CREATE INDEX IF NOT EXISTS idx_codex_threads_board_status ON codex_threads(board_status);
         CREATE INDEX IF NOT EXISTS idx_codex_threads_updated_at ON codex_threads(updated_at);",
    )?;
    Ok(())
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

fn default_app_db_path() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".codex-kanban")
        .join("app.db")
}
