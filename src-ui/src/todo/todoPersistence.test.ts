import { describe, expect, test } from "vitest";
import type { TodoTask } from "./types";
import { mergeTodoSnapshot, todoEditPayload, todoEdits } from "./todoPersistence";

const task = (id: string, patch: Partial<TodoTask> = {}): TodoTask => ({
  id, title: id, position: 0, status: "todo", pinned: false,
  processTracking: "", resultReview: "", ...patch
});

describe("concurrent To Do edits", () => {
  test("keeps agent-created children and updated status while preserving a local title draft", () => {
    const before = [task("a")];
    const local = [task("a", { title: "typing" })];
    const remote = [task("a", { status: "in_progress" }), task("child", { parentId: "a" })];
    expect(mergeTodoSnapshot(before, local, remote)).toEqual([
      task("a", { title: "typing", status: "in_progress" }), remote[1]
    ]);
  });

  test("sends a title edit without reverting a newer execution status or deleting unseen children", () => {
    const changes = todoEdits([task("a")], [task("a", { title: "edited" })]);
    const payload = todoEditPayload(changes, [task("a", { status: "completed" }), task("new")]);
    expect(payload.before).toEqual([task("a", { status: "completed" })]);
    expect(payload.after).toEqual([task("a", { title: "edited", status: "completed" })]);
  });

  test("retains expected title for conflict detection, rather than silently overwriting another edit", () => {
    const changes = todoEdits([task("a")], [task("a", { title: "local" })]);
    const payload = todoEditPayload(changes, [task("a", { title: "remote" })]);
    expect(payload.before[0].title).toBe("a");
    expect(payload.after[0].title).toBe("local");
  });

  test("does not resurrect a task deleted in the background", () => {
    expect(() => todoEditPayload(todoEdits([task("a")], [task("a", { title: "draft" })]), []))
      .toThrow(/已被删除/);
    expect(mergeTodoSnapshot([task("a")], [task("a")], [])).toEqual([]);
  });

  test("a pending deletion only removes the selected known task", () => {
    expect(mergeTodoSnapshot([task("a")], [], [task("a"), task("new")])).toEqual([task("new")]);
    const payload = todoEditPayload(todoEdits([task("a"), task("b")], [task("b")]), [task("a"), task("b"), task("new")]);
    expect(payload.before.map((item) => item.id)).toEqual(["a"]);
    expect(payload.after).toEqual([]);
  });
});
