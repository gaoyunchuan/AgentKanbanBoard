import { expect, test } from "vitest";
import { executionDiff, executionTimeline } from "./events";
import type { WorkEvent } from "./types";
const event = (id: number, kind: string, payload: unknown, run_id = "run-a"): WorkEvent => ({ id, kind, payload, run_id, task_id: "task-a", created_at: "now" });

test("streamed answer is replaced by its final item without duplication", () => {
  const events = [event(1, "item/agentMessage/delta", { itemId: "item-a", delta: "完成" }), event(2, "item/agentMessage/delta", { itemId: "item-a", delta: "检查" }), event(3, "item/completed", { item: { id: "item-a", type: "agentMessage", text: "完成检查。" } })];
  expect(executionTimeline(events)).toEqual([{ id: "run-a:item-a", role: "agent", text: "完成检查。" }]);
});

test("events from different runs cannot overwrite one another with a reused item ID", () => {
  const result = executionTimeline([event(1, "item/agentMessage/delta", { itemId: "same", delta: "old" }), event(2, "item/agentMessage/delta", { itemId: "same", delta: "new" }, "run-b")]);
  expect(result.map((item) => item.text)).toEqual(["old", "new"]);
});

test("latest aggregated diff is shown rather than concatenating repeated snapshots", () => {
  expect(executionDiff([event(1, "turn/diff/updated", { diff: "old" }), event(2, "runtime", { method: "turn/diff/updated", params: { diff: "new" } })])).toBe("new");
});

test("MCP screenshots render as images without dumping their base64 into tool output", () => {
  const result = executionTimeline([event(1, "item/completed", { item: { id: "browser", type: "mcpToolCall", tool: "browser_take_screenshot", result: { content: [{ type: "image", mimeType: "image/png", data: "AA==" }, { type: "text", text: "页面截图" }] } } })]);
  expect(result[0].images).toEqual(["data:image/png;base64,AA=="]);
  expect(result[0].text).not.toContain("AA==");
  expect(result[0].text).toContain("页面截图");
});
