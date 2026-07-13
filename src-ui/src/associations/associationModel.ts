import type { ThreadItem } from "@/types";
import { flattenTodoTree, flattenTodoTreeByCompletion } from "@/todo/todoTree";
import type { TodoTask } from "@/todo/types";
import type { AssociationOption, ThreadTaskLink } from "./types";

const isSelectableTask = (task: TodoTask) =>
  task.status === "todo" || task.status === "in_progress";

const normalizeQuery = (query: string) => query.trim().toLocaleLowerCase();

function taskPath(task: TodoTask, tasksById: Map<string, TodoTask>): string {
  const path = [task.title];
  const visited = new Set([task.id]);
  let parentId = task.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = tasksById.get(parentId);
    if (!parent) break;
    path.unshift(parent.title);
    parentId = parent.parentId;
  }
  return path.join(" / ");
}

function hasSelectableDescendant(
  taskId: string,
  childrenByParent: Map<string, TodoTask[]>
): boolean {
  const children = childrenByParent.get(taskId) ?? [];
  return children.some(
    (child) => isSelectableTask(child) || hasSelectableDescendant(child.id, childrenByParent)
  );
}

export function buildTaskAssociationOptions(
  tasks: TodoTask[],
  currentTaskId: string | undefined,
  query: string
): AssociationOption[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const normalizedQuery = normalizeQuery(query);
  const current = currentTaskId ? tasksById.get(currentTaskId) : undefined;

  if (normalizedQuery) {
    const matches = flattenTodoTree(tasks)
      .filter(({ task }) => {
        if (!isSelectableTask(task) || task.id === currentTaskId) return false;
        return taskPath(task, tasksById).toLocaleLowerCase().includes(normalizedQuery);
      })
      .map(({ task }) => ({
        id: task.id,
        label: task.title,
        description: taskPath(task, tasksById),
        depth: 0
      }));
    if (current && taskPath(current, tasksById).toLocaleLowerCase().includes(normalizedQuery)) {
      return [
        {
          id: current.id,
          label: current.title,
          description: "当前关联",
          depth: 0,
          current: true,
          disabled: true
        },
        ...matches
      ];
    }
    return matches;
  }

  const childrenByParent = new Map<string, TodoTask[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    childrenByParent.set(task.parentId, [
      ...(childrenByParent.get(task.parentId) ?? []),
      task
    ]);
  }

  const options = flattenTodoTree(tasks).flatMap<AssociationOption>(({ task, depth }) => {
    if (task.id === currentTaskId) return [];
    if (isSelectableTask(task)) {
      return [{ id: task.id, label: task.title, depth }];
    }
    if (hasSelectableDescendant(task.id, childrenByParent)) {
      return [{ id: task.id, label: task.title, depth, disabled: true }];
    }
    return [];
  });

  return current
    ? [
        {
          id: current.id,
          label: current.title,
          description: "当前关联",
          depth: 0,
          current: true,
          disabled: true
        },
        ...options
      ]
    : options;
}

export function buildThreadAssociationOptions(
  threads: ThreadItem[],
  linksByThread: Map<string, ThreadTaskLink>,
  currentTaskId: string,
  projectNames: Map<string, string>,
  query: string
): AssociationOption[] {
  const normalizedQuery = normalizeQuery(query);
  const eligible = threads.filter(
    (thread) =>
      (thread.boardStatus === "review_pending" || thread.boardStatus === "suspended") &&
      linksByThread.get(thread.id)?.taskId !== currentTaskId
  );
  const ordered = [
    ...eligible.filter((thread) => thread.boardStatus === "review_pending"),
    ...eligible.filter((thread) => thread.boardStatus === "suspended")
  ];

  return ordered.flatMap<AssociationOption>((thread) => {
    const projectName = projectNames.get(thread.projectId) ?? thread.projectId;
    const previousTaskId = linksByThread.get(thread.id)?.taskId;
    const description = [
      projectName,
      previousTaskId ? `当前关联：${previousTaskId}` : undefined
    ]
      .filter(Boolean)
      .join(" · ");
    const searchable = `${thread.title} ${projectName} ${previousTaskId ?? ""}`.toLocaleLowerCase();
    if (normalizedQuery && !searchable.includes(normalizedQuery)) return [];
    return [
      {
        id: thread.id,
        label: thread.title,
        description,
        group: thread.boardStatus === "review_pending" ? "待审核" : "挂起",
        depth: 0
      }
    ];
  });
}

export function todoTargetPage(
  tasks: TodoTask[],
  taskId: string,
  pageSize: number
): number | undefined {
  const index = flattenTodoTreeByCompletion(tasks).findIndex(({ task }) => task.id === taskId);
  return index < 0 ? undefined : Math.floor(index / pageSize) + 1;
}
