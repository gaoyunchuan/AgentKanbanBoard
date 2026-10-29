// 原生 unified exec 的进程生命周期可能长于 Turn，不能用 turn/completed 释放目录。
// 这里只保留活动或结果不确定的占用：确认终端为空或人工核对后删除，不积累历史。
impl Repository {
    pub(crate) fn task_resources_pending(&self, tid: &str) -> Result<bool, String> {
        self.connection.query_row("SELECT EXISTS(SELECT 1 FROM work_resource_leases l WHERE l.owner=?1 OR l.run_id IN (SELECT r.id FROM chat_runs r JOIN chat_conversations c ON c.id=r.conversation_id WHERE c.task_id=?1))",[tid],|r|r.get(0)).map_err(|e|e.to_string())
    }
    pub(crate) fn resource_hold(&self, owner: &str) -> Result<Option<Value>, String> {
        self.connection.query_row(
            "SELECT run_id,state,error FROM work_resource_leases WHERE owner=?1 OR run_id IN (SELECT r.id FROM chat_runs r JOIN chat_conversations c ON c.id=r.conversation_id WHERE c.task_id=?1 OR 'chat:'||c.id=?1) ORDER BY CASE state WHEN 'uncertain' THEN 0 WHEN 'stopping' THEN 1 ELSE 2 END,created_at LIMIT 1",[owner],
            |r| Ok(json!({"run_id":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?,"error":r.get::<_,Option<String>>(2)?}))
        ).optional().map_err(|e|e.to_string())
    }
}

