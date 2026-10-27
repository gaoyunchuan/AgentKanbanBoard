//! Shared project visibility and lazy binding for chats created before a project
//! was chosen. Hidden projects are not deleted and old Thread cwd never moves.
use crate::domain::ProjectRecord;
use crate::local_environment::{absolute_path, is_excluded, workspace_directory};
use crate::repository::Repository;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
impl Repository {
    pub fn project_exclusions(&self) -> Result<Vec<String>, String> {
        let raw: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM studio_settings WHERE key='excluded_project_dirs'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|s| serde_json::from_str(&s).map_err(|e| format!("项目排除设置损坏：{e}")))
            .transpose()
            .map(|x| x.unwrap_or_default())
    }
    pub fn save_project_exclusions(&self, values: &[String]) -> Result<(), String> {
        if values.len() > 100 {
            return Err("最多配置 100 个项目排除目录".into());
        }
        let mut roots = Vec::<String>::new();
        for value in values {
            let path = absolute_path(value)?;
            // Excluding a root drive hides everything and is likely accidental.
            if path.parent().is_none() {
                return Err("不能排除文件系统根目录，请选择具体目录".into());
            }
            let path = path.to_string_lossy().into_owned();
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
        self.connection.execute("INSERT INTO studio_settings(key,value) VALUES('excluded_project_dirs',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&roots).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn visible_chat_projects(&self) -> Result<Vec<ProjectRecord>, String> {
        let exclusions = self.project_exclusions()?;
        Ok(self
            .list_projects(false)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|p| {
                p.active
                    && absolute_path(&p.path).is_ok_and(|path| !is_excluded(&path, &exclusions))
            })
            .collect())
    }
    pub fn selectable_project_path(&self, id: &str) -> Result<String, String> {
        let project = self
            .visible_chat_projects()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("项目已隐藏、失效或被排除，请重新选择项目")?;
        Ok(absolute_path(&project.path)?.to_string_lossy().into_owned())
    }
    pub fn prepare_chat_workspace(
        &self,
        cid: &str,
    ) -> Result<crate::chat_store::Conversation, String> {
        let mut c = self.chat_conversation(cid)?;
        if c.thread_id.is_some() {
            workspace_directory(&c.config.workspace)?;
            return Ok(c);
        }
        let pid = c
            .project_id
            .clone()
            .or(self.chat_effective_project(&c.task_id)?);
        let path = if let Some(pid) = &pid {
            self.selectable_project_path(pid)?
        } else {
            c.config.workspace.clone()
        };
        let path = workspace_directory(&path)?;
        if is_excluded(&path, &self.project_exclusions()?) {
            return Err("项目目录已被排除，请选择其他项目后开始新会话".into());
        }
        let path = path.to_string_lossy().into_owned();
        if c.project_id != pid || c.config.workspace != path {
            c.project_id = pid;
            c.config.workspace = path;
            self.connection.execute("UPDATE chat_conversations SET project_id=?2,config_json=?3,revision=revision+1,last_error=NULL WHERE id=?1 AND thread_id IS NULL",params![cid,c.project_id,serde_json::to_string(&c.config).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            return self.chat_conversation(cid);
        }
        Ok(c)
    }
    /// New automatic threads follow current task project inheritance. Once a
    /// real thread exists, its directory stays fixed even if the default changes.
    pub fn prepare_work_workspace(&self, tid: &str) -> Result<crate::workflow::WorkTask, String> {
        let mut task = self.get_work_task(tid)?.ok_or("任务尚未委派")?;
        if task.thread_id.is_some() {
            workspace_directory(&task.config.workspace)?;
            return Ok(task);
        }
        let pid = self.chat_effective_project(tid)?;
        let path = if let Some(id) = pid {
            self.selectable_project_path(&id)?
        } else {
            task.config.workspace.clone()
        };
        let path = workspace_directory(&path)?;
        if is_excluded(&path, &self.project_exclusions()?) {
            return Err("项目目录已被排除，请调整项目或排除设置后恢复任务".into());
        }
        let path = path.to_string_lossy().into_owned();
        if task.config.workspace != path {
            task.config.workspace = path;
            self.connection.execute("UPDATE work_tasks SET config_json=?2,revision=revision+1 WHERE task_id=?1 AND thread_id IS NULL",params![tid,serde_json::to_string(&task.config).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            return self.get_work_task(tid)?.ok_or("任务不存在".into());
        }
        Ok(task)
    }
    pub fn studio_settings(&self) -> Result<Value, String> {
        Ok(json!({"excluded_project_dirs":self.project_exclusions()?}))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ProjectInput;
    #[test]
    fn inherited_project_is_resolved_after_placeholder_creation() {
        let r = Repository::open_in_memory().unwrap();
        let root = r.chat_create_task(&json!({"title":"parent"})).unwrap();
        let child = r
            .chat_create_task(&json!({"title":"child","parent_id":root}))
            .unwrap();
        let c = r.chat_create_conversation(&child, None).unwrap();
        assert!(c.config.workspace.is_empty());
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        r.upsert_project(ProjectInput {
            id: "p".into(),
            name: "Project".into(),
            path: path.clone(),
            origin_url: None,
            aliases: vec![],
            active: true,
        })
        .unwrap();
        r.chat_update_task(
            &root,
            &json!({"project_id":"p"}),
            &json!({"project_id":null}),
        )
        .unwrap();
        let ready = r.prepare_chat_workspace(&c.id).unwrap();
        assert_eq!(ready.config.workspace, path);
        assert_eq!(ready.project_id.as_deref(), Some("p"));
        assert!(ready.thread_id.is_none());
    }
    #[test]
    fn exclusions_filter_every_selector_without_deleting_history() {
        let r = Repository::open_in_memory().unwrap();
        for (id, path) in [
            ("hidden", "/tmp/akb-exclude/plugins/p"),
            ("visible", "/tmp/akb-exclude/plugins-other/p"),
        ] {
            r.upsert_project(ProjectInput {
                id: id.into(),
                name: id.into(),
                path: path.into(),
                origin_url: None,
                aliases: vec![],
                active: true,
            })
            .unwrap();
        }
        r.save_project_exclusions(&["/tmp/akb-exclude/plugins".into()])
            .unwrap();
        assert_eq!(r.visible_chat_projects().unwrap().len(), 1);
        assert!(r.selectable_project_path("hidden").is_err());
        assert_eq!(r.list_projects(true).unwrap().len(), 2);
        r.save_project_exclusions(&[]).unwrap();
        assert_eq!(r.visible_chat_projects().unwrap().len(), 2);
    }
    #[test]
    fn invalid_workspace_fails_before_a_message_or_run_is_saved() {
        let r = Repository::open_in_memory().unwrap();
        let task = r.chat_create_task(&json!({"title":"no project"})).unwrap();
        let c = r.chat_create_conversation(&task, None).unwrap();
        assert!(r.chat_queue(&c.id, "hello", &[], false).is_err());
        assert!(r.chat_active_run(&c.id).unwrap().is_none());
        assert_eq!(
            r.chat_detail(&c.id).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}
