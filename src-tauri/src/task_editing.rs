//! Transactional task-tree edits; UI sends only the edited fields, never a tree snapshot.
use crate::repository::Repository;
use rusqlite::{params, Transaction, TransactionBehavior};
use serde_json::Value;
impl Repository {
    pub fn chat_move_task(
        &self,
        tid: &str,
        parent: Option<&str>,
        expected: &Value,
    ) -> Result<(), String> {
        self.chat_require_task(tid)?;
        if let Some(parent) = parent {
            self.chat_require_task(parent)?;
        }
        let todos = self.list_todo_tasks().map_err(|e| e.to_string())?;
        let task = todos.iter().find(|t| t.id == tid).ok_or("任务不存在")?;
        if &serde_json::json!(task.parent_id) != expected {
            return Err("任务层级已改变，请刷新后重试".into());
        }
        if task.parent_id.as_deref() == parent {
            return Ok(());
        }
        let mut ancestor = parent;
        let mut visited = std::collections::HashSet::new();
        let mut root = parent;
        while let Some(id) = ancestor {
            if id == tid || !visited.insert(id) {
                return Err("不能移动到自身或自己的子任务中".into());
            }
            root = Some(id);
            ancestor = todos
                .iter()
                .find(|t| t.id == id)
                .and_then(|t| t.parent_id.as_deref());
        }
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
        let now = self.now_text();
        transaction.execute("UPDATE todo_tasks SET parent_id=?2,position=(SELECT COALESCE(MAX(position),-1)+1 FROM todo_tasks WHERE parent_id IS ?2),pinned=CASE WHEN ?2 IS NULL THEN pinned ELSE 0 END,updated_at=?3,activity_at=?3 WHERE id=?1",params![tid,parent,now]).map_err(|e|e.to_string())?;
        if task.pinned {
            if let Some(root) = root {
                transaction
                    .execute(
                        "UPDATE todo_tasks SET pinned=1,updated_at=?2 WHERE id=?1",
                        params![root, now],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        // A hierarchy edit can introduce an implicit parent-waits-child cycle or
        // make a previously local dependency cross a root. Roll back as a unit.
        for t in &todos {
            if self.chat_require_task(&t.id).is_err() {
                continue;
            }
            let deps = self.chat_dependencies(&t.id)?;
            if !deps.is_empty() {
                self.chat_validate_dependencies(&t.id, &deps)?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn moving_a_pinned_root_transfers_pin_and_repeated_tab_is_noop() {
        let r = Repository::open_in_memory().unwrap();
        let a = r.chat_create_task(&json!({"title":"a"})).unwrap();
        let b = r.chat_create_task(&json!({"title":"b"})).unwrap();
        r.chat_update_task(&b, &json!({"pinned":true}), &json!({"pinned":false}))
            .unwrap();
        r.chat_move_task(&b, Some(&a), &Value::Null).unwrap();
        r.chat_move_task(&b, Some(&a), &json!(a)).unwrap();
        let tasks = r.list_todo_tasks().unwrap();
        assert!(tasks.iter().find(|t| t.id == a).unwrap().pinned);
        assert!(!tasks.iter().find(|t| t.id == b).unwrap().pinned);
        assert!(r
            .chat_update_task(&b, &json!({"pinned":true}), &json!({"pinned":false}))
            .is_err());
    }
    #[test]
    fn sibling_insertion_keeps_position_and_no_implicit_execution() {
        let r = Repository::open_in_memory().unwrap();
        let a = r.chat_create_task(&json!({"title":"a"})).unwrap();
        let b = r.chat_create_task(&json!({"title":"b"})).unwrap();
        let n = r
            .chat_create_task(&json!({"title":"new","after_id":a}))
            .unwrap();
        let tasks = r.list_todo_tasks().unwrap();
        let pos = |id: &str| tasks.iter().find(|t| t.id == id).unwrap().position;
        assert!(pos(&a) < pos(&n));
        assert!(pos(&n) < pos(&b));
        assert!(r.chat_conversations().unwrap().is_empty());
    }
}
