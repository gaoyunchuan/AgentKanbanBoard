import type { WorkEvent } from "./types";

export type TimelineItem = { id: string; role: "user" | "agent" | "tool" | "system"; text: string; title?: string; status?: string; images?: string[] };

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
    const id = `${event.run_id ?? "task"}:${itemId}`;
    if (method.includes("agentMessage/delta")) {
      const current = items.get(id);
      items.set(id, { id, role: "agent", text: (current?.text ?? "") + str(params.delta) });
    } else if (method === "item/started" || method === "item/completed") {
      if (item.type === "agentMessage") {
        const text = str(item.text);
        if (text) items.set(id, { id, role: "agent", text });
      } else if (item.type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((part) => str(record(part).text)).filter(Boolean).join("\n");
        if (text) items.set(id, { id, role: "user", text });
      } else if (item.type === "commandExecution") {
        items.set(id, { id, role: "tool", title: str(item.command) || "执行命令", status: str(item.status), text: str(item.aggregatedOutput) || items.get(id)?.text || "" });
      } else if (["fileChange", "mcpToolCall", "dynamicToolCall", "webSearch"].includes(str(item.type))) {
        const output = toolOutput(item.type === "fileChange" ? item.changes ?? [] : item.result ?? item.contentItems ?? item.error ?? item.arguments ?? {});
        items.set(id, { id, role: "tool", title: str(item.tool) || str(item.type), status: str(item.status), ...output });
      }
    } else if (method.includes("commandExecution/outputDelta")) {
      const current = items.get(id);
      items.set(id, { id, role: "tool", title: current?.title || "命令输出", text: (current?.text ?? "") + str(params.delta), status: current?.status });
    } else if (["user_message", "message", "agent_message", "assistant_message"].includes(method)) {
      const text = str(params.text) || str(params.message) || str(params.content);
      if (text) items.set(id, { id, role: method === "user_message" || params.role === "user" ? "user" : "agent", text });
    }
  }
  return [...items.values()];
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
