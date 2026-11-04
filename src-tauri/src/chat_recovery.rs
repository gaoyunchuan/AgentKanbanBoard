// 半自动恢复只管理连接；归档由用户在 Codex 完成，不创建执行或重发消息。
struct ConnectionRecovery {
    conversation: crate::chat_store::Conversation,
    workspace: PathBuf,
    connection_id: String,
}

impl Scheduler {
    fn check_recovery_mutation(&self, method: &str, value: &Value) -> Result<(), String> {
        if matches!(
            method,
            "snapshot"
                | "detail"
                | "config"
                | "context"
                | "visit"
                | "list"
                | "workspace_config"
                | "browser_owner"
        ) {
            return Ok(());
        }
        let result_conversation: Option<String> = if let Some(id) = value["result_id"].as_str() {
            self.repository
                .connection
                .query_row(
                    "SELECT conversation_id FROM task_results WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
        } else {
            None
        };
        if result_conversation
            .as_deref()
            .is_some_and(|cid| self.recovering.contains_key(cid))
        {
            return Err("正在恢复该会话连接，请完成后再操作结果".into());
        }
        if self.recovering.values().any(|r| {
            value["conversation_id"].as_str() == Some(&r.conversation.id)
                || value["task_id"].as_str() == Some(&r.conversation.task_id)
                || value["task"].as_str() == Some(&r.conversation.task_id)
        }) {
            return Err("正在恢复该会话连接，请完成后再操作".into());
        }
        Ok(())
    }

    fn connection_recovery_target(
        &self,
        value: &Value,
    ) -> Result<crate::chat_store::Conversation, String> {
        let cid = crate::chat_store::required(value, "conversation_id")?;
        let c = self.repository.chat_conversation(cid)?;
        self.repository.chat_require_task(&c.task_id)?;
        let pending: bool = self
            .repository
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_pending_changes WHERE task_id=?1)",
                [&c.task_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if pending {
            return Err("任务仍在应用上次变更，请完成后恢复连接".into());
        }
        if value["revision"].as_i64() != Some(c.revision)
            || value["thread_id"].as_str() != c.thread_id.as_deref()
        {
            return Err("会话已变化，请关闭后重新打开恢复入口".into());
        }
        let thread_id = c.thread_id.as_deref().ok_or("会话尚未建立 Codex Thread")?;
        crate::deeplink::thread_deeplink(thread_id)?;
        if c.closed {
            return Err("请先重新打开会话".into());
        }
        if c.current_run_id.is_some()
            || c.resource_hold.is_some()
            || matches!(
                c.runtime_status.as_str(),
                "queued" | "running" | "needs_input" | "stopping"
            )
            || self.repository.chat_active_run(cid)?.is_some()
        {
            return Err("请先停止会话执行或结果提取，并确认资源已释放".into());
        }
        // 已 ended 的提取仍可能等待运行时停止确认，不能只看数据库终态。
        for (key, live) in &self.live {
            let belongs: bool = self
                .repository
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM chat_runs WHERE id=?1 AND conversation_id=?2)",
                    rusqlite::params![live.run_id, cid],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if belongs || key == &c.task_id || key == &format!("chat:{cid}") {
                return Err("请等待原执行停止确认后恢复连接".into());
            }
        }
        Ok(c)
    }

    fn open_connection_recovery(&self, value: &Value) -> Result<Value, String> {
        let c = self.connection_recovery_target(value)?;
        let target = crate::deeplink::thread_deeplink(
            c.thread_id.as_deref().ok_or("会话尚未建立 Codex Thread")?,
        )?;
        let status = std::process::Command::new("open")
            .arg(&target)
            .status()
            .map_err(|e| format!("打开 Codex 会话失败：{e}"))?;
        if !status.success() {
            return Err("未能打开 Codex，请手动定位并归档原会话".into());
        }
        Ok(json!({"opened":true,"thread_id":c.thread_id}))
    }

