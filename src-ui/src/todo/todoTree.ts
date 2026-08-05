import type { FlatTodoTask, TodoTask } from "./types";

const parentKey = (parentId: string | undefined) => parentId ?? "__root__";

export function normalizeTodoPositions(tasks: TodoTask[]): TodoTask[] {
  const sourceOrder = new Map(tasks.map((task, index) => [task.id, index]));
  const grouped = new Map<string, TodoTask[]>();
  for (const task of tasks) {
    const key = parentKey(task.parentId);
    grouped.set(key, [...(grouped.get(key) ?? []), task]);
  }

  const positions = new Map<string, number>();
  for (const siblings of grouped.values()) {
    siblings
      .slice()
      .sort(
        (left, right) =>
          left.position - right.position ||
          (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0)
      )
      .forEach((task, index) => positions.set(task.id, index));
  }

  return tasks.map((task) => ({ ...task, position: positions.get(task.id) ?? task.position }));
}

export function normalizeTodoPins(tasks: TodoTask[]): TodoTask[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const pinnedRootIds = new Set<string>();
  for (const task of tasks) {
    if (!task.pinned) continue;
    const rootId = findPinnedRootId(tasksById, task.id);
    if (rootId) pinnedRootIds.add(rootId);
  }

  // 置顶表达的是整棵顶层任务树；层级变化后必须把状态转移到新 root，子任务自身不能保留置顶。
  return tasks.map((task) => ({
    ...task,
    pinned: !task.parentId && pinnedRootIds.has(task.id)
  }));
}

function findPinnedRootId(tasksById: Map<string, TodoTask>, taskId: string) {
  let current = tasksById.get(taskId);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    if (!current.parentId) return current.id;
    current = tasksById.get(current.parentId);
  }
  return undefined;
}

export function flattenTodoTree(tasks: TodoTask[], collapsedIds: Set<string> = new Set()): FlatTodoTask[] {
  const normalized = normalizeTodoPositions(tasks);
  const knownIds = new Set(normalized.map((task) => task.id));
  const grouped = new Map<string, TodoTask[]>();
  for (const task of normalized) {
    const validParent = task.parentId && knownIds.has(task.parentId) ? task.parentId : undefined;
    const key = parentKey(validParent);
    grouped.set(key, [...(grouped.get(key) ?? []), task]);
  }
  for (const siblings of grouped.values()) {
    siblings.sort((left, right) => left.position - right.position);
  }

  const result: FlatTodoTask[] = [];
  const visited = new Set<string>();
  const visit = (task: TodoTask, depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const children = grouped.get(parentKey(task.id)) ?? [];
    result.push({ task, depth, hasChildren: children.length > 0 });
    if (!collapsedIds.has(task.id)) children.forEach((child) => visit(child, depth + 1));
  };

  (grouped.get(parentKey(undefined)) ?? []).forEach((task) => visit(task, 0));
  normalized.filter((task) => !visited.has(task.id)).forEach((task) => visit(task, 0));
  return result;
}

export type TodoTreeCompletion =
  | "all_incomplete"
  | "partially_incomplete"
  | "all_complete";

const completionRank: Record<TodoTreeCompletion, number> = {
  all_incomplete: 0,
  partially_incomplete: 1,
  all_complete: 2
};

const isDone = (task: TodoTask) =>
  task.status === "completed" || task.status === "cancelled";

function rootTaskId(tasks: TodoTask[], taskId: string) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  let current = tasksById.get(taskId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = tasksById.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? taskId;
}

export function todoTreeCompletion(tasks: TodoTask[], taskId: string): TodoTreeCompletion {
  const rootId = rootTaskId(tasks, taskId);
  const childrenByParent = new Map<string, TodoTask[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    childrenByParent.set(task.parentId, [
      ...(childrenByParent.get(task.parentId) ?? []),
      task
    ]);
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const pending = [rootId];
  const visited = new Set<string>();
  let hasDone = false;
  let hasIncomplete = false;
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const task = tasksById.get(currentId);
    if (!task) continue;
    if (isDone(task)) hasDone = true;
    else hasIncomplete = true;
    pending.push(...(childrenByParent.get(currentId) ?? []).map((child) => child.id));
  }

  if (hasDone && !hasIncomplete) return "all_complete";
  if (hasDone && hasIncomplete) return "partially_incomplete";
  return "all_incomplete";
}

export function flattenTodoTreeByCompletion(
  tasks: TodoTask[],
  collapsedIds: Set<string> = new Set()
): FlatTodoTask[] {
  const flat = flattenTodoTree(tasks, collapsedIds);
  const blocks: FlatTodoTask[][] = [];
  for (const item of flat) {
    if (item.depth === 0 || blocks.length === 0) blocks.push([item]);
    else blocks[blocks.length - 1].push(item);
  }
  return blocks
    .map((items, index) => ({ items, index }))
    .sort((left, right) => {
      const leftPinned = Boolean(left.items[0]?.task.pinned);
      const rightPinned = Boolean(right.items[0]?.task.pinned);
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
      if (leftPinned && rightPinned) return left.index - right.index;
      const leftRoot = left.items[0]?.task.id ?? "";
      const rightRoot = right.items[0]?.task.id ?? "";
      return (
        completionRank[todoTreeCompletion(tasks, leftRoot)] -
          completionRank[todoTreeCompletion(tasks, rightRoot)] ||
        left.index - right.index
      );
    })
    .flatMap(({ items }) => items);
}

