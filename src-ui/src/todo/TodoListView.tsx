import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Filter,
  GripVertical,
  Link2,
  ListTodo,
  Minus,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ThreadItem } from "@/types";
import type { ThreadTaskLink } from "@/associations/types";
import { todoTargetPage } from "@/associations/associationModel";
import { TaskThreadAssociationPanel } from "@/associations/TaskThreadAssociationPanel";
import { TodoCollapsedExtensionSummary } from "./TodoCollapsedExtensionSummary";
import { MarkdownText } from "./markdownLinks";
import {
  flattenTodoTreeByCompletion,
  indentTask,
  insertSiblingTask,
  moveTaskRelative,
  normalizeTodoPins,
  normalizeTodoPositions,
  outdentTask,
  removeTaskTree,
  todoTreeCompletion
} from "./todoTree";
import type { TaskDropPlacement } from "./todoTree";
import type { BackendTodoTask, TodoStatus, TodoTask } from "./types";
import {
  isTodoTaskRecentlyUpdated,
  normalizeTodoTitleForPersistence,
  stampChangedTodoTasks
} from "./todoRecency";
import { useTodoGridLayout } from "./useTodoGridLayout";
import { mergeTodoSnapshot, todoEditPayload, todoEdits } from "./todoPersistence";
import { useWorkbench } from "@/workbench/useWorkbench";
import { TaskExecutionPanel, WorkStatusBadge } from "@/workbench/TaskExecutionPanel";
import { needsAttention, type WorkTask } from "@/workbench/types";
import { RuntimeSettings } from "@/workbench/RuntimeSettings";

type DateField = "expectedEndDate" | "actualEndDate";
type ExtensionField = "processTracking" | "resultReview";
type TodoTaskDropPlacement = Exclude<TaskDropPlacement, "inside">;
const exactNamedHttpLinkPattern = /^\[([^\]]+)]\((https?:\/\/[^\s)]+)\)$/;

