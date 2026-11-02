//! 任务保存自己的权限；全局默认仅用于初始化，每轮执行使用任务已保存的值。
use crate::repository::Repository;
use crate::workflow::TaskConfig;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskPermissions {
    pub sandbox_mode: String,
    pub approval_policy: String,
}

impl TaskPermissions {
    pub fn from_config(config: &TaskConfig) -> Self {
        Self {
            sandbox_mode: config.sandbox_mode.clone(),
            approval_policy: config.approval_policy.clone(),
        }
    }

    pub fn apply(&self, config: &mut TaskConfig) {
        config.sandbox_mode.clone_from(&self.sandbox_mode);
        config.approval_policy.clone_from(&self.approval_policy);
    }

    fn validate(&self) -> Result<(), String> {
        if !["workspace-write", "read-only", "danger-full-access"]
            .contains(&self.sandbox_mode.as_str())
            || !["on-request", "untrusted", "never"].contains(&self.approval_policy.as_str())
        {
            return Err("不支持的任务执行权限".into());
        }
        Ok(())
    }
}

pub(crate) fn defaults(connection: &Connection) -> Result<TaskPermissions, String> {
    let mode: Option<String> = connection
        .query_row(
            "SELECT value FROM studio_settings WHERE key='delegation_permission'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut config = TaskConfig::default();
    crate::workflow::apply_delegation_permission(
        &mut config,
        mode.as_deref()
            .filter(|m| Repository::DELEGATION_PERMISSIONS.contains(m))
            .unwrap_or("on-request"),
    )?;
    Ok(TaskPermissions::from_config(&config))
}

pub(crate) fn migrate(connection: &Connection) -> rusqlite::Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(task_preferences)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|c| c == "execution_permissions") {
        connection.execute(
            "ALTER TABLE task_preferences ADD COLUMN execution_permissions TEXT",
            [],
        )?;
    }
    initialize_missing(connection)
}

pub(crate) fn initialize_missing(connection: &Connection) -> rusqlite::Result<()> {
    let default = defaults(connection).map_err(rusqlite::Error::InvalidParameterName)?;
    let encoded = serde_json::to_string(&default)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    // 历史任务优先保留其自动执行配置；只有没有配置的任务才采用当前默认。
    connection.execute(
        "INSERT OR IGNORE INTO task_preferences(task_id) SELECT id FROM todo_tasks",
        [],
    )?;
    connection.execute("UPDATE task_preferences SET execution_permissions=COALESCE(
        (SELECT json_object('sandbox_mode',COALESCE(json_extract(w.config_json,'$.sandbox_mode'),'workspace-write'),'approval_policy',COALESCE(json_extract(w.config_json,'$.approval_policy'),'on-request')) FROM work_tasks w WHERE w.task_id=task_preferences.task_id),
        (SELECT json_object('sandbox_mode',COALESCE(json_extract(c.config_json,'$.sandbox_mode'),'workspace-write'),'approval_policy',COALESCE(json_extract(c.config_json,'$.approval_policy'),'on-request')) FROM chat_conversations c WHERE c.task_id=task_preferences.task_id AND c.mode='auto'),?1)
        WHERE execution_permissions IS NULL", [encoded])?;
    Ok(())
}

