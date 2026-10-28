//! Earliest automatic-start time. Kept separate from legacy date-only task metadata.
//! Scheduling never changes a user's delegation, pause, approval or dependency policy.
use crate::repository::Repository;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

pub(crate) fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(task_preferences)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == "scheduled_start_at") {
        connection.execute(
            "ALTER TABLE task_preferences ADD COLUMN scheduled_start_at TEXT",
            [],
        )?;
    }
    Ok(())
}

pub(crate) fn scheduled_at(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT scheduled_start_at FROM task_preferences WHERE task_id=?1",
            [task_id],
            |r| r.get(0),
        )
        .optional()
        .map(|v| v.flatten())
        .map_err(|e| e.to_string())
}

pub(crate) fn waiting_for_time(
    connection: &Connection,
    task_id: &str,
    now: &str,
) -> Result<bool, String> {
    // Values are validated canonical UTC timestamps, same format as Repository's clock.
    Ok(scheduled_at(connection, task_id)?.is_some_and(|at| at.as_str() > now))
}

fn validate_time(connection: &Connection, value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    if value.len() != 20 || !value.ends_with('Z') {
        return Err("开始时间必须包含时区并转换为 UTC（YYYY-MM-DDTHH:MM:SSZ）".into());
    }
    let normalized: Option<String> = connection
        .query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%SZ',?1,'+0 seconds')",
            [value],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if normalized.as_deref() != Some(value) {
        return Err("开始时间无效，请重新选择日期与时间".into());
    }
    Ok(Some(value.to_owned()))
}

