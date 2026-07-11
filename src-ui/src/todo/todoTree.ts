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

export function indentTask(tasks: TodoTask[], taskId: string): TodoTask[] {
  const flat = flattenTodoTree(tasks);
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
  newTask: TodoTask
): TodoTask[] {
  const current = tasks.find((task) => task.id === taskId);
  if (!current) return normalizeTodoPositions([...tasks, newTask]);
  const position = current.position + 1;
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