    fn begin_connection_recovery(&mut self, value: Value, reply: Reply) -> Result<(), String> {
        self.check_recovery_mutation("recover_connection", &value)?;
        let c = self.connection_recovery_target(&value)?;
        if self.live.len() + self.recovering.len() >= MAX_CONCURRENT_TASKS {
            return Err("当前执行或恢复数量已达上限，请稍后重试".into());
        }
        let workspace = canonical_workspace(&c.config.workspace)?;
        if self.workspace_busy(&workspace) {
            return Err("工作目录仍有执行，请等待释放后恢复连接".into());
        }
        let runtime = self.connect(None)?;
        let config = recovery_execution_config(&c);
        let cid = c.id.clone();
        self.recovering.insert(
            cid.clone(),
            ConnectionRecovery {
                conversation: c,
                workspace,
                connection_id: runtime.connection_id().to_string(),
            },
        );
        let sender = self.sender.clone();
        let worker_cid = cid.clone();
        if let Err(error) = thread::Builder::new()
            .name("codex-recover-conversation".into())
            .spawn(move || {
                let result = runtime.recover_conversation(config);
                let _ = sender.send(Message::Recovered {
                    conversation_id: worker_cid,
                    result,
                    reply,
                });
            })
        {
            self.recovering.remove(&cid);
            return Err(format!("无法启动会话连接恢复：{error}"));
        }
        self.dirty = true;
        Ok(())
    }

    fn finish_connection_recovery(
        &mut self,
        cid: &str,
        result: Result<(), String>,
    ) -> Result<Value, String> {
        let pending = self.recovering.remove(cid).ok_or("会话恢复请求已失效")?;
        self.dirty = true;
        result?;
        if !self
            .runtime
            .as_ref()
            .is_some_and(|rt| rt.is_alive() && rt.connection_id() == pending.connection_id)
        {
            return Err("恢复期间 Codex 连接已变化，请重试；不会重发消息".into());
        }
        let c = &pending.conversation;
        self.connection_recovery_target(
            &json!({"conversation_id":cid,"revision":c.revision,"thread_id":c.thread_id}),
        )?;
        self.repository.connection.execute(
            "UPDATE chat_conversations SET last_error=NULL,runtime_status='idle' WHERE id=?1 AND revision=?2",
            rusqlite::params![cid,c.revision]).map_err(|e|e.to_string())?;
        self.repository.connection.execute("UPDATE chat_codex_bindings SET ready=1 WHERE conversation_id=?1",[cid]).map_err(|e|e.to_string())?;
        Ok(json!({"recovered":true,"thread_id":c.thread_id}))
    }
}

#[cfg(test)]
mod connection_recovery_tests {
    use super::*;
    const THREAD: &str = "550e8400-e29b-41d4-a716-446655440000";

