// Included in work_service: one actor owns both managed tasks and manual chats.
impl Scheduler {
    fn chat_call(&mut self, method: &str, value: Value) -> Result<Value, String> {
        use crate::chat_store::required as req;
        match method {
            "snapshot" => {
                let mut snapshot=self.repository.chat_snapshot()?;
                snapshot["runtime"]=self.call("list",json!({}))?["runtime"].clone();
                Ok(snapshot)
            }
            "detail" => self.repository.chat_detail(req(&value,"conversation_id")?),
            "browser_owner" => {
                let c=self.repository.chat_conversation(req(&value,"conversation_id")?)?;
                Ok(json!({"key":if c.mode=="auto"{c.task_id.clone()}else{format!("chat:{}",c.id)},"enabled":c.config.browser_enabled}))
            }
            "work_action" => {
                let tid=req(&value,"task_id")?.to_string();
                let response=self.call("action",value.clone())?;
                if value["action"]=="accept" {
                    if self.chat_task_busy(&tid)? {
                        self.repository.connection.execute("UPDATE todo_tasks SET status='in_progress' WHERE id=?1",[&tid]).map_err(|e|e.to_string())?;
                        self.repository.connection.execute("UPDATE work_tasks SET status='paused',wait_reason='stopping_sessions' WHERE task_id=?1",[&tid]).map_err(|e|e.to_string())?;
                    }
                    self.chat_request_change(&tid,"completed",json!({}))?;
                }
                Ok(response)
            }
            "context" => self.repository.chat_context(req(&value,"task_id")?),
            "create_task" => {let id=self.repository.chat_create_task(&value)?;self.dirty=true;Ok(json!({"task_id":id}))}
            "update_task" => {
                self.repository.chat_update_task(req(&value,"task_id")?,&value["patch"],&value["before"])?;
                self.dirty=true;Ok(json!({"saved":true}))
            }
            "create_conversation" => {
                let result=self.repository.chat_create_conversation(req(&value,"task_id")?,value.get("project_id").and_then(Value::as_str))?;
                self.dirty=true;Ok(json!(result))
            }
            "visit" => {self.repository.chat_visit(req(&value,"conversation_id")?)?;Ok(json!({"saved":true}))}
            "config" => Ok(json!(self.repository.chat_conversation(req(&value,"conversation_id")?)?.config)),
            "update_conversation" => {
                self.repository.chat_update_conversation(req(&value,"conversation_id")?,&value["patch"],value["revision"].as_i64().ok_or("缺少会话版本")?)?;
                self.dirty=true;Ok(json!({"saved":true}))
            }
            "project" => {
                let path=canonical_workspace(req(&value,"path")?)?;
                let project=crate::domain::ProjectInput {
                    id:value.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(||crate::chat_store::id("project")),
                    name:req(&value,"name")?.trim().to_string(), path:path.to_string_lossy().into_owned(),
                    origin_url:None, aliases:Vec::new(), active:true,
                };
                let id=project.id.clone();self.repository.upsert_project(project).map_err(|e|e.to_string())?;self.dirty=true;Ok(json!({"saved":true,"id":id}))
            }
            "delegate" => {
                let task_id=req(&value,"task_id")?;
                self.repository.chat_require_task(task_id)?;
                let todo=self.repository.list_todo_tasks().map_err(|e|e.to_string())?.into_iter().find(|t|t.id==task_id).ok_or("任务不存在")?;
                let mut config=self.repository.get_work_task(task_id)?.map(|w|w.config).unwrap_or_default();
                if config.workspace.is_empty(){config.workspace=self.repository.chat_project_workspace(task_id)?;}
                config.prompt=if todo.process_tracking.trim().is_empty(){todo.title.clone()}else{todo.process_tracking};
                config.acceptance=value.get("acceptance").and_then(Value::as_str).filter(|s|!s.trim().is_empty()).map(str::to_string).unwrap_or_else(||if config.acceptance.is_empty(){"完成当前任务要求；明确说明实际验证与尚未完成事项，保留可核对的产物。".into()}else{config.acceptance.clone()});
                config.blocked_by=self.repository.chat_dependencies(task_id)?;
                config.agent_id=value.get("agent_id").and_then(Value::as_str).unwrap_or("codex").into();
                if let Some(p)=value.get("review_policy"){config.review_policy=serde_json::from_value(p.clone()).map_err(|e|e.to_string())?;}
                self.call("delegate",json!({"task_id":task_id,"config":config}))
            }
            "dependencies" => {
                let task_id=req(&value,"task_id")?;
                let blockers=strings(&value,"blocked_by")?;
                self.repository.chat_validate_dependencies(task_id,&blockers)?;
                if let Some(expected)=value.get("expected_blocked_by") {
                    if &json!(self.repository.chat_dependencies(task_id)?)!=expected{return Err("前置任务已被其他操作修改，请刷新重试".into())}
                }
                if self.chat_task_busy(task_id)? && value["confirm_stop"]!=true {
                    return Err("当前有会话在执行。请确认暂停当前执行后再保存前置任务".into())
                }
                self.chat_request_change(task_id,"dependencies",json!({"blocked_by":blockers}))?;
                Ok(json!({"saved":true,"stopping":self.chat_task_busy(task_id)?}))
            }
            "task_state" => {
                let task_id=req(&value,"task_id")?;let state=req(&value,"state")?;
                if !["completed","cancelled","reopen"].contains(&state){return Err("不支持的任务操作".into())}
                if self.chat_task_busy(task_id)?&&value["confirm_stop"]!=true{return Err("请确认停止本任务正在运行的会话".into())}
                self.chat_request_change(task_id,state,json!({}))?;Ok(json!({"saved":true}))
            }
            "delete_task" => {
                let id=req(&value,"task_id")?;
                let todos=self.repository.list_todo_tasks().map_err(|e|e.to_string())?;
                let mut ids=HashSet::from([id.to_string()]);loop{let n=ids.len();for t in &todos{if t.parent_id.as_ref().is_some_and(|p|ids.contains(p)){ids.insert(t.id.clone());}}if ids.len()==n{break}}
                for t in &todos {if !ids.contains(&t.id)&&self.repository.chat_dependencies(&t.id)?.iter().any(|d|ids.contains(d)){return Err(format!("「{}」仍依赖该子树，请先调整依赖",t.title))}}
                if ids.iter().any(|id|self.chat_task_busy(id).unwrap_or(true)){return Err("请先停止该任务及子任务的执行，再删除；已有结果与会话会保留以供恢复".into())}
                let transaction=rusqlite::Transaction::new_unchecked(&self.repository.connection,rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
                for id in ids {
                    transaction.execute("INSERT INTO task_preferences(task_id,archived_at) VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET archived_at=excluded.archived_at",rusqlite::params![id,self.repository.now_text()]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE work_tasks SET status='paused',wait_reason='archived' WHERE task_id=?1 AND status NOT IN ('completed','cancelled')",[&id]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE chat_conversations SET closed=1 WHERE task_id=?1",[&id]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE chat_runs SET status='interrupted',ended_at=?2 WHERE conversation_id IN (SELECT id FROM chat_conversations WHERE task_id=?1) AND status='queued'",rusqlite::params![id,self.repository.now_text()]).map_err(|e|e.to_string())?;
                }
                transaction.commit().map_err(|e|e.to_string())?;self.dirty=true;Ok(json!({"archived":true}))
            }
            "deleted" => {
                let mut s=self.repository.connection.prepare("SELECT t.id,t.title,t.parent_id FROM todo_tasks t JOIN task_preferences p ON p.task_id=t.id WHERE p.archived_at IS NOT NULL ORDER BY t.position").map_err(|e|e.to_string())?;
                let rows=s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"parent_id":r.get::<_,Option<String>>(2)?}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;Ok(json!(rows))
            }
            "restore" => {
                let id=req(&value,"task_id")?;
                self.repository.connection.execute("WITH RECURSIVE parents(id) AS (SELECT ?1 UNION SELECT t.parent_id FROM todo_tasks t JOIN parents p ON t.id=p.id WHERE t.parent_id IS NOT NULL) UPDATE task_preferences SET archived_at=NULL WHERE task_id IN (SELECT id FROM parents)",[id]).map_err(|e|e.to_string())?;
                self.repository.connection.execute("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT t.id FROM todo_tasks t JOIN tree p ON t.parent_id=p.id) UPDATE task_preferences SET archived_at=NULL WHERE task_id IN (SELECT id FROM tree)",[id]).map_err(|e|e.to_string())?;
                self.dirty=true;Ok(json!({"restored":true}))
            }
            "send" => {
                let cid=req(&value,"conversation_id")?;let c=self.repository.chat_conversation(cid)?;
                self.repository.chat_require_task(&c.task_id)?;
                let text=value.get("text").and_then(Value::as_str).unwrap_or("");
                let attachments=value.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
                if c.mode=="auto" {
                    return self.call("message",json!({"task_id":c.task_id,"text":text,"expected_run_id":value["expected_run_id"],"attachments":attachments}));
                }
                if let Some(active)=self.repository.chat_active_run(cid)? {
                    if active.kind!="chat"||active.status!="running"||value.get("expected_run_id").and_then(Value::as_str)!=Some(active.id.as_str()) {return Err("会话执行已变化，请等待同步后发送；草稿会保留".into())}
                    let pending:bool=self.repository.connection.query_row("SELECT EXISTS(SELECT 1 FROM chat_requests WHERE run_id=?1 AND status='pending')",[&active.id],|r|r.get(0)).map_err(|e|e.to_string())?;
                    if pending{return Err("请先处理当前会话的确认请求".into())}
                    self.runtime.as_ref().ok_or("Codex 未连接")?.send_message(&format!("chat:{cid}"),&active.id,text,attachments.clone())?;
                    self.repository.chat_event(cid,Some(&active.id),"user_message",&json!({"text":text,"attachments":attachments}))?;
                    self.dirty=true;return Ok(json!({"sent":true}));
                }
                let run=self.repository.chat_queue(cid,text,&attachments,value["import_context"]==true)?;
                self.runtime_error=None;self.dirty=true;Ok(json!(run))
            }
            "stop" => {
                let cid=req(&value,"conversation_id")?;let c=self.repository.chat_conversation(cid)?;
                if c.mode=="auto" {let w=self.repository.get_work_task(&c.task_id)?.ok_or("任务尚未委派")?;self.call("action",json!({"task_id":c.task_id,"action":"pause","expected_revision":w.revision}))?;}
                self.chat_stop(cid)?;self.dirty=true;Ok(json!({"stopping":true}))
            }
            "close_conversation" => {
                let cid=req(&value,"conversation_id")?;let c=self.repository.chat_conversation(cid)?;
                if c.mode=="auto" {let w=self.repository.get_work_task(&c.task_id)?.ok_or("任务尚未委派")?;if !matches!(w.status,WorkflowStatus::Completed|WorkflowStatus::Cancelled){self.call("action",json!({"task_id":c.task_id,"action":"pause","expected_revision":w.revision}))?;}}
                self.chat_stop(cid)?;
                self.repository.connection.execute("UPDATE chat_conversations SET closed=1,revision=revision+1 WHERE id=?1",[cid]).map_err(|e|e.to_string())?;
                self.dirty=true;Ok(json!({"closed":true}))
            }
            "reopen_conversation" => {
                let cid=req(&value,"conversation_id")?;let c=self.repository.chat_conversation(cid)?;
                let status:String=self.repository.connection.query_row("SELECT status FROM todo_tasks WHERE id=?1",[c.task_id],|r|r.get(0)).map_err(|e|e.to_string())?;
                if ["completed","cancelled"].contains(&status.as_str()){return Err("请先重新打开关联任务".into())}
                self.repository.connection.execute("UPDATE chat_conversations SET closed=0,revision=revision+1 WHERE id=?1",[cid]).map_err(|e|e.to_string())?;self.dirty=true;Ok(json!({"saved":true}))
            }
            "extract" => {let run=self.repository.chat_queue_extraction(req(&value,"conversation_id")?)?;self.runtime_error=None;self.dirty=true;Ok(json!(run))}
            "retry_extract" => {
                let rid=req(&value,"result_id")?;
                let mut run:crate::chat_store::ChatRun={let mut s=self.repository.connection.prepare("SELECT id FROM chat_runs WHERE result_id=?1 ORDER BY started_at DESC LIMIT 1").map_err(|e|e.to_string())?;let id:String=s.query_row([rid],|r|r.get(0)).map_err(|e|e.to_string())?;self.repository.chat_run(&id)?};
                let state:String=self.repository.connection.query_row("SELECT status FROM task_results WHERE id=?1",[rid],|r|r.get(0)).map_err(|e|e.to_string())?;
                if state!="failed"{return Err("只有整理失败的结果可以重试".into())}
                if self.repository.chat_active_run(&run.conversation_id)?.is_some(){return Err("请等待当前会话执行结束".into())}
                run.id=crate::chat_store::id("extract");
                let transaction=rusqlite::Transaction::new_unchecked(&self.repository.connection,rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
                transaction.execute("INSERT INTO chat_runs(id,conversation_id,kind,status,prompt,started_at,source_boundary,result_id,context_json) VALUES(?1,?2,'extract','queued',?3,?4,?5,?6,?7)",rusqlite::params![run.id,run.conversation_id,run.prompt,self.repository.now_text(),run.source_boundary,rid,run.context.as_ref().map(Value::to_string)]).map_err(|e|e.to_string())?;
                transaction.execute("UPDATE task_results SET status='pending',error=NULL WHERE id=?1",[rid]).map_err(|e|e.to_string())?;
                transaction.commit().map_err(|e|e.to_string())?;self.runtime_error=None;self.dirty=true;Ok(json!({"queued":true}))
            }
            "withdraw_result" => {
                let id=req(&value,"result_id")?;
                let (task,usable):(String,bool)=self.repository.connection.query_row("SELECT task_id,usable FROM task_results WHERE id=?1 AND status='ready'",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
                let used:bool=self.repository.connection.query_row("SELECT EXISTS(SELECT 1 FROM work_dependencies d JOIN work_runs r ON r.task_id=d.task_id WHERE d.blocked_by=?1)",[&task],|r|r.get(0)).map_err(|e|e.to_string())?;
                if usable&&used{return Err("该结果已用于后续交接，不能撤销来源；请新增修订结果".into())}
                self.repository.connection.execute("UPDATE task_results SET status='withdrawn',usable=0 WHERE id=?1",[id]).map_err(|e|e.to_string())?;self.dirty=true;Ok(json!({"withdrawn":true}))
            }
            "respond" => {
                let cid=req(&value,"conversation_id")?;let c=self.repository.chat_conversation(cid)?;
                if c.mode=="auto" {return self.call("respond",json!({"task_id":c.task_id,"interaction_id":value["interaction_id"],"run_id":value["run_id"],"response":value["response"]}));}
                let request=req(&value,"interaction_id")?;let run_id=req(&value,"run_id")?;
                let run=self.repository.chat_run(run_id)?;
                if run.conversation_id!=cid||run.ended_at.is_some()||run.status!="running"{return Err("请求已失效，不能批准旧执行".into())}
                let (wire,method,payload):(String,String,String)=self.repository.connection.query_row("SELECT request_id_json,method,payload_json FROM chat_requests WHERE id=?1 AND conversation_id=?2 AND run_id=?3 AND status='pending'",rusqlite::params![request,cid,run_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
                let payload:Value=serde_json::from_str(&payload).map_err(|e|e.to_string())?;
                validate_human_response(&method,&payload,&value["response"])?;
                self.repository.connection.execute("UPDATE chat_requests SET status='resolved',response_json=?2 WHERE id=?1 AND status='pending'",rusqlite::params![request,value["response"].to_string()]).map_err(|e|e.to_string())?;
                let runtime=self.runtime.as_ref().ok_or("Codex 已断开")?;
                if let Err(e)=runtime.respond_to_request(&format!("chat:{cid}"),run_id,serde_json::from_str(&wire).map_err(|e|e.to_string())?,value["response"].clone()) {runtime.shutdown();return Err(e)}
                self.repository.connection.execute("UPDATE chat_conversations SET runtime_status='running' WHERE id=?1 AND current_run_id=?2",rusqlite::params![cid,run_id]).map_err(|e|e.to_string())?;
                self.dirty=true;Ok(json!({"responded":true}))
            }
            _ => Err("未知会话操作".into()),
        }
    }
    fn chat_task_busy(&self,tid:&str)->Result<bool,String>{
        if self.live.contains_key(tid){return Ok(true)}
        for c in self.repository.chat_conversations()?.into_iter().filter(|c|c.task_id==tid){
            if self.live.contains_key(&format!("chat:{}",c.id))||self.repository.chat_active_run(&c.id)?.is_some_and(|r|self.live.contains_key(&format!("extract:{}",r.id))){return Ok(true)}
        }
        Ok(false)
    }
    fn chat_stop(&mut self,cid:&str)->Result<(),String>{
        if let Some(run)=self.repository.chat_active_run(cid)? {
            if run.status=="queued"{self.repository.chat_finish(&run.id,"interrupted",None)?;}
            else {
                self.repository.connection.execute("UPDATE chat_runs SET status='stopping' WHERE id=?1 AND ended_at IS NULL",[&run.id]).map_err(|e|e.to_string())?;
                self.repository.connection.execute("UPDATE chat_requests SET status='expired' WHERE run_id=?1 AND status='pending'",[&run.id]).map_err(|e|e.to_string())?;
                self.repository.connection.execute("UPDATE chat_conversations SET runtime_status='stopping' WHERE id=?1 AND current_run_id=?2",rusqlite::params![cid,run.id]).map_err(|e|e.to_string())?;
                let key=if run.kind=="extract"{format!("extract:{}",run.id)}else{format!("chat:{cid}")};
                self.stop_deadlines.insert(key.clone(),(run.id.clone(),Instant::now()+Duration::from_secs(15)));
                if let Some(rt)=&self.runtime {if let Err(e)=rt.interrupt(&key,&run.id){rt.shutdown();self.runtime_error=Some(e);}}
            }
        }
        Ok(())
    }
    fn chat_request_change(&mut self,tid:&str,kind:&str,payload:Value)->Result<(),String>{
        self.repository.chat_require_task(tid)?;
        let pending:bool=self.repository.connection.query_row("SELECT EXISTS(SELECT 1 FROM chat_pending_changes WHERE task_id=?1)",[tid],|r|r.get(0)).map_err(|e|e.to_string())?;
        if pending{return Err("此任务仍在确认停止并应用上次变更，请等待完成".into())}
        let status:Option<String>=self.repository.get_work_task(tid)?.map(|w|w.status.as_str().to_string());
        let mut payload=payload;payload["previous_status"]=json!(status);
        self.repository.connection.execute("INSERT INTO chat_pending_changes(task_id,kind,payload_json,created_at) VALUES(?1,?2,?3,?4) ",rusqlite::params![tid,kind,payload.to_string(),self.repository.now_text()]).map_err(|e|e.to_string())?;
        if let Some(w)=self.repository.get_work_task(tid)? {
            if !matches!(w.status,WorkflowStatus::Completed|WorkflowStatus::Cancelled|WorkflowStatus::Paused){self.call("action",json!({"task_id":tid,"action":"pause","expected_revision":w.revision}))?;}
        }
        let ids:Vec<_>=self.repository.chat_conversations()?.into_iter().filter(|c|c.task_id==tid).map(|c|c.id).collect();
        for cid in ids {self.chat_stop(&cid)?;}
        self.chat_apply_changes()?;self.dirty=true;Ok(())
    }
    fn chat_apply_changes(&mut self)->Result<(),String>{
        let changes={let mut s=self.repository.connection.prepare("SELECT task_id,kind,payload_json FROM chat_pending_changes").map_err(|e|e.to_string())?;let rows=s.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;rows};
        for (tid,kind,payload) in changes {
            if self.chat_task_busy(&tid)?{continue}
            let payload:Value=serde_json::from_str(&payload).map_err(|e|e.to_string())?;
            if kind=="dependencies" {
                self.repository.chat_set_dependencies(&tid,&strings(&payload,"blocked_by")?)?;
                if self.runtime_error.is_none()&&matches!(payload["previous_status"].as_str(),Some("queued"|"running"|"waiting")) {
                    if let Some(w)=self.repository.get_work_task(&tid)? {self.repository.apply_task_action(&tid,TaskAction::Resume,w.revision,None)?;}
                }
            } else {
                let now=current_chat_time(&self.repository);
                let transaction=rusqlite::Transaction::new_unchecked(&self.repository.connection,rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
                if kind=="reopen" {
                    transaction.execute("UPDATE todo_tasks SET status='todo',actual_end_date=NULL,updated_at=?2,activity_at=?2 WHERE id=?1",rusqlite::params![tid,now]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE work_tasks SET status='queued',wait_reason=NULL,last_error=NULL,continuation_count=0,result_summary=NULL,generation=generation+1,revision=revision+1 WHERE task_id=?1",[&tid]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE task_results SET usable=0,error=COALESCE(error,'任务重新打开：保留为历史结果') WHERE task_id=?1",[&tid]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE chat_conversations SET closed=0 WHERE id=COALESCE((SELECT id FROM chat_conversations WHERE task_id=?1 AND mode='auto'),(SELECT id FROM chat_conversations WHERE task_id=?1 ORDER BY created_at LIMIT 1))",[&tid]).map_err(|e|e.to_string())?;
                } else {
                    transaction.execute("UPDATE todo_tasks SET status=?2,actual_end_date=date(?3,'localtime'),updated_at=?3,activity_at=?3 WHERE id=?1",rusqlite::params![tid,kind,now]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE work_tasks SET status=?2,current_run_id=NULL,wait_reason=NULL,generation=generation+1,revision=revision+1 WHERE task_id=?1",rusqlite::params![tid,kind]).map_err(|e|e.to_string())?;
                    transaction.execute("UPDATE chat_conversations SET closed=1,revision=revision+1 WHERE task_id=?1",[&tid]).map_err(|e|e.to_string())?;
                    if kind=="completed"{crate::chat_store::accept_results(&transaction,&tid)?;}
                }
                transaction.commit().map_err(|e|e.to_string())?;
            }
            self.repository.connection.execute("DELETE FROM chat_pending_changes WHERE task_id=?1",[tid]).map_err(|e|e.to_string())?;
            self.dirty=true;
        }
        Ok(())
    }
    fn schedule_chats(&mut self)->Result<(),String>{
        self.chat_apply_changes()?;
        if self.runtime_error.is_some(){return Ok(())}
        for run in self.repository.chat_pending_runs()? {
            if self.live.len()>=MAX_CONCURRENT_TASKS{break}
            let c=self.repository.chat_conversation(&run.conversation_id)?;
            if self.repository.chat_require_task(&c.task_id).is_err(){self.repository.chat_finish(&run.id,"interrupted",Some("任务已删除，执行不再启动"))?;continue}
            if run.kind=="chat" && (c.closed||!self.repository.chat_missing_dependencies(&c.task_id)?.is_empty()){continue}
            let workspace=match canonical_workspace(&c.config.workspace){Ok(p)=>p,Err(e)=>{self.repository.chat_finish(&run.id,"failed",Some(&e))?;self.dirty=true;continue}};
            if self.workspace_busy(&workspace){continue}
            let runtime=match self.connect(None){Ok(r)=>r,Err(e)=>{self.repository.chat_finish(&run.id,"failed",Some(&e))?;break}};
            let run=self.repository.chat_claim(&run.id)?;
            let key=if run.kind=="extract"{format!("extract:{}",run.id)}else{format!("chat:{}",c.id)};
            let config=TaskExecutionConfig{task_id:key.clone(),run_id:run.id.clone(),thread_id:if run.kind=="extract"{None}else{c.thread_id},workspace:c.config.workspace,
                prompt:run.prompt,model:c.config.model,reasoning_effort:c.config.reasoning_effort,
                approval_policy:if run.kind=="extract"{"untrusted".into()}else{c.config.approval_policy},sandbox_mode:if run.kind=="extract"{"read-only".into()}else{c.config.sandbox_mode},
                instructions:Some(c.config.instructions),browser_enabled:run.kind!="extract"&&c.config.browser_enabled};
            self.live.insert(key.clone(),LiveRun{run_id:run.id.clone(),workspace});self.dirty=true;
            let sender=self.sender.clone();let rid=run.id.clone();let worker_key=key.clone();
            if let Err(e)=thread::Builder::new().name("codex-start-conversation".into()).spawn(move||{
                let result=runtime.start_task_with_attachments(config,run.attachments);
                let known=runtime.binding_snapshot(&worker_key,&rid);
                let _=sender.send(Message::Started{task_id:worker_key,run_id:rid,result,known});
            }) {self.live.remove(&key);self.repository.chat_finish(&run.id,"failed",Some(&e.to_string()))?;}
        }
        Ok(())
    }
    fn chat_started(&mut self,key:&str,run_id:&str,result:Result<StartedTask,String>,known:Option<StartedTask>)->Result<(),String>{
        let run=self.repository.chat_run(run_id)?;
        match result {
            Ok(started) if run.ended_at.is_none()&&run.status!="stopping"=>self.repository.chat_bind(run_id,&started.thread_id,started.turn_id.as_deref())?,
            Ok(_)=>{if self.live.get(key).is_some_and(|live|live.run_id==run_id){if let Some(rt)=&self.runtime{if let Err(e)=rt.interrupt(key,run_id){rt.shutdown();self.runtime_error=Some(e)}}}},
            Err(e)=>{if let Some(k)=known{self.repository.chat_bind(run_id,&k.thread_id,k.turn_id.as_deref())?;}self.repository.chat_finish(run_id,"failed",Some(&e))?;if self.live.get(key).is_some_and(|l|l.run_id==run_id){self.live.remove(key);}}
        }
        self.dirty=true;Ok(())
    }
    fn chat_runtime_event(&mut self,event:&RuntimeEvent)->Result<(),String>{
        let Some(rid)=event.run_id.as_deref() else{return Ok(())};
        let run=match self.repository.chat_run(rid){Ok(r)=>r,Err(_)=>return Ok(())};
        let key=event.task_id.as_deref().ok_or("缺少运行归属")?;
        if run.ended_at.is_some(){
            if event.method=="runtime/disconnected" || (event.method=="turn/completed" && run.thread_id==event.thread_id) {
                if self.live.get(key).is_some_and(|l|l.run_id==rid){self.live.remove(key);}
                self.dirty=true;
            }
            return Ok(())
        }
        let root=run.thread_id.is_none()||run.thread_id==event.thread_id;
        if event.method=="runtime/disconnected" {
            self.repository.chat_finish(rid,"failed",Some("连接中断，执行效果需要核对；不会自动重放"))?;
            if self.live.get(key).is_some_and(|l|l.run_id==rid){self.live.remove(key);}self.dirty=true;return Ok(())
        }
        if root&&(event.method=="runtime/thread/bound"||event.method=="turn/started") {
            if let Some(thread_id)=&event.thread_id{self.repository.chat_bind(rid,thread_id,event.turn_id.as_deref())?;}
        }
        if event.method=="turn/completed"&&root {
            let status=if run.status=="stopping"{"interrupted"}else{event.params.pointer("/turn/status").and_then(Value::as_str).unwrap_or("failed")};
            self.repository.chat_finish(rid,status,event.params.pointer("/turn/error/message").and_then(Value::as_str))?;
            if self.live.get(key).is_some_and(|l|l.run_id==rid){self.live.remove(key);}
            self.dirty=true;return Ok(())
        }
        if run.status=="stopping" {return Ok(())}
        if run.kind=="extract" {
            if event.request_id.is_some()||is_meaningful_work(&event.method,&event.params){
                self.repository.chat_finish(rid,"failed",Some("整理过程尝试调用工具，已拒绝；请重试只读整理"))?;
                if let Some(rt)=&self.runtime{let _=rt.interrupt(key,rid);}
                self.dirty=true;return Ok(())
            }
            if event.method=="item/agentMessage/delta" {
                if let Some(text)=event.params.get("delta").and_then(Value::as_str){self.repository.connection.execute("UPDATE chat_runs SET output=output||?2 WHERE id=?1 AND ended_at IS NULL",rusqlite::params![rid,text]).map_err(|e|e.to_string())?;}
            } else if event.method=="item/completed"&&event.params.pointer("/item/type").and_then(Value::as_str)==Some("agentMessage") {
                if let Some(text)=event.params.pointer("/item/text").and_then(Value::as_str){self.repository.connection.execute("UPDATE chat_runs SET output=?2 WHERE id=?1 AND ended_at IS NULL",rusqlite::params![rid,text]).map_err(|e|e.to_string())?;}
            }
            self.dirty=true;return Ok(())
        }
        if let Some(wire)=&event.request_id {
            let supported=matches!(event.method.as_str(),"item/commandExecution/requestApproval"|"item/fileChange/requestApproval"|"item/permissions/requestApproval"|"item/tool/requestUserInput"|"mcpServer/elicitation/request");
            if !supported {self.repository.chat_finish(rid,"failed",Some("会话收到尚未支持的请求，执行已停止"))?;if let Some(rt)=&self.runtime{rt.shutdown();}return Ok(())}
            self.repository.connection.execute("INSERT OR IGNORE INTO chat_requests(id,conversation_id,run_id,request_id_json,method,payload_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",rusqlite::params![crate::chat_store::id("request"),run.conversation_id,rid,wire.to_string(),event.method,event.params.to_string(),self.repository.now_text()]).map_err(|e|e.to_string())?;
            self.repository.connection.execute("UPDATE chat_conversations SET runtime_status='needs_input' WHERE id=?1 AND current_run_id=?2",rusqlite::params![run.conversation_id,rid]).map_err(|e|e.to_string())?;
        }
        if event.method=="serverRequest/resolved" {if let Some(wire)=event.params.get("requestId") {self.repository.connection.execute("UPDATE chat_requests SET status='expired' WHERE run_id=?1 AND request_id_json=?2 AND status='pending'",rusqlite::params![rid,wire.to_string()]).map_err(|e|e.to_string())?;}}
        if event.method=="serverRequest/resolved" {
            let remaining:bool=self.repository.connection.query_row("SELECT EXISTS(SELECT 1 FROM chat_requests WHERE run_id=?1 AND status='pending')",[rid],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !remaining {self.repository.connection.execute("UPDATE chat_conversations SET runtime_status='running' WHERE id=?1 AND current_run_id=?2",rusqlite::params![run.conversation_id,rid]).map_err(|e|e.to_string())?;}
        }
        // User input is already recorded at send time, including its attachment snapshot.
        // Native userMessage items are echoes, not a second user message.
        if !matches!(event.method.as_str(),"item/started"|"item/completed") || event.params.pointer("/item/type").and_then(Value::as_str)!=Some("userMessage") {
            self.repository.chat_event(&run.conversation_id,Some(rid),&event.method,&event.params)?;
        }
        self.dirty=true;Ok(())
    }
}
fn current_chat_time(repository:&Repository)->String{repository.now_text()}
