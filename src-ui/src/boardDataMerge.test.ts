import { describe, expect, test } from "vitest";
import { mergeThreadRefresh } from "./boardDataMerge";
import type { ThreadItem } from "./types";

const baseThread: ThreadItem = {
  id: "thread-1",
  codexSessionId: "thread-1",
  title: "同步记录",
  preview: "preview",
  projectId: "project-1",
  cwd: "/repo",
  branch: "main",
  boardStatus: "review_pending",
  codexStatus: "idle",
  subStatus: "idle",
  taskType: "unset",
  module: "Sync",
  sprint: "S26",
  updatedAt: "2026-06-24 10:00:00",
  createdAt: "2026-06-24 09:00:00",
  notes: "",
  comments: [
    {
      id: 1,
      threadId: "thread-1",
      author: "我",
      body: "展开后加载的评论",
      createdAt: "2026-06-24 10:01:00",
      updatedAt: "2026-06-24 10:01:00"
    }
  ]
};

describe("board data merge", () => {
  test("keeps the current list and loaded comments when refresh data is unchanged", () => {
    const current = [baseThread];
    const refreshed: ThreadItem = {
      ...baseThread,
      comments: []
    };

    const merged = mergeThreadRefresh(current, [refreshed]);

    expect(merged).toBe(current);
    expect(merged[0]).toBe(baseThread);
    expect(merged[0].comments).toBe(baseThread.comments);
  });

  test("only replaces changed threads during refresh", () => {
    const unchanged = baseThread;
    const changed: ThreadItem = {
      ...baseThread,
      id: "thread-2",
      codexSessionId: "thread-2",
      title: "旧标题",
      comments: []
    };
    const refreshedUnchanged = { ...unchanged, comments: [] };
    const refreshedChanged = { ...changed, title: "新标题" };
    const current = [unchanged, changed];

    const merged = mergeThreadRefresh(current, [refreshedUnchanged, refreshedChanged]);

    expect(merged).not.toBe(current);
    expect(merged[0]).toBe(unchanged);
    expect(merged[1]).not.toBe(changed);
    expect(merged[1].title).toBe("新标题");
  });
});
