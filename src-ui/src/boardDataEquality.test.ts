import { describe, expect, test } from "vitest";
import { sameProjectList, sameThreadList } from "./boardDataEquality";
import type { Project, ThreadItem } from "./types";

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
      body: "先看卡顿",
      createdAt: "2026-06-24 10:01:00",
      updatedAt: "2026-06-24 10:01:00"
    }
  ]
};

const baseProject: Project = {
  id: "project-1",
  name: "AgentKanbanBoard",
  path: "/repo",
  aliases: ["AgentKanbanBoard"],
  active: true
};

describe("board data equality", () => {
  test("treats identical thread and project lists as unchanged", () => {
    expect(sameThreadList([baseThread], [{ ...baseThread, comments: [...baseThread.comments] }])).toBe(true);
    expect(sameProjectList([baseProject], [{ ...baseProject, aliases: [...baseProject.aliases] }])).toBe(true);
  });

  test("detects thread status, timestamp, and comment changes", () => {
    expect(
      sameThreadList([baseThread], [{ ...baseThread, boardStatus: "reviewed" }])
    ).toBe(false);
    expect(
      sameThreadList([baseThread], [{ ...baseThread, updatedAt: "2026-06-24 10:05:00" }])
    ).toBe(false);
    expect(
      sameThreadList([
        baseThread
      ], [
        {
          ...baseThread,
          comments: [{ ...baseThread.comments[0], body: "评论已变化" }]
        }
      ])
    ).toBe(false);
  });
});
