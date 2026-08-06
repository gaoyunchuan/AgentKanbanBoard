import type { TodoTask } from "./types";

export const TODO_RECENCY_WINDOW_MS = 168 * 60 * 60 * 1000;

// 与后端 TodoTaskInput 保持一致，避免纯前端元数据变化被误判为业务任务变动。
const persistedFields = [
  "parentId",
  "position",
  "title",
  "status",
  "pinned",
  "startDate",
  "expectedEndDate",
  "actualEndDate",
  "processTracking",
  "resultReview"
] as const satisfies readonly (keyof TodoTask)[];

export function normalizeTodoTitleForPersistence(title: string) {
  return title.trim() || "未命名任务";
}

function persistedFieldValue(
  task: TodoTask,
  field: (typeof persistedFields)[number]
) {
  // 标题保存前会去除首尾空白并填充默认值，变动判断必须使用相同语义。
  return field === "title"
    ? normalizeTodoTitleForPersistence(task.title)
    : task[field];
}

export function isTodoTaskRecentlyUpdated(task: TodoTask, nowMs: number) {
  if (!task.updatedAt) return false;
  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isNaN(updatedAtMs)) return false;
  return updatedAtMs >= nowMs - TODO_RECENCY_WINDOW_MS && updatedAtMs <= nowMs;
}

export function stampChangedTodoTasks(
  previous: TodoTask[],
  next: TodoTask[],
  nowIso: string
) {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  return next.map((task) => {
    const before = previousById.get(task.id);
    const changed =
      !before ||
      persistedFields.some(
        (field) => persistedFieldValue(before, field) !== persistedFieldValue(task, field)
      );
    return changed
      ? { ...task, updatedAt: nowIso }
      : { ...task, updatedAt: before.updatedAt };
  });
}