pub(crate) fn store(
    connection: &Connection,
    task_id: &str,
    permission: &TaskPermissions,
) -> Result<(), String> {
    let encoded = serde_json::to_string(permission).map_err(|e| e.to_string())?;
    connection
        .execute(
            "INSERT INTO task_preferences(task_id,execution_permissions) VALUES(?1,?2)
        ON CONFLICT(task_id) DO UPDATE SET execution_permissions=excluded.execution_permissions",
            params![task_id, encoded],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn for_run(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<TaskPermissions>, String> {
    let raw: Option<String> = connection.query_row("SELECT json_extract(payload_json,'$.execution_permissions') FROM work_events WHERE task_id=(SELECT task_id FROM work_runs WHERE id=?1) AND run_id=?1 AND kind='run_started' ORDER BY id DESC LIMIT 1", [run_id], |r| r.get(0)).optional().map_err(|e|e.to_string())?.flatten();
    raw.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
        .transpose()
}

impl Repository {
    pub fn task_permissions(&self, task_id: &str) -> Result<TaskPermissions, String> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT execution_permissions FROM task_preferences WHERE task_id=?1",
                [task_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        match raw {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| format!("任务权限配置无效：{e}")),
            None => self
                .get_work_task(task_id)?
                .map(|w| Ok(TaskPermissions::from_config(&w.config)))
                .unwrap_or_else(|| defaults(&self.connection)),
        }
    }

    pub fn set_task_permissions(
        &self,
        task_id: &str,
        next: &TaskPermissions,
        expected: &TaskPermissions,
    ) -> Result<(), String> {
        self.chat_require_task(task_id)?;
        next.validate()?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if self.task_permissions(task_id)? != *expected {
            return Err("任务权限已被修改，请刷新后重试".into());
        }
        if next != expected {
            store(&tx, task_id, next)?;
            self.sync_task_permissions(&tx, task_id, next)?;
            tx.execute(
                "UPDATE todo_tasks SET updated_at=?2,activity_at=?2 WHERE id=?1",
                params![task_id, self.now_text()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    fn sync_task_permissions(
        &self,
        tx: &Connection,
        task_id: &str,
        next: &TaskPermissions,
    ) -> Result<(), String> {
        // 只更新后续启动配置，正在执行的 worker 持有启动快照，不修改当前审批。
        tx.execute("UPDATE work_tasks SET config_json=json_set(config_json,'$.sandbox_mode',?2,'$.approval_policy',?3),revision=revision+1,updated_at=?4 WHERE task_id=?1", params![task_id,next.sandbox_mode,next.approval_policy,self.now_text()]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE chat_conversations SET config_json=json_set(config_json,'$.sandbox_mode',?2,'$.approval_policy',?3),revision=revision+1,updated_at=?4 WHERE task_id=?1 AND mode='auto'", params![task_id,next.sandbox_mode,next.approval_policy,self.now_text()]).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn create(repo: &Repository, title: &str, parent: Option<&str>) -> String {
        repo.chat_create_task(&json!({"title":title,"parent_id":parent}))
            .unwrap()
    }

    fn config() -> TaskConfig {
        TaskConfig {
            workspace: "/tmp".into(),
            prompt: "验证权限".into(),
            acceptance: "保存证据".into(),
            ..TaskConfig::default()
        }
    }

    fn full() -> TaskPermissions {
        TaskPermissions {
            sandbox_mode: "danger-full-access".into(),
            approval_policy: "never".into(),
        }
    }

    #[test]
    fn full_access_task_can_be_delegated_with_its_saved_permissions() {
        let repo = Repository::open_in_memory().unwrap();
        repo.save_delegation_permission("full-access").unwrap();
        let id = create(&repo, "全权限任务", None);
        let mut config = config();
        repo.task_permissions(&id).unwrap().apply(&mut config);
        let work = repo.delegate_task(&id, &config).unwrap();
        assert_eq!(TaskPermissions::from_config(&work.config), full());
    }

    #[test]
    fn permission_saved_while_waiting_is_used_after_dependencies_release() {
        let repo = Repository::open_in_memory().unwrap();
        let root = create(&repo, "root", None);
        let up = create(&repo, "up", Some(&root));
        let down = create(&repo, "down", Some(&root));
        let mut config = config();
        config.blocked_by = vec![up.clone()];
        repo.delegate_task(&down, &config).unwrap();
        let original = repo.task_permissions(&down).unwrap();
        let main = repo.chat_conversation(&format!("main:{down}")).unwrap();
        repo.set_task_permissions(&down, &full(), &original)
            .unwrap();
        assert!(repo.claim_work_task(&down, "尚未就绪").is_err());
        assert!(repo
            .set_task_permissions(&down, &original, &original)
            .is_err());
        assert!(repo
            .chat_update_conversation(
                &main.id,
                &json!({"sandbox_mode":"read-only"}),
                main.revision
            )
            .is_err());
        repo.connection
            .execute("UPDATE todo_tasks SET status='completed' WHERE id=?1", [up])
            .unwrap();
        repo.refresh_work_dependencies().unwrap();
        let run = repo.claim_work_task(&down, "开始").unwrap();
        assert_eq!(for_run(&repo.connection, &run.id).unwrap(), Some(full()));
        assert_eq!(
            repo.chat_conversation(&main.id)
                .unwrap()
                .config
                .approval_policy,
            "never"
        );
    }

    #[test]
    fn active_run_and_children_keep_start_permissions_but_next_run_uses_saved_value() {
        let repo = Repository::open_in_memory().unwrap();
        let id = create(&repo, "父任务", None);
        repo.delegate_task(&id, &config()).unwrap();
        let first = repo.claim_work_task(&id, "第一轮").unwrap();
        let original = repo.task_permissions(&id).unwrap();
        repo.set_task_permissions(&id, &full(), &original).unwrap();
        assert_eq!(
            for_run(&repo.connection, &first.id).unwrap(),
            Some(original.clone())
        );
        assert_eq!(
            repo.get_work_task(&id).unwrap().unwrap().current_run_id,
            Some(first.id.clone())
        );
        let child = repo
            .create_delegated_child(&id, &first.id, "子任务", &config())
            .unwrap();
        assert_eq!(TaskPermissions::from_config(&child.config), original);
        assert_eq!(repo.task_permissions(&child.task_id).unwrap(), original);
        repo.finish_work_run(&id, &first.id, "completed", None)
            .unwrap();
        let second = repo.claim_work_task(&id, "第二轮").unwrap();
        assert_eq!(for_run(&repo.connection, &second.id).unwrap(), Some(full()));
    }

    #[test]
    fn automatic_conversation_permission_edit_updates_task_without_touching_manual_conversation() {
        let repo = Repository::open_in_memory().unwrap();
        let id = create(&repo, "任务", None);
        repo.delegate_task(&id, &config()).unwrap();
        let manual = repo.chat_create_conversation(&id, None).unwrap();
        let main = repo.chat_conversation(&format!("main:{id}")).unwrap();
        repo.chat_update_conversation(
            &main.id,
            &json!({"sandbox_mode":"danger-full-access","approval_policy":"never"}),
            main.revision,
        )
        .unwrap();
        assert_eq!(repo.task_permissions(&id).unwrap(), full());
        assert_eq!(
            repo.chat_conversation(&manual.id)
                .unwrap()
                .config
                .approval_policy,
            "on-request"
        );
    }

    #[test]
    fn migration_preserves_historical_custom_permissions_and_is_idempotent() {
        let path = std::env::temp_dir().join(format!(
            "task-permissions-{}-{}.db",
            std::process::id(),
            crate::chat_store::id("migration")
        ));
        let id;
        {
            let repo = Repository::open_path(&path).unwrap();
            id = create(&repo, "历史任务", None);
            let mut config = config();
            config.approval_policy = "on-failure".into();
            repo.delegate_task(&id, &config).unwrap();
            repo.save_delegation_permission("full-access").unwrap();
            repo.connection
                .execute(
                    "UPDATE task_preferences SET execution_permissions=NULL WHERE task_id=?1",
                    [&id],
                )
                .unwrap();
        }
        {
            let repo = Repository::open_path(&path).unwrap();
            assert_eq!(
                repo.task_permissions(&id).unwrap().approval_policy,
                "on-failure"
            );
            repo.set_task_permissions(&id, &full(), &repo.task_permissions(&id).unwrap())
                .unwrap();
            repo.save_delegation_permission("read-only").unwrap();
        }
        let repo = Repository::open_path(&path).unwrap();
        assert_eq!(repo.task_permissions(&id).unwrap(), full());
        drop(repo);
        std::fs::remove_file(path).unwrap();
    }
}