export function indentTask(tasks: TodoTask[], taskId: string): TodoTask[] {
  const flat = flattenTodoTreeByCompletion(tasks);
  const index = flat.findIndex(({ task }) => task.id === taskId);
  if (index <= 0) return tasks;
  const previous = flat[index - 1].task;
  if (previous.id === taskId || isDescendant(tasks, previous.id, taskId)) return tasks;
  const childCount = tasks.filter((task) => task.parentId === previous.id).length;
  return normalizeTodoPositions(
    tasks.map((task) =>
      task.id === taskId ? { ...task, parentId: previous.id, position: childCount } : task
    )
  );
}

export function outdentTask(tasks: TodoTask[], taskId: string): TodoTask[] {
  const current = tasks.find((task) => task.id === taskId);
  if (!current?.parentId) return tasks;
  const parent = tasks.find((task) => task.id === current.parentId);
  if (!parent) return tasks;
  const nextPosition = parent.position + 1;
  const changed = tasks.map((task) => {
    if (task.id === taskId) {
      return { ...task, parentId: parent.parentId, position: nextPosition };
    }
    if (task.parentId === parent.parentId && task.id !== parent.id && task.position >= nextPosition) {
      return { ...task, position: task.position + 1 };
    }
    return task;
  });
  return normalizeTodoPositions(changed);
}

export function insertSiblingTask(
  tasks: TodoTask[],
  taskId: string,
  newTask: TodoTask,
  placement: "before" | "after" = "after"
): TodoTask[] {
  const current = tasks.find((task) => task.id === taskId);
  if (!current) return normalizeTodoPositions([...tasks, newTask]);
  const position = current.position + (placement === "after" ? 1 : 0);
  const shifted = tasks.map((task) =>
    task.parentId === current.parentId && task.position >= position
      ? { ...task, position: task.position + 1 }
      : task
  );
  return normalizeTodoPositions([
    ...shifted,
    { ...newTask, parentId: current.parentId, position }
  ]);
}

export function removeTaskTree(tasks: TodoTask[], taskId: string): TodoTask[] {
  const removed = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.parentId && removed.has(task.parentId) && !removed.has(task.id)) {
        removed.add(task.id);
        changed = true;
      }
    }
  }
  return normalizeTodoPositions(tasks.filter((task) => !removed.has(task.id)));
}

export function moveTaskAsChild(tasks: TodoTask[], taskId: string, parentId: string): TodoTask[] {
  if (taskId === parentId || isDescendant(tasks, parentId, taskId)) return tasks;
  const position = tasks.filter((task) => task.parentId === parentId).length;
  return normalizeTodoPositions(
    tasks.map((task) => (task.id === taskId ? { ...task, parentId, position } : task))
  );
}

export type TaskDropPlacement = "before" | "inside" | "after";

export function moveTaskRelative(
  tasks: TodoTask[],
  taskId: string,
  targetId: string,
  placement: TaskDropPlacement
): TodoTask[] {
  if (taskId === targetId || isDescendant(tasks, targetId, taskId)) return tasks;
  if (placement === "inside") return moveTaskAsChild(tasks, taskId, targetId);

  const normalized = normalizeTodoPositions(tasks);
  const moving = normalized.find((task) => task.id === taskId);
  const target = normalized.find((task) => task.id === targetId);
  if (!moving || !target) return tasks;

  const targetSiblings = normalized
    .filter((task) => task.parentId === target.parentId && task.id !== taskId)
    .sort((left, right) => left.position - right.position);
  const targetIndex = targetSiblings.findIndex((task) => task.id === targetId);
  if (targetIndex < 0) return tasks;

  const insertAt = targetIndex + (placement === "after" ? 1 : 0);
  const reordered = targetSiblings.slice();
  reordered.splice(insertAt, 0, { ...moving, parentId: target.parentId });
  const positions = new Map(reordered.map((task, index) => [task.id, index]));

  return normalizeTodoPositions(
    normalized.map((task) => {
      if (task.id === taskId) {
        return { ...task, parentId: target.parentId, position: positions.get(task.id) ?? 0 };
      }
      if (task.parentId === target.parentId && positions.has(task.id)) {
        return { ...task, position: positions.get(task.id) ?? task.position };
      }
      return task;
    })
  );
}

function isDescendant(tasks: TodoTask[], taskId: string, ancestorId: string) {
  let current = tasks.find((task) => task.id === taskId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    visited.add(current.id);
    current = tasks.find((task) => task.id === current?.parentId);
  }
  return false;
}
