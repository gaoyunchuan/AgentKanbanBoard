import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns3,
  ExternalLink,
  Filter,
  FolderKanban,
  Inbox,
  KanbanSquare,
  LayoutList,
  Menu,
  PlayCircle,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  TimerReset
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { initialThreads, projects } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import type {
  BoardStatus,
  FilterState,
  Project,
  TaskType,
  ThreadItem
} from "@/types";

type ViewKey =
  | "inbox"
  | "running"
  | "review_pending"
  | "active"
  | "archived"
  | "projects";

type LayoutMode = "list" | "board";

const statusLabels: Record<BoardStatus, string> = {
  untriaged: "未分类",
  running: "运行中",
  review_pending: "待审核",
  reviewed: "已审核",
  archived: "已归档"
};

const statusTone: Record<
  BoardStatus,
  "default" | "secondary" | "success" | "warning" | "outline" | "neutral"
> = {
  untriaged: "neutral",
  running: "default",
  review_pending: "warning",
  reviewed: "success",
  archived: "secondary"
};

const taskTypes: TaskType[] = ["feature", "bugfix", "review", "docs", "ops"];

const defaultFilters: FilterState = {
  search: "",
  projectId: "all",
  boardStatus: "all",
  taskType: "all",
  sprint: "all",
  showArchived: false
};

const projectName = (projectId: string) =>
  projects.find((project) => project.id === projectId)?.name ?? "Unknown";

const countByStatus = (threads: ThreadItem[], status: BoardStatus) =>
  threads.filter((thread) => thread.boardStatus === status).length;

