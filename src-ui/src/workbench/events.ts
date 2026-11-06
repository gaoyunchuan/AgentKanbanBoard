import type { WorkEvent } from "./types";
import { inlineImageUrl } from "../lib/imageUrl";

export type HistoryImageRef = {eventId:number;slot:number};
export type TimelineItem = { id: string; sourceEventId?: number; role: "user" | "agent" | "tool" | "system"; text: string; userSource?: 'local' | 'protocol'; userLabel?: string; title?: string; status?: string; images?: string[]; imageRefs?:HistoryImageRef[]; unavailableImages?: number; runId?:string; turnId?:string; threadId?:string; children?:TimelineItem[]; phase?:string; createdAt?:string; startedAt?:string; endedAt?:string; toolKind?:ToolKind; label?:string };
export type ToolKind = "read"|"search"|"command"|"edit"|"agent"|"computer"|"tool";

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";
function humanResponse(kind: string, payload: Record<string, unknown>) {
  if (kind === 'task_action' && payload.action === 'rework') {
    return {text:str(payload.feedback), label:'返工反馈'};
  }
  if (kind !== 'question_answered' && kind !== 'interaction_resolved') return;
  const response = record(payload.response);
  const answers = Object.values(record(response.answers)).flatMap(entry => {
    const values = record(entry).answers;
    return Array.isArray(values) ? values.map(str).filter(Boolean) : [];
  });
  const text = str(response.text) || str(response.answer) || answers.join('\n');
  return text ? {text,label:'回答问题'} : undefined;
}

function protocolTime(value: unknown): string | undefined {
  if (typeof value !== 'number') return;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
}

/** 本地附件和协议回显使用同一规则，无法显示的图片也保留在消息中告知用户。 */
function userImages(parts: unknown): Pick<TimelineItem, 'images' | 'unavailableImages'> {
  const images: string[] = [];
  let unavailableImages = 0;
  for (const part of Array.isArray(parts) ? parts : []) {
    const content = record(part);
    if (!['image', 'inputImage', 'input_image', 'localImage', 'local_image'].includes(str(content.type))) continue;
    const src = inlineImageUrl(content.url ?? content.imageUrl ?? content.image_url);
    if (src) images.push(src);
    else unavailableImages++;
  }
  // 协议补充记录可能只含文字，此时不能覆盖先前已投影的图片。
  return images.length || unavailableImages ? { images, unavailableImages } : {};
}

function toolOutput(value: unknown) {
  const images: string[] = [];
  const text = JSON.stringify(value, (_key, part: unknown) => {
    const content = record(part);
    const mime = str(content.mimeType);
    if (content.type === "image" && typeof content.data === "string" && /^image\/(png|jpeg|webp|gif)$/.test(mime)) {
      images.push(`data:${mime};base64,${content.data}`);
      return { ...content, data: "[图片见下方]" };
    }
    const url = str(content.imageUrl);
    if (content.type === "inputImage" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(url)) {
      images.push(url);
      return { ...content, imageUrl: "[图片见下方]" };
    }
    return part;
  }, 2) ?? "";
  return { text, ...(images.length ? { images } : {}) };
}