    #[test]
    fn service_recovers_asynchronously_without_run_or_message() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(crate::chat_store::id("connection-recovery-test"));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("fake-codex");
        std::fs::write(&executable,r#"#!/usr/bin/env python3
import json,sys
pending=None;released=False;calls=[]
def reply(m,result):print(json.dumps({'id':m['id'],'result':result}),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m:continue
 method=m['method'];calls.append(method)
 if method=='config/read':reply(m,{'config':{}})
 elif method=='thread/read':reply(m,{'thread':{'id':'550e8400-e29b-41d4-a716-446655440000','path':'/test/archived_sessions/rollout.jsonl'}})
 elif method=='thread/resume':
  if released:reply(m,{'thread':{'id':'550e8400-e29b-41d4-a716-446655440000'}})
  else:pending=m
 elif method=='model/list':
  released=True
  if pending:reply(pending,{'thread':{'id':'550e8400-e29b-41d4-a716-446655440000'}});pending=None
  reply(m,{'data':[],'calls':calls})
 elif method=='thread/goal/get':reply(m,{'goal':None})
 elif method=='turn/start':raise RuntimeError('恢复连接不能启动模型')
 else:reply(m,{})
"#).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let db = root.join("app.db");
        let repo = Repository::open_path(&db).unwrap();
        let task = repo
            .chat_create_task(&json!({"title":"隔离协议恢复"}))
            .unwrap();
        let mut c = repo.chat_create_conversation(&task, None).unwrap();
        c.config.workspace = root.to_string_lossy().into_owned();
        // 这是服务启动前的最小设置夹具；迁移仍由真实服务启动路径执行。
        repo.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS work_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
        ).unwrap();
        repo.connection.execute("UPDATE chat_conversations SET config_json=?2,thread_id=?3,last_error='连接中断',runtime_status='failed' WHERE id=?1",rusqlite::params![c.id,serde_json::to_string(&c.config).unwrap(),THREAD]).unwrap();
        repo.connection
            .execute(
                "INSERT INTO work_settings(key,value) VALUES('codex_executable',?1)",
                [executable.to_str().unwrap()],
            )
            .unwrap();
        drop(repo);
        let service = WorkService::spawn_with_path(db.clone(), Arc::new(|| {})).unwrap();
        let background = service.clone();
        let params = json!({"conversation_id":c.id,"thread_id":THREAD,"revision":c.revision});
        let recovery = thread::spawn(move || background.call("chat/recover_connection", params));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = service.call("chat/snapshot", json!({})).unwrap();
            if snapshot["conversations"][0]["runtime_status"] == "recovering" {
                break;
            }
            assert!(Instant::now() < deadline, "恢复必须异步且可读取状态");
            thread::yield_now();
        }
        assert!(service
            .call(
                "chat/send",
                json!({"conversation_id":c.id,"text":"不得发送"})
            )
            .unwrap_err()
            .contains("恢复"));
        service
            .runtime()
            .unwrap()
            .rpc_read("model/list", json!({}))
            .unwrap();
        assert_eq!(recovery.join().unwrap().unwrap()["thread_id"], THREAD);
        let calls = service
            .runtime()
            .unwrap()
            .rpc_read("model/list", json!({}))
            .unwrap();
        assert!(!calls["calls"]
            .as_array()
            .unwrap()
            .contains(&json!("turn/start")));
        service.shutdown();
        let repo = Repository::open_path(&db).unwrap();
        assert!(repo.chat_conversation(&c.id).unwrap().last_error.is_none());
        assert_eq!(
            repo.connection
                .query_row("SELECT count(*) FROM chat_runs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            repo.connection
                .query_row("SELECT count(*) FROM chat_events", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(repo);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn fixture() -> (Scheduler, Value) {
        let repository = Repository::open_in_memory().unwrap();
        let task = repository
            .chat_create_task(&json!({"title":"连接恢复"}))
            .unwrap();
        let c = repository.chat_create_conversation(&task, None).unwrap();
        repository
            .connection
            .execute(
                "UPDATE chat_conversations SET thread_id=?2 WHERE id=?1",
                rusqlite::params![c.id, THREAD],
            )
            .unwrap();
        let (sender, _receiver) = mpsc::channel();
        let scheduler = Scheduler {
            repository,
            runtime: None,
            emergency_runtime: Arc::new(Mutex::new(None)),
            executable: String::new(),
            resolved_executable: None,
            runtime_error: None,
            sender,
            live: HashMap::new(),
            recovering: HashMap::new(),
            stop_deadlines: HashMap::new(),
            changed: Arc::new(|| {}),
            last_notification: Instant::now(),
            dirty: false,
        };
        (
            scheduler,
            json!({"conversation_id":c.id,"thread_id":THREAD,"revision":c.revision}),
        )
    }

    #[test]
    fn rejects_changed_busy_closed_deleted_and_unsettled_targets() {
        let (mut scheduler, params) = fixture();
        assert!(scheduler.connection_recovery_target(&params).is_ok());
        let mut stale = params.clone();
        stale["revision"] = json!(999);
        assert!(scheduler
            .connection_recovery_target(&stale)
            .unwrap_err()
            .contains("变化"));
        stale = params.clone();
        stale["thread_id"] = json!("550e8400-e29b-41d4-a716-446655440001");
        assert!(scheduler
            .connection_recovery_target(&stale)
            .unwrap_err()
            .contains("变化"));
        let cid = params["conversation_id"].as_str().unwrap();
        for state in ["queued", "running", "needs_input", "stopping"] {
            scheduler
                .repository
                .connection
                .execute(
                    "UPDATE chat_conversations SET runtime_status=?2 WHERE id=?1",
                    rusqlite::params![cid, state],
                )
                .unwrap();
            assert!(scheduler.connection_recovery_target(&params).is_err());
        }
        scheduler
            .repository
            .connection
            .execute(
                "UPDATE chat_conversations SET runtime_status='idle',closed=1 WHERE id=?1",
                [cid],
            )
            .unwrap();
        assert!(scheduler
            .connection_recovery_target(&params)
            .unwrap_err()
            .contains("重新打开"));
        scheduler
            .repository
            .connection
            .execute("UPDATE chat_conversations SET closed=0 WHERE id=?1", [cid])
            .unwrap();
        scheduler.repository.connection.execute("INSERT INTO chat_runs(id,conversation_id,kind,status,prompt,started_at,ended_at) VALUES('extract',?1,'extract','failed','x','now','now')",[cid]).unwrap();
        scheduler.live.insert(
            "extract:extract".into(),
            LiveRun {
                run_id: "extract".into(),
                workspace: PathBuf::from("/tmp"),
            },
        );
        assert!(scheduler
            .connection_recovery_target(&params)
            .unwrap_err()
            .contains("停止确认"));
        scheduler.live.clear();
        scheduler
            .repository
            .chat_delete_conversation(cid, params["revision"].as_i64().unwrap())
            .unwrap();
        assert!(scheduler.connection_recovery_target(&params).is_err());
    }

    #[test]
    fn recovery_fences_mutations_but_leaves_reads_and_other_workspaces_available() {
        let (mut scheduler, params) = fixture();
        let c = scheduler.connection_recovery_target(&params).unwrap();
        let cid = c.id.clone();
        let tid = c.task_id.clone();
        scheduler.recovering.insert(
            cid.clone(),
            ConnectionRecovery {
                conversation: c,
                workspace: PathBuf::from("/tmp/recovery-project"),
                connection_id: "connection".into(),
            },
        );
        assert!(scheduler.check_recovery_mutation("send", &params).is_err());
        assert!(scheduler
            .check_recovery_mutation("delete_conversation", &params)
            .is_err());
        scheduler.repository.connection.execute("INSERT INTO task_results(id,task_id,conversation_id,source_boundary,method,stage,markdown,status,created_at) VALUES('failed-result',?1,?2,1,'manual','summary','','failed','now')",rusqlite::params![tid,cid]).unwrap();
        assert!(scheduler
            .chat_call("retry_extract", json!({"result_id":"failed-result"}))
            .unwrap_err()
            .contains("恢复"));
        assert_eq!(
            scheduler
                .repository
                .connection
                .query_row(
                    "SELECT status FROM task_results WHERE id='failed-result'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "failed"
        );
        assert!(scheduler
            .check_recovery_mutation("task_state", &json!({"task_id":tid}))
            .is_err());
        assert!(scheduler.check_recovery_mutation("detail", &params).is_ok());
        assert!(
            scheduler.chat_call("snapshot", json!({})).unwrap()["conversations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["id"] == cid && c["runtime_status"] == "recovering")
        );
        assert!(scheduler.workspace_busy(Path::new("/tmp/recovery-project/sub")));
        assert!(!scheduler.workspace_busy(Path::new("/tmp/other-project")));
        assert!(scheduler
            .finish_connection_recovery(&cid, Err("尚未归档".into()))
            .is_err());
        assert!(scheduler.recovering.is_empty());
        assert!(scheduler.connection_recovery_target(&params).is_ok());
    }
}

fn recovery_execution_config(c: &crate::chat_store::Conversation) -> TaskExecutionConfig {
    TaskExecutionConfig {
        task_id: if c.mode == "auto" {
            c.task_id.clone()
        } else {
            format!("chat:{}", c.id)
        },
        run_id: format!("recovery:{}", c.id),
        thread_id: c.thread_id.clone(),
        thread_name: Some(c.title.clone()),
        workspace: c.config.workspace.clone(),
        prompt: String::new(),
        model: c.config.model.clone(),
        reasoning_effort: c.config.reasoning_effort.clone(),
        approval_policy: c.config.approval_policy.clone(),
        sandbox_mode: c.config.sandbox_mode.clone(),
        instructions: Some(c.config.instructions.clone()),
        browser_enabled: c.config.browser_enabled,
    }
}
