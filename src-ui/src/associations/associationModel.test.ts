import { expect, test } from "vitest";
import type { BoardStatus, ThreadItem } from "@/types";
import type { TodoStatus, TodoTask } from "@/todo/types";
import {
  buildTaskAssociationOptions,
  buildThreadAssociationOptions,
  todoTargetPage
} from "./associationModel";
import type { ThreadTaskLink } from "./types";

const task = (
  id: string,
  parentId: string | undefined,
  status: TodoStatus,
  position = 0
): TodoTask => ({
  id,
  parentId,
  position,
  title: id,
  status,
  processTracking: "",
  resultReview: ""
});

const thread = (id: string, boardStatus: BoardStatus): ThreadItem => ({
  id,
  title: id,
  preview: "",
  projectId: "project",
  cwd: "/repo",
  branch: "main",
  boardStatus,
  codexStatus: "idle",
  subStatus: "",
  taskType: "unset",
  module: "",
  sprint: "",
  updatedAt: "2026-07-13",
  createdAt: "2026-07-13",
  notes: "",
  comments: []
});

const link = (threadId: string, taskId: string): ThreadTaskLink => ({
  threadId,
  taskId,
  createdAt: "2026-07-13T08:00:00Z",
  updatedAt: "2026-07-13T08:00:00Z"
});

test("Task 候选保留已完成祖先作为禁用上下文，并排除已完成叶子", () => {
  const options = buildTaskAssociationOptions(
    [
      task("parent", undefined, "completed"),
      task("child", "parent", "todo"),
      task("done", undefined, "completed")
    ],
    undefined,
    ""
  );

  expect(options.find((option) => option.id === "parent")).toMatchObject({ disabled: true });
  expect(options.find((option) => option.id === "child")).toMatchObject({ depth: 1 });
  expect(options.find((option) => option.id === "done")).toBeUndefined();
});

test("搜索子 Task 时扁平展示完整父级路径", () => {
  const options = buildTaskAssociationOptions(
    [task("root", undefined, "todo"), task("child", "root", "in_progress")],
    undefined,
    "child"
  );
  expect(options).toEqual([
    expect.objectContaining({ id: "child", depth: 0, description: "root / child" })
  ]);
});

test("当前已关联的终态 Task 固定在顶部且不可重新选择", () => {
  const options = buildTaskAssociationOptions(
    [task("done", undefined, "completed"), task("open", undefined, "todo")],
    "done",
    ""
  );
  expect(options[0]).toMatchObject({
    id: "done",
    current: true,
    disabled: true,
    description: "当前关联"
  });
});

test("Thread 候选只保留待审核和挂起，并显示旧 Task 归属", () => {
  const options = buildThreadAssociationOptions(
    [thread("pending", "review_pending"), thread("running", "running")],
    new Map([["pending", link("pending", "old-task")]]),
    "new-task",
    new Map([["project", "AgentKanbanBoard"]]),
    ""
  );
  expect(options).toHaveLength(1);
  expect(options[0]).toMatchObject({ id: "pending", group: "待审核" });
  expect(options[0].description).toContain("当前关联：old-task");
});

test("Todo 定位按树顺序计算分页", () => {
  const tasks = Array.from({ length: 51 }, (_, index) =>
    task(`task-${index + 1}`, undefined, "todo", index)
  );
  expect(todoTargetPage(tasks, "task-51", 50)).toBe(2);
});
