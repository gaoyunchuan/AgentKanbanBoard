import { describe, expect, test } from "vitest";
import type { TodoTask } from "./types";
import {
  isTodoTaskRecentlyUpdated,
  stampChangedTodoTasks,
  TODO_RECENCY_WINDOW_MS
} from "./todoRecency";

const baseTask = (updatedAt?: string): TodoTask => ({
  id: "task",
  position: 0,
  title: "任务",
  status: "todo",
  pinned: false,
  processTracking: "",
  resultReview: "",
  updatedAt
});

describe("todoRecency", () => {
  test("168 小时双边界命中，过期、未来、缺失和无效时间不命中", () => {
    const now = Date.parse("2026-08-06T12:00:00Z");

    expect(
      isTodoTaskRecentlyUpdated(
        baseTask(new Date(now - TODO_RECENCY_WINDOW_MS).toISOString()),
        now
      )
    ).toBe(true);
    expect(isTodoTaskRecentlyUpdated(baseTask(new Date(now).toISOString()), now)).toBe(true);
    expect(
      isTodoTaskRecentlyUpdated(
        baseTask(new Date(now - TODO_RECENCY_WINDOW_MS - 1).toISOString()),
        now
      )
    ).toBe(false);
    expect(isTodoTaskRecentlyUpdated(baseTask(new Date(now + 1).toISOString()), now)).toBe(false);
    expect(isTodoTaskRecentlyUpdated(baseTask(), now)).toBe(false);
    expect(isTodoTaskRecentlyUpdated(baseTask("invalid"), now)).toBe(false);
  });

  test("未变化任务保留原时间，新增任务使用当前时间", () => {
    const previous = [baseTask("2026-07-01T00:00:00Z")];
    const nowIso = "2026-08-06T12:00:00Z";

    expect(stampChangedTodoTasks(previous, [{ ...previous[0] }], nowIso)).toEqual(previous);
    expect(stampChangedTodoTasks([], [baseTask()], nowIso)[0].updatedAt).toBe(nowIso);
  });

  test.each([
    ["任务", " 任务 "],
    ["未命名任务", ""],
    ["未命名任务", "   "]
  ])("持久化标题等价时保留原时间：%s → %s", (beforeTitle, nextTitle) => {
    const updatedAt = "2026-07-01T00:00:00Z";
    const previous = [{ ...baseTask(updatedAt), title: beforeTitle }];

    const stamped = stampChangedTodoTasks(
      previous,
      [{ ...previous[0], title: nextTitle }],
      "2026-08-06T12:00:00Z"
    );

    expect(stamped[0].updatedAt).toBe(updatedAt);
  });

  test.each<Partial<TodoTask>>([
    { parentId: "parent" },
    { position: 1 },
    { title: "已修改" },
    { status: "in_progress" },
    { pinned: true },
    { startDate: "2026-08-01" },
    { expectedEndDate: "2026-08-10" },
    { actualEndDate: "2026-08-06" },
    { processTracking: "已处理" },
    { resultReview: "已复盘" }
  ])("持久化字段变化时刷新内部时间：%o", (patch) => {
    const previous = [baseTask("2026-07-01T00:00:00Z")];
    const nowIso = "2026-08-06T12:00:00Z";

    const stamped = stampChangedTodoTasks(previous, [{ ...previous[0], ...patch }], nowIso);

    expect(stamped[0].updatedAt).toBe(nowIso);
  });
});
