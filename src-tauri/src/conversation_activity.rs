//! 消息活动与阅读游标独立于任务状态；每会话固定一行，不为轮询追加日志。
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Activity {
    pub activity_at: Option<String>,
    pub last_output_event_id: i64,
    pub read_output_event_id: i64,
    pub manual_unread: bool,
    pub read_version: i64,
    pub unread: bool,
}

// 只把用户消息和模型正文视为聊天活动；工具、推理和运行状态不能改变侧栏顺序。
const USER: &str = "(e.kind='user_message' OR (e.kind IN ('item/started','item/completed') AND json_extract(e.payload_json,'$.item.type')='userMessage'))";
const OUTPUT: &str = "(e.kind IN ('agent_message','assistant_message') AND COALESCE(json_extract(e.payload_json,'$.text'),json_extract(e.payload_json,'$.message'),'')<>'' OR e.kind IN ('item/agentMessage/delta','agentMessage/delta') AND COALESCE(json_extract(e.payload_json,'$.delta'),'')<>'' OR e.kind IN ('item/started','item/completed') AND json_extract(e.payload_json,'$.item.type')='agentMessage' AND COALESCE(json_extract(e.payload_json,'$.item.text'),'')<>'')";

fn projection(table: &str, owner: &str, runs: &str) -> String {
    // 子 Agent 的输出属于工具过程，不单独触发任务未读。缺 threadId 的旧事件仍可回填。
    format!("FROM {table} e JOIN chat_conversations c ON {owner}
        LEFT JOIN {runs} r ON r.id=e.run_id
        WHERE ({USER} OR {OUTPUT})
        AND (COALESCE(json_extract(e.payload_json,'$.threadId'),'')='' OR json_extract(e.payload_json,'$.threadId')=COALESCE(r.thread_id,c.thread_id))")
}

pub fn migrate(c: &Connection) -> rusqlite::Result<()> {
    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_activity')", [], |r| r.get(0))?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversation_activity(
        conversation_id TEXT PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
        activity_at TEXT, last_output_event_id INTEGER NOT NULL DEFAULT 0,
        read_output_event_id INTEGER NOT NULL DEFAULT 0,
        manual_unread INTEGER NOT NULL DEFAULT 0 CHECK(manual_unread IN (0,1)),
        read_version INTEGER NOT NULL DEFAULT 0)",
    )?;
    for (table, owner, runs) in [
        (
            "chat_events",
            "c.id=e.conversation_id AND c.mode='manual'",
            "chat_runs",
        ),
        (
            "work_events",
            "c.task_id=e.task_id AND c.mode='auto'",
            "work_runs",
        ),
    ] {
        let source = projection(table, owner, runs);
        if !exists {
            // 升级不能把所有历史回复变成未读；此基线只在附加表首次创建时建立。
            c.execute_batch(&format!("INSERT INTO conversation_activity(conversation_id,activity_at,last_output_event_id,read_output_event_id)
                SELECT c.id,MAX(e.created_at),MAX(CASE WHEN {OUTPUT} THEN e.id ELSE 0 END),MAX(CASE WHEN {OUTPUT} THEN e.id ELSE 0 END)
                {source} GROUP BY c.id"))?;
        }
        c.execute_batch(&format!(
            "CREATE TRIGGER IF NOT EXISTS activity_{table}_insert AFTER INSERT ON {table} BEGIN
            INSERT INTO conversation_activity(conversation_id,activity_at,last_output_event_id)
            SELECT c.id,e.created_at,CASE WHEN {OUTPUT} THEN e.id ELSE 0 END
            {source} AND e.id=NEW.id
            ON CONFLICT(conversation_id) DO UPDATE SET
                activity_at=MAX(COALESCE(activity_at,''),excluded.activity_at),
                last_output_event_id=MAX(last_output_event_id,excluded.last_output_event_id);
            END"
        ))?;
    }
    // 旧自动任务的逻辑会话可能在数据库迁移之后才补建，同样恢复其历史已读基线。
    let source = projection(
        "work_events",
        "c.task_id=e.task_id AND c.mode='auto'",
        "work_runs",
    );
    c.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS activity_auto_conversation_insert AFTER INSERT ON chat_conversations WHEN NEW.mode='auto' BEGIN
        INSERT INTO conversation_activity(conversation_id,activity_at,last_output_event_id,read_output_event_id)
        SELECT c.id,MAX(e.created_at),MAX(CASE WHEN {OUTPUT} THEN e.id ELSE 0 END),MAX(CASE WHEN {OUTPUT} THEN e.id ELSE 0 END)
        {source} AND c.id=NEW.id GROUP BY c.id;
        END"))?;
    Ok(())
}

pub fn load(c: &Connection, cid: &str) -> rusqlite::Result<Activity> {
    Ok(c.query_row("SELECT activity_at,last_output_event_id,read_output_event_id,manual_unread,read_version FROM conversation_activity WHERE conversation_id=?1", [cid], |r| {
        let last: i64 = r.get(1)?;
        let read: i64 = r.get(2)?;
        let manual: bool = r.get(3)?;
        Ok(Activity { activity_at:r.get(0)?,last_output_event_id:last,read_output_event_id:read,manual_unread:manual,read_version:r.get(4)?,unread:manual||last>read })
    }).optional()?.unwrap_or_default())
}

impl crate::repository::Repository {
    pub fn mark_conversation_unread(&self, cid: &str) -> Result<(), String> {
        let conversation = self.chat_conversation(cid)?;
        self.chat_require_task(&conversation.task_id)?;
        self.connection.execute("INSERT INTO conversation_activity(conversation_id,manual_unread,read_version) VALUES(?1,1,1)
            ON CONFLICT(conversation_id) DO UPDATE SET manual_unread=1,read_version=read_version+1", [cid]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn mark_conversation_read(
        &self,
        cid: &str,
        boundary: i64,
        version: i64,
    ) -> Result<(), String> {
        let conversation = self.chat_conversation(cid)?;
        self.chat_require_task(&conversation.task_id)?;
        if boundary < 0 || boundary > conversation.activity.last_output_event_id || version < 0 {
            return Err("阅读边界无效，请重新打开会话".into());
        }
        // 只确认客户端已经显示的内容。迟到确认不能越过新回复或清除后来的人工未读。
        self.connection.execute("UPDATE conversation_activity SET read_output_event_id=MAX(read_output_event_id,?2),manual_unread=0
            WHERE conversation_id=?1 AND read_version=?3", params![cid,boundary,version]).map_err(|e|e.to_string())?;
        Ok(())
    }
}