impl Repository {
    pub fn task_start_time(&self, task_id: &str) -> Result<Option<String>, String> {
        scheduled_at(&self.connection, task_id)
    }
    pub fn set_task_start_time(
        &self,
        task_id: &str,
        value: Option<&str>,
        expected: Option<&str>,
    ) -> Result<(), String> {
        self.chat_require_task(task_id)?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let value = validate_time(&tx, value)?;
        let current = scheduled_at(&tx, task_id)?;
        if current.as_deref() != expected {
            return Err("开始时间已被修改，请刷新后重试".into());
        }
        if current == value {
            return Ok(());
        }
        let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM work_tasks WHERE task_id=?1 AND current_run_id IS NOT NULL) OR EXISTS(SELECT 1 FROM chat_runs r JOIN chat_conversations c ON c.id=r.conversation_id WHERE c.task_id=?1 AND r.ended_at IS NULL AND r.kind='chat') OR EXISTS(SELECT 1 FROM chat_pending_changes WHERE task_id=?1)", [task_id], |r|r.get(0)).map_err(|e|e.to_string())?;
        if busy {
            return Err("请先暂停当前执行并等待停止确认，再修改开始时间".into());
        }
        let now = self.now_text();
        tx.execute("INSERT INTO task_preferences(task_id,scheduled_start_at,revision) VALUES(?1,?2,1) ON CONFLICT(task_id) DO UPDATE SET scheduled_start_at=excluded.scheduled_start_at,revision=task_preferences.revision+1", params![task_id,value]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE todo_tasks SET activity_at=?2,updated_at=?2 WHERE id=?1",
            params![task_id, now],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO work_events(task_id,run_id,kind,payload_json,created_at) VALUES(?1,NULL,'start_time_changed',?2,?3)", params![task_id,serde_json::json!({"scheduled_start_at":value}).to_string(),now]).map_err(|e|e.to_string())?;
        // Includes dependency/time waits but deliberately excludes manual pauses,
        // environment/human waits, running work and terminal tasks.
        crate::workflow::refresh_dependencies(&tx, &now)?;
        tx.commit().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{TodoTaskInput, TodoTaskStatus},
        workflow::{TaskAction, TaskConfig, WorkflowStatus},
    };
    use std::sync::{Arc, Mutex};
    fn fixture() -> (Repository, Arc<Mutex<String>>) {
        let clock = Arc::new(Mutex::new("2026-10-28T02:00:00Z".to_string()));
        let value = clock.clone();
        let repo =
            Repository::open_in_memory_with_clock(Box::new(move || value.lock().unwrap().clone()))
                .unwrap();
        repo.save_todo_tasks(
            &["a", "b"]
                .into_iter()
                .map(|id| TodoTaskInput {
                    id: id.into(),
                    parent_id: None,
                    position: 0,
                    title: id.into(),
                    status: TodoTaskStatus::Todo,
                    pinned: false,
                    start_date: None,
                    expected_end_date: None,
                    actual_end_date: None,
                    process_tracking: String::new(),
                    result_review: String::new(),
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        (repo, clock)
    }
    fn config() -> TaskConfig {
        TaskConfig {
            workspace: "/tmp".into(),
            prompt: "Do the work".into(),
            ..TaskConfig::default()
        }
    }
    #[test]
    fn only_delegated_due_tasks_become_claimable_at_exact_boundary() {
        let (r, c) = fixture();
        r.set_task_start_time("a", Some("2026-10-28T03:00:00Z"), None)
            .unwrap();
        r.refresh_work_dependencies().unwrap();
        assert!(r.get_work_task("a").unwrap().is_none());
        let w = r.delegate_task("a", &config()).unwrap();
        assert_eq!(w.wait_reason.as_deref(), Some("scheduled"));
        assert!(r.claim_work_task("a", "early").is_err());
        assert!(r.chat_conversation("main:a").unwrap().thread_id.is_none());
        *c.lock().unwrap() = "2026-10-28T03:00:00Z".into();
        assert_eq!(r.refresh_work_dependencies().unwrap(), 1);
        assert_eq!(r.refresh_work_dependencies().unwrap(), 0);
        r.claim_work_task("a", "due").unwrap();
        assert!(r.claim_work_task("a", "duplicate").is_err());
    }
    #[test]
    fn start_time_is_anded_with_dependencies_and_never_clears_a_pause() {
        let (r, c) = fixture();
        r.set_task_start_time("a", Some("2026-10-28T03:00:00Z"), None)
            .unwrap();
        let mut conf = config();
        conf.blocked_by = vec!["b".into()];
        r.delegate_task("a", &conf).unwrap();
        *c.lock().unwrap() = "2026-10-28T04:00:00Z".into();
        r.refresh_work_dependencies().unwrap();
        assert_eq!(
            r.get_work_task("a")
                .unwrap()
                .unwrap()
                .wait_reason
                .as_deref(),
            Some("dependencies")
        );
        let w = r.get_work_task("a").unwrap().unwrap();
        r.apply_task_action("a", TaskAction::Pause, w.revision, None)
            .unwrap();
        r.set_task_start_time("a", None, Some("2026-10-28T03:00:00Z"))
            .unwrap();
        assert_eq!(
            r.get_work_task("a").unwrap().unwrap().status,
            WorkflowStatus::Paused
        );
    }
    #[test]
    fn invalid_dates_stale_writes_and_inflight_edits_are_rejected() {
        let (r, _) = fixture();
        for bad in ["2026-02-30T03:00:00Z", "2026-10-28T03:00", "garbage"] {
            assert!(r.set_task_start_time("a", Some(bad), None).is_err());
        }
        r.set_task_start_time("a", Some("2026-10-28T03:00:00Z"), None)
            .unwrap();
        assert!(r.set_task_start_time("a", None, None).is_err());
        r.set_task_start_time("a", None, Some("2026-10-28T03:00:00Z"))
            .unwrap();
        r.delegate_task("a", &config()).unwrap();
        r.claim_work_task("a", "running").unwrap();
        assert!(r
            .set_task_start_time("a", Some("2026-10-29T03:00:00Z"), None)
            .unwrap_err()
            .contains("停止确认"));
    }
    #[test]
    fn migration_is_idempotent_and_does_not_promote_legacy_start_dates() {
        let (r, _) = fixture();
        r.connection
            .execute(
                "UPDATE todo_tasks SET start_date='2020-01-01' WHERE id='a'",
                [],
            )
            .unwrap();
        migrate(&r.connection).unwrap();
        migrate(&r.connection).unwrap();
        assert_eq!(r.task_start_time("a").unwrap(), None);
        r.set_task_start_time("a", Some("2026-10-28T03:00:00Z"), None)
            .unwrap();
        migrate(&r.connection).unwrap();
        assert_eq!(
            r.task_start_time("a").unwrap().as_deref(),
            Some("2026-10-28T03:00:00Z")
        );
    }
    #[test]
    fn reading_and_noop_changes_do_not_pollute_week_view_activity() {
        let (r, c) = fixture();
        let activity = |id: &str| -> String {
            r.connection
                .query_row(
                    "SELECT activity_at FROM todo_tasks WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let initial = activity("a");
        *c.lock().unwrap() = "2026-10-28T05:00:00Z".into();
        r.chat_snapshot().unwrap();
        r.chat_update_task(
            "a",
            &serde_json::json!({"title":"a"}),
            &serde_json::json!({"title":"a"}),
        )
        .unwrap();
        r.set_task_start_time("a", None, None).unwrap();
        assert_eq!(activity("a"), initial);
        r.set_task_start_time("a", Some("2026-10-29T05:00:00Z"), None)
            .unwrap();
        assert_eq!(activity("a"), "2026-10-28T05:00:00Z");
        *c.lock().unwrap() = "2026-10-28T06:00:00Z".into();
        r.set_task_start_time(
            "a",
            Some("2026-10-29T05:00:00Z"),
            Some("2026-10-29T05:00:00Z"),
        )
        .unwrap();
        assert_eq!(activity("a"), "2026-10-28T05:00:00Z");
        r.chat_update_task(
            "a",
            &serde_json::json!({"process_tracking":"updated context"}),
            &serde_json::json!({"process_tracking":""}),
        )
        .unwrap();
        assert_eq!(activity("a"), "2026-10-28T06:00:00Z");
    }
}