function App() {
  const [threads, setThreads] = usePersistentThreads();
  const [view, setView] = useState<ViewKey>("active");
  const [layout, setLayout] = useState<LayoutMode>("list");
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const [toast, setToast] = useState("只读同步边界已启用");

  const visibleThreads = useMemo(() => {
    return applyFilters(applyView(threads, view), filters)
      .slice()
      .sort((a, b) => rankThread(a, view) - rankThread(b, view));
  }, [filters, threads, view]);

  const counts = useMemo(
    () => ({
      inbox: threads.filter((thread) => thread.boardStatus === "untriaged").length,
      running: countByStatus(threads, "running"),
      review: countByStatus(threads, "review_pending"),
      active: threads.filter((thread) => thread.boardStatus !== "archived").length,
      archived: countByStatus(threads, "archived")
    }),
    [threads]
  );

  const updateThread = (id: string, patch: Partial<ThreadItem>) => {
    setThreads((current) =>
      current.map((thread) => (thread.id === id ? { ...thread, ...patch } : thread))
    );
  };

  const markReviewed = (thread: ThreadItem) => {
    updateThread(thread.id, {
      boardStatus: "reviewed",
      subStatus: "manual reviewed",
      updatedAt: nowLabel()
    });
    setToast(`已标记审核完成：${thread.title}`);
  };

  const archiveThread = (thread: ThreadItem) => {
    updateThread(thread.id, {
      boardStatus: "archived",
      archivedAt: nowLabel(),
      subStatus: "manual archived",
      updatedAt: nowLabel()
    });
    setToast(`已归档：${thread.title}`);
  };

  const unarchiveThread = (thread: ThreadItem) => {
    updateThread(thread.id, {
      boardStatus: "review_pending",
      archivedAt: undefined,
      subStatus: "restored",
      updatedAt: nowLabel()
    });
    setToast(`已恢复：${thread.title}`);
  };

  const openThread = async (thread: ThreadItem) => {
    if (!thread.codexSessionId || !isSessionUuid(thread.codexSessionId)) {
      setToast(`无法打开：${thread.title} 缺少有效 Codex session id`);
      return;
    }

    const link = `codex://threads/${thread.codexSessionId}`;
    const result = await openCodexDeepLink(link);
    setToast(result.ok ? `已打开 Codex thread：${thread.title}` : result.message);
  };

  const openProject = async (projectId: string, prompt?: string) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project?.path.startsWith("/")) {
      setToast("无法打开：请先修正项目绝对路径");
      return;
    }

    const query = new URLSearchParams({ path: project.path });
    if (prompt) query.set("prompt", prompt);
    const link = `codex://new?${query.toString()}`;
    const result = await openCodexDeepLink(link);
    setToast(result.ok ? `已打开 Codex 项目入口：${project.name}` : result.message);
  };

  const syncOnce = () => {
    setThreads((current) =>
      current.map((thread, index) =>
        index === 0
          ? {
              ...thread,
              updatedAt: nowLabel(),
              subStatus:
                thread.subStatus === "waiting approval" ? "typing" : "waiting approval"
            }
          : thread
      )
    );
    setToast("已模拟一次只读同步：保留本地人工字段");
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="app-shell flex h-screen min-h-[680px] overflow-hidden text-[12px]">
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r bg-card/90 transition-all duration-200",
            sidebarOpen ? "w-[218px]" : "w-[54px]"
          )}
        >
          <div className="flex h-12 items-center gap-2 border-b px-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label="折叠导航"
            >
              <Menu className="h-4 w-4" />
            </Button>
            {sidebarOpen && (
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">Codex Kanban</div>
                <div className="truncate text-[11px] text-muted-foreground">只读 thread 工作台</div>
              </div>
            )}
          </div>
          <nav className="flex-1 space-y-1 p-2">
            <NavItem
              active={view === "active"}
              collapsed={!sidebarOpen}
              icon={<KanbanSquare className="h-4 w-4" />}
              label="全部活跃"
              count={counts.active}
              onClick={() => setView("active")}
            />
            <NavItem
              active={view === "review_pending"}
              collapsed={!sidebarOpen}
              icon={<ShieldAlert className="h-4 w-4" />}
              label="待人工审核"
              count={counts.review}
              onClick={() => setView("review_pending")}
            />
            <NavItem
              active={view === "running"}
              collapsed={!sidebarOpen}
              icon={<PlayCircle className="h-4 w-4" />}
              label="运行中"
              count={counts.running}
              onClick={() => setView("running")}
            />
            <NavItem
              active={view === "inbox"}
              collapsed={!sidebarOpen}
              icon={<Inbox className="h-4 w-4" />}
              label="未分类"
              count={counts.inbox}
              onClick={() => setView("inbox")}
            />
            <NavItem
              active={view === "archived"}
              collapsed={!sidebarOpen}
              icon={<Archive className="h-4 w-4" />}
              label="归档"
              count={counts.archived}
              onClick={() => {
                setView("archived");
                setFilters((current) => ({ ...current, showArchived: true }));
              }}
            />
            <NavItem
              active={view === "projects"}
              collapsed={!sidebarOpen}
              icon={<FolderKanban className="h-4 w-4" />}
              label="项目"
              count={projects.length - 1}
              onClick={() => setView("projects")}
            />
          </nav>
          {sidebarOpen && (
            <div className="border-t p-3 text-[11px] leading-5 text-muted-foreground">
              <div className="font-medium text-foreground">本地数据</div>
              <div>~/.codex-kanban/app.db</div>
              <div>~/.codex-kanban/projects.yaml</div>
            </div>
          )}
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 items-center justify-between border-b bg-card/85 px-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-[15px] font-semibold">{viewTitle(view)}</h1>
                <Badge variant="outline">OpenSpec: codex-thread-kanban-view</Badge>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                Codex Desktop 保持执行权威，此处只做同步、筛选、归档和跳转。
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden max-w-[320px] truncate rounded border bg-secondary/55 px-2 py-1 text-[11px] text-muted-foreground md:block">
                {toast}
              </div>
              <Button variant="outline" size="sm" onClick={syncOnce}>
                <RotateCcw className="h-3.5 w-3.5" />
                同步
              </Button>
              <Button size="sm" onClick={() => openProject("agent-kanban")}>
                <ExternalLink className="h-3.5 w-3.5" />
                打开 Codex
              </Button>
            </div>
          </header>

          {view === "projects" ? (
            <ProjectsView onOpenProject={openProject} />
          ) : (
            <section className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              <CollapsibleBand
                open={summaryOpen}
                onOpenChange={setSummaryOpen}
                title="同步与队列概览"
                icon={<TimerReset className="h-3.5 w-3.5" />}
                right={<span className="text-[11px] text-muted-foreground">前台 5s / 后台 30s</span>}
              >
                <div className="grid gap-2 md:grid-cols-4">
                  <MetricCard label="运行中" value={counts.running} hint="waiting approval 优先" tone="blue" />
                  <MetricCard label="待审核" value={counts.review} hint="按等待时长排序" tone="amber" />
                  <MetricCard label="未分类" value={counts.inbox} hint="unknown 项目仍可见" tone="slate" />
                  <MetricCard label="已归档" value={counts.archived} hint="默认隐藏，不删除" tone="green" />
                </div>
              </CollapsibleBand>

              <div className="flex min-h-0 flex-1 flex-col rounded-md border bg-card shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="relative min-w-[260px] max-w-[520px] flex-1">
                      <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={filters.search}
                        onChange={(event) =>
                          setFilters((current) => ({ ...current, search: event.target.value }))
                        }
                        className="h-8 pl-7"
                        placeholder="搜索 thread、项目、模块"
                      />
                    </div>
                    <Button
                      variant={filtersOpen ? "secondary" : "outline"}
                      size="sm"
                      onClick={() => setFiltersOpen((open) => !open)}
                    >
                      <Filter className="h-3.5 w-3.5" />
                      筛选
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setFilters(defaultFilters)}>
                      清空
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Tabs value={layout} onValueChange={(value) => setLayout(value as LayoutMode)}>
                      <TabsList>
                        <TabsTrigger value="list">
                          <LayoutList className="mr-1 h-3.5 w-3.5" />
                          列表
                        </TabsTrigger>
                        <TabsTrigger value="board">
                          <Columns3 className="mr-1 h-3.5 w-3.5" />
                          看板
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  </div>
                </div>

                {filtersOpen && (
                  <FilterPanel threads={threads} filters={filters} onChange={setFilters} />
                )}

                {layout === "list" ? (
                  <ThreadList
                    threads={visibleThreads}
                    expandedRows={expandedRows}
                    onToggleExpand={(id) =>
                      setExpandedRows((current) =>
                        current.includes(id)
                          ? current.filter((rowId) => rowId !== id)
                          : [...current, id]
                      )
                    }
                    onMarkReviewed={markReviewed}
                    onArchive={archiveThread}
                    onUnarchive={unarchiveThread}
                    onOpen={openThread}
                    onUpdate={updateThread}
                  />
                ) : (
                  <BoardView
                    threads={visibleThreads}
                    onUpdate={updateThread}
                    onMarkReviewed={markReviewed}
                    onArchive={archiveThread}
                    onUnarchive={unarchiveThread}
                    onOpen={openThread}
                  />
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

function usePersistentThreads() {
  const [threads, setThreads] = useState<ThreadItem[]>(() => {
    const cached = localStorage.getItem("codex-kanban-prototype");
    if (!cached) return initialThreads;
    try {
      return JSON.parse(cached) as ThreadItem[];
    } catch {
      return initialThreads;
    }
  });

  useEffect(() => {
    localStorage.setItem("codex-kanban-prototype", JSON.stringify(threads));
  }, [threads]);

  return [threads, setThreads] as const;
}

function applyView(threads: ThreadItem[], view: ViewKey) {
  if (view === "running") return threads.filter((thread) => thread.boardStatus === "running");
  if (view === "review_pending")
    return threads.filter((thread) => thread.boardStatus === "review_pending");
  if (view === "inbox") return threads.filter((thread) => thread.boardStatus === "untriaged");
  if (view === "archived") return threads.filter((thread) => thread.boardStatus === "archived");
  return threads.filter((thread) => thread.boardStatus !== "archived");
}

function applyFilters(threads: ThreadItem[], filters: FilterState) {
  return threads.filter((thread) => {
    const searchText = [
      thread.title,
      thread.preview,
      thread.module,
      projectName(thread.projectId),
      thread.cwd
    ]
      .join(" ")
      .toLowerCase();
    const searchMatched = filters.search
      ? searchText.includes(filters.search.trim().toLowerCase())
      : true;

    return (
      searchMatched &&
      (filters.projectId === "all" || thread.projectId === filters.projectId) &&
      (filters.boardStatus === "all" || thread.boardStatus === filters.boardStatus) &&
      (filters.taskType === "all" || thread.taskType === filters.taskType) &&
      (filters.sprint === "all" || thread.sprint === filters.sprint) &&
      (filters.showArchived || thread.boardStatus !== "archived")
    );
  });
}

function rankThread(thread: ThreadItem, view: ViewKey) {
  const updatedAt = new Date(thread.updatedAt.replace(" ", "T")).getTime();
  const safeUpdatedAt = Number.isNaN(updatedAt) ? 0 : updatedAt;

  if (view === "running") {
    const approvalRank = thread.subStatus.includes("approval") ? 0 : 1;
    return approvalRank * 10_000_000_000_000 - safeUpdatedAt;
  }

  if (view === "review_pending") {
    return safeUpdatedAt;
  }

  return -safeUpdatedAt;
}

function viewTitle(view: ViewKey) {
  const titles: Record<ViewKey, string> = {
    inbox: "未分类队列",
    running: "运行中聚焦",
    review_pending: "待人工审核",
    active: "全部活跃 Threads",
    archived: "归档 Threads",
    projects: "项目注册表"
  };
  return titles[view];
}

function nowLabel() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function NavItem({
  active,
  collapsed,
  icon,
  label,
  count,
  onClick
}: {
  active: boolean;
  collapsed: boolean;
  icon: ReactNode;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        collapsed && "justify-center px-0"
      )}
      onClick={onClick}
    >
      {icon}
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px]",
              active ? "bg-white/18 text-white" : "bg-muted text-muted-foreground"
            )}
          >
            {count}
          </span>
        </>
      )}
    </button>
  );
}

