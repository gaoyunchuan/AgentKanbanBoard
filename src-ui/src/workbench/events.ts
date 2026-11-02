import type { WorkEvent } from "./types";

export type TimelineItem = { id: string; role: "user" | "agent" | "tool" | "system"; text: string; title?: string; status?: string; images?: string[]; runId?:string; turnId?:string; threadId?:string; children?:TimelineItem[]; phase?:string; createdAt?:string; toolKind?:ToolKind; label?:string };
export type ToolKind = "read"|"search"|"command"|"edit"|"agent"|"computer"|"tool";

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string => typeof value === "string" ? value : "";

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
    const itemId = str(params.itemId) || str(item.id) || `event-${event.id}`;
    const threadId=str(params.threadId);
    const id = `${event.run_id ?? "task"}:${threadId?`${threadId}:`:""}${itemId}`;
    const previous = items.get(id);
    const put = (value: TimelineItem) => items.set(id, {
      ...previous, ...value, runId: event.run_id || undefined,
      turnId: str(params.turnId) || previous?.turnId, threadId:threadId||previous?.threadId,
      createdAt: previous?.createdAt || event.created_at,
    });
    if (method.includes("agentMessage/delta")) {
      put({ id, role: "agent", text: (previous?.text ?? "") + str(params.delta) });
    } else if (method.includes("reasoning/") && method.endsWith("Delta")) {
      put({id,role:"system",phase:"reasoning",text:(previous?.text??"")+str(params.delta)});
    } else if (method === "item/started" || method === "item/completed") {
      if (item.type === "agentMessage") {
        put({ id, role: "agent", text: str(item.text) || previous?.text || "", phase:str(item.phase)||previous?.phase });
      } else if (item.type === "reasoning") {
        const summary=Array.isArray(item.summary)?item.summary.map(x=>typeof x==='string'?x:str(record(x).text)).join("\n"):"";
        put({id,role:"system",phase:"reasoning",text:summary||previous?.text||""});
      } else if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((part) => str(record(part).text)).filter(Boolean).join("\n");
        if (text) put({ id, role: "user", text });
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
      if (text) put({ id, role: method === "user_message" || params.role === "user" ? "user" : "agent", text, phase:str(params.phase)||undefined });
    }
  }
  return [...items.values()].filter(item=>item.role==='tool'||item.text.length>0);
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
