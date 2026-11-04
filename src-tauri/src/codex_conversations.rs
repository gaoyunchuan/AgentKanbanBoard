//! 外部会话只登记身份；历史保持在 Codex，写入权由用户手动归档交接。
use crate::{chat_store::Conversation, repository::Repository};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::{
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

const PAGE_SIZE: u64 = 40;
const TEXT_BYTES: usize = 16 * 1024;
static READERS: AtomicUsize = AtomicUsize::new(0);

struct ReaderSlot;
impl Drop for ReaderSlot {
    fn drop(&mut self) {
        READERS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct CodexReader {
    server: crate::app_server::AppServer,
    deadline: Instant,
    _slot: ReaderSlot,
}

impl CodexReader {
    pub fn connect(executable: &Path) -> Result<Self, String> {
        READERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .map_err(|_| "正在读取其他 Codex 历史，请稍后重试")?;
        let slot = ReaderSlot;
        // 大工具输出可超过帧上限；只读进程单独拥有传输，失败绝不能杀掉业务执行连接。
        let (server, _events) = crate::app_server::AppServer::spawn(executable)?;
        let deadline = Instant::now() + Duration::from_secs(60);
        server.initialize()?;
        Ok(Self {
            server,
            deadline,
            _slot: slot,
        })
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if !matches!(method, "thread/list" | "thread/read" | "thread/items/list") {
            return Err("只读历史连接不允许执行该操作".into());
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("读取 Codex 历史超时，请稍后重试".into());
        }
        self.server
            .request_with_timeout(method, params, remaining.min(Duration::from_secs(30)))
    }
}

impl Drop for CodexReader {
    fn drop(&mut self) {
        self.server.shutdown();
    }
}

fn cursor(value: &Value) -> Result<Option<&str>, String> {
    let cursor = value.get("cursor").and_then(Value::as_str);
    if cursor.is_some_and(|c| c.len() > 4096) {
        return Err("分页标识过长，请重新打开列表".into());
    }
    Ok(cursor)
}

fn is_subagent(thread: &Value) -> bool {
    thread["parentThreadId"].as_str().is_some()
        || crate::domain::is_subagent_source(&thread["source"].to_string())
        || thread["source"]
            .as_str()
            .is_some_and(crate::domain::is_subagent_source)
}

fn status(thread: &Value) -> &str {
    thread
        .pointer("/status/type")
        .and_then(Value::as_str)
        .or_else(|| thread["status"].as_str())
        .unwrap_or("unknown")
}

fn title(thread: &Value) -> String {
    clip(
        thread["name"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or("未命名会话"),
        1000,
    )
}

pub fn list_threads(
    value: &Value,
    request: impl FnOnce(&str, Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let query = value["query"].as_str().unwrap_or("").trim();
    if query.len() > 1000 {
        return Err("搜索内容过长".into());
    }
    let archived = value["archived"] == true;
    let response = request(
        "thread/list",
        json!({
            "limit":PAGE_SIZE,"cursor":cursor(value)?,"archived":archived,
            "searchTerm":if query.is_empty(){None}else{Some(query)},
            "sortKey":"updated_at","sortDirection":"desc","modelProviders":[],"useStateDbOnly":true
        }),
    )?;
    let rows = response["data"]
        .as_array()
        .ok_or("Codex 会话列表格式无效")?;
    let data: Vec<_> = rows
        .iter()
        .take(PAGE_SIZE as usize)
        .filter(|t| !is_subagent(t))
        .map(|t| {
            json!({
                "id":t["id"],"name":title(t),"cwd":t["cwd"],"updated_at":t["updatedAt"],
                "status":status(t),"archived":archived
            })
        })
        .collect();
    Ok(json!({"data":data,"nextCursor":response["nextCursor"]}))
}

pub fn read_thread(
    value: &Value,
    request: impl FnOnce(&str, Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let id = crate::chat_store::required(value, "thread_id")?;
    crate::deeplink::thread_deeplink(id)?;
    let response = request("thread/read", json!({"threadId":id,"includeTurns":false}))?;
    if response["thread"]["id"] != id {
        return Err("Codex 返回的会话标识不一致".into());
    }
    Ok(response["thread"].clone())
}

pub fn read_history(
    context: &Value,
    value: &Value,
    mut request: impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let response = history_response(&context["thread_id"], &json!(cursor(value)?), &mut request)?;
    let owned = context["owned_turns"]
        .as_array()
        .ok_or("历史归属信息无效")?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    history_page(&response, &owned)
}

fn history_response(
    thread: &Value,
    cursor: &Value,
    request: &mut impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let local = cursor
        .as_str()
        .is_some_and(|c| c.starts_with("akb-local-history:"));
    if !local {
        match request(
            "thread/items/list",
            json!({"threadId":thread,"cursor":cursor,"limit":PAGE_SIZE,"sortDirection":"desc"}),
        ) {
            Ok(response) => return Ok(response),
            Err(error) if error.contains("not supported") || error.contains("-32601") => {}
            Err(error) => return Err(error),
        }
    }
    local_history_page(thread, cursor, request)
}

fn local_history_page(
    thread: &Value,
    cursor: &Value,
    request: &mut impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let offset = cursor
        .as_str()
        .map(|c| {
            c.strip_prefix("akb-local-history:")
                .ok_or("本地历史分页标识无效")?
                .parse::<usize>()
                .map_err(|_| "本地历史分页标识无效")
        })
        .transpose()?
        .unwrap_or(0);
    // 旧本地后端没有分页 API；回读由独立进程的 16MiB 单帧上限约束，超限只让该阅读失败。
    let response = request(
        "thread/read",
        json!({"threadId":thread,"includeTurns":true}),
    )
    .map_err(|e| format!("读取旧本地历史失败；超大历史请在 Codex 中查看：{e}"))?;
    if &response["thread"]["id"] != thread {
        return Err("Codex 返回的历史会话标识不一致".into());
    }
    let turns = response["thread"]["turns"]
        .as_array()
        .ok_or("Codex 未提供旧本地历史，请更新 Codex 后重试")?;
    let mut rows = turns
        .iter()
        .rev()
        .flat_map(|turn| {
            turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .map(move |item| json!({"turnId":turn["id"],"item":item}))
        })
        .skip(offset);
    let data = rows.by_ref().take(PAGE_SIZE as usize).collect::<Vec<_>>();
    let next = if rows.next().is_some() {
        Some(format!(
            "akb-local-history:{}",
            offset.saturating_add(data.len())
        ))
    } else {
        None
    };
    Ok(json!({"data":data,"nextCursor":next}))
}

fn clip(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.into();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n[内容较长，请在 Codex 中查看完整记录]", &value[..end])
}

fn item_text(item: &Value) -> String {
    match item["type"].as_str().unwrap_or("") {
        "userMessage" => item["content"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|v| {
                        v["text"].as_str().map(str::to_string).unwrap_or_else(|| {
                            format!("[{}]", v["type"].as_str().unwrap_or("附件"))
                        })
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        "agentMessage" | "plan" => item["text"].as_str().unwrap_or("").into(),
        "reasoning" => item["summary"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        _ => serde_json::to_string_pretty(item).unwrap_or_default(),
    }
}

pub fn history_page(response: &Value, owned: &HashSet<String>) -> Result<Value, String> {
    let mut data = history_items(response, owned)?;
    for item in &mut data {
        item["text"] = json!(clip(item["text"].as_str().unwrap_or(""), TEXT_BYTES));
    }
    Ok(json!({"data":data,"nextCursor":response["nextCursor"]}))
}

fn history_items(response: &Value, owned: &HashSet<String>) -> Result<Vec<Value>, String> {
    let rows = response["data"]
        .as_array()
        .ok_or("Codex 历史格式无效，请更新 Codex 后重试")?;
    let mut seen = HashSet::new();
    let mut data = Vec::new();
    for row in rows.iter().take(PAGE_SIZE as usize) {
        let turn = row["turnId"].as_str().ok_or("Codex 历史缺少回合标识")?;
        let item = &row["item"];
        let id = item["id"].as_str().ok_or("Codex 历史缺少消息标识")?;
        if owned.contains(turn) || !seen.insert((turn, id)) {
            continue;
        }
        data.push(json!({"id":id,"turn_id":turn,"kind":item["type"],"text":item_text(item),"phase":item["phase"]}));
    }
    data.reverse();
    Ok(data)
}

pub fn capture_history(
    context: &Value,
    mut request: impl FnMut(&str, Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let owned = context["owned_turns"]
        .as_array()
        .ok_or("历史归属信息无效")?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let mut bytes = 0;
    // 整理是明确的模型操作，必须捕获完整来源；超出预算拒绝，不用界面截断文本冒充完整证据。
    for _ in 0..20 {
        let response = history_response(&context["thread_id"], &cursor, &mut request)?;
        let page = history_items(&response, &owned)?
            .into_iter()
            .filter(|v| seen.insert(format!("{}:{}", v["turn_id"], v["id"])))
            .collect::<Vec<_>>();
        for item in &page {
            bytes += item.to_string().len();
        }
        if bytes > 600_000 {
            return Err("原 Codex 会话过长，无法完整提取；请在原会话整理，不会静默截断来源".into());
        }
        items.splice(0..0, page);
        cursor = response["nextCursor"].clone();
        if cursor.is_null() {
            let mut snapshot = context.clone();
            snapshot["items"] = json!(items);
            return Ok(snapshot);
        }
        if !cursors.insert(cursor.to_string()) {
            return Err("Codex 历史分页未推进，请刷新后重试".into());
        }
    }
    Err("原 Codex 会话过长，超过本次完整提取的分页上限；不会遗漏较早成果后继续整理".into())
}

impl Repository {
    pub fn codex_binding(&self, cid: &str) -> Result<Option<bool>, String> {
        self.connection
            .query_row(
                "SELECT ready FROM chat_codex_bindings WHERE conversation_id=?1",
                [cid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn codex_history_context(&self, cid: &str) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        self.chat_require_task(&c.task_id)?;
        if c.codex_binding.is_none() {
            return Err("该会话没有外部 Codex 历史".into());
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT turn_id FROM chat_runs WHERE conversation_id=?1 AND turn_id IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let owned = statement
            .query_map([cid], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        let boundary: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(id),0) FROM chat_events WHERE conversation_id=?1",
                [cid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"thread_id":c.thread_id,"revision":c.revision,"local_boundary":boundary,"owned_turns":owned}),
        )
    }

    pub fn codex_extraction_context(&self, cid: &str) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        if c.codex_binding.is_none() {
            return Ok(Value::Null);
        }
        if c.codex_binding == Some(false) {
            return Err("请先完成会话交接后再提取结果".into());
        }
        if c.current_run_id.is_some() || self.chat_active_run(cid)?.is_some() {
            return Err("请等待当前执行结束后提取结果".into());
        }
        self.codex_history_context(cid)
    }

    pub fn bind_codex_conversation(
        &self,
        tid: &str,
        thread: &Value,
    ) -> Result<Conversation, String> {
        self.chat_require_task(tid)?;
        let thread_id = crate::chat_store::required(thread, "id")?;
        crate::deeplink::thread_deeplink(thread_id)?;
        if let Some(c) = self.existing_codex_binding(tid, thread_id)? {
            return Ok(c);
        }
        self.validate_codex_candidate(tid, thread)?;
        let workspace = crate::local_environment::workspace_directory(
            crate::chat_store::required(thread, "cwd")?,
        )?;
        let project = self
            .list_projects(false)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| std::fs::canonicalize(&p.path).is_ok_and(|path| path == workspace))
            .map(|p| p.id);
        let mut config = crate::workflow::TaskConfig {
            workspace: workspace.to_string_lossy().into_owned(),
            ..Default::default()
        };
        self.task_permissions(tid)?.apply(&mut config);
        let cid = crate::chat_store::id("conversation");
        let now = self.now_text();
        // 事务只登记原身份和待交接标记，不创建 run、事件或修改任务业务状态。
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        transaction.execute("INSERT INTO chat_conversations(id,task_id,title,mode,project_id,config_json,thread_id,runtime_status,created_at,updated_at) VALUES(?1,?2,?3,'manual',?4,?5,?6,'idle',?7,?7)",
            params![cid,tid,title(thread),project,serde_json::to_string(&config).map_err(|e|e.to_string())?,thread_id,now]).map_err(|e|e.to_string())?;
        transaction
            .execute(
                "INSERT INTO chat_codex_bindings(conversation_id,ready) VALUES(?1,0)",
                [&cid],
            )
            .map_err(|e| e.to_string())?;
        transaction.execute("INSERT INTO task_preferences(task_id,last_conversation_id) VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET last_conversation_id=excluded.last_conversation_id",params![tid,cid]).map_err(|e|e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        self.chat_conversation(&cid)
    }

    fn existing_codex_binding(
        &self,
        tid: &str,
        thread: &str,
    ) -> Result<Option<Conversation>, String> {
        let existing: Option<(String,String,String,bool,bool)> = self.connection.query_row(
            "SELECT c.id,c.task_id,t.title,c.deleted_at IS NOT NULL,p.archived_at IS NOT NULL FROM chat_conversations c JOIN todo_tasks t ON t.id=c.task_id LEFT JOIN work_tasks w ON w.task_id=c.task_id AND c.mode='auto' LEFT JOIN task_preferences p ON p.task_id=c.task_id WHERE COALESCE(w.thread_id,c.thread_id)=?1 LIMIT 1",[thread],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|e|e.to_string())?;
        let Some((id, owner, title, deleted, archived)) = existing else {
            return Ok(None);
        };
        if deleted || archived {
            return Err(format!(
                "会话已属于「{title}」，请先在已删除中恢复原任务或会话"
            ));
        }
        if owner != tid {
            return Err(format!(
                "会话已绑定「{title}」，请从该任务接续，不能重复绑定"
            ));
        }
        self.chat_conversation(&id).map(Some)
    }

    fn validate_codex_candidate(&self, tid: &str, thread: &Value) -> Result<(), String> {
        if is_subagent(thread) {
            return Err("子 Agent 会话不能独立绑定，请选择主会话".into());
        }
        if status(thread) == "active" {
            return Err("会话仍在 Codex 中执行，请等待结束后绑定".into());
        }
        let status: String = self
            .connection
            .query_row("SELECT status FROM todo_tasks WHERE id=?1", [tid], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        if matches!(status.as_str(), "completed" | "cancelled") {
            return Err("请先重新打开任务，再绑定会话".into());
        }
        let directory = crate::local_environment::workspace_directory(
            crate::chat_store::required(thread, "cwd")?,
        )?;
        if crate::local_environment::is_excluded(&directory, &self.project_exclusions()?) {
            return Err("原会话目录已被排除，请先调整项目排除设置".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::Repository;
    use serde_json::json;
    use std::collections::HashSet;

    const THREAD: &str = "550e8400-e29b-41d4-a716-446655440000";

    fn candidate() -> serde_json::Value {
        json!({"id":THREAD,"name":"原 Codex 会话","cwd":std::env::temp_dir(),"source":"vscode","status":{"type":"idle"},"updatedAt":1793750400})
    }

    #[test]
    fn catalog_uses_bounded_read_only_pages_and_filters_structured_subagents() {
        let result = list_threads(
            &json!({"query":"原会话","archived":true,"cursor":"page-2"}),
            |method, params| {
                assert_eq!(method, "thread/list");
                assert_eq!(params["limit"], 40);
                assert_eq!(params["searchTerm"], "原会话");
                assert_eq!(params["archived"], true);
                assert_eq!(params["cursor"], "page-2");
                let mut child = candidate();
                child["source"] = json!({"subAgent":{"thread_spawn":{"parent_thread_id":THREAD}}});
                let mut untitled = candidate();
                untitled["name"] = json!(null);
                Ok(json!({"data":[candidate(),child,untitled],"nextCursor":"page-3"}))
            },
        )
        .unwrap();
        assert_eq!(result["data"].as_array().unwrap().len(), 2);
        assert_eq!(result["nextCursor"], "page-3");
    }

    #[test]
    fn binding_is_idempotent_keeps_original_workspace_and_never_starts_a_run() {
        let repo = Repository::open_in_memory().unwrap();
        let tid = repo.chat_create_task(&json!({"title":"接续目标"})).unwrap();
        let first = repo.bind_codex_conversation(&tid, &candidate()).unwrap();
        let second = repo.bind_codex_conversation(&tid, &candidate()).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.thread_id.as_deref(), Some(THREAD));
        assert_eq!(
            first.config.workspace,
            std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
        );
        assert_eq!(first.codex_binding, Some(false));
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
        assert_eq!(repo.list_todo_tasks().unwrap()[0].status.as_str(), "todo");
        let other = repo.chat_create_task(&json!({"title":"其他任务"})).unwrap();
        assert!(repo
            .bind_codex_conversation(&other, &candidate())
            .unwrap_err()
            .contains("接续目标"));
        assert!(repo
            .chat_queue(&first.id, "不能提前发送", &[], false)
            .unwrap_err()
            .contains("交接"));
        repo.chat_delete_conversation(&first.id, first.revision)
            .unwrap();
        assert!(repo
            .bind_codex_conversation(&tid, &candidate())
            .unwrap_err()
            .contains("恢复"));
    }

    #[test]
    fn binding_rejects_subagents_active_threads_missing_directories_and_ended_tasks() {
        let repo = Repository::open_in_memory().unwrap();
        let tid = repo.chat_create_task(&json!({"title":"目标"})).unwrap();
        for patch in [
            json!({"source":{"subagent":{}}}),
            json!({"parentThreadId":"parent"}),
            json!({"status":{"type":"active"}}),
            json!({"cwd":"/does-not-exist/akb-bind"}),
        ] {
            let mut c = candidate();
            c.as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(repo.bind_codex_conversation(&tid, &c).is_err(), "{patch}");
        }
        repo.connection
            .execute(
                "UPDATE todo_tasks SET status='completed' WHERE id=?1",
                [&tid],
            )
            .unwrap();
        assert!(repo
            .bind_codex_conversation(&tid, &candidate())
            .unwrap_err()
            .contains("重新打开"));
        assert!(repo.chat_conversations().unwrap().is_empty());
    }

    #[test]
    fn history_deduplicates_item_identity_and_omits_local_turns() {
        let page = json!({"data":[
            {"turnId":"external","item":{"id":"answer","type":"agentMessage","text":"原回答"}},
            {"turnId":"local","item":{"id":"local-answer","type":"agentMessage","text":"本地已显示"}},
            {"turnId":"external","item":{"id":"answer","type":"agentMessage","text":"原回答"}},
            {"turnId":"external","item":{"id":"prompt","type":"userMessage","content":[{"type":"text","text":"原问题"}]}}
        ],"nextCursor":"older"});
        let result = history_page(&page, &HashSet::from(["local".to_string()])).unwrap();
        let data = result["data"].as_array().unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0]["text"], "原问题");
        assert_eq!(data[1]["text"], "原回答");
        assert_eq!(result["nextCursor"], "older");
    }

    #[test]
    fn service_binding_history_and_handoff_keep_original_thread_without_turns() {
        use crate::work_service::WorkService;
        use std::{os::unix::fs::PermissionsExt, sync::Arc};
        let root = std::env::temp_dir().join(crate::chat_store::id("codex-binding-service"));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("codex-fixture");
        std::fs::write(&binary,r#"#!/usr/bin/env python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
tid='550e8400-e29b-41d4-a716-446655440000'
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m:continue
 method=m['method']
 with (root/'calls').open('a') as log:log.write(method+'\n')
 t={'id':tid,'name':'隔离原会话','cwd':str(root),'source':'vscode','status':{'type':'idle'},'path':str(root/('archived_sessions' if (root/'released').exists() else 'sessions')/'rollout.jsonl')}
 if method=='config/read':result={'config':{}}
 elif method=='thread/list':result={'data':[t],'nextCursor':None}
 elif method=='thread/read':result={'thread':t}
 elif method=='thread/items/list' and (root/'oversize').exists():result={'data':[{'turnId':'old','item':{'id':'huge','type':'agentMessage','text':'x'*(17*1024*1024)}}],'nextCursor':None}
 elif method=='thread/items/list':result={'data':[{'turnId':'old','item':{'id':'original','type':'agentMessage','text':'原会话历史'}}],'nextCursor':None}
 elif method=='thread/resume' and not (root/'released').exists():
  print(json.dumps({'id':m['id'],'error':{'code':-32600,'message':'thread already has an active writer'}}),flush=True);continue
 elif method=='thread/resume':result={'thread':t}
 elif method=='thread/goal/get':result={'goal':None}
 elif method=='turn/start':raise RuntimeError('绑定和恢复不得启动业务')
 else:result={}
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = root.join("test.db");
        let repo = Repository::open_path(&path).unwrap();
        let tid = repo
            .chat_create_task(&json!({"title":"隔离接续任务"}))
            .unwrap();
        repo.connection.execute_batch("CREATE TABLE IF NOT EXISTS work_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
        repo.connection
            .execute(
                "INSERT INTO work_settings(key,value) VALUES('codex_executable',?1)",
                [binary.to_str().unwrap()],
            )
            .unwrap();
        drop(repo);
        let service = WorkService::spawn_with_path(path.clone(), Arc::new(|| {})).unwrap();
        assert_eq!(
            service.call("chat/codex_threads", json!({})).unwrap()["data"][0]["id"],
            THREAD
        );
        let c = service
            .call(
                "chat/bind_codex_thread",
                json!({"task_id":tid,"thread_id":THREAD,"codex_thread":{"cwd":"/untrusted"}}),
            )
            .unwrap();
        assert_eq!(
            c["config"]["workspace"],
            root.canonicalize().unwrap().to_str().unwrap()
        );
        assert_eq!(c["codex_binding"], false);
        let params = json!({"conversation_id":c["id"],"revision":c["revision"],"thread_id":THREAD});
        assert_eq!(
            service.call("chat/codex_history", params.clone()).unwrap()["data"][0]["text"],
            "原会话历史"
        );
        let execution = service.runtime().unwrap();
        std::fs::write(root.join("oversize"), "隔离超大历史响应").unwrap();
        assert!(service.call("chat/codex_history", params.clone()).is_err());
        std::fs::remove_file(root.join("oversize")).unwrap();
        assert!(execution.is_alive(), "只读历史超限不能断开执行连接");
        assert!(service
            .call(
                "chat/send",
                json!({"conversation_id":c["id"],"text":"不得执行"})
            )
            .unwrap_err()
            .contains("交接"));
        assert!(service
            .call("chat/recover_connection", params.clone())
            .is_err());
        assert_eq!(
            service.call("chat/detail", params.clone()).unwrap()["conversation"]["codex_binding"],
            false
        );
        service
            .runtime()
            .unwrap()
            .rpc_read("model/list", json!({}))
            .unwrap();
        std::fs::write(root.join("released"), "用户已归档的隔离夹具").unwrap();
        service
            .call("chat/recover_connection", params.clone())
            .unwrap();
        let detail = service.call("chat/detail", params).unwrap();
        assert_eq!(detail["conversation"]["codex_binding"], true);
        assert!(detail["runs"].as_array().unwrap().is_empty());
        assert!(detail["events"].as_array().unwrap().is_empty());
        let calls = std::fs::read_to_string(root.join("calls")).unwrap();
        assert!(calls.contains("thread/unarchive"));
        assert!(!calls.contains("turn/start"));
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extraction_includes_external_history_and_keeps_the_source_snapshot() {
        let repo = Repository::open_in_memory().unwrap();
        let tid = repo.chat_create_task(&json!({"title":"外部成果"})).unwrap();
        let c = repo.bind_codex_conversation(&tid, &candidate()).unwrap();
        repo.connection
            .execute(
                "UPDATE chat_codex_bindings SET ready=1 WHERE conversation_id=?1",
                [&c.id],
            )
            .unwrap();
        let snapshot = json!({"thread_id":THREAD,"revision":c.revision,"local_boundary":0,"items":[{"id":"original","turn_id":"old","kind":"agentMessage","text":"原 Codex 成果"}]});
        let run = repo
            .chat_queue_extraction_with_history(&c.id, Some(&snapshot))
            .unwrap();
        assert!(run.prompt.contains("原 Codex 成果"));
        assert!(repo
            .chat_queue_extraction_with_history(&c.id, Some(&snapshot))
            .is_err());
        assert_eq!(repo.chat_detail(&c.id).unwrap()["events"], json!([]));
    }

    #[test]
    fn extraction_rejects_oversized_sources_without_silent_text_clipping() {
        let context = json!({"thread_id":THREAD,"owned_turns":[],"revision":1,"local_boundary":0});
        let result = capture_history(&context, |method, _| {
            assert_eq!(method, "thread/items/list");
            Ok(
                json!({"data":[{"turnId":"old","item":{"id":"huge","type":"agentMessage","text":"x".repeat(610_000)}}],"nextCursor":null}),
            )
        });
        assert!(result.unwrap_err().contains("过长"));
    }

    #[test]
    fn local_history_falls_back_when_new_pagination_is_unavailable() {
        let context = json!({"thread_id":THREAD,"owned_turns":[]});
        let response=read_history(&context,&json!({}),|method,_|{
            if method=="thread/items/list" {return Err("thread/items/list is not supported yet".into());}
            assert_eq!(method,"thread/read");
            Ok(json!({"thread":{"id":THREAD,"turns":[{"id":"old","items":[{"id":"q","type":"userMessage","content":[{"type":"text","text":"旧本地问题"}]},{"id":"a","type":"agentMessage","text":"旧本地成果"}]}]}}))
        }).unwrap();
        assert_eq!(response["data"][0]["text"], "旧本地问题");
        assert_eq!(response["data"][1]["text"], "旧本地成果");
        assert!(response["nextCursor"].is_null());
    }
}
