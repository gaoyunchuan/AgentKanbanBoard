//! Durable task execution. Codex turns are attempts, not business completion.
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::domain::{TodoTaskInput, TodoTaskRecord};
use crate::repository::Repository;

pub const MAX_AUTOMATIC_CONTINUATIONS: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Queued,
    Running,
    Waiting,
    Review,
    Completed,
    Paused,
    Cancelled,
    Attention,
}

impl WorkflowStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Review => "review",
            Self::Completed => "completed",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
            Self::Attention => "attention",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "review" => Ok(Self::Review),
            "completed" => Ok(Self::Completed),
            "paused" => Ok(Self::Paused),
            "cancelled" => Ok(Self::Cancelled),
            "attention" => Ok(Self::Attention),
            _ => Err(format!("未知任务执行状态: {value}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPolicy {
    #[default]
    Human,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct TaskConfig {
    pub agent_id: String,
    pub delegated_by: String,
    pub workspace: String,
    pub prompt: String,
    pub acceptance: String,
    pub review_policy: ReviewPolicy,
    pub blocked_by: Vec<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub instructions: String,
    pub approval_policy: String,
    pub sandbox_mode: String,
    pub browser_enabled: bool,
}

impl Default for TaskConfig {
    fn default() -> Self {
        Self {
            agent_id: "codex".into(),
            delegated_by: "user".into(),
            workspace: String::new(),
            prompt: String::new(),
            acceptance: String::new(),
            review_policy: ReviewPolicy::Human,
            blocked_by: Vec::new(),
            model: None,
            reasoning_effort: None,
            instructions: String::new(),
            approval_policy: "on-request".into(),
            sandbox_mode: "workspace-write".into(),
            browser_enabled: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub fn default_agent_profiles() -> Vec<AgentProfile> {
    vec![
        AgentProfile {
            id: "codex".into(),
            name: "Codex".into(),
            instructions: String::new(),
            model: None,
            reasoning_effort: None,
        },
        AgentProfile {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            instructions: "Review the requested delivery against its acceptance criteria. Report concrete findings with evidence.".into(),
            model: None,
            reasoning_effort: None,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTask {
    pub task_id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub status: WorkflowStatus,
    pub revision: i64,
    pub config: TaskConfig,
    pub current_run_id: Option<String>,
    pub thread_id: Option<String>,
    pub wait_reason: Option<String>,
    pub last_error: Option<String>,
    pub result_summary: Option<String>,
    pub continuation_count: i64,
    pub execution_status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkRun {
    pub id: String,
    pub task_id: String,
    pub generation: i64,
    pub status: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub prompt: String,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkEvent {
    pub id: i64,
    pub task_id: String,
    pub run_id: Option<String>,
    pub kind: String,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInteraction {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub request_id: Value,
    pub kind: String,
    pub method: String,
    pub payload: Value,
    pub status: String,
    pub response: Option<Value>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecutionDetail {
    pub task: WorkTask,
    pub runs: Vec<WorkRun>,
    pub events: Vec<WorkEvent>,
    pub interactions: Vec<TaskInteraction>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskAction {
    Pause,
    Resume,
    Retry,
    Accept,
    Rework,
    Cancel,
}

fn db(error: rusqlite::Error) -> String {
    error.to_string()
}

fn encode(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn decode<T: serde::de::DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn transaction(connection: &Connection) -> Result<Transaction<'_>, String> {
    Transaction::new_unchecked(connection, TransactionBehavior::Immediate).map_err(db)
}

fn unique_id(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{prefix}-{nanos:x}-{:x}",
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn event(
    connection: &Connection,
    task_id: &str,
    run_id: Option<&str>,
    kind: &str,
    payload: &Value,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO work_events(task_id,run_id,kind,payload_json,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![task_id, run_id, kind, encode(payload)?, now],
        )
        .map_err(db)?;
    Ok(())
}

fn current_run(connection: &Connection, task_id: &str, run_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM work_tasks w JOIN work_runs r ON r.id=w.current_run_id
         WHERE w.task_id=?1 AND r.id=?2 AND r.generation=w.generation AND r.ended_at IS NULL)",
            params![task_id, run_id],
            |row| row.get(0),
        )
        .map_err(db)
}

fn require_run(connection: &Connection, task_id: &str, run_id: &str) -> Result<(), String> {
    if current_run(connection, task_id, run_id)? {
        Ok(())
    } else {
        Err("该执行已结束或已被替换；请刷新任务，旧执行不能改变当前任务".into())
    }
}

pub(crate) fn unresolved_dependencies(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT d.blocked_by FROM work_dependencies d JOIN todo_tasks t ON t.id=d.blocked_by
         WHERE d.task_id=?1 AND (t.status<>'completed' OR NOT (
           EXISTS(SELECT 1 FROM task_results r WHERE r.task_id=t.id AND r.status='ready' AND r.usable=1)
           OR (NOT EXISTS(SELECT 1 FROM chat_conversations c WHERE c.task_id=t.id) AND trim(t.result_review)<>''))) ORDER BY d.blocked_by",
        )
        .map_err(db)?;
    let result = statement
        .query_map([task_id], |row| row.get(0))
        .map_err(db)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(db)?;
    Ok(result)
}

pub(crate) fn replace_dependencies(
    connection: &Connection,
    task_id: &str,
    blockers: &[String],
) -> Result<(), String> {
    let mut unique = HashSet::new();
    for blocker in blockers {
        if blocker == task_id || !unique.insert(blocker.as_str()) {
            return Err("依赖不能包含自身或重复任务".into());
        }
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM todo_tasks WHERE id=?1)",
                [blocker],
                |row| row.get(0),
            )
            .map_err(db)?;
        if !exists {
            return Err(format!("依赖任务不存在: {blocker}"));
        }
        let cycle: bool = connection
            .query_row(
                "WITH RECURSIVE ancestors(id) AS (
               SELECT blocked_by FROM work_dependencies WHERE task_id=?1
               UNION SELECT d.blocked_by FROM work_dependencies d JOIN ancestors a ON d.task_id=a.id
             ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=?2)",
                params![blocker, task_id],
                |row| row.get(0),
            )
            .map_err(db)?;
        if cycle {
            return Err(format!("依赖形成循环: {task_id} → {blocker}"));
        }
    }
    connection
        .execute("DELETE FROM work_dependencies WHERE task_id=?1", [task_id])
        .map_err(db)?;
    for blocker in blockers {
        connection
            .execute(
                "INSERT INTO work_dependencies(task_id,blocked_by) VALUES(?1,?2)",
                params![task_id, blocker],
            )
            .map_err(db)?;
    }
    Ok(())
}

fn project_business_status(
    connection: &Connection,
    task_id: &str,
    status: WorkflowStatus,
    now: &str,
) -> Result<(), String> {
    let business = match status {
        WorkflowStatus::Completed => "completed",
        WorkflowStatus::Cancelled => "cancelled",
        WorkflowStatus::Queued => {
            let started: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM work_runs WHERE task_id=?1)",
                    [task_id],
                    |row| row.get(0),
                )
                .map_err(db)?;
            if started {
                "in_progress"
            } else {
                "todo"
            }
        }
        WorkflowStatus::Waiting => {
            let started: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM work_runs WHERE task_id=?1)",
                    [task_id],
                    |row| row.get(0),
                )
                .map_err(db)?;
            if started {
                "in_progress"
            } else {
                "todo"
            }
        }
        _ => "in_progress",
    };
    connection.execute(
        "UPDATE todo_tasks SET status=?2,actual_end_date=CASE WHEN ?2 IN ('completed','cancelled') THEN date(?3,'localtime') ELSE NULL END,
         activity_at=CASE WHEN status<>?2 THEN ?3 ELSE activity_at END,updated_at=?3 WHERE id=?1",
        params![task_id,business,now],
    ).map_err(db)?;
    Ok(())
}

fn invalidate_run(connection: &Connection, task_id: &str, now: &str) -> Result<(), String> {
    connection.execute(
        "UPDATE work_runs SET status='superseded',ended_at=?2 WHERE task_id=?1 AND ended_at IS NULL",
        params![task_id,now],
    ).map_err(db)?;
    connection.execute(
        "UPDATE work_interactions SET status='expired',resolved_at=?2 WHERE task_id=?1 AND status='pending'",
        params![task_id,now],
    ).map_err(db)?;
    connection
        .execute(
            "UPDATE work_tasks SET current_run_id=NULL,generation=generation+1 WHERE task_id=?1",
            [task_id],
        )
        .map_err(db)?;
    Ok(())
}

fn get_task(connection: &Connection, task_id: &str) -> Result<Option<WorkTask>, String> {
    let mut value = connection.query_row(
        "SELECT w.task_id,t.title,t.parent_id,w.status,w.revision,w.config_json,w.current_run_id,w.thread_id,
                w.wait_reason,w.last_error,w.result_summary,w.continuation_count,w.updated_at,
                COALESCE((SELECT r.status FROM work_runs r WHERE r.id=w.current_run_id),'idle')
         FROM work_tasks w JOIN todo_tasks t ON t.id=w.task_id WHERE w.task_id=?1",
        [task_id], |row| {
            let status: String = row.get(3)?;
            Ok(WorkTask {
                task_id: row.get(0)?,title: row.get(1)?,parent_id: row.get(2)?,
                status: WorkflowStatus::parse(&status).map_err(|error| rusqlite::Error::FromSqlConversionFailure(3,rusqlite::types::Type::Text,Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData,error))))?,
                revision: row.get(4)?,config: decode(row.get(5)?)?,current_run_id: row.get(6)?,thread_id: row.get(7)?,
                wait_reason: row.get(8)?,last_error: row.get(9)?,result_summary: row.get(10)?,continuation_count: row.get(11)?,
                updated_at: row.get(12)?,execution_status: row.get(13)?,
            })
        },
    ).optional().map_err(db)?;
    if let Some(task) = &mut value {
        let mut statement = connection
            .prepare(
                "SELECT blocked_by FROM work_dependencies WHERE task_id=?1 ORDER BY blocked_by",
            )
            .map_err(db)?;
        task.config.blocked_by = statement
            .query_map([task_id], |row| row.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(db)?;
        let pending_kind: Option<String> = connection.query_row(
            "SELECT kind FROM work_interactions WHERE task_id=?1 AND status='pending' ORDER BY created_at LIMIT 1",
            [task_id], |row| row.get(0),
        ).optional().map_err(db)?;
        if let Some(kind) = pending_kind {
            task.execution_status = if kind == "approval" {
                "waiting_approval"
            } else {
                "waiting_input"
            }
            .into();
        }
    }
    Ok(value)
}

fn required_task(connection: &Connection, task_id: &str) -> Result<WorkTask, String> {
    get_task(connection, task_id)?.ok_or_else(|| "任务尚未委派给 Agent".into())
}

pub(crate) fn refresh_dependencies(connection: &Connection, now: &str) -> Result<usize, String> {
    let ids = {
        let mut statement = connection.prepare(
            "SELECT task_id FROM work_tasks WHERE status IN ('queued','waiting') AND (wait_reason IN ('dependencies','scheduled') OR status='queued')",
        ).map_err(db)?;
        let result = statement
            .query_map([], |row| row.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(db)?;
        result
    };
    let mut count = 0;
    for id in ids {
        let reason = if !unresolved_dependencies(connection, &id)?.is_empty() {
            Some("dependencies")
        } else if crate::task_schedule::waiting_for_time(connection, &id, now)? {
            Some("scheduled")
        } else {
            None
        };
        let ready = reason.is_none();
        let status = if ready { "queued" } else { "waiting" };
        let changed = connection.execute(
            "UPDATE work_tasks SET status=?2,wait_reason=?3,revision=revision+1,updated_at=?4 WHERE task_id=?1 AND (status<>?2 OR wait_reason IS NOT ?3)",
            params![id,status,reason,now],
        ).map_err(db)?;
        if changed > 0 {
            event(
                connection,
                &id,
                None,
                if ready {
                    "dependencies_ready"
                } else if reason == Some("scheduled") {
                    "scheduled_waiting"
                } else {
                    "dependencies_waiting"
                },
                &json!({"wait_reason":reason}),
                now,
            )?;
            count += changed;
        }
    }
    Ok(count)
}

fn validate_config(config: &TaskConfig) -> Result<(), String> {
    if config.agent_id.trim().is_empty() || config.prompt.trim().is_empty() {
        return Err("请填写执行 Agent 和任务说明".into());
    }
    if !std::path::Path::new(&config.workspace).is_absolute() {
        return Err("工作目录必须是绝对路径".into());
    }
    if !matches!(
        config.approval_policy.as_str(),
        "on-request" | "untrusted" | "on-failure" | "never"
    ) {
        return Err("不支持的审批策略".into());
    }
    if !matches!(
        config.sandbox_mode.as_str(),
        "read-only" | "workspace-write"
    ) {
        return Err("一期支持只读或 workspace-write 沙箱".into());
    }
    Ok(())
}

impl Repository {
    /// Apply only the caller's actual edits. Both complete before/after snapshots
    /// and a subset of touched rows are supported; absence from both is no-op.
    /// A field changed by another actor is a conflict, never last-writer-wins.
    pub fn save_todo_task_changes(
        &self,
        before: &[TodoTaskInput],
        after: &[TodoTaskInput],
    ) -> Result<Vec<TodoTaskRecord>, String> {
        let before_map = unique_todo_inputs(before)?;
        let after_map = unique_todo_inputs(after)?;
        let tx = transaction(&self.connection)?;
        let now = self.now_text();
        let records = self.list_todo_tasks().map_err(db)?;
        let existing: HashMap<String, TodoTaskInput> = records
            .iter()
            .map(|record| (record.id.clone(), todo_record_input(record)))
            .collect();
        let mut next = existing.clone();
        let mut deleted = HashSet::new();
        for (id, old) in &before_map {
            if !after_map.contains_key(id) {
                if let Some(current) = existing.get(id) {
                    if encode(current)? != encode(old)? {
                        return Err(format!("任务 {id} 已被更新，刷新后才能删除"));
                    }
                    if let Some(work) = get_task(&tx, id)? {
                        if !matches!(
                            work.status,
                            WorkflowStatus::Completed | WorkflowStatus::Cancelled
                        ) || work.current_run_id.is_some()
                        {
                            return Err(format!("任务 {id} 仍在执行流程中，请先取消后再删除"));
                        }
                    }
                }
                deleted.insert(id.clone());
                next.remove(id);
            }
        }
        for (id, new) in &after_map {
            if let Some(old) = before_map.get(id) {
                if encode(old)? == encode(new)? {
                    continue;
                }
                let current = existing
                    .get(id)
                    .ok_or_else(|| format!("任务 {id} 已被删除，不能覆盖恢复"))?;
                if old.status != new.status && get_task(&tx, id)?.is_some() {
                    return Err(
                        "已委派任务的状态由执行与验收驱动，请使用暂停、取消、验收或返工操作".into(),
                    );
                }
                let old_value = serde_json::to_value(old).map_err(|error| error.to_string())?;
                let new_value = serde_json::to_value(new).map_err(|error| error.to_string())?;
                let mut merged =
                    serde_json::to_value(current).map_err(|error| error.to_string())?;
                let fields = old_value
                    .as_object()
                    .ok_or_else(|| "无效任务数据".to_string())?;
                for (field, old_field) in fields {
                    let new_field = &new_value[field];
                    if old_field != new_field {
                        let current_field = &merged[field];
                        if current_field != old_field && current_field != new_field {
                            return Err(format!("任务 {id} 的 {field} 已更新，请刷新后重试"));
                        }
                        merged[field] = new_field.clone();
                    }
                }
                next.insert(
                    id.clone(),
                    serde_json::from_value(merged).map_err(|error| error.to_string())?,
                );
            } else {
                if existing.contains_key(id) {
                    return Err(format!("新任务 ID 已存在: {id}"));
                }
                next.insert(id.clone(), new.clone());
            }
        }
        // A newly delegated child that the client has never seen cannot be lost
        // by deleting its stale parent snapshot. Explicit reparenting is allowed.
        validate_todo_tree(&next)?;
        let pinned_roots: HashSet<String> = next
            .values()
            .filter(|task| task.pinned)
            .map(|task| {
                let mut current = task;
                while let Some(parent) = current.parent_id.as_ref() {
                    current = &next[parent];
                }
                current.id.clone()
            })
            .collect();
        for task in next.values_mut() {
            task.pinned = pinned_roots.contains(&task.id);
        }
        for id in &deleted {
            tx.execute("DELETE FROM work_dependencies WHERE task_id=?1", [id])
                .map_err(db)?;
        }
        for id in &deleted {
            tx.execute("DELETE FROM todo_tasks WHERE id=?1", [id])
                .map_err(|error| format!("不能删除仍被其他任务依赖的任务 {id}: {error}"))?;
        }
        for (id, task) in &next {
            if existing.get(id).map(encode).transpose()?.as_deref() == Some(encode(task)?.as_str())
            {
                continue;
            }
            write_todo(&tx, task, &now)?;
        }
        refresh_dependencies(&tx, &now)?;
        tx.commit().map_err(db)?;
        self.list_todo_tasks().map_err(db)
    }

    pub fn list_work_tasks(&self) -> Result<Vec<WorkTask>, String> {
        let ids = {
            let mut statement = self
                .connection
                .prepare("SELECT task_id FROM work_tasks ORDER BY updated_at,task_id")
                .map_err(db)?;
            let result = statement
                .query_map([], |row| row.get(0))
                .map_err(db)?
                .collect::<rusqlite::Result<Vec<String>>>()
                .map_err(db)?;
            result
        };
        ids.iter()
            .map(|id| required_task(&self.connection, id))
            .collect()
    }

    pub fn get_work_task(&self, task_id: &str) -> Result<Option<WorkTask>, String> {
        get_task(&self.connection, task_id)
    }

    pub fn load_task_execution(&self, task_id: &str) -> Result<TaskExecutionDetail, String> {
        let task = required_task(&self.connection, task_id)?;
        let mut statement = self.connection.prepare(
            "SELECT id,task_id,generation,status,thread_id,turn_id,prompt,error,started_at,ended_at FROM work_runs WHERE task_id=?1 ORDER BY generation",
        ).map_err(db)?;
        let runs = statement
            .query_map([task_id], |row| {
                Ok(WorkRun {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    generation: row.get(2)?,
                    status: row.get(3)?,
                    thread_id: row.get(4)?,
                    turn_id: row.get(5)?,
                    prompt: row.get(6)?,
                    error: row.get(7)?,
                    started_at: row.get(8)?,
                    ended_at: row.get(9)?,
                })
            })
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        let mut statement = self.connection.prepare("SELECT id,task_id,run_id,kind,payload_json,created_at FROM work_events WHERE task_id=?1 ORDER BY id").map_err(db)?;
        let events = statement
            .query_map([task_id], |row| {
                Ok(WorkEvent {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    run_id: row.get(2)?,
                    kind: row.get(3)?,
                    payload: decode(row.get(4)?)?,
                    created_at: row.get(5)?,
                })
            })
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        let mut statement = self.connection.prepare("SELECT id,task_id,run_id,request_id_json,kind,method,payload_json,status,response_json,created_at,resolved_at FROM work_interactions WHERE task_id=?1 ORDER BY created_at,id").map_err(db)?;
        let interactions = statement
            .query_map([task_id], interaction_row)
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        Ok(TaskExecutionDetail {
            task,
            runs,
            events,
            interactions,
        })
    }

    pub fn delegate_task(&self, task_id: &str, config: &TaskConfig) -> Result<WorkTask, String> {
        validate_config(config)?;
        let tx = transaction(&self.connection)?;
        let now = self.now_text();
        let business: String = tx
            .query_row(
                "SELECT status FROM todo_tasks WHERE id=?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db)?
            .ok_or_else(|| "任务不存在".to_string())?;
        if matches!(business.as_str(), "completed" | "cancelled") {
            return Err("请先返工或重新打开任务，再委派 Agent".into());
        }
        if let Some(task) = get_task(&tx, task_id)? {
            if task.current_run_id.is_some()
                || matches!(
                    task.status,
                    WorkflowStatus::Review | WorkflowStatus::Completed | WorkflowStatus::Cancelled
                )
            {
                return Err("请先暂停正在执行的任务，或处理当前交付后再修改委派".into());
            }
            // Warm thread/resume reuses the existing thread's MCP connections
            // and long-lived instructions; config overrides are ignored there.
            // Do not display a changed setting that the actual session cannot use.
            if task.thread_id.is_some()
                && (task.config.browser_enabled != config.browser_enabled
                    || task.config.workspace != config.workspace
                    || task.config.instructions != config.instructions
                    || task.config.agent_id != config.agent_id)
            {
                return Err("本任务已创建 Codex 会话，浏览器、工作目录、Agent 身份和长期指令已固定；请新建任务使用新配置，当前任务会保留完整历史".into());
            }
        }
        replace_dependencies(&tx, task_id, &config.blocked_by)?;
        let reason = if !unresolved_dependencies(&tx, task_id)?.is_empty() {
            Some("dependencies")
        } else if crate::task_schedule::waiting_for_time(&tx, task_id, &now)? {
            Some("scheduled")
        } else {
            None
        };
        let ready = reason.is_none();
        let status = if ready {
            WorkflowStatus::Queued
        } else {
            WorkflowStatus::Waiting
        };
        tx.execute(
            "INSERT INTO work_tasks(task_id,config_json,status,wait_reason,updated_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(task_id) DO UPDATE SET config_json=excluded.config_json,status=excluded.status,wait_reason=excluded.wait_reason,
             revision=work_tasks.revision+1,continuation_count=0,last_error=NULL,updated_at=excluded.updated_at",
            params![task_id,encode(config)?,status.as_str(),reason,now],
        ).map_err(db)?;
        project_business_status(&tx, task_id, status, &now)?;
        event(
            &tx,
            task_id,
            None,
            "delegated",
            &json!({"config":config}),
            &now,
        )?;
        crate::chat_store::ensure_main(&tx, task_id, &now)?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }

    pub fn claim_work_task(&self, task_id: &str, prompt: &str) -> Result<WorkRun, String> {
        let tx = transaction(&self.connection)?;
        let task = required_task(&tx, task_id)?;
        if task.status != WorkflowStatus::Queued || task.current_run_id.is_some() {
            return Err("任务当前不能启动或已有执行占用".into());
        }
        if !unresolved_dependencies(&tx, task_id)?.is_empty() {
            return Err("前置任务尚未完成".into());
        }
        let now = self.now_text();
        if crate::task_schedule::waiting_for_time(&tx, task_id, &now)? {
            return Err("尚未到达开始时间，任务继续等待；不会创建 Codex Thread".into());
        }
        let generation: i64 = tx
            .query_row(
                "SELECT generation+1 FROM work_tasks WHERE task_id=?1",
                [task_id],
                |row| row.get(0),
            )
            .map_err(db)?;
        let run = WorkRun {
            id: unique_id("run"),
            task_id: task_id.into(),
            generation,
            status: "starting".into(),
            thread_id: task.thread_id,
            turn_id: None,
            prompt: prompt.into(),
            error: None,
            started_at: now.clone(),
            ended_at: None,
        };
        tx.execute("INSERT INTO work_runs(id,task_id,generation,status,thread_id,prompt,started_at) VALUES(?1,?2,?3,'starting',?4,?5,?6)", params![run.id,task_id,generation,run.thread_id,prompt,now]).map_err(db)?;
        tx.execute("UPDATE work_tasks SET current_run_id=?2,generation=?3,status='running',wait_reason=NULL,last_error=NULL,revision=revision+1,updated_at=?4 WHERE task_id=?1", params![task_id,run.id,generation,now]).map_err(db)?;
        project_business_status(&tx, task_id, WorkflowStatus::Running, &now)?;
        event(
            &tx,
            task_id,
            Some(&run.id),
            "run_started",
            &json!({"generation":generation}),
            &now,
        )?;
        tx.commit().map_err(db)?;
        Ok(run)
    }

    pub fn bind_work_run(
        &self,
        task_id: &str,
        run_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
    ) -> Result<bool, String> {
        let tx = transaction(&self.connection)?;
        if !current_run(&tx, task_id, run_id)? {
            return Ok(false);
        }
        tx.execute("UPDATE work_runs SET thread_id=?2,turn_id=COALESCE(?3,turn_id),status='running' WHERE id=?1", params![run_id,thread_id,turn_id]).map_err(db)?;
        tx.execute(
            "UPDATE work_tasks SET thread_id=?2 WHERE task_id=?1",
            params![task_id, thread_id],
        )
        .map_err(db)?;
        tx.execute(
            "UPDATE chat_conversations SET thread_id=?2,updated_at=?3 WHERE id=?1",
            params![format!("main:{task_id}"), thread_id, self.now_text()],
        )
        .map_err(db)?;
        tx.commit().map_err(db)?;
        Ok(true)
    }

    pub fn append_work_event(
        &self,
        task_id: &str,
        run_id: Option<&str>,
        kind: &str,
        payload: &Value,
    ) -> Result<bool, String> {
        let tx = transaction(&self.connection)?;
        if let Some(run_id) = run_id {
            if !current_run(&tx, task_id, run_id)? {
                return Ok(false);
            }
        }
        event(&tx, task_id, run_id, kind, payload, &self.now_text())?;
        tx.commit().map_err(db)?;
        Ok(true)
    }

    pub fn finish_work_run(
        &self,
        task_id: &str,
        run_id: &str,
        outcome: &str,
        error: Option<&str>,
    ) -> Result<WorkTask, String> {
        let tx = transaction(&self.connection)?;
        if !current_run(&tx, task_id, run_id)? {
            return required_task(&tx, task_id);
        }
        let task = required_task(&tx, task_id)?;
        let now = self.now_text();
        tx.execute(
            "UPDATE work_runs SET status=?2,error=?3,ended_at=?4 WHERE id=?1",
            params![run_id, outcome, error, now],
        )
        .map_err(db)?;
        tx.execute("UPDATE work_interactions SET status='expired',resolved_at=?2 WHERE run_id=?1 AND status='pending' AND kind<>'question'", params![run_id,now]).map_err(db)?;
        let mut status = task.status;
        let mut reason = task.wait_reason;
        let mut last_error = error.map(str::to_owned);
        let mut continuations = task.continuation_count;
        if status == WorkflowStatus::Review {
            if outcome == "completed" && error.is_none() {
                if task.config.review_policy == ReviewPolicy::Auto {
                    status = WorkflowStatus::Completed;
                }
            } else {
                status = WorkflowStatus::Attention;
                reason = Some("submission_interrupted".into());
                if last_error.is_none() {
                    last_error = Some("交付提交后执行未正常结束，请复核交付后重试".into());
                }
            }
        }
        if matches!(status, WorkflowStatus::Running | WorkflowStatus::Waiting)
            && !matches!(
                reason.as_deref(),
                Some("dependencies" | "question" | "environment")
            )
        {
            if outcome == "completed" && error.is_none() {
                continuations += 1;
                if continuations <= MAX_AUTOMATIC_CONTINUATIONS {
                    status = WorkflowStatus::Queued;
                    reason = None;
                } else {
                    status = WorkflowStatus::Attention;
                    reason = Some("continuation_limit".into());
                    last_error = Some(
                        "已达到自动续跑上限；尚无有效交付，请检查执行记录后重试或补充指令".into(),
                    );
                }
            } else if outcome == "interrupted" {
                status = WorkflowStatus::Paused;
                reason = Some("interrupted".into());
            } else {
                status = WorkflowStatus::Attention;
                reason = Some("execution_error".into());
                if last_error.is_none() {
                    last_error = Some(format!("执行结束: {outcome}"));
                }
            }
        }
        tx.execute("UPDATE work_tasks SET status=?2,current_run_id=NULL,wait_reason=?3,last_error=?4,continuation_count=?5,revision=revision+1,updated_at=?6 WHERE task_id=?1", params![task_id,status.as_str(),reason,last_error,continuations,now]).map_err(db)?;
        crate::chat_store::finalize_handoff(
            &tx,
            task_id,
            run_id,
            outcome == "completed" && error.is_none(),
            status == WorkflowStatus::Completed,
        )?;
        project_business_status(&tx, task_id, status, &now)?;
        event(
            &tx,
            task_id,
            Some(run_id),
            "run_ended",
            &json!({"outcome":outcome,"error":error,"task_status":status}),
            &now,
        )?;
        refresh_dependencies(&tx, &now)?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }

    pub fn submit_task(
        &self,
        task_id: &str,
        run_id: &str,
        summary: &str,
        evidence: &Value,
    ) -> Result<WorkTask, String> {
        if summary.trim().is_empty() {
            return Err("交付必须包含结果说明".into());
        }
        let tx = transaction(&self.connection)?;
        require_run(&tx, task_id, run_id)?;
        let task = required_task(&tx, task_id)?;
        if task.status != WorkflowStatus::Running {
            return Err("只有执行中的任务能提交交付".into());
        }
        if !unresolved_dependencies(&tx, task_id)?.is_empty() {
            return Err("前置任务尚未完成，不能提交交付".into());
        }
        let incomplete_children: i64 = tx.query_row("SELECT COUNT(*) FROM todo_tasks WHERE parent_id=?1 AND status NOT IN ('completed','cancelled')", [task_id], |row| row.get(0)).map_err(db)?;
        if incomplete_children > 0 {
            return Err("仍有未完成子任务，先等待或明确取消不再需要的子任务".into());
        }
        if task.config.review_policy == ReviewPolicy::Auto
            && (evidence.is_null()
                || evidence == &json!({})
                || evidence == &json!([])
                || evidence == &json!(""))
        {
            return Err("自动验收需要提交验收证据".into());
        }
        crate::chat_store::record_handoff(
            &tx,
            task_id,
            run_id,
            summary,
            evidence,
            "delivery",
            &self.now_text(),
        )?;
        // A tool response is not the end of a turn: later writes or a crash can
        // still invalidate this delivery. Auto acceptance runs at successful end.
        let status = WorkflowStatus::Review;
        let now = self.now_text();
        tx.execute("UPDATE work_tasks SET status=?2,result_summary=?3,wait_reason=NULL,last_error=NULL,revision=revision+1,updated_at=?4 WHERE task_id=?1", params![task_id,status.as_str(),summary,now]).map_err(db)?;
        project_business_status(&tx, task_id, status, &now)?;
        event(
            &tx,
            task_id,
            Some(run_id),
            "result_submitted",
            &json!({"summary":summary,"evidence":evidence,"review_policy":task.config.review_policy}),
            &now,
        )?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }

    pub fn invalidate_task_submission(
        &self,
        task_id: &str,
        run_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let tx = transaction(&self.connection)?;
        require_run(&tx, task_id, run_id)?;
        let now = self.now_text();
        let changed=tx.execute("UPDATE work_tasks SET status='running',result_summary=NULL,revision=revision+1,updated_at=?2 WHERE task_id=?1 AND status='review'",params![task_id,now]).map_err(db)?;
        if changed > 0 {
            tx.execute("UPDATE task_results SET status='failed',usable=0,error=?3 WHERE task_id=?1 AND source_run_id=?2 AND status='pending'",params![task_id,run_id,reason]).map_err(db)?;
            event(
                &tx,
                task_id,
                Some(run_id),
                "submission_invalidated",
                &json!({"reason":reason}),
                &now,
            )?;
        }
        tx.commit().map_err(db)
    }

    pub fn wait_for_tasks(
        &self,
        task_id: &str,
        run_id: &str,
        blockers: &[String],
        reason: &str,
    ) -> Result<WorkTask, String> {
        let tx = transaction(&self.connection)?;
        require_run(&tx, task_id, run_id)?;
        let mut task = required_task(&tx, task_id)?;
        if task.status != WorkflowStatus::Running {
            return Err("当前任务不能登记等待".into());
        }
        task.config.blocked_by.extend_from_slice(blockers);
        task.config.blocked_by.sort();
        task.config.blocked_by.dedup();
        replace_dependencies(&tx, task_id, &task.config.blocked_by)?;
        let status = if unresolved_dependencies(&tx, task_id)?.is_empty() {
            WorkflowStatus::Running
        } else {
            WorkflowStatus::Waiting
        };
        let now = self.now_text();
        tx.execute("UPDATE work_tasks SET status=?2,config_json=?3,wait_reason=?4,revision=revision+1,updated_at=?5 WHERE task_id=?1", params![task_id,status.as_str(),encode(&task.config)?,if status==WorkflowStatus::Waiting {Some("dependencies")} else {None},now]).map_err(db)?;
        event(
            &tx,
            task_id,
            Some(run_id),
            "waiting_for_tasks",
            &json!({"blocked_by":blockers,"reason":reason}),
            &now,
        )?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }

    pub fn apply_task_action(
        &self,
        task_id: &str,
        action: TaskAction,
        expected_revision: i64,
        feedback: Option<&str>,
    ) -> Result<WorkTask, String> {
        let tx = transaction(&self.connection)?;
        let task = required_task(&tx, task_id)?;
        if task.revision != expected_revision {
            return Err("任务已更新，请刷新后重试，避免覆盖 Agent 的新进展".into());
        }
        let now = self.now_text();
        let (status, reason) = match action {
            TaskAction::Pause
                if !matches!(
                    task.status,
                    WorkflowStatus::Completed | WorkflowStatus::Cancelled
                ) =>
            {
                (WorkflowStatus::Paused, Some("user_paused"))
            }
            TaskAction::Cancel if task.status != WorkflowStatus::Completed => {
                (WorkflowStatus::Cancelled, None)
            }
            TaskAction::Resume | TaskAction::Retry
                if matches!(
                    task.status,
                    WorkflowStatus::Paused | WorkflowStatus::Attention
                ) || (task.status == WorkflowStatus::Waiting
                    && task.wait_reason.as_deref() == Some("environment")) =>
            {
                (WorkflowStatus::Queued, None)
            }
            TaskAction::Accept if task.status == WorkflowStatus::Review => {
                if task.current_run_id.is_some() {
                    return Err("交付执行尚未结束，暂时不能验收".into());
                }
                if !unresolved_dependencies(&tx, task_id)?.is_empty() {
                    return Err("依赖已失效，请先重新核验交付".into());
                }
                (WorkflowStatus::Completed, None)
            }
            TaskAction::Rework
                if matches!(
                    task.status,
                    WorkflowStatus::Review
                        | WorkflowStatus::Completed
                        | WorkflowStatus::Cancelled
                        | WorkflowStatus::Attention
                ) =>
            {
                if feedback.unwrap_or_default().trim().is_empty() {
                    return Err("返工需要具体反馈，旧交付会保留在执行记录中".into());
                }
                (WorkflowStatus::Queued, None)
            }
            _ => return Err("当前任务状态不支持这个操作".into()),
        };
        if action == TaskAction::Accept {
            crate::chat_store::accept_results(&tx, task_id)?;
        }
        if action == TaskAction::Rework {
            tx.execute("UPDATE task_results SET usable=0,error=COALESCE(error,'此结果对应返工前版本，仅保留历史') WHERE task_id=?1",[task_id]).map_err(db)?;
        }
        invalidate_run(&tx, task_id, &now)?;
        tx.execute("UPDATE work_tasks SET status=?2,wait_reason=?3,last_error=NULL,continuation_count=0,revision=revision+1,updated_at=?4,result_summary=CASE WHEN ?5 THEN NULL ELSE result_summary END WHERE task_id=?1", params![task_id,status.as_str(),reason,now,action==TaskAction::Rework]).map_err(db)?;
        project_business_status(&tx, task_id, status, &now)?;
        event(
            &tx,
            task_id,
            task.current_run_id.as_deref(),
            "task_action",
            &json!({"action":action,"feedback":feedback,"previous_result":task.result_summary}),
            &now,
        )?;
        refresh_dependencies(&tx, &now)?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }

    pub fn open_task_interaction(
        &self,
        task_id: &str,
        run_id: &str,
        request_id: &Value,
        kind: &str,
        method: &str,
        payload: &Value,
    ) -> Result<TaskInteraction, String> {
        let tx = transaction(&self.connection)?;
        require_run(&tx, task_id, run_id)?;
        let request_json = encode(request_id)?;
        if let Some(existing) = tx.query_row("SELECT id,task_id,run_id,request_id_json,kind,method,payload_json,status,response_json,created_at,resolved_at FROM work_interactions WHERE run_id=?1 AND request_id_json=?2", params![run_id,request_json],interaction_row).optional().map_err(db)? {
            return Ok(existing);
        }
        let interaction = TaskInteraction {
            id: unique_id("interaction"),
            task_id: task_id.into(),
            run_id: run_id.into(),
            request_id: request_id.clone(),
            kind: kind.into(),
            method: method.into(),
            payload: payload.clone(),
            status: "pending".into(),
            response: None,
            created_at: self.now_text(),
            resolved_at: None,
        };
        tx.execute("INSERT INTO work_interactions(id,task_id,run_id,request_id_json,kind,method,payload_json,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8)", params![interaction.id,task_id,run_id,request_json,kind,method,encode(payload)?,interaction.created_at]).map_err(db)?;
        tx.execute("UPDATE work_tasks SET status='waiting',wait_reason=?2,revision=revision+1,updated_at=?3 WHERE task_id=?1", params![task_id,match kind {"approval"=>"approval","question"=>"question",_=>"input"},interaction.created_at]).map_err(db)?;
        event(
            &tx,
            task_id,
            Some(run_id),
            "interaction_opened",
            &json!({"interaction_id":interaction.id,"kind":kind,"payload":payload}),
            &interaction.created_at,
        )?;
        tx.commit().map_err(db)?;
        Ok(interaction)
    }

    pub fn resolve_task_interaction(
        &self,
        task_id: &str,
        interaction_id: &str,
        run_id: &str,
        response: &Value,
    ) -> Result<TaskInteraction, String> {
        let tx = transaction(&self.connection)?;
        let mut interaction = tx.query_row("SELECT id,task_id,run_id,request_id_json,kind,method,payload_json,status,response_json,created_at,resolved_at FROM work_interactions WHERE id=?1 AND task_id=?2 AND run_id=?3",params![interaction_id,task_id,run_id],interaction_row).optional().map_err(db)?.ok_or_else(|| "请求不属于当前任务执行".to_string())?;
        if interaction.status != "pending" {
            return Err("请求已处理或已过期，不能再次响应".into());
        }
        if interaction.kind == "question" {
            let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM work_tasks w JOIN work_runs r ON r.task_id=w.task_id AND r.generation=w.generation WHERE w.task_id=?1 AND r.id=?2 AND w.status='waiting' AND w.wait_reason='question')",params![task_id,run_id],|row|row.get(0)).map_err(db)?;
            if !valid {
                return Err("问题对应的任务已改变，不能应用旧回复".into());
            }
        } else {
            require_run(&tx, task_id, run_id)?;
        }
        let now = self.now_text();
        tx.execute("UPDATE work_interactions SET status='resolved',response_json=?2,resolved_at=?3 WHERE id=?1",params![interaction_id,encode(response)?,now]).map_err(db)?;
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM work_interactions WHERE task_id=?1 AND status='pending'",
                [task_id],
                |row| row.get(0),
            )
            .map_err(db)?;
        if pending == 0 {
            tx.execute("UPDATE work_tasks SET status=CASE WHEN current_run_id IS NULL THEN 'queued' ELSE 'running' END,wait_reason=NULL,revision=revision+1,updated_at=?2 WHERE task_id=?1 AND status='waiting' AND wait_reason IN ('approval','input','question')",params![task_id,now]).map_err(db)?;
        }
        event(
            &tx,
            task_id,
            Some(run_id),
            if interaction.kind == "question" {
                "question_answered"
            } else {
                "interaction_resolved"
            },
            &json!({"interaction_id":interaction_id,"question":interaction.payload,"response":response}),
            &now,
        )?;
        refresh_dependencies(&tx, &now)?;
        tx.commit().map_err(db)?;
        interaction.status = "resolved".into();
        interaction.response = Some(response.clone());
        interaction.resolved_at = Some(now);
        Ok(interaction)
    }

    /// A business question can release its turn and survive until the user
    /// answers. It is not a native app-server request and must not be replayed
    /// through the JSON-RPC approval channel.
    pub fn wait_for_input(
        &self,
        task_id: &str,
        run_id: &str,
        question: &str,
    ) -> Result<TaskInteraction, String> {
        if question.trim().is_empty() {
            return Err("问题不能为空".into());
        }
        self.open_task_interaction(
            task_id,
            run_id,
            &json!(unique_id("question")),
            "question",
            "task/question",
            &json!({"question":question}),
        )
    }

    pub fn block_work_task(
        &self,
        task_id: &str,
        run_id: &str,
        reason: &str,
    ) -> Result<WorkTask, String> {
        if reason.trim().is_empty() {
            return Err("请说明需要解决的阻塞原因".into());
        }
        let tx = transaction(&self.connection)?;
        require_run(&tx, task_id, run_id)?;
        let now = self.now_text();
        tx.execute("UPDATE work_tasks SET status='waiting',wait_reason='environment',last_error=?2,revision=revision+1,updated_at=?3 WHERE task_id=?1",params![task_id,reason,now]).map_err(db)?;
        event(
            &tx,
            task_id,
            Some(run_id),
            "environment_blocked",
            &json!({"reason":reason}),
            &now,
        )?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }

    pub fn expire_task_request(
        &self,
        task_id: &str,
        run_id: &str,
        request_id: &Value,
    ) -> Result<bool, String> {
        let tx = transaction(&self.connection)?;
        if !current_run(&tx, task_id, run_id)? {
            return Ok(false);
        }
        let now = self.now_text();
        let changed=tx.execute("UPDATE work_interactions SET status='expired',resolved_at=?4 WHERE task_id=?1 AND run_id=?2 AND request_id_json=?3 AND status='pending' AND kind<>'question'",params![task_id,run_id,encode(request_id)?,now]).map_err(db)?;
        if changed > 0 {
            let pending: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM work_interactions WHERE task_id=?1 AND status='pending'",
                    [task_id],
                    |row| row.get(0),
                )
                .map_err(db)?;
            if pending == 0 {
                tx.execute("UPDATE work_tasks SET status='running',wait_reason=NULL,revision=revision+1,updated_at=?2 WHERE task_id=?1 AND status='waiting' AND wait_reason IN ('approval','input')",params![task_id,now]).map_err(db)?;
            }
            event(
                &tx,
                task_id,
                Some(run_id),
                "request_expired",
                &json!({"request_id":request_id}),
                &now,
            )?;
        }
        tx.commit().map_err(db)?;
        Ok(changed > 0)
    }

    pub fn refresh_work_dependencies(&self) -> Result<usize, String> {
        let tx = transaction(&self.connection)?;
        let changed = refresh_dependencies(&tx, &self.now_text())?;
        tx.commit().map_err(db)?;
        Ok(changed)
    }

    /// Only call after startup has established that no prior app-server process is
    /// being reused. An uncertain execution is never silently launched twice.
    pub fn recover_work_runs(&self) -> Result<usize, String> {
        let tx = transaction(&self.connection)?;
        let now = self.now_text();
        let ids = {
            let mut statement = tx
                .prepare("SELECT task_id FROM work_tasks WHERE current_run_id IS NOT NULL")
                .map_err(db)?;
            let result = statement
                .query_map([], |row| row.get(0))
                .map_err(db)?
                .collect::<rusqlite::Result<Vec<String>>>()
                .map_err(db)?;
            result
        };
        for id in &ids {
            let task = required_task(&tx, id)?;
            invalidate_run(&tx, id, &now)?;
            if !matches!(
                task.status,
                WorkflowStatus::Completed | WorkflowStatus::Cancelled
            ) {
                tx.execute("UPDATE work_tasks SET status='attention',wait_reason='recovery',last_error='上次执行连接已中断；请检查结果后重试，防止重复执行',revision=revision+1,updated_at=?2 WHERE task_id=?1",params![id,now]).map_err(db)?;
            }
            event(
                &tx,
                id,
                task.current_run_id.as_deref(),
                "recovery_required",
                &json!({}),
                &now,
            )?;
        }
        tx.commit().map_err(db)?;
        Ok(ids.len())
    }

    pub fn create_delegated_child(
        &self,
        parent_task_id: &str,
        parent_run_id: &str,
        title: &str,
        config: &TaskConfig,
    ) -> Result<WorkTask, String> {
        validate_config(config)?;
        if title.trim().is_empty() {
            return Err("子任务标题不能为空".into());
        }
        let tx = transaction(&self.connection)?;
        require_run(&tx, parent_task_id, parent_run_id)?;
        let parent = required_task(&tx, parent_task_id)?;
        if parent.status != WorkflowStatus::Running {
            return Err("当前任务不能继续委派子任务".into());
        }
        let id = unique_id("task");
        let now = self.now_text();
        let mut child_config = config.clone();
        child_config.delegated_by = parent_task_id.into();
        // An Agent cannot grant itself broader runtime permissions or bypass the
        // review selected by the human who delegated its parent.
        child_config.approval_policy = parent.config.approval_policy;
        child_config.sandbox_mode = parent.config.sandbox_mode;
        child_config.workspace = parent.config.workspace;
        child_config.review_policy = parent.config.review_policy;
        child_config.browser_enabled = parent.config.browser_enabled;
        tx.execute("INSERT INTO todo_tasks(id,parent_id,position,title,status,pinned,process_tracking,result_review,created_at,updated_at,activity_at) VALUES(?1,?2,(SELECT COALESCE(MAX(position),-1)+1 FROM todo_tasks WHERE parent_id=?2),?3,'todo',0,'','',?4,?4,?4)",params![id,parent_task_id,title,now]).map_err(db)?;
        replace_dependencies(&tx, &id, &child_config.blocked_by)?;
        let ready = unresolved_dependencies(&tx, &id)?.is_empty();
        tx.execute("INSERT INTO work_tasks(task_id,config_json,status,wait_reason,updated_at) VALUES(?1,?2,?3,?4,?5)",params![id,encode(&child_config)?,if ready {"queued"} else {"waiting"},if ready {None} else {Some("dependencies")},now]).map_err(db)?;
        event(
            &tx,
            &id,
            None,
            "delegated",
            &json!({"parent_task_id":parent_task_id,"parent_run_id":parent_run_id,"config":child_config}),
            &now,
        )?;
        event(
            &tx,
            parent_task_id,
            Some(parent_run_id),
            "child_created",
            &json!({"child_task_id":id,"title":title}),
            &now,
        )?;
        tx.execute(
            "UPDATE todo_tasks SET process_tracking=?2 WHERE id=?1",
            params![id, child_config.prompt],
        )
        .map_err(db)?;
        crate::chat_store::ensure_main(&tx, &id, &now)?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, &id)
    }

    pub fn send_work_message(
        &self,
        task_id: &str,
        text: &str,
        expected_run_id: Option<&str>,
    ) -> Result<WorkTask, String> {
        if text.trim().is_empty() {
            return Err("消息不能为空".into());
        }
        let tx = transaction(&self.connection)?;
        let task = required_task(&tx, task_id)?;
        if let Some(run_id) = expected_run_id {
            require_run(&tx, task_id, run_id)?;
        }
        if matches!(
            task.status,
            WorkflowStatus::Completed | WorkflowStatus::Cancelled
        ) {
            return Err("任务已经结束，请先返工或新建任务".into());
        }
        let now = self.now_text();
        event(
            &tx,
            task_id,
            task.current_run_id.as_deref(),
            "user_message",
            &json!({"text":text}),
            &now,
        )?;
        tx.commit().map_err(db)?;
        required_task(&self.connection, task_id)
    }
}

fn interaction_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskInteraction> {
    let response: Option<String> = row.get(8)?;
    Ok(TaskInteraction {
        id: row.get(0)?,
        task_id: row.get(1)?,
        run_id: row.get(2)?,
        request_id: decode(row.get(3)?)?,
        kind: row.get(4)?,
        method: row.get(5)?,
        payload: decode(row.get(6)?)?,
        status: row.get(7)?,
        response: response.map(decode).transpose()?,
        created_at: row.get(9)?,
        resolved_at: row.get(10)?,
    })
}

fn unique_todo_inputs(tasks: &[TodoTaskInput]) -> Result<HashMap<String, TodoTaskInput>, String> {
    let mut result = HashMap::new();
    for task in tasks {
        if task.id.trim().is_empty() || result.insert(task.id.clone(), task.clone()).is_some() {
            return Err("任务 ID 不能为空或重复".into());
        }
    }
    Ok(result)
}

fn todo_record_input(task: &TodoTaskRecord) -> TodoTaskInput {
    TodoTaskInput {
        id: task.id.clone(),
        parent_id: task.parent_id.clone(),
        position: task.position,
        title: task.title.clone(),
        status: task.status,
        pinned: task.pinned,
        start_date: task.start_date.clone(),
        expected_end_date: task.expected_end_date.clone(),
        actual_end_date: task.actual_end_date.clone(),
        process_tracking: task.process_tracking.clone(),
        result_review: task.result_review.clone(),
    }
}

fn validate_todo_tree(tasks: &HashMap<String, TodoTaskInput>) -> Result<(), String> {
    for task in tasks.values() {
        let mut visited = HashSet::new();
        let mut current = task;
        while let Some(parent) = current.parent_id.as_ref() {
            if !visited.insert(current.id.as_str()) {
                return Err("任务层级不能形成循环".into());
            }
            current = tasks.get(parent).ok_or_else(|| {
                format!("父任务 {parent} 不存在；可能有新子任务尚未加载，请刷新后重试")
            })?;
        }
    }
    Ok(())
}

fn write_todo(connection: &Connection, task: &TodoTaskInput, now: &str) -> Result<(), String> {
    connection.execute(
        "INSERT INTO todo_tasks(id,parent_id,position,title,status,pinned,start_date,expected_end_date,actual_end_date,process_tracking,result_review,created_at,updated_at,activity_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?12)
         ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,position=excluded.position,title=excluded.title,status=excluded.status,pinned=excluded.pinned,
         start_date=excluded.start_date,expected_end_date=excluded.expected_end_date,actual_end_date=excluded.actual_end_date,process_tracking=excluded.process_tracking,result_review=excluded.result_review,
         updated_at=excluded.updated_at,activity_at=CASE WHEN todo_tasks.parent_id IS NOT excluded.parent_id OR todo_tasks.title IS NOT excluded.title OR todo_tasks.status IS NOT excluded.status OR todo_tasks.pinned IS NOT excluded.pinned OR todo_tasks.start_date IS NOT excluded.start_date OR todo_tasks.expected_end_date IS NOT excluded.expected_end_date OR todo_tasks.actual_end_date IS NOT excluded.actual_end_date OR todo_tasks.process_tracking IS NOT excluded.process_tracking OR todo_tasks.result_review IS NOT excluded.result_review THEN excluded.activity_at ELSE todo_tasks.activity_at END",
        params![task.id,task.parent_id,task.position,task.title,task.status.as_str(),task.pinned,task.start_date,task.expected_end_date,task.actual_end_date,task.process_tracking,task.result_review,now],
    ).map_err(db)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TodoTaskStatus;

    fn todo(id: &str) -> TodoTaskInput {
        TodoTaskInput {
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
        }
    }

    fn config(policy: ReviewPolicy) -> TaskConfig {
        TaskConfig {
            workspace: "/workspace/project".into(),
            prompt: "Implement and verify the requested change".into(),
            acceptance: "Existing tests pass".into(),
            review_policy: policy,
            ..TaskConfig::default()
        }
    }

    fn repository(ids: &[&str]) -> Repository {
        let repo = Repository::open_in_memory().unwrap();
        repo.save_todo_tasks(&ids.iter().map(|id| todo(id)).collect::<Vec<_>>())
            .unwrap();
        repo
    }

    #[test]
    fn turn_completion_continues_without_falsely_completing_task() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Auto))
            .unwrap();
        for index in 0..=MAX_AUTOMATIC_CONTINUATIONS {
            let run = repo.claim_work_task("work", "continue").unwrap();
            let result = repo
                .finish_work_run("work", &run.id, "completed", None)
                .unwrap();
            assert_eq!(
                result.status,
                if index == MAX_AUTOMATIC_CONTINUATIONS {
                    WorkflowStatus::Attention
                } else {
                    WorkflowStatus::Queued
                }
            );
        }
        assert_eq!(
            repo.list_todo_tasks().unwrap()[0].status,
            TodoTaskStatus::InProgress
        );
    }

    #[test]
    fn submission_and_successful_turn_end_are_both_required_for_auto_acceptance() {
        let repo = repository(&["source", "consumer"]);
        repo.delegate_task("source", &config(ReviewPolicy::Auto))
            .unwrap();
        let mut consumer = config(ReviewPolicy::Auto);
        consumer.blocked_by = vec!["source".into()];
        repo.delegate_task("consumer", &consumer).unwrap();
        let run = repo.claim_work_task("source", "work").unwrap();
        assert_eq!(
            repo.submit_task("source", &run.id, "Implemented", &json!({"tests":"passed"}))
                .unwrap()
                .status,
            WorkflowStatus::Review
        );
        assert_eq!(
            repo.get_work_task("consumer").unwrap().unwrap().status,
            WorkflowStatus::Waiting
        );
        assert!(repo.claim_work_task("consumer", "early").is_err());
        assert_eq!(
            repo.finish_work_run("source", &run.id, "completed", None)
                .unwrap()
                .status,
            WorkflowStatus::Completed
        );
        assert_eq!(
            repo.get_work_task("consumer").unwrap().unwrap().status,
            WorkflowStatus::Queued
        );
    }

    #[test]
    fn submission_followed_by_failure_or_mutation_is_not_accepted() {
        let repo = repository(&["failed", "changed"]);
        for id in ["failed", "changed"] {
            repo.delegate_task(id, &config(ReviewPolicy::Auto)).unwrap();
        }
        let failed = repo.claim_work_task("failed", "work").unwrap();
        repo.submit_task("failed", &failed.id, "Done", &json!({"tests":"passed"}))
            .unwrap();
        assert_eq!(
            repo.finish_work_run("failed", &failed.id, "failed", Some("process exited"))
                .unwrap()
                .status,
            WorkflowStatus::Attention
        );
        let changed = repo.claim_work_task("changed", "work").unwrap();
        repo.submit_task("changed", &changed.id, "Done", &json!({"tests":"passed"}))
            .unwrap();
        repo.invalidate_task_submission("changed", &changed.id, "file changed after submit")
            .unwrap();
        assert_eq!(
            repo.finish_work_run("changed", &changed.id, "completed", None)
                .unwrap()
                .status,
            WorkflowStatus::Queued
        );
    }

    #[test]
    fn manual_acceptance_requires_finished_current_submission_and_revision() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        let staged = repo
            .submit_task("work", &run.id, "Result", &json!({}))
            .unwrap();
        assert!(repo
            .apply_task_action("work", TaskAction::Accept, staged.revision, None)
            .is_err());
        let ready = repo
            .finish_work_run("work", &run.id, "completed", None)
            .unwrap();
        assert!(repo
            .apply_task_action("work", TaskAction::Accept, staged.revision, None)
            .is_err());
        let done = repo
            .apply_task_action("work", TaskAction::Accept, ready.revision, None)
            .unwrap();
        let rework = repo
            .apply_task_action(
                "work",
                TaskAction::Rework,
                done.revision,
                Some("Missing case"),
            )
            .unwrap();
        assert_eq!(rework.status, WorkflowStatus::Queued);
        assert_eq!(repo.load_task_execution("work").unwrap().runs.len(), 1);
        assert!(repo
            .load_task_execution("work")
            .unwrap()
            .events
            .iter()
            .any(|event| event.kind == "result_submitted"));
    }

    #[test]
    fn cancelled_dependency_does_not_satisfy_wait_and_cycles_are_rejected() {
        let repo = repository(&["a", "b"]);
        let a = repo
            .delegate_task("a", &config(ReviewPolicy::Auto))
            .unwrap();
        let mut b = config(ReviewPolicy::Auto);
        b.blocked_by = vec!["a".into()];
        repo.delegate_task("b", &b).unwrap();
        let mut cyclic = config(ReviewPolicy::Auto);
        cyclic.blocked_by = vec!["b".into()];
        assert!(repo.delegate_task("a", &cyclic).is_err());
        repo.apply_task_action("a", TaskAction::Cancel, a.revision, None)
            .unwrap();
        assert_eq!(
            repo.get_work_task("b").unwrap().unwrap().status,
            WorkflowStatus::Waiting
        );
        assert!(repo.claim_work_task("b", "work").is_err());
    }

    #[test]
    fn late_run_events_and_old_interaction_replies_cannot_revive_cancelled_task() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        let request = repo
            .open_task_interaction(
                "work",
                &run.id,
                &json!(7),
                "approval",
                "item/commandExecution/requestApproval",
                &json!({"command":"test"}),
            )
            .unwrap();
        let waiting = repo.get_work_task("work").unwrap().unwrap();
        repo.apply_task_action("work", TaskAction::Cancel, waiting.revision, None)
            .unwrap();
        assert!(!repo
            .append_work_event(
                "work",
                Some(&run.id),
                "item/agentMessage/delta",
                &json!({"delta":"done"})
            )
            .unwrap());
        assert!(repo
            .resolve_task_interaction("work", &request.id, &run.id, &json!({"decision":"accept"}))
            .is_err());
        assert_eq!(
            repo.finish_work_run("work", &run.id, "completed", None)
                .unwrap()
                .status,
            WorkflowStatus::Cancelled
        );
        assert_eq!(
            repo.load_task_execution("work").unwrap().interactions[0].status,
            "expired"
        );
    }

    #[test]
    fn recovery_expires_requests_and_does_not_blindly_repeat_unknown_work() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        repo.open_task_interaction(
            "work",
            &run.id,
            &json!(7),
            "input",
            "item/tool/requestUserInput",
            &json!({}),
        )
        .unwrap();
        assert_eq!(repo.recover_work_runs().unwrap(), 1);
        let task = repo.get_work_task("work").unwrap().unwrap();
        assert_eq!(task.status, WorkflowStatus::Attention);
        assert!(repo.claim_work_task("work", "duplicate").is_err());
        assert_eq!(
            repo.load_task_execution("work").unwrap().interactions[0].status,
            "expired"
        );
    }

    #[test]
    fn business_question_survives_turn_end_and_answer_queues_the_next_turn() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        let question = repo
            .wait_for_input("work", &run.id, "Which target environment?")
            .unwrap();
        let waiting = repo
            .finish_work_run("work", &run.id, "completed", None)
            .unwrap();
        assert_eq!(waiting.status, WorkflowStatus::Waiting);
        assert_eq!(waiting.wait_reason.as_deref(), Some("question"));
        assert_eq!(
            repo.load_task_execution("work").unwrap().interactions[0].status,
            "pending"
        );
        assert!(repo
            .resolve_task_interaction(
                "work",
                &question.id,
                "another-run",
                &json!({"answer":"local"})
            )
            .is_err());
        repo.resolve_task_interaction("work", &question.id, &run.id, &json!({"answer":"local"}))
            .unwrap();
        assert_eq!(
            repo.get_work_task("work").unwrap().unwrap().status,
            WorkflowStatus::Queued
        );
        assert!(repo.claim_work_task("work", "resume with answer").is_ok());
    }

    #[test]
    fn native_server_resolved_request_is_expired_not_approved() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        let request = repo
            .open_task_interaction(
                "work",
                &run.id,
                &json!(42),
                "approval",
                "item/commandExecution/requestApproval",
                &json!({}),
            )
            .unwrap();
        assert!(repo
            .expire_task_request("work", &run.id, &json!(42))
            .unwrap());
        let detail = repo.load_task_execution("work").unwrap();
        assert_eq!(detail.interactions[0].status, "expired");
        assert!(detail.interactions[0].response.is_none());
        assert!(repo
            .resolve_task_interaction("work", &request.id, &run.id, &json!({"decision":"accept"}))
            .is_err());
        assert_eq!(detail.task.status, WorkflowStatus::Running);
    }

    #[test]
    fn environment_wait_survives_turn_end_and_requires_explicit_resume() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        repo.block_work_task("work", &run.id, "Database credentials unavailable")
            .unwrap();
        let blocked = repo
            .finish_work_run("work", &run.id, "completed", None)
            .unwrap();
        assert_eq!(blocked.status, WorkflowStatus::Waiting);
        assert_eq!(blocked.wait_reason.as_deref(), Some("environment"));
        assert!(repo.claim_work_task("work", "blind retry").is_err());
        assert_eq!(
            repo.apply_task_action("work", TaskAction::Resume, blocked.revision, None)
                .unwrap()
                .status,
            WorkflowStatus::Queued
        );
    }

    #[test]
    fn restart_cannot_accept_a_submission_whose_turn_never_finished() {
        let repo = repository(&["work"]);
        repo.delegate_task("work", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("work", "work").unwrap();
        repo.submit_task(
            "work",
            &run.id,
            "Candidate result",
            &json!({"tests":"passed"}),
        )
        .unwrap();
        repo.recover_work_runs().unwrap();
        let recovered = repo.get_work_task("work").unwrap().unwrap();
        assert_eq!(recovered.status, WorkflowStatus::Attention);
        assert_eq!(
            recovered.result_summary.as_deref(),
            Some("Candidate result")
        );
        assert!(repo
            .apply_task_action("work", TaskAction::Accept, recovered.revision, None)
            .is_err());
    }

    #[test]
    fn stale_todo_snapshot_preserves_agent_child_and_background_status() {
        let repo = repository(&["parent"]);
        let before = vec![todo("parent")];
        repo.delegate_task("parent", &config(ReviewPolicy::Human))
            .unwrap();
        let run = repo.claim_work_task("parent", "work").unwrap();
        let child = repo
            .create_delegated_child("parent", &run.id, "New child", &config(ReviewPolicy::Auto))
            .unwrap();
        let mut after = before.clone();
        after[0].title = "Renamed parent".into();
        let saved = repo.save_todo_task_changes(&before, &after).unwrap();
        assert_eq!(saved.len(), 2);
        assert!(saved.iter().any(|task| task.id == child.task_id));
        let parent = saved.iter().find(|task| task.id == "parent").unwrap();
        assert_eq!(parent.status, TodoTaskStatus::InProgress);
        assert_eq!(parent.title, "Renamed parent");
        assert!(repo.save_todo_tasks(&after).is_err());
    }

    #[test]
    fn fieldwise_cas_merges_disjoint_edits_but_rejects_overlapping_edits() {
        let repo = repository(&["task"]);
        let old = todo("task");
        let mut server = old.clone();
        server.process_tracking = "Agent progress".into();
        repo.save_todo_task_changes(&[old.clone()], &[server])
            .unwrap();
        let mut user = old.clone();
        user.title = "User title".into();
        let saved = repo
            .save_todo_task_changes(&[old.clone()], &[user])
            .unwrap();
        assert_eq!(saved[0].process_tracking, "Agent progress");
        assert_eq!(saved[0].title, "User title");
        let mut conflicting = old.clone();
        conflicting.process_tracking = "Stale overwrite".into();
        assert!(repo.save_todo_task_changes(&[old], &[conflicting]).is_err());
        assert_eq!(
            repo.list_todo_tasks().unwrap()[0].process_tracking,
            "Agent progress"
        );
    }

    #[test]
    fn stale_parent_delete_rejects_unseen_descendants_and_rolls_back() {
        let repo = repository(&["parent"]);
        let before = todo("parent");
        let mut child = todo("child");
        child.parent_id = Some("parent".into());
        repo.save_todo_task_changes(&[], &[child]).unwrap();
        assert!(repo.save_todo_task_changes(&[before], &[]).is_err());
        assert_eq!(repo.list_todo_tasks().unwrap().len(), 2);
    }

    #[test]
    fn managed_status_cannot_be_overridden_by_todo_edit() {
        let repo = repository(&["task"]);
        repo.delegate_task("task", &config(ReviewPolicy::Auto))
            .unwrap();
        let before = todo("task");
        let mut after = before.clone();
        after.status = TodoTaskStatus::Completed;
        assert!(repo.save_todo_task_changes(&[before], &[after]).is_err());
        assert_eq!(
            repo.list_todo_tasks().unwrap()[0].status,
            TodoTaskStatus::Todo
        );
    }

    #[test]
    fn bound_thread_configuration_is_immutable_but_turn_model_settings_can_change() {
        let repo = repository(&["task"]);
        let original = config(ReviewPolicy::Human);
        repo.delegate_task("task", &original).unwrap();
        let run = repo.claim_work_task("task", "start").unwrap();
        repo.bind_work_run("task", &run.id, "existing-thread", Some("turn-1"))
            .unwrap();
        let running = repo.get_work_task("task").unwrap().unwrap();
        repo.apply_task_action("task", TaskAction::Pause, running.revision, None)
            .unwrap();
        let mut browser = original.clone();
        browser.browser_enabled = true;
        let error = repo.delegate_task("task", &browser).unwrap_err();
        assert!(error.contains("新建任务"));
        let mut workspace = original.clone();
        workspace.workspace = "/workspace/elsewhere".into();
        assert!(repo.delegate_task("task", &workspace).is_err());
        let mut instructions = original.clone();
        instructions.instructions = "Another role".into();
        assert!(repo.delegate_task("task", &instructions).is_err());
        let mut agent = original.clone();
        agent.agent_id = "reviewer".into();
        assert!(repo.delegate_task("task", &agent).is_err());
        let mut model = original.clone();
        model.model = Some("test-model".into());
        model.reasoning_effort = Some("high".into());
        let changed = repo.delegate_task("task", &model).unwrap();
        assert_eq!(changed.config.model.as_deref(), Some("test-model"));
        assert_eq!(changed.thread_id.as_deref(), Some("existing-thread"));
        assert!(!changed.config.browser_enabled);
    }

    #[test]
    fn browser_is_opt_in_and_child_cannot_escalate_the_parent_browser_permission() {
        let defaults: TaskConfig =
            serde_json::from_value(json!({"workspace":"/workspace/project","prompt":"work"}))
                .unwrap();
        assert!(!defaults.browser_enabled);
        let repo = repository(&["parent"]);
        let original = config(ReviewPolicy::Human);
        repo.delegate_task("parent", &original).unwrap();
        let run = repo.claim_work_task("parent", "delegate").unwrap();
        let mut child_config = original.clone();
        child_config.browser_enabled = true;
        let child = repo
            .create_delegated_child("parent", &run.id, "Child", &child_config)
            .unwrap();
        assert!(!child.config.browser_enabled);
        let task = repo.get_work_task("parent").unwrap().unwrap();
        repo.apply_task_action("parent", TaskAction::Pause, task.revision, None)
            .unwrap();
        // Before a thread exists the human can explicitly enable this capability.
        let mut enabled = original;
        enabled.browser_enabled = true;
        repo.delegate_task("parent", &enabled).unwrap();
        let run = repo
            .claim_work_task("parent", "delegate with browser")
            .unwrap();
        let child = repo
            .create_delegated_child(
                "parent",
                &run.id,
                "Browser child",
                &config(ReviewPolicy::Human),
            )
            .unwrap();
        assert!(child.config.browser_enabled);
    }

    #[test]
    fn two_connections_cannot_claim_the_same_task() {
        use std::sync::{Arc, Barrier};
        let path =
            std::env::temp_dir().join(format!("{}.sqlite", unique_id("workflow-claim-test")));
        {
            let repo = Repository::open_path(&path).unwrap();
            repo.save_todo_tasks(&[todo("task")]).unwrap();
            repo.delegate_task("task", &config(ReviewPolicy::Human))
                .unwrap();
        }
        let barrier = Arc::new(Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let repo = Repository::open_path(&path).unwrap();
                    barrier.wait();
                    repo.claim_work_task("task", "claim once").is_ok()
                })
            })
            .collect::<Vec<_>>();
        let successful = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successful, 1);
        let repo = Repository::open_path(&path).unwrap();
        assert_eq!(repo.load_task_execution("task").unwrap().runs.len(), 1);
        drop(repo);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn upstream_rework_reblocks_queued_dependants() {
        let repo = repository(&["upstream", "downstream"]);
        repo.delegate_task("upstream", &config(ReviewPolicy::Auto))
            .unwrap();
        let run = repo.claim_work_task("upstream", "deliver").unwrap();
        repo.submit_task("upstream", &run.id, "Delivered", &json!({"tests":"passed"}))
            .unwrap();
        let delivered = repo
            .finish_work_run("upstream", &run.id, "completed", None)
            .unwrap();
        let mut downstream = config(ReviewPolicy::Human);
        downstream.blocked_by = vec!["upstream".into()];
        repo.delegate_task("downstream", &downstream).unwrap();
        assert_eq!(
            repo.get_work_task("downstream").unwrap().unwrap().status,
            WorkflowStatus::Queued
        );
        repo.apply_task_action(
            "upstream",
            TaskAction::Rework,
            delivered.revision,
            Some("Fix acceptance gap"),
        )
        .unwrap();
        assert_eq!(
            repo.get_work_task("downstream").unwrap().unwrap().status,
            WorkflowStatus::Waiting
        );
        assert!(repo.claim_work_task("downstream", "must wait").is_err());
    }

    #[test]
    fn position_only_patch_preserves_business_activity_time_and_creation() {
        use std::sync::{atomic::AtomicUsize, Arc};
        let clock = Arc::new(AtomicUsize::new(0));
        let clock_value = clock.clone();
        let repo = Repository::open_in_memory_with_clock(Box::new(move || {
            format!("2026-10-26T00:00:0{}Z", clock_value.load(Ordering::Relaxed))
        }))
        .unwrap();
        let before = todo("task");
        repo.save_todo_tasks(&[before.clone()]).unwrap();
        let first = repo.list_todo_tasks().unwrap()[0].clone();
        clock.store(1, Ordering::Relaxed);
        let mut after = before.clone();
        after.position = 12;
        let next = repo.save_todo_task_changes(&[before], &[after]).unwrap();
        assert_eq!(next[0].position, 12);
        assert_eq!(next[0].updated_at, first.updated_at);
        assert_eq!(next[0].created_at, first.created_at);
    }

    // Exercise the complete scheduler -> JSONL transport -> dynamic task tool ->
    // SQLite path. No real Codex account, user database or HOME is involved.
    #[cfg(unix)]
    struct ServiceFixture {
        service: crate::work_service::WorkService,
        directory: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl ServiceFixture {
        fn new() -> Self {
            use std::os::unix::fs::PermissionsExt;
            let directory = std::env::temp_dir().join(unique_id("workflow-service-test"));
            std::fs::create_dir_all(&directory).unwrap();
            let executable = directory.join("fake-codex");
            std::fs::write(&executable,r###"#!/usr/bin/env python3
import json, sys
threads = {}
pending = {}

def emit(value):
    print(json.dumps(value), flush=True)

def complete(thread, turn, status='completed'):
    emit({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':status}}})

def call_tool(thread, turn, tool, arguments, stage):
    request = 'tool-' + thread + '-' + turn + '-' + stage
    pending[request] = (thread, turn, stage)
    emit({'id':request,'method':'item/tool/call','params':{'threadId':thread,'turnId':turn,'callId':request,'tool':tool,'arguments':arguments}})

for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method is None:
        record = pending.pop(message.get('id'), None)
        if record is None:
            continue
        thread, turn, stage = record
        result = message.get('result', {})
        if not result.get('success'):
            print('task tool rejected: ' + json.dumps(result), file=sys.stderr, flush=True)
            complete(thread, turn, 'failed')
            continue
        if stage == 'delegate':
            content = json.loads(result['contentItems'][0]['text'])
            call_tool(thread,turn,'task_wait',{'reason':'Need the child result','blocked_by':[content['task']['task_id']]},'wait-child')
        else:
            complete(thread, turn)
        continue
    request = message.get('id')
    params = message.get('params', {})
    if method == 'initialize':
        emit({'id':request,'result':{'userAgent':'workflow-test'}})
    elif method == 'initialized':
        pass
    elif method == 'thread/start':
        thread = 'thread-' + str(len(threads) + 1)
        threads[thread] = {'turns':0, 'manual': not bool(params.get('dynamicTools')), 'summary': bool(params.get('ephemeral'))}
        emit({'id':request,'result':{'thread':{'id':thread}}})
    elif method == 'thread/resume':
        emit({'id':request,'result':{'thread':{'id':params['threadId']}}})
    elif method == 'thread/goal/get':
        emit({'id':request,'result':{'goal':None}})
    elif method == 'turn/start':
        thread=params['threadId']
        state=threads[thread]
        state['turns'] += 1
        turn='turn-' + str(state['turns'])
        text='\n'.join(item.get('text','') for item in params['input'])
        task=text.split('\n',1)[0].removeprefix('Task ID: ')
        emit({'id':request,'result':{'turn':{'id':turn,'status':'inProgress'}}})
        emit({'method':'turn/started','params':{'threadId':thread,'turn':{'id':turn,'status':'inProgress'}}})
        if state['manual']:
            # The new chat path has no durable-task tools. Summary extraction uses
            # a separate ephemeral readonly thread, never the source conversation.
            content = 'Summary: a plan, not implemented.' if state['summary'] else 'We discussed a plan; no files were changed.'
            emit({'method':'item/agentMessage/delta','params':{'threadId':thread,'turnId':turn,'itemId':'reply','delta':content}})
            emit({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'id':'reply','type':'agentMessage','text':content}}})
            complete(thread,turn)
        elif task == 'e2e-parent' and state['turns'] == 1:
            call_tool(thread,turn,'task_delegate',{'title':'Delegated verification','prompt':'Verify the child deliverable','acceptance':'Provide test evidence'},'delegate')
        elif task == 'e2e-question' and state['turns'] == 1:
            call_tool(thread,turn,'task_wait',{'reason':'Need user input','question':'Which color?'},'question')
        elif task == 'e2e-question' and 'blue' not in text:
            print('The next turn did not receive the durable answer',file=sys.stderr,flush=True)
            complete(thread,turn,'failed')
        elif task == 'e2e-cancel':
            emit({'id':'approval-'+thread,'method':'item/commandExecution/requestApproval','params':{'threadId':thread,'turnId':turn,'itemId':'cmd','command':'echo pending'}})
        else:
            call_tool(thread,turn,'task_submit_result',{'summary':'Verified delivery','evidence':{'checks':'passed'}},'submit')
    elif method == 'turn/interrupt':
        emit({'id':request,'result':{}})
        # Deliberately simulate a completion that arrives after cancellation.
        complete(params['threadId'],params['turnId'])
    elif method == 'command/exec':
        emit({'id':request,'result':{'exitCode':0,'stdout':'terminal checked\n','stderr':''}})
    elif request is not None:
        emit({'id':request,'result':{}})
"###).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let service = crate::work_service::WorkService::spawn_with_path(
                directory.join("tasks.sqlite"),
                std::sync::Arc::new(|| {}),
            )
            .unwrap();
            service
                .call(
                    "connect",
                    json!({"executable":executable.to_string_lossy()}),
                )
                .unwrap();
            Self { service, directory }
        }

        fn delegate(&self, id: &str) {
            self.service
                .call("save_todos", json!({"before":[],"after":[todo(id)]}))
                .unwrap();
            let mut task_config = config(ReviewPolicy::Auto);
            task_config.workspace = self.directory.to_string_lossy().into_owned();
            self.service
                .call("delegate", json!({"task_id":id,"config":task_config}))
                .unwrap();
        }

        fn wait_for(
            &self,
            id: &str,
            predicate: impl Fn(&TaskExecutionDetail) -> bool,
        ) -> TaskExecutionDetail {
            let start = std::time::Instant::now();
            loop {
                let value = self.service.call("detail", json!({"task_id":id})).unwrap();
                let detail: TaskExecutionDetail = serde_json::from_value(value).unwrap();
                if predicate(&detail) {
                    return detail;
                }
                assert!(
                    start.elapsed() < std::time::Duration::from_secs(10),
                    "Timed out waiting for {id}: {:?}, error {:?}, events {:?}",
                    detail.task.status,
                    detail.task.last_error,
                    detail.events
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }

    #[cfg(unix)]
    impl Drop for ServiceFixture {
        fn drop(&mut self) {
            self.service.shutdown();
            std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    #[cfg(unix)]
    fn service_drives_delegation_dependency_wait_and_parent_completion_without_user_pumping() {
        let fixture = ServiceFixture::new();
        fixture.delegate("e2e-parent");
        let detail = fixture.wait_for("e2e-parent", |detail| {
            detail.task.status == WorkflowStatus::Completed
        });
        assert_eq!(detail.runs.len(), 2);
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "child_created"));
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "dependencies_ready"));
        let list = fixture.service.call("list", json!({})).unwrap();
        let tasks: Vec<WorkTask> = serde_json::from_value(list["tasks"].clone()).unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(tasks
            .iter()
            .all(|task| task.status == WorkflowStatus::Completed));
    }

    #[test]
    #[cfg(unix)]
    fn service_supplies_durable_human_answer_to_the_automatically_resumed_turn() {
        let fixture = ServiceFixture::new();
        fixture.delegate("e2e-question");
        let detail = fixture.wait_for("e2e-question", |detail| {
            detail.task.status == WorkflowStatus::Waiting && detail.task.current_run_id.is_none()
        });
        let question = detail
            .interactions
            .iter()
            .find(|interaction| interaction.status == "pending")
            .unwrap();
        fixture.service.call("respond",json!({"task_id":"e2e-question","interaction_id":question.id,"run_id":question.run_id,"response":{"answer":"blue"}})).unwrap();
        let completed = fixture.wait_for("e2e-question", |detail| {
            detail.task.status == WorkflowStatus::Completed
        });
        assert_eq!(completed.runs.len(), 2);
        assert!(completed
            .events
            .iter()
            .any(|event| event.kind == "question_answered"));
    }

    #[test]
    #[cfg(unix)]
    fn service_cancellation_fences_a_late_success_and_old_permission_request() {
        let fixture = ServiceFixture::new();
        fixture.delegate("e2e-cancel");
        let detail = fixture.wait_for("e2e-cancel", |detail| {
            detail
                .interactions
                .iter()
                .any(|interaction| interaction.status == "pending")
        });
        let request = detail.interactions[0].clone();
        fixture.service.call("action",json!({"task_id":"e2e-cancel","action":"cancel","expected_revision":detail.task.revision})).unwrap();
        let cancelled = fixture.wait_for("e2e-cancel", |detail| {
            detail.task.status == WorkflowStatus::Cancelled
        });
        assert_eq!(cancelled.interactions[0].status, "expired");
        assert!(fixture.service.call("respond",json!({"task_id":"e2e-cancel","interaction_id":request.id,"run_id":request.run_id,"response":{"decision":"accept"}})).is_err());
        std::thread::sleep(std::time::Duration::from_millis(100));
        let final_state = fixture
            .service
            .call("detail", json!({"task_id":"e2e-cancel"}))
            .unwrap();
        assert_eq!(final_state["task"]["status"], "cancelled");
        assert_eq!(final_state["runs"].as_array().unwrap().len(), 1);
    }

    #[test]
    #[cfg(unix)]
    fn service_terminal_respects_agent_workspace_lease_and_does_not_reopen_completed_work() {
        let fixture = ServiceFixture::new();
        fixture.delegate("e2e-cancel");
        let active = fixture.wait_for("e2e-cancel", |detail| {
            detail
                .interactions
                .iter()
                .any(|interaction| interaction.status == "pending")
        });
        let error = fixture
            .service
            .execute_command(
                "e2e-cancel",
                vec!["echo".into(), "unsafe overlap".into()],
                1000,
            )
            .unwrap_err();
        assert!(error.contains("该目录仍有 Agent 或终端在执行"));
        fixture.service.call("action",json!({"task_id":"e2e-cancel","action":"cancel","expected_revision":active.task.revision})).unwrap();
        // A later task in the same directory cannot finish until cancellation has
        // actually released the former execution's workspace lease.
        fixture.delegate("e2e-terminal");
        let completed = fixture.wait_for("e2e-terminal", |detail| {
            detail.task.status == WorkflowStatus::Completed
        });
        let result = fixture
            .service
            .execute_command(
                "e2e-terminal",
                vec!["echo".into(), "inspection".into()],
                1000,
            )
            .unwrap();
        assert_eq!(result["exitCode"], 0);
        assert_eq!(result["stdout"], "terminal checked\n");
        let inspected = fixture.wait_for("e2e-terminal", |detail| {
            detail
                .events
                .iter()
                .any(|event| event.kind == "runtime/command/completed")
        });
        assert_eq!(inspected.task.status, WorkflowStatus::Completed);
        assert_eq!(inspected.task.revision, completed.task.revision);
        assert_eq!(inspected.runs.len(), completed.runs.len());
    }

    #[test]
    #[cfg(unix)]
    fn service_manual_chats_and_extraction_keep_task_and_source_identity() {
        let fixture = ServiceFixture::new();
        let project = fixture
            .service
            .call(
                "chat/project",
                json!({
                    "name":"Fixture project","path":fixture.directory.to_string_lossy()
                }),
            )
            .unwrap();
        let task = fixture
            .service
            .call(
                "chat/create_task",
                json!({
                    "title":"Discuss a plan","project_id":project["id"]
                }),
            )
            .unwrap();
        let tid = task["task_id"].as_str().unwrap();
        let first = fixture
            .service
            .call("chat/create_conversation", json!({"task_id":tid}))
            .unwrap();
        let second = fixture
            .service
            .call("chat/create_conversation", json!({"task_id":tid}))
            .unwrap();
        let cid = first["id"].as_str().unwrap();
        fixture.service.call("chat/send", json!({
            "conversation_id":cid,"text":"Discuss only, do not change files","attachments":[],"include_context":true
        })).unwrap();
        let started = std::time::Instant::now();
        let source_thread = loop {
            let detail = fixture
                .service
                .call("chat/detail", json!({"conversation_id":cid}))
                .unwrap();
            if detail["conversation"]["runtime_status"] == "idle"
                && detail["runs"]
                    .as_array()
                    .is_some_and(|runs| !runs.is_empty())
            {
                break detail["conversation"]["thread_id"].clone();
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "manual chat did not finish: {detail}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let extraction = fixture
            .service
            .call("chat/extract", json!({"conversation_id":cid}))
            .unwrap();
        let result_id = extraction["result_id"].as_str().unwrap();
        let started = std::time::Instant::now();
        loop {
            let snapshot = fixture.service.call("chat/snapshot", json!({})).unwrap();
            let task = &snapshot["tasks"][0];
            if let Some(result) = task["results"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == result_id && r["status"] == "ready")
            {
                assert_eq!(result["conversation_id"], cid);
                assert_eq!(result["method"], "manual");
                assert_eq!(result["usable"], false);
                assert!(result["markdown"].as_str().unwrap().contains("plan"));
                assert_ne!(task["status"], "completed");
                assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
                assert_eq!(snapshot["conversations"].as_array().unwrap().len(), 2);
                break;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "summary did not finish: {snapshot}"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let first = fixture
            .service
            .call("chat/detail", json!({"conversation_id":cid}))
            .unwrap();
        assert_eq!(first["conversation"]["thread_id"], source_thread);
        let untouched = fixture
            .service
            .call("chat/detail", json!({"conversation_id":second["id"]}))
            .unwrap();
        assert!(untouched["conversation"]["thread_id"].is_null());
        assert!(fixture
            .service
            .call("chat/extract", json!({"conversation_id":cid}))
            .is_err());
    }
    #[test]
    #[cfg(unix)]
    fn service_holds_scheduled_work_without_thread_then_starts_once_when_due() {
        let fixture = ServiceFixture::new();
        fixture
            .service
            .call(
                "save_todos",
                json!({"before":[],"after":[todo("scheduled-child")]}),
            )
            .unwrap();
        fixture.service.call("chat/set_start_time",json!({"task_id":"scheduled-child","scheduled_start_at":"2099-01-01T00:00:00Z","expected_start_at":null})).unwrap();
        let mut cfg = config(ReviewPolicy::Auto);
        cfg.workspace = fixture.directory.to_string_lossy().into_owned();
        fixture
            .service
            .call(
                "delegate",
                json!({"task_id":"scheduled-child","config":cfg}),
            )
            .unwrap();
        let waiting = fixture.wait_for("scheduled-child", |d| {
            d.task.wait_reason.as_deref() == Some("scheduled")
        });
        assert!(waiting.runs.is_empty());
        assert!(waiting.task.thread_id.is_none());
        fixture.service.call("chat/set_start_time",json!({"task_id":"scheduled-child","scheduled_start_at":"2000-01-01T00:00:00Z","expected_start_at":"2099-01-01T00:00:00Z"})).unwrap();
        let done = fixture.wait_for("scheduled-child", |d| {
            d.task.status == WorkflowStatus::Completed
        });
        assert_eq!(done.runs.len(), 1);
        assert!(done.task.thread_id.is_some());
        let again: TaskExecutionDetail = serde_json::from_value(
            fixture
                .service
                .call("detail", json!({"task_id":"scheduled-child"}))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(again.runs.len(), 1);
    }
}