function CollapsibleBand({
  open,
  onOpenChange,
  title,
  icon,
  right,
  children
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border bg-card shadow-sm">
      <button
        className="flex h-9 w-full items-center justify-between px-3 text-left"
        onClick={() => onOpenChange(!open)}
      >
        <span className="flex items-center gap-2 font-medium">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {icon}
          {title}
        </span>
        {right}
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: number;
  hint: string;
  tone: "blue" | "amber" | "green" | "slate";
}) {
  const toneClass = {
    blue: "bg-blue-50 text-blue-700",
    amber: "bg-amber-50 text-amber-700",
    green: "bg-emerald-50 text-emerald-700",
    slate: "bg-slate-50 text-slate-700"
  }[tone];

  return (
    <div className="rounded-md border bg-card p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", toneClass)}>
          {hint}
        </span>
      </div>
      <div className="mt-1 text-[22px] font-semibold leading-none">{value}</div>
    </div>
  );
}

function FilterPanel({
  threads,
  filters,
  onChange
}: {
  threads: ThreadItem[];
  filters: FilterState;
  onChange: (filters: FilterState) => void;
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  const sprints = Array.from(new Set(threads.map((thread) => thread.sprint).filter(Boolean))).sort();

  return (
    <div className="grid gap-2 border-b bg-secondary/30 px-3 py-2 md:grid-cols-5">
      <FieldSelect
        label="项目"
        value={filters.projectId}
        values={[
          ["all", "全部项目"],
          ...projects.map((project) => [project.id, project.name] as const)
        ]}
        onChange={(value) => set({ projectId: value })}
      />
      <FieldSelect
        label="状态"
        value={filters.boardStatus}
        values={[
          ["all", "全部状态"],
          ...Object.entries(statusLabels)
        ]}
        onChange={(value) => set({ boardStatus: value })}
      />
      <FieldSelect
        label="类型"
        value={filters.taskType}
        values={[
          ["all", "全部类型"],
          ...taskTypes.map((type) => [type, type] as const)
        ]}
        onChange={(value) => set({ taskType: value })}
      />
      <FieldSelect
        label="Sprint"
        value={filters.sprint}
        values={[
          ["all", "全部 Sprint"],
          ...sprints.map((sprint) => [sprint, sprint] as const)
        ]}
        onChange={(value) => set({ sprint: value })}
      />
      <button
        className={cn(
          "mt-[18px] flex h-8 items-center justify-center gap-1 rounded-md border px-2",
          filters.showArchived
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input bg-card"
        )}
        onClick={() => set({ showArchived: !filters.showArchived })}
      >
        <Archive className="h-3.5 w-3.5" />
        显示归档
      </button>
    </div>
  );
}

function FieldSelect({
  label,
  value,
  values,
  onChange
}: {
  label: string;
  value: string;
  values: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function ThreadList({
  threads,
  expandedRows,
  onToggleExpand,
  onMarkReviewed,
  onArchive,
  onUnarchive,
  onOpen,
  onUpdate
}: {
  threads: ThreadItem[];
  expandedRows: string[];
  onToggleExpand: (id: string) => void;
  onMarkReviewed: (thread: ThreadItem) => void;
  onArchive: (thread: ThreadItem) => void;
  onUnarchive: (thread: ThreadItem) => void;
  onOpen: (thread: ThreadItem) => void;
  onUpdate: (id: string, patch: Partial<ThreadItem>) => void;
}) {
  return (
    <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
      <div className="dense-grid sticky top-0 z-10 hidden min-w-[480px] border-b bg-card px-2 py-2 text-[11px] font-medium text-muted-foreground lg:grid">
        <div>Thread / 项目</div>
        <div>状态</div>
        <div className="text-right">操作</div>
      </div>
      {threads.length === 0 ? (
        <div className="flex h-44 items-center justify-center text-muted-foreground">
          当前筛选下没有 thread。
        </div>
      ) : (
        threads.map((thread) => {
          const expanded = expandedRows.includes(thread.id);
          return (
            <div key={thread.id} className="min-w-[480px] border-b last:border-b-0">
              <div className="dense-grid grid items-center gap-1 px-2 py-2 hover:bg-accent/45">
                <button
                  className="min-w-0 text-left"
                  onClick={() => onToggleExpand(thread.id)}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{thread.title}</span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] text-muted-foreground">
                    <span className="truncate">{projectName(thread.projectId)}</span>
                    <span>·</span>
                    <span className="truncate font-mono">{thread.id}</span>
                    <span>·</span>
                    <span className="truncate">{thread.updatedAt}</span>
                    <span>·</span>
                    <span className="truncate">{thread.module} · {thread.sprint}</span>
                  </div>
                </button>
                <div className="min-w-0 space-y-1 text-left">
                  <Badge variant={statusTone[thread.boardStatus]}>
                    {statusLabels[thread.boardStatus]}
                  </Badge>
                  <div className="truncate text-[10px] text-muted-foreground">{thread.subStatus}</div>
                </div>
                <RowActions
                  thread={thread}
                  onOpen={onOpen}
                  onMarkReviewed={onMarkReviewed}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                />
              </div>
              {expanded && (
                <div className="min-w-0 space-y-2 bg-secondary/25 px-8 py-2 text-[11px]">
                  <div className="text-foreground">{thread.preview}</div>
                  <div className="truncate text-muted-foreground">
                    cwd: <span className="font-mono">{thread.cwd}</span>
                  </div>
                  <div className="truncate text-muted-foreground">
                    branch: <span className="font-mono">{thread.branch}</span>
                  </div>
                  <div className="truncate text-muted-foreground">
                    sync: <span>{thread.codexStatus}</span>
                    <span className="px-1">·</span>
                    last_running: <span>{thread.lastSeenRunningAt ?? "--"}</span>
                    <span className="px-1">·</span>
                    notes: <span>{thread.notes || "--"}</span>
                  </div>
                  <div className="grid gap-2 md:grid-cols-[140px_1fr_1fr_2fr]">
                    <InlineSelect
                      value={thread.taskType}
                      values={taskTypes.map((value) => [value, value] as const)}
                      onChange={(value) => onUpdate(thread.id, { taskType: value as TaskType })}
                    />
                    <InlineInput
                      value={thread.module}
                      placeholder="module"
                      onChange={(module) => onUpdate(thread.id, { module })}
                    />
                    <InlineInput
                      value={thread.sprint}
                      placeholder="sprint"
                      onChange={(sprint) => onUpdate(thread.id, { sprint })}
                    />
                    <InlineInput
                      value={thread.notes}
                      placeholder="notes"
                      onChange={(notes) => onUpdate(thread.id, { notes })}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function InlineSelect({
  value,
  values,
  onChange
}: {
  value: string;
  values: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 rounded border-0 bg-secondary/70 px-2 shadow-none">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {values.map(([optionValue, optionLabel]) => (
          <SelectItem key={optionValue} value={optionValue}>
            {optionLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InlineInput({
  value,
  placeholder,
  onChange
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      value={value}
      placeholder={placeholder}
      className="h-7 rounded border-0 bg-secondary/70 px-2 shadow-none"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function RowActions({
  thread,
  onOpen,
  onMarkReviewed,
  onArchive,
  onUnarchive
}: {
  thread: ThreadItem;
  onOpen: (thread: ThreadItem) => void;
  onMarkReviewed: (thread: ThreadItem) => void;
  onArchive: (thread: ThreadItem) => void;
  onUnarchive: (thread: ThreadItem) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-0">
      <IconButton
        label={thread.codexSessionId ? "打开 Codex" : "缺少 Codex session id"}
        disabled={!thread.codexSessionId || !isSessionUuid(thread.codexSessionId)}
        onClick={() => onOpen(thread)}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </IconButton>
      {thread.boardStatus !== "archived" && (
        <IconButton label="标记已审核" onClick={() => onMarkReviewed(thread)}>
          <CheckCircle2 className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {thread.boardStatus === "archived" ? (
        <IconButton label="恢复归档" onClick={() => onUnarchive(thread)}>
          <RotateCcw className="h-3.5 w-3.5" />
        </IconButton>
      ) : (
        <IconButton label="归档" onClick={() => onArchive(thread)}>
          <Archive className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled = false,
  onClick,
  children
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 rounded-sm"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function BoardView({
  threads,
  onUpdate,
  onMarkReviewed,
  onArchive,
  onUnarchive,
  onOpen
}: {
  threads: ThreadItem[];
  onUpdate: (id: string, patch: Partial<ThreadItem>) => void;
  onMarkReviewed: (thread: ThreadItem) => void;
  onArchive: (thread: ThreadItem) => void;
  onUnarchive: (thread: ThreadItem) => void;
  onOpen: (thread: ThreadItem) => void;
}) {
  const columns: BoardStatus[] = ["review_pending", "running", "untriaged", "reviewed", "archived"];

  return (
    <div className="thin-scrollbar flex min-h-0 flex-1 items-stretch gap-2 overflow-x-auto overflow-y-hidden p-2">
      {columns.map((status) => {
        const columnThreads = threads.filter((thread) => thread.boardStatus === status);
        return (
          <section
            key={status}
            className="flex min-h-0 min-w-[292px] flex-1 flex-col rounded-md border bg-secondary/25"
          >
            <div className="flex h-9 items-center justify-between border-b bg-card px-2">
              <div className="flex items-center gap-1.5 font-medium">
                <Badge variant={statusTone[status]}>{statusLabels[status]}</Badge>
                <span className="text-[11px] text-muted-foreground">{columnThreads.length}</span>
              </div>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
              {columnThreads.map((thread) => (
                <div key={thread.id} className="rounded-md border bg-card p-2 shadow-sm">
                  <div className="line-clamp-2 font-medium">{thread.title}</div>
                  <div className="mt-1 truncate text-[11px] text-muted-foreground">
                    {projectName(thread.projectId)} · {thread.module}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="outline">{thread.taskType}</Badge>
                    <Badge variant="secondary">{thread.sprint}</Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-1">
                    <InlineSelect
                      value={thread.taskType}
                      values={taskTypes.map((value) => [value, value] as const)}
                      onChange={(value) => onUpdate(thread.id, { taskType: value as TaskType })}
                    />
                    <InlineInput
                      value={thread.module}
                      placeholder="module"
                      onChange={(module) => onUpdate(thread.id, { module })}
                    />
                    <InlineInput
                      value={thread.sprint}
                      placeholder="sprint"
                      onChange={(sprint) => onUpdate(thread.id, { sprint })}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{thread.updatedAt}</span>
                    <RowActions
                      thread={thread}
                      onOpen={onOpen}
                      onMarkReviewed={onMarkReviewed}
                      onArchive={onArchive}
                      onUnarchive={onUnarchive}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ProjectsView({ onOpenProject }: { onOpenProject: (projectId: string, prompt?: string) => void }) {
  const [projectRows, setProjectRows] = useState<Project[]>(projects);
  const updateProject = (id: string, patch: Partial<Project>) => {
    setProjectRows((current) =>
      current.map((project) => (project.id === id ? { ...project, ...patch } : project))
    );
  };
  const addProject = () => {
    const id = `project-${projectRows.length + 1}`;
    setProjectRows((current) => [
      ...current,
      {
        id,
        name: "New Project",
        path: "/Users/gaoyunchuan/workspace",
        aliases: [],
        active: true
      }
    ]);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="rounded-md border bg-card shadow-sm">
        <div className="flex h-10 items-center justify-between border-b px-3">
          <div className="flex items-center gap-2 font-medium">
            <FolderKanban className="h-4 w-4 text-primary" />
            项目注册表
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={addProject}>
              <Settings2 className="h-3.5 w-3.5" />
              新增
            </Button>
            <Button size="sm">
              <Settings2 className="h-3.5 w-3.5" />
              编辑 projects.yaml
            </Button>
          </div>
        </div>
        <div className="divide-y">
          {projectRows.map((project) => (
            <div key={project.id} className="grid grid-cols-[220px_1fr_240px_160px] gap-3 px-3 py-2">
              <div className="min-w-0">
                <Input
                  value={project.name}
                  className="h-7 border-0 bg-secondary/70 px-2 shadow-none"
                  onChange={(event) => updateProject(project.id, { name: event.target.value })}
                />
                <button
                  className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => updateProject(project.id, { active: !project.active })}
                >
                  {project.active ? "active" : "inactive"}
                </button>
              </div>
              <div className="min-w-0">
                <Input
                  value={project.path}
                  className="h-7 border-0 bg-secondary/70 px-2 font-mono text-[11px] shadow-none"
                  onChange={(event) => updateProject(project.id, { path: event.target.value })}
                />
                <Input
                  value={project.originUrl ?? ""}
                  placeholder="origin URL"
                  className="mt-1 h-7 border-0 bg-secondary/70 px-2 text-[11px] shadow-none"
                  onChange={(event) =>
                    updateProject(project.id, { originUrl: event.target.value || undefined })
                  }
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {project.aliases.map((alias) => (
                  <Badge key={alias} variant="outline">
                    {alias}
                  </Badge>
                ))}
              </div>
              <div className="flex items-start justify-end gap-1">
                <Button variant="outline" size="sm" onClick={() => updateProject(project.id, { active: !project.active })}>
                  {project.active ? "禁用" : "启用"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!project.active}
                  onClick={() => onOpenProject(project.id, project.promptTemplate)}
                >
                  打开
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <div className="rounded-md border bg-card p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            ProjectMatcher 规则
          </div>
          <div className="space-y-1 text-[11px] text-muted-foreground">
            <div>1. cwd 精确匹配</div>
            <div>2. cwd 子目录匹配，最长路径优先</div>
            <div>3. origin URL 匹配</div>
            <div>4. basename / aliases fallback</div>
          </div>
        </div>
        <div className="rounded-md border bg-card p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <Star className="h-4 w-4 text-primary" />
            默认 Presets
          </div>
          <div className="flex flex-wrap gap-1">
            {["Running", "Review Pending", "Untriaged", "Archived"].map(
              (preset) => (
                <Badge key={preset} variant="secondary">
                  {preset}
                </Badge>
              )
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function isSessionUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function openCodexDeepLink(link: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await invoke("open_codex_deeplink", { target: link });
    return { ok: true };
  } catch (error) {
    await navigator.clipboard?.writeText(link).catch(() => undefined);
    return {
      ok: false,
      message: `已复制 Codex deep link，请在 Codex Desktop 打开：${String(error)}`
    };
  }
}

export default App;
