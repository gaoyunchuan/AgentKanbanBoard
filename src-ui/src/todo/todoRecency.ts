import type { TodoTask } from "./types";

export const TODO_RECENCY_WINDOW_MS = 168 * 60 * 60 * 1000;

// 排序位置仍会持久化，但插入或删除任务可能连带重排大量兄弟任务；
// 周视图只追踪任务本身的业务变化，因此 position 不参与活动时间判定。
const activityFields = [
  "parentId",
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
  field: (typeof activityFields)[number]
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
      activityFields.some(
        (field) => persistedFieldValue(before, field) !== persistedFieldValue(task, field)
      );
    return changed
      ? { ...task, updatedAt: nowIso }
      : { ...task, updatedAt: before.updatedAt };
  });
}
