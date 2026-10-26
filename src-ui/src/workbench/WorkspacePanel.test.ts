import { expect, test } from "vitest";
import { commandTimeline } from "./WorkspacePanel";
import type { WorkEvent } from "./types";

const event = (id: number, kind: string, payload: unknown): WorkEvent => ({ id, task_id: "task-a", run_id: "run-a", kind, payload, created_at: "now" });

test("terminal output decodes UTF-8 split across chunks without replacing Chinese characters", () => {
  const bytes = new TextEncoder().encode("你好");
  const base64 = (part: Uint8Array) => btoa(Array.from(part, (value) => String.fromCharCode(value)).join(""));
  const result = commandTimeline([
    event(1, "runtime/command/started", { processId: "p1", command: ["echo", "你好"] }),
    event(2, "command/exec/outputDelta", { processId: "p1", stream: "stdout", deltaBase64: base64(bytes.slice(0, 2)) }),
    event(3, "command/exec/outputDelta", { processId: "p1", stream: "stdout", deltaBase64: base64(bytes.slice(2)) }),
    event(4, "runtime/command/completed", { processId: "p1", result: { exitCode: 0, stdout: "", stderr: "" } })
  ]);
  expect(result).toEqual([{ id: "p1", runId: "run-a", command: "echo 你好", output: "你好", running: false, exitCode: 0, error: undefined }]);
});

test("independent terminal processes retain their own output and stop identity", () => {
  const result = commandTimeline([
    event(1, "runtime/command/started", { processId: "p1", command: ["test"] }),
    event(2, "runtime/command/started", { processId: "p2", command: ["build"] }),
    event(3, "runtime/command/completed", { processId: "p1", result: { exitCode: 1, stdout: "failed", stderr: "" } })
  ]);
  expect(result[0].running).toBe(false);
  expect(result[1].running).toBe(true);
  expect(result[1].id).toBe("p2");
  expect(result[1].runId).toBe("run-a");
});
