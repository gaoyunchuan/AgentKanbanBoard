import { describe, expect, test } from "vitest";
import type { TodoTask } from "./types";
import {
  flattenTodoTree,
  indentTask,
  insertSiblingTask,
  moveTaskRelative,
  outdentTask
} from "./todoTree";

const task = (
  id: string,
  parentId: string | undefined,
  position: number,
  title = id
): TodoTask => ({
  id,
  parentId,
  position,
  title,
  status: "todo",
  processTracking: "",
  resultReview: ""
});

describe("todo tree operations", () => {
  test("按父子关系和同级顺序展开任务树", () => {
    const tasks = [task("b", undefined, 1), task("a-child", "a", 0), task("a", undefined, 0)];

    expect(flattenTodoTree(tasks).map(({ task, depth }) => [task.id, depth])).toEqual([
      ["a", 0],
      ["a-child", 1],
      ["b", 0]
    ]);
  });

  test("Tab 将任务缩进为前一个可见任务的子任务且不改变状态", () => {
    const tasks = [
      { ...task("a", undefined, 0), status: "completed" as const },
      { ...task("b", undefined, 1), status: "in_progress" as const }
    ];

    const changed = indentTask(tasks, "b");
    expect(changed.find((item) => item.id === "b")).toMatchObject({
      parentId: "a",
      position: 0,
      status: "in_progress"
    });
    expect(changed.find((item) => item.id === "a")?.status).toBe("completed");
  });

  test("Shift+Tab 将任务提升到父任务之后", () => {
    const tasks = [
      task("root", undefined, 0),
      task("parent", "root", 0),
      task("child", "parent", 0),
      task("sibling", "root", 1)
    ];

    const changed = outdentTask(tasks, "child");
    expect(changed.find((item) => item.id === "child")).toMatchObject({
      parentId: "root",
      position: 1
    });
    expect(changed.find((item) => item.id === "sibling")?.position).toBe(2);
  });

  test("可在当前任务之前或之后插入同级任务", () => {
    const tasks = [task("a", undefined, 0), task("b", undefined, 1)];
    const insertedAfter = insertSiblingTask(tasks, "a", task("after", undefined, 0, ""));

    expect(flattenTodoTree(insertedAfter).map(({ task }) => task.id)).toEqual([
      "a",
      "after",
      "b"
    ]);

    const insertedBefore = insertSiblingTask(
      tasks,
      "b",
      task("before", undefined, 0, ""),
      "before"
    );
    expect(flattenTodoTree(insertedBefore).map(({ task }) => task.id)).toEqual([
      "a",
      "before",
      "b"
    ]);
  });

  test("向前插入时继承当前任务的父级", () => {
    const tasks = [
      task("root", undefined, 0),
      task("first", "root", 0),
      task("second", "root", 1)
    ];
    const changed = insertSiblingTask(
      tasks,
      "second",
      task("new", undefined, 0, ""),
      "before"
    );

    expect(changed.find((item) => item.id === "new")).toMatchObject({
      parentId: "root",
      position: 1
    });
  });

  test("可将任务移动到目标任务之前或之后", () => {
    const tasks = [task("a", undefined, 0), task("b", undefined, 1), task("c", undefined, 2)];

    const movedBefore = moveTaskRelative(tasks, "c", "a", "before");
    expect(flattenTodoTree(movedBefore).map(({ task }) => task.id)).toEqual(["c", "a", "b"]);

    const movedAfter = moveTaskRelative(tasks, "a", "c", "after");
    expect(flattenTodoTree(movedAfter).map(({ task }) => task.id)).toEqual(["b", "c", "a"]);
  });

  test("跨层级排序时沿用目标任务的父级", () => {
    const tasks = [
      task("parent", undefined, 0),
      task("child", "parent", 0),
      task("moving", undefined, 1)
    ];

    const changed = moveTaskRelative(tasks, "moving", "child", "before");

    expect(changed.find((item) => item.id === "moving")).toMatchObject({
      parentId: "parent",
      position: 0
    });
    expect(changed.find((item) => item.id === "child")?.position).toBe(1);
  });

  test("中部落点成为目标的最后一个子任务，并阻止移动到自身后代", () => {
    const tasks = [
      task("parent", undefined, 0),
      task("child", "parent", 0),
      task("moving", undefined, 1)
    ];

    const changed = moveTaskRelative(tasks, "moving", "parent", "inside");
    expect(changed.find((item) => item.id === "moving")).toMatchObject({
      parentId: "parent",
      position: 1
    });

    expect(moveTaskRelative(tasks, "parent", "child", "inside")).toEqual(tasks);
    expect(moveTaskRelative(tasks, "parent", "child", "before")).toEqual(tasks);
  });
});
