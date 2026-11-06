// 只读投影。原始事件保留在原表，列表和正文读取使用各自的预算。
use crate::{chat_store::Conversation, repository::Repository};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const PAGE_ROWS: usize = 96;
const PAGE_BYTES: usize = 768 * 1024;
const INLINE_BYTES: usize = 16 * 1024;
const CHUNK_CHARS: usize = 32 * 1024;

const IMAGE_SLOTS: u64 = 16;
// 输入框单张附件 4,000,000 字节，Base64 后约 5,333,336 字节。
const IMAGE_URL_BYTES: usize = 5_400_000;
const USER_IMAGE_PARTS: &str = "CASE
    WHEN e.kind='user_message' THEN json_extract(e.payload_json,'$.attachments')
    WHEN e.kind IN ('item/started','item/completed')
         AND COALESCE(json_extract(e.payload_json,'$.params.item.type'),json_extract(e.payload_json,'$.item.type'))='userMessage'
         THEN COALESCE(json_extract(e.payload_json,'$.params.item.content'),json_extract(e.payload_json,'$.item.content'))
    ELSE NULL END";

// 生图结果是同一会话的图片来源，历史页只返回索引，读取时仍校验会话归属与大小。
const GENERATED_IMAGE_RESULT: &str = "CASE WHEN e.kind='item/completed'
    AND COALESCE(json_extract(e.payload_json,'$.params.item.type'),json_extract(e.payload_json,'$.item.type'))='imageGeneration'
    AND COALESCE(json_extract(e.payload_json,'$.params.item.status'),json_extract(e.payload_json,'$.item.status'))='completed'
    THEN COALESCE(json_extract(e.payload_json,'$.params.item.result'),json_extract(e.payload_json,'$.item.result'))
    END";