impl Scheduler {
    fn mark_native_stop(&self, owner: &str, run: &str) -> Result<(), String> {
        self.repository.connection.execute("UPDATE work_resource_leases SET state='stop_requested' WHERE owner=?1 AND run_id=?2 AND state='active'",rusqlite::params![owner,run]).map_err(|e|e.to_string())?;
        Ok(())
    }
    fn track_native_resources(&mut self, event: &RuntimeEvent) -> Result<(), String> {
        let (Some(owner), Some(run), Some(thread)) =
            (&event.task_id, &event.run_id, &event.thread_id)
        else {
            return Ok(());
        };
        let Some(live) = self.live.get(owner).filter(|l| &l.run_id == run) else {
            return Ok(());
        };
        if !matches!(event.method.as_str(), "item/started" | "item/completed")
            || event.params.pointer("/item/type").and_then(Value::as_str)
                != Some("commandExecution")
            || event
                .params
                .pointer("/item/processId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        {
            return Ok(());
        }
        self.repository.connection.execute(
            "INSERT OR IGNORE INTO work_resource_leases(run_id,owner,connection_id,workspace,threads_json,state,created_at) VALUES(?1,?2,?3,?4,'[]',?6,?5)",
            rusqlite::params![run,owner,event.connection_id,live.workspace.to_string_lossy(),self.repository.now_text(),if self.stop_deadlines.get(owner).is_some_and(|(id,_)|id==run){"stop_requested"}else{"active"}]
        ).map_err(|e|e.to_string())?;
        let encoded: String = self
            .repository
            .connection
            .query_row(
                "SELECT threads_json FROM work_resource_leases WHERE run_id=?1",
                [run],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut threads: Vec<String> = serde_json::from_str(&encoded).map_err(|e| e.to_string())?;
        if thread.len() > 256 {
            return Err("原生命令线程 ID 超过占用记录上限".into());
        }
        if !threads.contains(thread) {
            if threads.len() >= 256 {
                return Err("原生命令线程超过本轮占用上限，请核对执行状态".into());
            }
            threads.push(thread.clone());
            self.repository
                .connection
                .execute(
                    "UPDATE work_resource_leases SET threads_json=?2 WHERE run_id=?1",
                    rusqlite::params![
                        run,
                        serde_json::to_string(&threads).map_err(|e| e.to_string())?
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn settle_native_resources(&mut self, event: &RuntimeEvent) -> Result<bool, String> {
        if event.method != "turn/completed" {
            return Ok(false);
        }
        let (Some(owner), Some(run)) = (&event.task_id, &event.run_id) else {
            return Ok(false);
        };
        // EOF/超时后的迟到终态只能留作历史，不得重启清理或解除不确定占用。
        if !self.live.get(owner).is_some_and(|l| &l.run_id == run) {
            return Ok(false);
        }
        let Some(runtime) = self.runtime.as_ref().filter(|r| r.is_alive()) else {
            return Ok(false);
        };
        let Some(binding) = runtime.binding_snapshot(owner, run) else {
            return Ok(false);
        };
        if event.thread_id.as_deref() != Some(&binding.thread_id) {
            return Ok(false);
        }
        let row:Option<(String,String)>=self.repository.connection.query_row(
            "SELECT threads_json,state FROM work_resource_leases WHERE run_id=?1 AND owner=?2 AND connection_id=?3",rusqlite::params![run,owner,event.connection_id],|r|Ok((r.get(0)?,r.get(1)?))
        ).optional().map_err(|e|e.to_string())?;
        let Some((encoded, state)) = row else {
            return Ok(false);
        };
        if state == "uncertain" {
            return Ok(false);
        }
        if state == "stopping" {
            return Ok(true);
        }
        let explicitly_stopped = self
            .stop_deadlines
            .get(owner)
            .is_some_and(|(id, _)| id == run);
        let completed =
            event.params.pointer("/turn/status").and_then(Value::as_str) == Some("completed");
        if normal_native_completion(&state, completed, explicitly_stopped) {
            // 普通回合可以有意启动预览服务；停止修复不能悄悄杀掉这些服务。
            self.repository
                .connection
                .execute(
                    "DELETE FROM work_resource_leases WHERE run_id=?1 AND connection_id=?2",
                    rusqlite::params![run, event.connection_id],
                )
                .map_err(|e| e.to_string())?;
            return Ok(false);
        }
        let threads: Vec<String> = serde_json::from_str(&encoded).map_err(|e| e.to_string())?;
        self.repository
            .connection
            .execute(
                "UPDATE work_resource_leases SET state='stopping' WHERE run_id=?1",
                [run],
            )
            .map_err(|e| e.to_string())?;
        self.stop_deadlines.remove(owner);
        let sender = self.sender.clone();
        let runtime = runtime.clone();
        let event = event.clone();
        thread::Builder::new()
            .name("codex-settle-native-terminals".into())
            .spawn(move || {
                let result = runtime.cleanup_native_terminals(
                    event.task_id.as_deref().unwrap_or_default(),
                    event.run_id.as_deref().unwrap_or_default(),
                    &threads,
                );
                let _ = sender.send(Message::ResourcesSettled { event, result });
            })
            .map_err(|e| e.to_string())?;
        self.dirty = true;
        Ok(true)
    }

    fn resources_settled(
        &mut self,
        mut event: RuntimeEvent,
        result: Result<(), String>,
    ) -> Result<(), String> {
        let (Some(owner), Some(run)) = (&event.task_id, &event.run_id) else {
            return Ok(());
        };
        let owns = self
            .runtime
            .as_ref()
            .is_some_and(|r| r.connection_id() == event.connection_id)
            && self.live.get(owner).is_some_and(|l| &l.run_id == run);
        if !owns {
            return Ok(());
        }
        match result {
            Ok(()) => {
                self.repository
                    .connection
                    .execute(
                        "DELETE FROM work_resource_leases WHERE run_id=?1 AND connection_id=?2",
                        rusqlite::params![run, event.connection_id],
                    )
                    .map_err(|e| e.to_string())?;
            }
            Err(error) => {
                let error: String = error.chars().take(512).collect();
                self.repository.connection.execute("UPDATE work_resource_leases SET state='uncertain',error=?2 WHERE run_id=?1",rusqlite::params![run,error]).map_err(|e|e.to_string())?;
                event.params["turn"]["status"] = json!("failed");
                event.params["turn"]["error"] = json!({"message":format!("无法确认原生命令已停止，目录仍保留占用：{error}。请核对进程后解除占用。")});
                // 失败后仍保留持久占用；重试、断线和应用重启都不能绕过。
                if owner.starts_with("chat:") || owner.starts_with("extract:") {
                    self.repository.chat_finish(
                        run,
                        "failed",
                        event
                            .params
                            .pointer("/turn/error/message")
                            .and_then(Value::as_str),
                    )?;
                    self.live.remove(owner);
                    self.dirty = true;
                    return Ok(());
                }
                self.repository.finish_work_run(
                    owner,
                    run,
                    "failed",
                    event
                        .params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str),
                )?;
                self.live.remove(owner);
                self.dirty = true;
                return Ok(());
            }
        }
        // 经过目录占用核验后再交给原有完成逻辑，不能重复进入清理。
        self.runtime_event(event)
    }

    fn native_workspace_busy(&self, workspace: &Path) -> bool {
        let check = || -> Result<bool, rusqlite::Error> {
            let count: i64 = self.repository.connection.query_row(
                "SELECT COUNT(*) FROM work_resource_leases",
                [],
                |r| r.get(0),
            )?;
            // 最多两个活动执行；留出两项在途记录后停止接纳，持久占用最多 256 条。
            if count >= 254 {
                return Ok(true);
            }
            let mut statement = self
                .repository
                .connection
                .prepare("SELECT workspace FROM work_resource_leases")?;
            let paths = statement.query_map([], |r| r.get::<_, String>(0))?;
            for path in paths {
                if workspaces_overlap(Path::new(&path?), workspace) {
                    return Ok(true);
                }
            }
            Ok(false)
        };
        check().unwrap_or(true)
    }

    fn release_checked_resources(&mut self, cid: &str, run: &str) -> Result<Value, String> {
        let c = self.repository.chat_conversation(cid)?;
        let owner = if c.mode == "auto" {
            c.task_id
        } else {
            format!("chat:{cid}")
        };
        if self.live.values().any(|l| l.run_id == run) {
            return Err("执行仍在活动或停止确认中，请等待结束".into());
        }
        let changed=self.repository.connection.execute("DELETE FROM work_resource_leases WHERE run_id=?1 AND state='uncertain' AND (owner=?2 OR run_id IN (SELECT r.id FROM chat_runs r JOIN chat_conversations c ON c.id=r.conversation_id WHERE c.task_id=?2 OR 'chat:'||c.id=?2))",rusqlite::params![run,owner]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("占用已经改变，请刷新后核对".into());
        }
        self.dirty = true;
        Ok(json!({"released":true}))
    }
}

// stop_requested 与 watchdog 分离，清掉计时器不能清掉停止意图。
fn normal_native_completion(state: &str, completed: bool, stop_pending: bool) -> bool {
    state == "active" && completed && !stop_pending
}
#[cfg(test)]
mod resource_tests {
    use super::normal_native_completion;
    #[test]
    fn late_completion_cannot_clear_uncertain_or_stopped_lease_after_watchdog_is_gone() {
        assert!(!normal_native_completion("stop_requested", true, false));
        assert!(!normal_native_completion("uncertain", true, false));
        assert!(!normal_native_completion("stopping", true, false));
        assert!(normal_native_completion("active", true, false));
    }
}
