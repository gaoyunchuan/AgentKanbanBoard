//! 人工会话清理保留消息与结果来源，不借用任务归档或会话完成状态。
use crate::repository::Repository;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

impl Repository {
    pub fn chat_delete_conversation(&self, cid: &str, revision: i64) -> Result<(), String> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let c = self.chat_conversation(cid)?;
        self.chat_require_task(&c.task_id)?;
        if c.mode == "auto" {
            return Err("自动主会话保留任务执行历史，不能删除".into());
        }
        // 提取结果使用独立执行，不能仅依据会话上的 current_run_id 判断空闲。
        if self.chat_active_run(cid)?.is_some()
            || c.current_run_id.is_some()
            || matches!(
                c.runtime_status.as_str(),
                "queued" | "running" | "needs_input" | "stopping"
            )
            || c.resource_hold.is_some()
        {
            return Err("请先停止会话执行或结果提取，并确认资源已释放，再删除".into());
        }
        let changed = tx.execute("UPDATE chat_conversations SET deleted_at=?2,revision=revision+1 WHERE id=?1 AND revision=?3 AND deleted_at IS NULL", params![cid,self.now_text(),revision]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("会话已变化，请刷新后重新确认删除".into());
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn chat_deleted_conversations(&self) -> Result<Vec<Value>, String> {
        let mut stmt = self.connection.prepare("SELECT c.id,c.title,c.task_id,c.revision,t.title,p.archived_at IS NOT NULL FROM chat_conversations c JOIN todo_tasks t ON t.id=c.task_id LEFT JOIN task_preferences p ON p.task_id=c.task_id WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC,c.id").map_err(|e|e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"task_id":r.get::<_,String>(2)?,"revision":r.get::<_,i64>(3)?,"task_title":r.get::<_,String>(4)?,"task_deleted":r.get::<_,bool>(5)?}))).map_err(|e|e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn chat_restore_conversation(&self, cid: &str, revision: i64) -> Result<(), String> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let task: Option<String> = tx
            .query_row(
                "SELECT task_id FROM chat_conversations WHERE id=?1 AND deleted_at IS NOT NULL",
                [cid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let tid = task.ok_or("会话不存在或已恢复")?;
        self.chat_require_task(&tid)?;
        // 只撤销墓碑，closed、消息、结果、执行历史和任务状态保持原值，绝不自动续跑。
        let changed = tx.execute("UPDATE chat_conversations SET deleted_at=NULL,revision=revision+1 WHERE id=?1 AND revision=?2 AND deleted_at IS NOT NULL", params![cid,revision]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("会话已变化，请刷新后重新恢复".into());
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
