use crate::{repository::Repository, workflow::WorkTask};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const PREFIX: &str = "AKB task input through event ";
const UPDATES: usize = 12;
const EVENT_BYTES: usize = 2048;

fn db(error: rusqlite::Error) -> String {
    error.to_string()
}

impl Repository {
    fn acknowledged_context(&self, task: &WorkTask) -> Result<Option<i64>, String> {
        let Some(thread) = &task.thread_id else {
            return Ok(None);
        };
        // run 的 Thread/Turn 绑定说明 Codex 已接收该轮输入。仅领取或恢复 Thread 不算投递。
        let header: Option<String> = self
            .connection
            .query_row(
                "SELECT substr(prompt,instr(prompt,char(10))+1,80) FROM work_runs WHERE task_id=?1 AND thread_id=?2
             AND turn_id IS NOT NULL AND substr(prompt,instr(prompt,char(10))+1,?3)=?4 ORDER BY generation DESC LIMIT 1",
                params![task.task_id, thread, PREFIX.len(), PREFIX],
                |row| row.get(0),
            )
            .optional()
            .map_err(db)?;
        Ok(header
            .as_deref()
            .and_then(|h| h.lines().next()?.strip_prefix(PREFIX)?.parse().ok()))
    }

    fn task_updates(
        &self,
        task: &WorkTask,
        acknowledged: Option<i64>,
    ) -> Result<(i64, Vec<Value>, bool), String> {
        // 旧会话首次升级只回看近期决策，已有对话正文仍由原 Thread 管理。
        let legacy = acknowledged.is_none() && task.thread_id.is_some();
        let order = if legacy { "DESC" } else { "ASC" };
        let sql = format!(
            "SELECT id,kind,length(CAST(payload_json AS BLOB)),substr(payload_json,1,?3)
             FROM work_events WHERE task_id=?1 AND id>?2 AND
             (kind IN ('user_message','agent_message','question_answered','continue_requested')
              OR (kind='task_action' AND json_extract(payload_json,'$.action')='rework'))
             ORDER BY id {order} LIMIT ?4"
        );
        let mut statement = self.connection.prepare(&sql).map_err(db)?;
        let mut rows = statement
            .query(params![
                task.task_id,
                acknowledged.unwrap_or(0),
                EVENT_BYTES,
                UPDATES + 1
            ])
            .map_err(db)?;
        let mut boundary = acknowledged.unwrap_or(0);
        let mut updates = Vec::new();
        let mut more = false;
        while let Some(row) = rows.next().map_err(db)? {
            if updates.len() == UPDATES {
                more = !legacy;
                break;
            }
            let id: i64 = row.get(0).map_err(db)?;
            let kind: String = row.get(1).map_err(db)?;
            let size: usize = row.get(2).map_err(db)?;
            let raw: String = row.get(3).map_err(db)?;
            let payload = if size > EVENT_BYTES {
                let end = raw
                    .char_indices()
                    .map(|(i, _)| i)
                    .take_while(|i| *i <= EVENT_BYTES)
                    .last()
                    .unwrap_or(0);
                json!({"preview":&raw[..end],"read_original_with":"task_read_context_event"})
            } else {
                serde_json::from_str(&raw).map_err(|e| e.to_string())?
            };
            updates.push(json!({"event_id":id,"kind":kind,"payload":payload}));
            boundary = boundary.max(id);
        }
        if legacy {
            updates.reverse();
        }
        Ok((boundary, updates, more))
    }

    pub(crate) fn work_turn_prompt(&self, task: &WorkTask) -> Result<String, String> {
        let ack = self.acknowledged_context(task)?;
        let (boundary, updates, more) = self.task_updates(task, ack)?;
        let goal: Option<String> = self
            .connection
            .query_row(
                "SELECT process_tracking FROM todo_tasks WHERE id=?1",
                [&task.task_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?;
        let goal = goal
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&task.config.prompt);
        let mut dependency = self
            .connection
            .prepare(
                "SELECT t.title,substr(COALESCE(w.result_summary,t.result_review,''),1,800)
             FROM todo_tasks t LEFT JOIN work_tasks w ON w.task_id=t.id WHERE t.id=?1",
            )
            .map_err(db)?;
        let mut sources = Vec::new();
        for id in task.config.blocked_by.iter().take(16) {
            if let Some(result) = dependency.query_row([id], |r| Ok(json!({
                "task_id":id,"title":r.get::<_,String>(0)?,"result_preview":r.get::<_,String>(1)?
            }))).optional().map_err(db)? {
                sources.push(result);
            }
        }
        let updates = Value::Array(updates);
        let sources = Value::Array(sources);
        let remaining = if more {
            "More task decisions remain queued. Read these entries, then call task_continue to receive the next batch before performing business actions."
        } else {
            ""
        };
        let continuation = if task.continuation_count > 0 {
            "The previous turn ended without an accepted handoff. Make progress or report the concrete blocker."
        } else {
            ""
        };
        Ok(format!(
            "Task ID: {}\n{PREFIX}{boundary}\nTitle: {}\nGoal:\n{}\nAcceptance:\n{}\nDelegated by: {}\nReview policy: {:?}\n\
             Completed dependency result previews (context only):\n{sources}\nNew task decisions:\n{updates}\n\
             Read any referenced original decision before acting on it. {remaining}\n\
             Continue in the existing workspace and thread. Verify against acceptance. Call task_submit_result with evidence, task_wait for a real blocker, or task_continue with the next step. A final message does not complete the task. {continuation}",
            task.task_id, task.title, goal, task.config.acceptance, task.config.delegated_by, task.config.review_policy
        ))
    }
}