function isValidExtensionUrl(value: string) {
  const target = value.trim();
  if (!/^https?:\/\/[^\s)]+$/.test(target)) return false;
  try {
    const parsed = new URL(target);
    return Boolean(parsed.hostname) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

type Props = {
  initialTasks?: TodoTask[];
  persistTasks?: (tasks: TodoTask[]) => Promise<void> | void;
  openLink?: (url: string) => Promise<void> | void;
  today?: () => string;
  now?: () => number;
  onCountChange?: (count: number) => void;
  threads?: ThreadItem[];
  projectNames?: Map<string, string>;
  linksByThread?: Map<string, ThreadTaskLink>;
  linksLoading?: boolean;
  linksLoadError?: string;
  savingThreadIds?: Set<string>;
  navigationTarget?: { taskId: string; requestId: number };
  onTasksChange?: (tasks: TodoTask[]) => void;
  onTasksPersisted?: (tasks: TodoTask[]) => void;
  onExpandTask?: (taskId: string) => void;
  onLoadThreadLinks?: (force?: boolean) => Promise<void>;
  onAssignThread?: (threadId: string, taskId: string) => Promise<void>;
  onUnlinkThread?: (threadId: string) => Promise<void>;
  onOpenThread?: (thread: ThreadItem) => void;
  onNavigationError?: (message: string) => void;
};

const statusLabels: Record<TodoStatus, string> = {
  todo: "未完成",
  in_progress: "进行中",
  cancelled: "已取消",
  completed: "已完成"
};

const dateLabels: Record<DateField, string> = {
  expectedEndDate: "预期结束日期",
  actualEndDate: "实际结束日期"
};
const todoPageSize = 200;

function taskDropPlacement(
  clientY: number,
  rect: Pick<DOMRect, "top" | "height">
): TodoTaskDropPlacement {
  return clientY - rect.top < rect.height / 2 ? "before" : "after";
}

const emptyTask = (id: string, parentId: string | undefined, position: number): TodoTask => ({
  id,
  parentId,
  position,
  title: "",
  status: "todo",
  pinned: false,
  processTracking: "",
  resultReview: ""
});

const newTask = (
  id: string,
  parentId: string | undefined,
  position: number,
  today: string
): TodoTask => ({
  ...emptyTask(id, parentId, position),
  expectedEndDate: nextLocalDate(today),
  createdAt: `${today}T00:00:00`
});

type TitleFocusMode = "select-all" | "caret-end";

export function TodoListView({
  initialTasks,
  persistTasks,
  openLink,
  today = localToday,
  now = Date.now,
  onCountChange,
  threads = [],
  projectNames = new Map(),
  linksByThread = new Map(),
  linksLoading = false,
  linksLoadError,
  savingThreadIds = new Set(),
  navigationTarget,
  onTasksChange,
  onTasksPersisted,
  onExpandTask,
  onLoadThreadLinks,
  onAssignThread,
  onUnlinkThread,
  onOpenThread,
  onNavigationError
}: Props) {
  const [tasks, setTasks] = useState<TodoTask[]>(() =>
    normalizeTodoPins(initialTasks ?? [])
  );
  const [tasksReady, setTasksReady] = useState(initialTasks !== undefined);
  const [executionTaskId, setExecutionTaskId] = useState<string>();
  const [saveError, setSaveError] = useState(false);
  const workbenchEnabled = isTauriRuntime();
  const workbench = useWorkbench(workbenchEnabled);
  const workById = useMemo(() => new Map(workbench.data.tasks.map((task) => [task.task_id, task])), [workbench.data.tasks]);
  const attentionTasks = workbench.data.tasks.filter(needsAttention);
  const executionTask = tasks.find((task) => task.id === executionTaskId);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TodoStatus>("all");
  const [weekViewEnabled, setWeekViewEnabled] = useState(false);
  const [recencyNow, setRecencyNow] = useState(() => now());
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string>();
  const [statusMenuId, setStatusMenuId] = useState<string>();
  const [editingDate, setEditingDate] = useState<{ taskId: string; field: DateField }>();
  const [titleFocus, setTitleFocus] = useState<{ taskId: string; mode: TitleFocusMode }>();
  const [draggedId, setDraggedId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{
    taskId: string;
    placement: TodoTaskDropPlacement;
  }>();
  const [message, setMessage] = useState(
    "⌘⇧Enter 向上新建 · ⌘Enter 向后新建 · Tab 缩进 · Shift+Tab 提升层级"
  );
  const titleRefs = useRef(new Map<string, HTMLInputElement>());
  const saveQueue = useRef(Promise.resolve());
  const acknowledgedTasks = useRef<TodoTask[]>(tasks);
  const lastIntentTasks = useRef<TodoTask[]>(tasks);
  const latestTasks = useRef<TodoTask[]>(tasks);
  const saveEpoch = useRef(0);
  const failedSaveEpoch = useRef(0);
  const handledNavigationRequest = useRef<number>();
  const pendingNavigationId = useRef<string>();
  const navigatingFilters = useRef(false);
  const listContainerRef = useRef<HTMLDivElement>(null);
  useTodoGridLayout(listContainerRef);

  useEffect(() => {
    if (!onLoadThreadLinks) return;
    void onLoadThreadLinks().catch(() => undefined);
  }, [onLoadThreadLinks]);

  useEffect(() => {
    if (initialTasks) return;
    let cancelled = false;
    if (!isTauriRuntime()) {
      const demo = demoTasks();
      setTasks(demo);
      acknowledgedTasks.current = demo;
      lastIntentTasks.current = demo;
      latestTasks.current = demo;
      setTasksReady(true);
      onTasksChange?.(demo);
      return;
    }
    void invoke<BackendTodoTask[]>("load_todo_tasks")
      .then((records) => {
        if (!cancelled) {
          const loaded = records.map(mapBackendTodoTask);
          setTasks(loaded);
          acknowledgedTasks.current = loaded;
          lastIntentTasks.current = loaded;
          latestTasks.current = loaded;
          setTasksReady(true);
          onTasksChange?.(loaded);
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(`任务加载失败：${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [initialTasks]);

  const mergeServerTasks = (remote: TodoTask[], base = acknowledgedTasks.current) => {
    const merged = mergeTodoSnapshot(base, latestTasks.current, remote);
    lastIntentTasks.current = mergeTodoSnapshot(base, lastIntentTasks.current, remote);
    acknowledgedTasks.current = remote;
    latestTasks.current = merged;
    setTasks(merged);
    onTasksChange?.(merged);
    onTasksPersisted?.(remote);
  };

  const refreshExecutionTasks = async () => {
    await workbench.refresh();
    if (!workbenchEnabled) return;
    await saveQueue.current;
    const epoch = saveEpoch.current;
    const remote = await invoke<BackendTodoTask[]>("load_todo_tasks");
    if (saveEpoch.current === epoch && Array.isArray(remote)) mergeServerTasks(remote.map(mapBackendTodoTask));
  };

  const workRevision = workbench.data.tasks.map((task) => `${task.task_id}:${task.revision}:${task.status}`).join("|");
  useEffect(() => {
    if (!workbenchEnabled || !tasksReady || !workRevision) return;
    void refreshExecutionTasks().catch((error) => setMessage(`执行状态刷新失败：${String(error)}`));
  }, [workRevision, tasksReady, workbenchEnabled]);

  useEffect(() => onCountChange?.(tasks.length), [onCountChange, tasks.length]);

  useEffect(() => {
    if (!weekViewEnabled) return;
    setRecencyNow(now());
    const timer = window.setInterval(() => setRecencyNow(now()), 60_000);
    return () => window.clearInterval(timer);
  }, [now, weekViewEnabled]);

  useEffect(() => {
    if (!titleFocus) return;
    const input = titleRefs.current.get(titleFocus.taskId);
    if (!input) return;
    input.focus();
    // 空任务删除后要从上一标题末尾继续退格；其他聚焦场景仍全文选中以便直接录入。
    if (titleFocus.mode === "caret-end") {
      const caretPosition = input.value.length;
      input.setSelectionRange(caretPosition, caretPosition);
    } else {
      input.select();
    }
    if (pendingNavigationId.current === titleFocus.taskId) {
      input.scrollIntoView?.({ block: "center" });
      pendingNavigationId.current = undefined;
    }
    setTitleFocus(undefined);
  }, [titleFocus, tasks]);

  const flatTasks = useMemo(() => flattenTodoTreeByCompletion(tasks), [tasks]);
  const visibleIds = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matched = new Set(
      tasks
        .filter(
          (task) =>
            (!normalizedQuery ||
              [task.title, task.processTracking, task.resultReview]
                .join(" ")
                .toLowerCase()
                .includes(normalizedQuery)) &&
            (statusFilter === "all" || task.status === statusFilter) &&
            (!weekViewEnabled || isTodoTaskRecentlyUpdated(task, recencyNow))
        )
        .map((task) => task.id)
    );
    for (const id of [...matched]) {
      let current = tasks.find((task) => task.id === id);
      while (current?.parentId) {
        matched.add(current.parentId);
        current = tasks.find((task) => task.id === current?.parentId);
      }
    }
    return matched;
  }, [query, recencyNow, statusFilter, tasks, weekViewEnabled]);
  const visibleTasks = flatTasks.filter(({ task }) => visibleIds.has(task.id));
  const pageCount = Math.max(1, Math.ceil(visibleTasks.length / todoPageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedTasks = visibleTasks.slice(
    (currentPage - 1) * todoPageSize,
    currentPage * todoPageSize
  );

  useEffect(() => {
    if (navigatingFilters.current) {
      navigatingFilters.current = false;
      return;
    }
    setPage(1);
  }, [query, statusFilter, weekViewEnabled]);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  useEffect(() => {
    if (!navigationTarget || !tasksReady) return;
    if (handledNavigationRequest.current === navigationTarget.requestId) return;
    const target = tasks.find((task) => task.id === navigationTarget.taskId);
    if (!target) {
      handledNavigationRequest.current = navigationTarget.requestId;
      onNavigationError?.("关联的 Task 已不存在");
      return;
    }

    handledNavigationRequest.current = navigationTarget.requestId;
    navigatingFilters.current =
      query !== "" || statusFilter !== "all" || weekViewEnabled;
    setQuery("");
    setStatusFilter("all");
    setWeekViewEnabled(false);
    setPage(todoTargetPage(tasks, target.id, todoPageSize) ?? 1);
    setExpandedId(target.id);
    pendingNavigationId.current = target.id;
    setTitleFocus({ taskId: target.id, mode: "select-all" });
  }, [navigationTarget, onNavigationError, query, statusFilter, tasks, tasksReady, weekViewEnabled]);

  const saveSnapshot = (next: TodoTask[]) => {
    const edits = todoEdits(lastIntentTasks.current, next);
    lastIntentTasks.current = next;
    if (!edits.length) return saveQueue.current;
    const epoch = ++saveEpoch.current;
    const failureAtEnqueue = failedSaveEpoch.current;
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (failureAtEnqueue !== failedSaveEpoch.current) return;
        if (persistTasks) {
          await persistTasks(next);
          acknowledgedTasks.current = next;
          onTasksPersisted?.(next);
        } else if (isTauriRuntime()) {
          const payload = todoEditPayload(edits, acknowledgedTasks.current);
          const remote = await invoke<BackendTodoTask[]>("save_todo_task_changes", {
            before: payload.before.map(mapTodoTaskInput),
            after: payload.after.map(mapTodoTaskInput)
          });
          if (!Array.isArray(remote)) throw new Error("任务保存没有返回有效的数据快照。");
          mergeServerTasks(remote.map(mapBackendTodoTask), next);
        } else {
          acknowledgedTasks.current = next;
          onTasksPersisted?.(next);
        }
        setSaveError(false);
        setMessage("已保存");
      })
      .catch(async (error) => {
        failedSaveEpoch.current = epoch;
        if (isTauriRuntime()) {
          try {
            const remote = await invoke<BackendTodoTask[]>("load_todo_tasks");
            if (Array.isArray(remote)) mergeServerTasks(remote.map(mapBackendTodoTask));
          } catch { /* Keep the draft and the last acknowledged baseline for an explicit retry. */ }
        }
        lastIntentTasks.current = acknowledgedTasks.current;
        setSaveError(true);
        setMessage(`保存失败，本地修改仍保留：${String(error)}`);
      });
    return saveQueue.current;
  };

  const applyTasks = (
    next: TodoTask[],
    options?: {
      focusId?: string;
      focusMode?: TitleFocusMode;
      focusPage?: number;
      persist?: boolean;
    }
  ) => {
    // 所有交互共用这一入口，避免缩进或跨层级移动后把置顶状态遗留在子任务上。
    const normalized = normalizeTodoPins(normalizeTodoPositions(next));
    // 后端仍生成权威时间；本地只给实际变化任务打戳，让启用中的周视图即时响应。
    const timestamped = stampChangedTodoTasks(
      tasks,
      normalized,
      new Date(now()).toISOString()
    );
    setTasks(timestamped);
    latestTasks.current = timestamped;
    onTasksChange?.(timestamped);
    if (options?.focusId) {
      if (options.focusPage) {
        setPage(options.focusPage);
      } else {
        const focusIndex = flattenTodoTreeByCompletion(timestamped).findIndex(
          ({ task }) => task.id === options.focusId
        );
        if (focusIndex >= 0) setPage(Math.floor(focusIndex / todoPageSize) + 1);
      }
      setTitleFocus({ taskId: options.focusId, mode: options.focusMode ?? "select-all" });
    }
    if (options?.persist !== false) void saveSnapshot(timestamped);
  };

  const updateTask = (taskId: string, patch: Partial<TodoTask>, persist = true) => {
    applyTasks(
      tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
      { persist }
    );
  };

  const addRootTask = () => {
    const id = createId();
    const position = tasks.filter((task) => !task.parentId).length;
    applyTasks([...tasks, newTask(id, undefined, position, today())], { focusId: id });
  };

  const addChildTask = (parentId: string) => {
    const id = createId();
    const position = tasks.filter((task) => task.parentId === parentId).length;
    applyTasks([...tasks, newTask(id, parentId, position, today())], { focusId: id });
  };

  const addSiblingTask = (taskId: string, placement: "before" | "after" = "after") => {
    const id = createId();
    applyTasks(insertSiblingTask(tasks, taskId, newTask(id, undefined, 0, today()), placement), {
      focusId: id
    });
  };

  const toggleCompleted = (task: TodoTask) => {
    if (workById.has(task.id)) { setExecutionTaskId(task.id); return; }
    const completed = task.status !== "completed";
    updateTask(task.id, {
      status: completed ? "completed" : "todo",
      actualEndDate: completed ? today() : undefined
    });
  };

  const setStatus = (task: TodoTask, status: TodoStatus) => {
    if (workById.has(task.id)) { setStatusMenuId(undefined); setExecutionTaskId(task.id); return; }
    updateTask(task.id, {
      status,
      actualEndDate: status === "completed" ? task.actualEndDate ?? today() : undefined
    });
    setStatusMenuId(undefined);
  };

  const togglePinned = (task: TodoTask) => {
    if (task.parentId) return;
    updateTask(task.id, { pinned: !task.pinned });
    setStatusMenuId(undefined);
  };

  const openExternalLink = (url: string) => {
    if (openLink) return void openLink(url);
    if (isTauriRuntime()) {
      void invoke("open_external_link", { target: url }).catch((error) =>
        setMessage(`链接打开失败：${String(error)}`)
      );
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const removableTree = (task: TodoTask) => {
    const remaining = removeTaskTree(tasks, task.id);
    const retainedIds = new Set(remaining.map((candidate) => candidate.id));
    const active = workbench.data.tasks.find((managed) => !retainedIds.has(managed.task_id) && tasks.some((candidate) => candidate.id === managed.task_id) && !["completed", "cancelled"].includes(managed.status));
    if (active) {
      setExecutionTaskId(active.task_id);
      setMessage("此任务树仍有执行中的任务，请先在工作台取消相关任务后再删除。");
      return undefined;
    }
    return remaining;
  };

  const deleteTask = (task: TodoTask) => {
    const remaining = removableTree(task);
    if (!remaining) return;
    const descendants = tasks.length - remaining.length - 1;
    if (descendants > 0 && !window.confirm(`删除“${task.title || "未命名任务"}”及其 ${descendants} 个子任务？`)) {
      return;
    }
    applyTasks(remaining);
    setExpandedId((current) => (current === task.id ? undefined : current));
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 gap-3 p-3">
      <div
        ref={listContainerRef}
        className={cn("todo-list-container min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border bg-card shadow-sm", executionTask ? "hidden xl:flex" : "flex")}
      >
        <RuntimeSettings enabled={workbenchEnabled} runtime={workbench.data.runtime} onChanged={workbench.refresh} />
        {workbench.error && <div role="alert" className="flex items-center justify-between gap-2 border-b bg-red-50 px-3 py-2 text-[11px] text-red-800"><span className="break-all">执行服务不可用：{workbench.error}</span><Button size="sm" variant="ghost" onClick={() => void workbench.refresh()}>重试</Button></div>}
        {attentionTasks.length > 0 && <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-3 py-2"><span className="text-[11px] font-medium text-amber-900">需要我 · {attentionTasks.length}</span>{attentionTasks.map((managed) => <button key={managed.task_id} onClick={() => setExecutionTaskId(managed.task_id)} className="flex min-w-0 max-w-[240px] items-center gap-2 rounded border border-amber-200 bg-white px-2 py-1 text-[11px]"><span className="truncate">{managed.title}</span><WorkStatusBadge task={managed} /></button>)}</div>}
        <div role="toolbar" aria-label="任务筛选与新建" className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={addRootTask}>
              <Plus className="h-3.5 w-3.5" />
              新建任务
            </Button>
            <div className="relative w-[320px] max-w-[42vw]">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索任务、过程与复盘"
                className="h-8 pl-8"
                aria-label="搜索任务"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as "all" | TodoStatus)}
              className="h-8 rounded-md border bg-card px-2 text-[12px] outline-none focus:ring-2 focus:ring-ring"
              aria-label="状态筛选"
            >
              <option value="all">全部状态</option>
              <option value="todo">未完成</option>
              <option value="in_progress">进行中</option>
              <option value="completed">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(
                weekViewEnabled &&
                  "border-primary/50 bg-primary/10 text-primary shadow-sm hover:bg-primary/15"
              )}
              aria-pressed={weekViewEnabled}
              onClick={() => {
                setRecencyNow(now());
                setWeekViewEnabled((enabled) => !enabled);
              }}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              周视图
            </Button>
          </div>
        </div>

        <div
          data-todo-grid-header
          className="todo-grid grid border-b bg-secondary/25 px-3 py-1.5 text-[10px] font-medium text-muted-foreground"
        >
          <div className="flex items-center gap-2 pl-1"><ListTodo className="h-3.5 w-3.5" />任务</div>
          <div>Agent / 关联 Thread</div>
          <div className="flex items-center gap-1">预期结束日期<span className="font-normal text-muted-foreground/70">· 双击编辑</span></div>
          <div>实际结束日期</div>
          <div aria-hidden="true" />
        </div>

        <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
          {visibleTasks.length === 0 ? (
            <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 text-muted-foreground">
              <CircleDashed className="h-8 w-8 text-border" />
              <div className="text-[13px]">{tasks.length === 0 ? "还没有任务" : "没有匹配的任务"}</div>
              {tasks.length === 0 && (
                <Button variant="outline" size="sm" onClick={addRootTask}>创建第一个任务</Button>
              )}
            </div>
          ) : (
            pagedTasks.map(({ task, depth }) => (
              <div key={task.id}>
                <div
                  data-task-row
                  data-depth={depth}
                  data-pinned={depth === 0 && task.pinned ? "true" : undefined}
                  data-drop-placement={dropTarget?.taskId === task.id ? dropTarget.placement : undefined}
                  className={cn(
                    "todo-grid group relative grid min-h-9 items-center border-b px-3 transition-colors",
                    depth === 0 && task.pinned
                      ? "bg-emerald-50 hover:bg-emerald-100/80 dark:bg-emerald-950/35 dark:hover:bg-emerald-950/50"
                      : expandedId === task.id
                        ? "bg-accent/55"
                        : "hover:bg-accent/35",
                    draggedId && draggedId !== task.id && "hover:bg-primary/5",
                    dropTarget?.taskId === task.id && dropTarget.placement === "before" && "before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5 before:bg-primary",
                    dropTarget?.taskId === task.id && dropTarget.placement === "after" && "after:absolute after:inset-x-0 after:bottom-0 after:z-10 after:h-0.5 after:bg-primary"
                  )}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!draggedId || draggedId === task.id) return;
                    const draggedTask = tasks.find((item) => item.id === draggedId);
                    if (
                      draggedTask &&
                      !draggedTask.parentId &&
                      !task.parentId &&
                      todoTreeCompletion(tasks, draggedId) !== todoTreeCompletion(tasks, task.id)
                    ) {
                      setDropTarget(undefined);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDropTarget({
                      taskId: task.id,
                      placement: taskDropPlacement(event.clientY, rect)
                    });
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggedId || draggedId === task.id) return;
                    const draggedTask = tasks.find((item) => item.id === draggedId);
                    if (
                      draggedTask &&
                      !draggedTask.parentId &&
                      !task.parentId &&
                      todoTreeCompletion(tasks, draggedId) !== todoTreeCompletion(tasks, task.id)
                    ) {
                      setDraggedId(undefined);
                      setDropTarget(undefined);
                      return;
                    }
                    const placement =
                      dropTarget?.taskId === task.id
                        ? dropTarget.placement
                        : taskDropPlacement(
                            event.clientY,
                            event.currentTarget.getBoundingClientRect()
                          );
                    applyTasks(moveTaskRelative(tasks, draggedId, task.id, placement), { focusId: draggedId });
                    setDraggedId(undefined);
                    setDropTarget(undefined);
                  }}
                >
                  <div className="relative flex min-w-0 items-start py-1" style={{ paddingLeft: `${depth * 28}px` }}>
                    {depth > 0 && (
                      <>
                        <span aria-hidden="true" className="pointer-events-none absolute bottom-0 top-0 border-l border-dashed border-border" style={{ left: `${depth * 28 - 14}px` }} />
                        {/* 摘要会拉高整行，横向连接线必须固定在标题首行中心，不能使用整行 50%。 */}
                        <span aria-hidden="true" className="pointer-events-none absolute top-[18px] w-3 border-t border-dashed border-border" style={{ left: `${depth * 28 - 14}px` }} />
                      </>
                    )}
                    <button
                      draggable
                      aria-label={`拖动 ${task.title || "未命名任务"}`}
                      className="mr-0.5 mt-1 cursor-grab p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                      onDragStart={() => setDraggedId(task.id)}
                      onDragEnd={() => {
                        setDraggedId(undefined);
                        setDropTarget(undefined);
                      }}
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                    <button
                      aria-label={`${expandedId === task.id ? "收起" : "展开"} ${task.title || "未命名任务"}`}
                      className="mr-1 mt-1 rounded p-0.5 text-muted-foreground hover:bg-secondary"
                      onClick={() => {
                        const willExpand = expandedId !== task.id;
                        setExpandedId((current) => (current === task.id ? undefined : task.id));
                        if (willExpand) onExpandTask?.(task.id);
                      }}
                    >
                      {expandedId === task.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    </button>
                    {depth === 0 && task.pinned && (
                      <Pin
                        role="img"
                        aria-label={`已置顶 ${task.title || "未命名任务"}`}
                        className="mr-1 mt-1.5 h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300"
                      />
                    )}
                    <div className="relative mr-2 mt-1">
                      <button
                        aria-label={`${workById.has(task.id) ? "验收或调整" : task.status === "completed" ? "恢复" : "完成"} ${task.title || "未命名任务"}`}
                        title={workById.has(task.id) ? "在工作台验收、暂停或返工此 Agent 任务" : `${statusLabels[task.status]}；单击完成，右键选择状态`}
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-110",
                          task.status === "completed" && "bg-emerald-500 text-white",
                          task.status === "in_progress" && "text-primary",
                          task.status === "cancelled" && "bg-muted text-muted-foreground",
                          task.status === "todo" && "text-border hover:text-primary"
                        )}
                        onClick={() => toggleCompleted(task)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setStatusMenuId(task.id);
                        }}
                      >
                        <StatusIcon status={task.status} />
                      </button>
                      {statusMenuId === task.id && (
                        <StatusMenu task={task} onSelect={(status) => setStatus(task, status)} onOpenExecution={workById.has(task.id) ? () => { setStatusMenuId(undefined); setExecutionTaskId(task.id); } : undefined} onTogglePinned={depth === 0 ? () => togglePinned(task) : undefined} onDelete={() => deleteTask(task)} onClose={() => setStatusMenuId(undefined)} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <input
                        ref={(node) => {
                          if (node) titleRefs.current.set(task.id, node);
                          else titleRefs.current.delete(task.id);
                        }}
                        value={task.title}
                        aria-label="任务标题"
                        placeholder="输入任务描述"
                        className={cn(
                          "h-7 w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 text-[12px] font-medium outline-none transition-colors focus:border-primary focus:bg-card focus:ring-2 focus:ring-primary/10",
                          task.status === "completed" && "text-muted-foreground line-through",
                          task.status === "cancelled" && "text-muted-foreground line-through decoration-dashed"
                        )}
                        onChange={(event) => updateTask(task.id, { title: event.target.value }, false)}
                        onBlur={() => void saveSnapshot(tasks)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && event.metaKey) {
                            event.preventDefault();
                            addSiblingTask(task.id, event.shiftKey ? "before" : "after");
                          } else if (event.key === "Tab") {
                            event.preventDefault();
                            applyTasks(event.shiftKey ? outdentTask(tasks, task.id) : indentTask(tasks, task.id), { focusId: task.id });
                          } else if (event.key === "Backspace" && !task.title && tasks.length > 1) {
                            event.preventDefault();
                            const remaining = removableTree(task);
                            if (!remaining) return;
                            const index = visibleTasks.findIndex(
                              ({ task: item }) => item.id === task.id
                            );
                            const nextFocus =
                              visibleTasks[Math.max(0, index - 1)]?.task.id;
                            applyTasks(remaining, {
                              focusId: nextFocus,
                              focusMode: "caret-end",
                              focusPage:
                                Math.floor(Math.max(0, index - 1) / todoPageSize) + 1
                            });
                          }
                        }}
                      />
                      {expandedId !== task.id && (
                        <TodoCollapsedExtensionSummary
                          task={task}
                          onOpenLink={openExternalLink}
                        />
                      )}
                    </div>
                  </div>
                  <TaskThreadTags
                    task={task}
                    work={workById.get(task.id)}
                    onExecute={() => { void saveQueue.current.then(() => setExecutionTaskId(task.id)); }}
                    threads={threads}
                    linksByThread={linksByThread}
                    loading={linksLoading}
                    loadError={linksLoadError}
                    onRetry={onLoadThreadLinks}
                    onOpenThread={onOpenThread}
                  />
                  <DateCell task={task} field="expectedEndDate" editing={editingDate} onEdit={setEditingDate} onChange={(value) => updateTask(task.id, { expectedEndDate: value || undefined })} />
                  <DateCell task={task} field="actualEndDate" editing={editingDate} onEdit={setEditingDate} onChange={(value) => updateTask(task.id, { actualEndDate: value || undefined })} />
                  <div className="flex justify-end gap-0.5">
                    <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-60 transition-opacity hover:bg-secondary hover:text-primary group-hover:opacity-100" onClick={() => addChildTask(task.id)} aria-label={`为 ${task.title || "未命名任务"} 添加子任务`}>
                      <Plus className="h-3 w-3" />子任务
                    </button>
                    <button
                      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      onClick={(event) => {
                        // 真实浏览器会在离散事件内挂载外部监听器；阻止本次点击把刚打开的菜单立即关闭。
                        event.stopPropagation();
                        setStatusMenuId((current) => current === task.id ? undefined : task.id);
                      }}
                      aria-label={`设置 ${task.title || "未命名任务"}`}
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {expandedId === task.id && (
                  <ExtensionPanel
                    task={task}
                    onChange={(patch) => updateTask(task.id, patch)}
                    onOpenLink={openExternalLink}
                  >
                    {onAssignThread && onUnlinkThread && onOpenThread && (
                      <TaskThreadAssociationPanel
                        task={task}
                        threads={threads}
                        projectNames={projectNames}
                        linksByThread={linksByThread}
                        savingThreadIds={savingThreadIds}
                        onAssign={onAssignThread}
                        onUnlink={onUnlinkThread}
                        onOpenThread={onOpenThread}
                      />
                    )}
                  </ExtensionPanel>
                )}
              </div>
            ))
          )}
        </div>

        <div role="group" aria-label="任务分页" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t bg-card px-3 py-1.5 text-[10px] text-muted-foreground">
          <span className="whitespace-nowrap">第 {currentPage} / {pageCount} 页 · 共 {visibleTasks.length} 条</span>
          <span className="order-3 col-span-2 flex min-w-0 items-center gap-1"><span className="truncate" title={message}>{message}</span>{saveError && <button className="shrink-0 text-primary underline" onClick={() => void saveSnapshot(latestTasks.current)}>重试保存</button>}</span>
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</Button>
            <Button size="sm" variant="ghost" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>下一页</Button>
          </div>
        </div>
      </div>
      {executionTask && <TaskExecutionPanel key={executionTask.id} task={executionTask} tasks={tasks} work={workById.get(executionTask.id)} agents={workbench.data.agents} defaultWorkspace={threads.find((thread) => linksByThread.get(thread.id)?.taskId === executionTask.id)?.cwd ?? ""} enabled={workbenchEnabled} onClose={() => setExecutionTaskId(undefined)} onChanged={refreshExecutionTasks} />}
    </section>
  );
}

function DateCell({ task, field, editing, onEdit, onChange }: {
  task: TodoTask;
  field: DateField;
  editing?: { taskId: string; field: DateField };
  onEdit: (value?: { taskId: string; field: DateField }) => void;
  onChange: (value: string) => void;
}) {
  const isEditing = editing?.taskId === task.id && editing.field === field;
  const title = task.title || "未命名任务";
  const value = task[field] ?? "";
  if (isEditing) {
    return (
      <InlineDateEditor
        value={value}
        label={`编辑${title}的${dateLabels[field]}`}
        onCommit={(next) => {
          onChange(next);
          onEdit(undefined);
        }}
        onCancel={() => onEdit(undefined)}
      />
    );
  }
  return (
    <button
      className={cn(
        "flex h-full min-h-9 items-center text-left text-[11px] text-muted-foreground hover:text-foreground",
        field === "actualEndDate" && value && "font-medium text-emerald-600"
      )}
      aria-label={`${title}的${dateLabels[field]}`}
      title="双击编辑日期"
      onDoubleClick={() => onEdit({ taskId: task.id, field })}
    >
      {value || "—"}
    </button>
  );
}

function TaskThreadTags({
  task,
  work,
  onExecute,
  threads,
  linksByThread,
  loading,
  loadError,
  onRetry,
  onOpenThread
}: {
  task: TodoTask;
  work?: WorkTask;
  onExecute: () => void;
  threads: ThreadItem[];
  linksByThread: Map<string, ThreadTaskLink>;
  loading: boolean;
  loadError?: string;
  onRetry?: (force?: boolean) => Promise<void>;
  onOpenThread?: (thread: ThreadItem) => void;
}) {
  const execute = <button type="button" aria-label={`执行 ${task.title || "未命名任务"}`} title="在工作台委派与执行" onClick={onExecute} className="w-fit rounded px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10">{work ? <WorkStatusBadge task={work} /> : "交给 Agent"}</button>;
  if (loading) {
    return <div className="flex flex-wrap items-center gap-1">{execute}<span className="text-[10px] text-muted-foreground">关联加载中…</span></div>;
  }
  if (loadError) {
    return (
      <div className="flex flex-wrap items-center gap-1">{execute}<button
        type="button"
        aria-label="重试关联加载"
        className="w-fit rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
        onClick={() => void onRetry?.(true).catch(() => undefined)}
      >
        加载失败 · 重试
      </button></div>
    );
  }

  const linkedThreads = threads.filter(
    (thread) => linksByThread.get(thread.id)?.taskId === task.id
  );
  if (linkedThreads.length === 0) {
    return execute;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-1 py-1">
      {execute}
      {linkedThreads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          aria-label={`在 Codex 打开 Thread ${thread.title}`}
          title={thread.title}
          className="flex h-5 max-w-full min-w-0 items-center gap-1 rounded bg-primary/10 px-1.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
          onClick={() => onOpenThread?.(thread)}
        >
          <Link2 className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{thread.title}</span>
        </button>
      ))}
    </div>
  );
}

function InlineDateEditor({ value, label, onCommit, onCancel }: {
  value: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const commitCurrent = () => onCommit(inputRef.current?.value ?? draft);
  return (
    <div className="flex items-center gap-1 pr-2">
      <input
        type="date"
        ref={inputRef}
        autoFocus
        value={draft}
        aria-label={label}
        className="h-7 min-w-0 flex-1 rounded-md border border-primary bg-card px-2 text-[11px] outline-none ring-2 ring-primary/10"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit(event.currentTarget.value);
          if (event.key === "Escape") onCancel();
        }}
        onBlur={(event) => onCommit(event.currentTarget.value)}
      />
      <button className="text-primary" aria-label="确认日期" onMouseDown={(event) => event.preventDefault()} onClick={commitCurrent}><Check className="h-3.5 w-3.5" /></button>
      <button className="text-muted-foreground" aria-label="取消日期编辑" onMouseDown={(event) => event.preventDefault()} onClick={onCancel}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === "completed") return <Check className="h-3.5 w-3.5" strokeWidth={3} />;
  if (status === "cancelled") return <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />;
  if (status === "in_progress") return <CircleDashed className="h-5 w-5" strokeWidth={2.4} />;
  return <Circle className="h-5 w-5" strokeWidth={1.8} />;
}

function StatusMenu({ task, onSelect, onOpenExecution, onTogglePinned, onDelete, onClose }: {
  task: TodoTask;
  onSelect: (status: TodoStatus) => void;
  onOpenExecution?: () => void;
  onTogglePinned?: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener("click", closeOnOutsideClick);
    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, [onClose]);

  return (
    <div ref={menuRef} className="absolute left-0 top-7 z-30 w-36 rounded-md border bg-card p-1 shadow-lg" role="menu">
      {onOpenExecution ? <button className="w-full rounded px-2 py-1.5 text-left text-[12px] text-primary hover:bg-accent" onClick={onOpenExecution} role="menuitem">验收、暂停或返工</button> : (["todo", "in_progress", "completed", "cancelled"] as TodoStatus[]).map((status) => (
        <button key={status} className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent", task.status === status && "bg-accent font-medium")} onClick={() => onSelect(status)} role="menuitem">
          <StatusIcon status={status} />{statusLabels[status]}
        </button>
      ))}
      {onTogglePinned && (
        <>
          <div className="my-1 border-t" />
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent" onClick={onTogglePinned} role="menuitem">
            {task.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {task.pinned ? "取消置顶" : "置顶"}
          </button>
        </>
      )}
      {onDelete && (
        <>
          <div className="my-1 border-t" />
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-destructive hover:bg-destructive/10" onClick={onDelete} role="menuitem"><Trash2 className="h-3.5 w-3.5" />删除任务</button>
        </>
      )}
      <button className="sr-only" onClick={onClose}>关闭菜单</button>
    </div>
  );
}

function ExtensionPanel({ task, onChange, onOpenLink, children }: {
  task: TodoTask;
  onChange: (patch: Partial<TodoTask>) => void;
  onOpenLink: (url: string) => void;
  children?: ReactNode;
}) {
  return (
    <div className="ml-24 grid grid-cols-1 border-b border-l bg-secondary/20 lg:grid-cols-2">
      <div className="col-span-full border-b px-2.5 py-2 text-[10px] text-muted-foreground">
        添加日期：{formatLocalCreatedDate(task.createdAt)}
      </div>
      <ExtensionSection task={task} field="processTracking" title="过程跟踪" value={task.processTracking} onChange={(value) => onChange({ processTracking: value })} onOpenLink={onOpenLink} />
      <ExtensionSection task={task} field="resultReview" title="结果复盘" value={task.resultReview} onChange={(value) => onChange({ resultReview: value })} onOpenLink={onOpenLink} />
      {children && <div className="col-span-full border-t p-2">{children}</div>}
    </div>
  );
}

function ExtensionSection({ task, field, title, value, onChange, onOpenLink }: {
  task: TodoTask;
  field: ExtensionField;
  title: string;
  value: string;
  onChange: (value: string) => void;
  onOpenLink: (url: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "text" | "link">("idle");
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [editingLine, setEditingLine] = useState<number>();
  const [editingText, setEditingText] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const linkClickTimer = useRef<number>();
  const rawLines = value.split("\n");
  const lines = rawLines
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(({ line }) => Boolean(line.trim()));
  const append = (content: string) => onChange(value ? `${value}\n${content.trim()}` : content.trim());
  const cancelEditing = () => setEditingLine(undefined);
  const replaceLine = (sourceIndex: number, content: string) => {
    const next = rawLines.slice();
    next[sourceIndex] = content;
    onChange(next.join("\n"));
    setEditingLine(undefined);
  };
  const beginEditing = (sourceIndex: number, line: string) => {
    if (linkClickTimer.current) window.clearTimeout(linkClickTimer.current);
    const link = exactNamedHttpLinkPattern.exec(line);
    setEditingLine(sourceIndex);
    setMode("idle");
    setEditingText(line);
    setEditingLabel(link?.[1] ?? "");
    setEditingUrl(link?.[2] ?? "");
  };
  const commitTextEditing = (sourceIndex: number) => {
    if (!editingText.trim()) return cancelEditing();
    replaceLine(sourceIndex, editingText.trim());
  };
  const commitLinkEditing = (sourceIndex: number) => {
    if (!editingLabel.trim() || !isValidExtensionUrl(editingUrl)) return;
    replaceLine(sourceIndex, `[${editingLabel.trim()}](${editingUrl.trim()})`);
  };

  useEffect(() => () => {
    if (linkClickTimer.current) window.clearTimeout(linkClickTimer.current);
  }, []);

  return (
    <section className="min-h-[110px] min-w-0 border-r p-2.5" role="region" aria-label={`${task.title || "未命名任务"}的${title}`}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold text-muted-foreground">{title}</h3>
        <div className="flex items-center gap-1">
          <button className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-accent" onClick={() => { setEditingLine(undefined); setMode("text"); }}>添加文本</button>
          <button className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-accent" onClick={() => { setEditingLine(undefined); setMode("link"); }}><Link2 className="h-3 w-3" />添加链接</button>
        </div>
      </div>
      <div className="min-h-7 text-[11px] leading-4 text-foreground">
        {lines.length > 0 ? lines.map(({ line, sourceIndex }, index) => {
          const displayLine = line.trim();
          const link = exactNamedHttpLinkPattern.exec(displayLine);
          if (editingLine === sourceIndex) {
            if (link) {
              const canSave = Boolean(editingLabel.trim()) && isValidExtensionUrl(editingUrl);
              return (
                <div key={`${sourceIndex}-${line}`} className="my-1 grid min-w-0 grid-cols-[minmax(88px,0.7fr)_minmax(128px,1.3fr)_auto] gap-1">
                  <Input value={editingLabel} onChange={(event) => setEditingLabel(event.target.value)} aria-label="编辑链接名称" className="h-7 min-w-0" autoFocus onKeyDown={(event) => { if (event.key === "Enter" && canSave) commitLinkEditing(sourceIndex); if (event.key === "Escape") cancelEditing(); }} />
                  <Input value={editingUrl} onChange={(event) => setEditingUrl(event.target.value)} aria-label="编辑链接 URL" className="h-7 min-w-0" onKeyDown={(event) => { if (event.key === "Enter" && canSave) commitLinkEditing(sourceIndex); if (event.key === "Escape") cancelEditing(); }} />
                  <div className="flex">
                    <Button size="icon" variant="ghost" aria-label="保存编辑链接" disabled={!canSave} onClick={() => commitLinkEditing(sourceIndex)}><Check className="h-3.5 w-3.5" /></Button>
                    <Button size="icon" variant="ghost" aria-label="取消编辑链接" onClick={cancelEditing}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              );
            }
            return (
              <div key={`${sourceIndex}-${line}`} className="my-1 flex min-w-0 gap-1">
                <Input value={editingText} onChange={(event) => setEditingText(event.target.value)} aria-label={`编辑${title}第${index + 1}条文本`} className="h-7 min-w-0 flex-1" autoFocus onKeyDown={(event) => { if (event.key === "Enter") commitTextEditing(sourceIndex); if (event.key === "Escape") cancelEditing(); }} />
                <Button size="icon" variant="ghost" aria-label="保存编辑文本" onClick={() => commitTextEditing(sourceIndex)}><Check className="h-3.5 w-3.5" /></Button>
                <Button size="icon" variant="ghost" aria-label="取消编辑文本" onClick={cancelEditing}><X className="h-3.5 w-3.5" /></Button>
              </div>
            );
          }
          return (
            <div key={`${sourceIndex}-${line}`} className="min-h-5 rounded px-0.5 hover:bg-accent/45" onDoubleClick={() => beginEditing(sourceIndex, displayLine)} title="双击编辑">
              {link ? (
                <a
                  href={link[2]}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline decoration-primary/25 underline-offset-2 hover:decoration-primary"
                  onClick={(event) => {
                    event.preventDefault();
                    if (event.detail > 1) {
                      if (linkClickTimer.current) window.clearTimeout(linkClickTimer.current);
                      return;
                    }
                    linkClickTimer.current = window.setTimeout(() => onOpenLink(link[2]), 200);
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    beginEditing(sourceIndex, displayLine);
                  }}
                >
                  {link[1]}
                </a>
              ) : <MarkdownText value={displayLine} onOpenLink={onOpenLink} />}
            </div>
          );
        }) : <span className="text-muted-foreground">暂无内容</span>}
      </div>
      {mode === "text" && (
        <div className="mt-2 flex gap-1">
          <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="补充文本" aria-label={`${title}文本`} className="h-8" autoFocus />
          <Button size="sm" onClick={() => { if (text.trim()) append(text); setText(""); setMode("idle"); }}>保存</Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("idle")}>取消</Button>
        </div>
      )}
      {mode === "link" && (
        <div className="mt-2 grid min-w-0 grid-cols-[minmax(88px,0.7fr)_minmax(128px,1.3fr)_auto] gap-1">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="显示名称" aria-label="显示名称" className="h-8 min-w-0" autoFocus />
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" aria-label="URL" className="h-8 min-w-0" />
          <div className="flex">
            <Button size="icon" variant="ghost" aria-label="保存链接" disabled={!label.trim() || !isValidExtensionUrl(url)} onClick={() => { append(`[${label.trim()}](${url.trim()})`); setLabel(""); setUrl(""); setMode("idle"); }}><Check className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" aria-label="取消添加链接" onClick={() => setMode("idle")}><X className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function mapBackendTodoTask(task: BackendTodoTask): TodoTask {
  return {
    id: task.id,
    parentId: task.parent_id ?? undefined,
    position: task.position,
    title: task.title,
    status: task.status,
    pinned: task.pinned,
    startDate: task.start_date ?? undefined,
    expectedEndDate: task.expected_end_date ?? undefined,
    actualEndDate: task.actual_end_date ?? undefined,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    processTracking: task.process_tracking,
    resultReview: task.result_review
  };
}

export function mapTodoTaskInput(task: TodoTask) {
  return {
    id: task.id,
    parent_id: task.parentId ?? null,
    position: task.position,
    title: normalizeTodoTitleForPersistence(task.title),
    status: task.status,
    pinned: task.pinned,
    start_date: task.startDate ?? null,
    expected_end_date: task.expectedEndDate ?? null,
    actual_end_date: task.actualEndDate ?? null,
    process_tracking: task.processTracking,
    result_review: task.resultReview
  };
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `todo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function localToday() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function nextLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + 1);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalCreatedDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10) || "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function demoTasks(nowMs = Date.now()): TodoTask[] {
  const recent = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const expired = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString();
  return [
    { ...emptyTask("demo-1", undefined, 0), title: "西北中卫质量链路验收", startDate: "2026-07-08", expectedEndDate: "2026-07-10", updatedAt: recent },
    { ...emptyTask("demo-2", undefined, 1), title: "顺便修复子东南亚 crash 不生效问题", status: "completed", startDate: "2026-07-09", expectedEndDate: "2026-07-10", actualEndDate: "2026-07-10", updatedAt: expired },
    { ...emptyTask("demo-3", undefined, 2), title: "异构镜像需要清理管控 agent 的残留状态信息", status: "in_progress", startDate: "2026-07-08", expectedEndDate: "2026-07-12", processTracking: "[排查记录](https://example.com/trace)\n[监控面板](https://example.com/dashboard)\n[修复方案](https://example.com/fix)", resultReview: "已完成残留状态清理与验证，agent 运行稳定。\n[查看事故复盘](https://example.com/review)", updatedAt: expired },
    { ...emptyTask("demo-4", "demo-3", 0), title: "异构实现带外探测 from 方文奇", startDate: "2026-07-07", expectedEndDate: "2026-07-07", updatedAt: recent },
    { ...emptyTask("demo-5", "demo-3", 1), title: "可观测这周搞完 clickhouse 的 trace", startDate: "2026-07-06", expectedEndDate: "2026-07-11" },
    { ...emptyTask("demo-6", undefined, 3), title: "云助手标准输出放大一些", status: "completed", startDate: "2026-07-03", expectedEndDate: "2026-07-10", actualEndDate: "2026-07-10", updatedAt: expired },
    { ...emptyTask("demo-7", undefined, 4), title: "GpuError: DegmlHealth NVLink NVLinkDown 告警—重启", status: "in_progress", startDate: "2026-07-03", expectedEndDate: "2026-07-12", updatedAt: recent },
    { ...emptyTask("demo-8", "demo-7", 0), title: "一键诊断 国产先停用", startDate: "2026-06-30", expectedEndDate: "2026-07-03" },
    { ...emptyTask("demo-9", "demo-7", 1), title: "国产算力 管控 agent label selector", startDate: "2026-06-30", expectedEndDate: "2026-07-08" },
    { ...emptyTask("demo-10", "demo-7", 2), title: "jcs 集群支持 trace", startDate: "2026-06-30", expectedEndDate: "2026-07-09" },
    { ...emptyTask("demo-11", "demo-7", 3), title: "边缘支持 NPD", status: "completed", startDate: "2026-06-30", expectedEndDate: "2026-07-10", actualEndDate: "2026-07-10" },
    { ...emptyTask("demo-12", undefined, 5), title: "国产算力规则确认", startDate: "2026-07-11", expectedEndDate: "2026-07-15", updatedAt: recent }
  ];
}