/** Reduce streamed deltas and final items into one stable, non-duplicated transcript. */
export function executionTimeline(events: WorkEvent[]): TimelineItem[] {
  const items = new Map<string, TimelineItem>();
  for (const event of events) {
    const raw = record(event.payload);
    const method = str(raw.method) || event.kind;
    const params = Object.keys(record(raw.params)).length ? record(raw.params) : raw;
    const item = record(params.item);
    const itemId = str(params.itemId) || str(item.id) || str(raw.item_id) || `event-${event.id}`;
    const threadId=str(params.threadId);
    const id = `${event.run_id ?? "task"}:${threadId?`${threadId}:`:""}${itemId}`;
    const previous = items.get(id);
    const put = (value: TimelineItem) => items.set(id, {
      ...previous, ...value, runId: event.run_id || undefined,
      turnId: str(params.turnId) || previous?.turnId, threadId:threadId||previous?.threadId,
      createdAt: previous?.createdAt || event.created_at,
    });
    const submitted = humanResponse(method, params);
    if (submitted?.text) {
      put({id, role:'user', text:submitted.text, userLabel:submitted.label});
    } else if ('truncated' in event && event.truncated) {
      const role = ['user_message','question_answered','task_action','interaction_resolved'].includes(event.kind) || raw.item_type === 'userMessage' ? 'user'
        : raw.item_type === 'agentMessage' || method.includes('agentMessage/delta') ? 'agent' : 'tool';
      const generated = raw.item_type === 'imageGeneration';
      const imageRefs = (role==='user' || generated) && Array.isArray(raw.image_slots)
        ? raw.image_slots.filter((slot):slot is number=>Number.isInteger(slot) && slot>=0 && slot<16)
          .map(slot=>({eventId:event.id,slot}))
        : [];
      if (generated) {
        if (imageRefs.length) put({id, role:'tool', text:'', phase:'generated_image', imageRefs});
        continue;
      }
      put({id, role, ...(imageRefs.length ? {imageRefs} : {}), title: `大记录 · ${event.kind}`, sourceEventId: event.id,
        text: str(raw.preview), phase: str(raw.phase) || undefined,
        ...(role === 'user' ? {userSource: event.kind === 'user_message' ? 'local' : 'protocol'} : {})});
    } else if (method.includes("agentMessage/delta")) {
      put({ id, role: "agent", text: (previous?.text ?? "") + str(params.delta) });
    } else if (method.includes("reasoning/") && method.endsWith("Delta")) {
      put({id,role:"system",phase:"reasoning",text:(previous?.text??"")+str(params.delta)});
    } else if (method === "item/started" || method === "item/completed") {
      if (item.type === "agentMessage") {
        put({ id, role: "agent", text: str(item.text) || previous?.text || "", phase:str(item.phase)||previous?.phase });
      } else if (item.type === "imageGeneration") {
        if (method === 'item/completed' && item.status === 'completed' && str(item.result)) {
          put({id, role:'tool', text:'', phase:'generated_image', imageRefs:[{eventId:event.id,slot:0}]});
        }
      } else if (item.type === "contextCompaction") {
        // 压缩可能长时间没有正文，必须投影为独立过程；重复轮询不能重置协议起点。
        const completed = method === 'item/completed' || previous?.status === 'completed';
        put({id, role:'system', phase:'compaction', text:'正在压缩上下文', status:completed?'completed':'inProgress',
          startedAt:protocolTime(item.startedAtMs)||previous?.startedAt||event.created_at,
          endedAt:previous?.endedAt||(method==='item/completed'?(protocolTime(item.completedAtMs)||event.created_at):undefined)});
      } else if (item.type === "reasoning") {
        const summary=Array.isArray(item.summary)?item.summary.map(x=>typeof x==='string'?x:str(record(x).text)).join("\n"):"";
        put({id,role:"system",phase:"reasoning",text:summary||previous?.text||""});
      } else if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((part) => str(record(part).text)).filter(Boolean).join("\n");
        const images = userImages(content);
        if (text || images.images?.length || images.unavailableImages) {
          put({ id, role: "user", userSource: 'protocol', text: text || previous?.text || "", ...images });
        }
      } else if (item.type === "commandExecution") {
        const actions=Array.isArray(item.commandActions)?item.commandActions.map(record):[];
        const action=actions[0], toolKind:ToolKind=action?.type==='read'?'read':action?.type==='search'?'search':'command';
        const command=str(item.command)||"执行命令";
        const label=toolKind==='read'?`读取 ${actions.map(a=>str(a.name)||str(a.path)).filter(Boolean).join('、')||command}`:toolKind==='search'?`搜索 ${str(action?.query)||str(action?.path)||command}`:command;
        put({ id, role: "tool", title:command, label, toolKind, status: str(item.status), text: str(item.aggregatedOutput) || previous?.text || "" });
      } else if (["fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall", "computerCall"].includes(str(item.type))) {
        const title=str(item.tool)||str(item.type);
        const toolKind:ToolKind=item.type==='fileChange'?'edit':item.type==='collabAgentToolCall'||/agent|spawn|delegate/i.test(title)?'agent':item.type==='webSearch'?'search':/browser|computer/i.test(title)?'computer':'tool';
        const changes=Array.isArray(item.changes)?item.changes.map(record):[];
        const label=toolKind==='edit'?`编辑 ${changes.map(c=>str(c.path)).filter(Boolean).join('、')||'文件'}`:title;
        const output = toolOutput(item.type === "fileChange" ? item.changes ?? [] : item.result ?? item.contentItems ?? item.error ?? item.arguments ?? item);
        put({ id, role: "tool", title, label, toolKind, status: str(item.status), ...output });
      }
    } else if (method.includes("commandExecution/outputDelta")) {
      put({ id, role: "tool", title: previous?.title || "命令输出", text: (previous?.text ?? "") + str(params.delta), status: previous?.status, toolKind:previous?.toolKind||'command' });
    } else if (["user_message", "message", "agent_message", "assistant_message"].includes(method)) {
      const text = str(params.text) || str(params.message) || str(params.content);
      const role = method === "user_message" || params.role === "user" ? "user" : "agent";
      const images = role === "user" ? userImages(params.attachments) : {};
      if (text || images.images?.length || images.unavailableImages) {
        put({ id, role, ...(method === 'user_message' ? { userSource: 'local' } : {}), text: text || previous?.text || "", phase:str(params.phase)||undefined, ...images });
      }
    }
  }
  return [...items.values()].filter(item=>item.role==='tool'||item.text.length>0||Boolean(item.images?.length)||Boolean(item.unavailableImages));
}

export function executionDiff(events: WorkEvent[]) {
  let diff = "";
  for (const event of events) {
    const payload = record(event.payload);
    const params = Object.keys(record(payload.params)).length ? record(payload.params) : payload;
    if ((payload.method || event.kind) === "turn/diff/updated") diff = str(params.diff);
  }
  return diff;
}