fn image_url_sql(part: &str) -> String {
    format!("CASE WHEN json_type({part})='object' AND
        json_extract({part},'$.type') IN ('image','inputImage','input_image','localImage','local_image')
        THEN COALESCE(json_extract({part},'$.url'),json_extract({part},'$.imageUrl'),json_extract({part},'$.image_url'))
        END")
}

fn is_inline_image_url(url: &str) -> bool {
    let Some((prefix, data)) = url.split_once(',') else {
        return false;
    };
    if !matches!(
        prefix,
        "data:image/png;base64"
            | "data:image/jpeg;base64"
            | "data:image/webp;base64"
            | "data:image/gif;base64"
    ) {
        return false;
    }
    let body = data.trim_end_matches('=');
    !body.is_empty()
        && data.len() - body.len() <= 2
        && body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

fn db(error: rusqlite::Error) -> String {
    error.to_string()
}

struct HistorySource<'a> {
    events: &'static str,
    owner: &'static str,
    runs: &'static str,
    key: &'a str,
}

impl<'a> HistorySource<'a> {
    fn for_conversation(c: &'a Conversation) -> Self {
        if c.mode == "auto" {
            Self {
                events: "work_events",
                owner: "task_id",
                runs: "work_runs",
                key: &c.task_id,
            }
        } else {
            Self {
                events: "chat_events",
                owner: "conversation_id",
                runs: "chat_runs",
                key: &c.id,
            }
        }
    }
}

impl Repository {
    pub fn conversation_history(&self, cid: &str, request: &Value) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        let source = HistorySource::for_conversation(&c);
        let before = request["before"].as_i64().unwrap_or(i64::MAX);
        let after = request["after"].as_i64();
        let order = if after.is_some() { "ASC" } else { "DESC" };
        // 已结束的回答使用 item/completed 正文。旧页不能把增量尾巴再当成一条回答。
        // 搜索和原文入口仍可访问所有原始事件。
        let projection = if request["transcript"] == true {
            format!("AND (e.kind IN ('user_message','agent_message','assistant_message','message',
                      'turn/started','turn/completed','item/completed','question_answered')
                  OR (e.kind='task_action' AND json_extract(e.payload_json,'$.action')='rework'
                      AND length(trim(json_extract(e.payload_json,'$.feedback')))>0)
                  OR (e.kind='interaction_resolved' AND json_type(e.payload_json,'$.response.answers')='object')
                  OR (e.kind='item/started' AND COALESCE(json_extract(e.payload_json,'$.item.type'),
                      json_extract(e.payload_json,'$.params.item.type'))='contextCompaction')
                  OR ((e.kind='item/started' OR e.kind LIKE 'item/%/delta' OR e.kind LIKE 'item/reasoning/%Delta')
                      AND EXISTS (SELECT 1 FROM {} r WHERE r.id=e.run_id AND r.ended_at IS NULL)))", source.runs)
        } else {
            String::new()
        };
        let image_slot_url =
            image_url_sql("CASE WHEN part.type='object' THEN part.value ELSE 'null' END");
        let sql = format!(
            "SELECT id,run_id,kind,created_at,length(CAST(payload_json AS BLOB)),
                CASE WHEN length(CAST(payload_json AS BLOB)) <= ?4 THEN payload_json
                     ELSE json_object(
                        'preview',substr(COALESCE(
                            json_extract(payload_json,'$.params.item.aggregatedOutput'),
                            json_extract(payload_json,'$.item.aggregatedOutput'),
                            json_extract(payload_json,'$.params.item.text'),
                            json_extract(payload_json,'$.item.text'),
                            json_extract(payload_json,'$.params.item.content[0].text'),
                            json_extract(payload_json,'$.item.content[0].text'),
                            json_extract(payload_json,'$.text'),
                            json_extract(payload_json,'$.feedback'),
                            json_extract(payload_json,'$.response.text'),
                            json_extract(payload_json,'$.params.delta'),
                            json_extract(payload_json,'$.delta'),
                            '此记录包含较大的输出或附件。'),1,2048),
                        'item_type',COALESCE(json_extract(payload_json,'$.params.item.type'),json_extract(payload_json,'$.item.type')),
                        'item_id',COALESCE(json_extract(payload_json,'$.params.item.id'),json_extract(payload_json,'$.item.id')),
                        'image_slots',json(CASE WHEN length({GENERATED_IMAGE_RESULT})>0 THEN '[0]'
                           ELSE (SELECT json_group_array(slot) FROM
                           (SELECT part.key AS slot FROM json_each({USER_IMAGE_PARTS}) part
                            WHERE typeof(part.key)='integer' AND part.key BETWEEN 0 AND {IMAGE_SLOTS}-1
                              AND {image_slot_url} LIKE 'data:image/%;base64,%' ORDER BY part.key)) END),
                        'phase',COALESCE(json_extract(payload_json,'$.params.item.phase'),json_extract(payload_json,'$.item.phase')),
                        'threadId',COALESCE(json_extract(payload_json,'$.params.threadId'),json_extract(payload_json,'$.threadId')),
                        'turnId',COALESCE(json_extract(payload_json,'$.params.turnId'),json_extract(payload_json,'$.turnId'))
                     ) END
             FROM {} e WHERE {}=?1 AND id<?2 AND id>?3 {projection} ORDER BY id {} LIMIT ?5",
            source.events, source.owner, order
        );
        let mut statement = self.connection.prepare(&sql).map_err(db)?;
        let mut rows = statement
            .query(params![
                source.key,
                before,
                after.unwrap_or(0),
                INLINE_BYTES,
                PAGE_ROWS + 1
            ])
            .map_err(db)?;
        let mut events = Vec::new();
        let mut used = 0;
        let mut more = false;
        let mut run_ids = BTreeSet::new();
        while let Some(row) = rows.next().map_err(db)? {
            if events.len() == PAGE_ROWS {
                more = true;
                break;
            }
            let size: usize = row.get(4).map_err(db)?;
            let raw: String = row.get(5).map_err(db)?;
            let run: Option<String> = row.get(1).map_err(db)?;
            let truncated = size > INLINE_BYTES;
            let mut payload: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if truncated {
                payload["bytes"] = json!(size);
            }
            let event = json!({
                "id":row.get::<_, i64>(0).map_err(db)?,"task_id":c.task_id,"run_id":run,
                "kind":row.get::<_, String>(2).map_err(db)?,"created_at":row.get::<_, String>(3).map_err(db)?,
                "payload":payload,"truncated":truncated
            });
            used += event.to_string().len() + 1;
            if used > PAGE_BYTES {
                more = true;
                break;
            }
            run_ids.extend(run);
            events.push(event);
        }
        if after.is_none() {
            events.reverse();
        }
        let runs = self.history_runs(&source, run_ids)?;
        let older = if after.is_none() { more } else { false };
        Ok(json!({"events":events,"runs":runs,"older":older,"more":more}))
    }

    fn history_runs(
        &self,
        source: &HistorySource<'_>,
        ids: BTreeSet<String>,
    ) -> Result<Vec<Value>, String> {
        let sql = format!(
            "SELECT id,thread_id,turn_id,status,started_at,ended_at FROM {} WHERE id=?1 AND {}=?2",
            source.runs, source.owner
        );
        let mut statement = self.connection.prepare(&sql).map_err(db)?;
        let mut runs = Vec::new();
        for id in ids {
            if let Some(run) = statement.query_row(params![id, source.key], |r| Ok(json!({
                "id":r.get::<_, String>(0)?,"thread_id":r.get::<_, Option<String>>(1)?,
                "turn_id":r.get::<_, Option<String>>(2)?,"status":r.get::<_, String>(3)?,
                "started_at":r.get::<_, String>(4)?,"ended_at":r.get::<_, Option<String>>(5)?
            }))).optional().map_err(db)? {
                runs.push(run);
            }
        }
        Ok(runs)
    }

    pub fn conversation_state(&self, cid: &str) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        let work = if c.mode == "auto" {
            self.get_work_task(&c.task_id)?
        } else {
            None
        };
        let interactions = self.chat_pending_interactions(&c)?;
        Ok(
            json!({"history_paged":true,"conversation":c,"work":work,"interactions":interactions,"results":[],"runs":[],"events":[]}),
        )
    }

    pub fn conversation_event_chunk(
        &self,
        cid: &str,
        event: i64,
        offset: u64,
    ) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        let source = HistorySource::for_conversation(&c);
        self.history_chunk(&source, event, offset)
    }

    pub fn conversation_event_image(
        &self,
        cid: &str,
        event: i64,
        slot: u64,
    ) -> Result<Value, String> {
        if slot >= IMAGE_SLOTS {
            return Err("图片编号无效".into());
        }
        let c = self.chat_conversation(cid)?;
        let source = HistorySource::for_conversation(&c);
        let candidate = image_url_sql(
            "CASE WHEN json_type(parts,?3)='object' THEN json_extract(parts,?3) ELSE 'null' END",
        );
        let sql = format!(
            "SELECT CASE WHEN length(CAST(url AS BLOB))<=?4 THEN url END
             FROM (SELECT CASE WHEN ?3='$[0]' AND length(generated)>0
                     THEN 'data:image/png;base64,' || generated ELSE {candidate} END AS url
               FROM (SELECT {USER_IMAGE_PARTS} AS parts, {GENERATED_IMAGE_RESULT} AS generated
                     FROM {} e WHERE {}=?1 AND id=?2))",
            source.events, source.owner
        );
        let url = self
            .connection
            .query_row(
                &sql,
                params![source.key, event, format!("$[{slot}]"), IMAGE_URL_BYTES],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(db)?
            .flatten();
        let url = url
            .filter(|url| is_inline_image_url(url))
            .ok_or("这张图片无法读取")?;
        Ok(json!(url))
    }

    pub(crate) fn work_event_chunk(
        &self,
        task: &str,
        event: i64,
        offset: u64,
    ) -> Result<Value, String> {
        let source = HistorySource {
            events: "work_events",
            owner: "task_id",
            runs: "work_runs",
            key: task,
        };
        self.history_chunk(&source, event, offset)
    }

    fn history_chunk(
        &self,
        source: &HistorySource<'_>,
        event: i64,
        offset: u64,
    ) -> Result<Value, String> {
        let offset = i64::try_from(offset)
            .ok()
            .filter(|v| *v < i64::MAX)
            .ok_or("偏移无效")?;
        let sql = format!(
            "SELECT substr(payload_json,?3,?4) FROM {} WHERE {}=?1 AND id=?2",
            source.events, source.owner
        );
        let mut text: String = self
            .connection
            .query_row(
                &sql,
                params![source.key, event, offset + 1, CHUNK_CHARS + 1],
                |r| r.get(0),
            )
            .optional()
            .map_err(db)?
            .ok_or("历史记录不存在")?;
        let next = text.char_indices().nth(CHUNK_CHARS).map(|(end, _)| {
            text.truncate(end);
            offset + CHUNK_CHARS as i64
        });
        Ok(json!({"text":text,"next":next}))
    }

    pub(crate) fn check_extraction_size(&self, c: &Conversation, limit: i64) -> Result<(), String> {
        let source = HistorySource::for_conversation(c);
        let sql = format!(
            "SELECT length(CAST(payload_json AS BLOB)) FROM {} WHERE {}=?1",
            source.events, source.owner
        );
        let mut statement = self.connection.prepare(&sql).map_err(db)?;
        let mut rows = statement.query([source.key]).map_err(db)?;
        let mut bytes = 0;
        while let Some(row) = rows.next().map_err(db)? {
            bytes += row.get::<_, i64>(0).map_err(db)?;
            if bytes > limit {
                return Err("会话过长，请选择较短的会话整理；不会静默截断证据".into());
            }
        }
        Ok(())
    }

    pub fn conversation_diff(&self, cid: &str) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        let source = HistorySource::for_conversation(&c);
        let sql = format!(
            "SELECT substr(COALESCE(json_extract(payload_json,'$.params.diff'),json_extract(payload_json,'$.diff'),''),1,32769)
             FROM {} WHERE {}=?1 AND kind='turn/diff/updated' ORDER BY id DESC LIMIT 1", source.events, source.owner
        );
        let mut text: String = self
            .connection
            .query_row(&sql, [source.key], |r| r.get(0))
            .optional()
            .map_err(db)?
            .unwrap_or_default();
        if let Some((end, _)) = text.char_indices().nth(32768) {
            text.truncate(end);
            text.push_str("\n…（预览已截断，可在会话历史中分段查看原记录）");
        }
        Ok(json!(text))
    }

    pub fn conversation_search(
        &self,
        cid: &str,
        query: &str,
        before: i64,
    ) -> Result<Value, String> {
        let c = self.chat_conversation(cid)?;
        let source = HistorySource::for_conversation(&c);
        let query = query.trim();
        if query.is_empty() || query.len() > 512 {
            return Err("请输入 1 至 512 字节的搜索词".into());
        }
        // 搜索一次最多检查一批原始记录。没有匹配时仍返回游标，以便继续。
        let sql = format!(
            "SELECT id,kind,created_at,CASE WHEN instr(payload_json,?3)>0 THEN 1 ELSE 0 END
            FROM {} WHERE {}=?1 AND id<?2 ORDER BY id DESC LIMIT 96",
            source.events, source.owner
        );
        let mut statement = self.connection.prepare(&sql).map_err(db)?;
        let mut rows = statement
            .query(params![source.key, before, query])
            .map_err(db)?;
        let mut matches = Vec::new();
        let mut next = None;
        let mut count = 0;
        while let Some(row) = rows.next().map_err(db)? {
            let id: i64 = row.get(0).map_err(db)?;
            next = Some(id);
            count += 1;
            if row.get::<_, bool>(3).map_err(db)? {
                matches.push(json!({"id":id,"kind":row.get::<_,String>(1).map_err(db)?,"created_at":row.get::<_,String>(2).map_err(db)?}));
            }
        }
        Ok(json!({"matches":matches,"next":if count == 96 {next} else {None}}))
    }
}
