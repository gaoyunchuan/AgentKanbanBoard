import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App";
import type { BackendThread, BoardData } from "./types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args)
}));

const backendProjects = [
  {
    id: "unknown",
    name: "Unknown",
    path: "",
    origin_url: null,
    aliases: [],
    active: true
  },
  {
    id: "agent-kanban",
    name: "AgentKanbanBoard",
    path: "/Users/gaoyunchuan/workspace/typescript/AgentKanbanBoard",
    origin_url: "git@coding.jd.com:gaoyunchuan/AgentKanbanBoard.git",
    aliases: ["AgentKanbanBoard"],
    active: true
  }
];

const backendThreads: BoardData["threads"] = [
  {
    id: "019ef927-4206-7823-a752-eb0364a6f11b",
    project_id: "agent-kanban",
    title: "接入真实数据",
    preview: "你没有对接真实的codex desktop啊。 数据都是假的。",
    cwd: "/Users/gaoyunchuan/workspace/typescript/AgentKanbanBoard",
    branch: "main",
    source_kind: "codex",
    codex_status: "running",
    codex_sub_status: "active",
    board_status: "running",
    task_type: null,
    module: "ThreadSync",
    sprint: "S26",
    notes: "",
    first_seen_at: "2026-06-24T10:23:20Z",
    last_seen_running_at: "2026-06-24T10:23:20Z",
    last_seen_completed_at: null,
    manual_status_override: false,
    archived_at: null,
    created_at: "2026-06-24T10:22:40Z",
    updated_at: "2026-06-24T10:23:20Z"
  },
  {
    id: "019ef88b-6207-7122-9f6e-da4d6d52a9ba",
    project_id: "unknown",
    title: "修正 Grafana 日志 service 名称",
    preview: "这个 service 并不是预期的 runtimeID。",
    cwd: "/Users/gaoyunchuan/workspace/go/agentgrid-observability",
    branch: "master",
    source_kind: "codex",
    codex_status: "idle",
    codex_sub_status: "",
    board_status: "review_pending",
    task_type: "bugfix",
    module: "Observability",
    sprint: "S26",
    notes: "",
    first_seen_at: "2026-06-24T07:32:38Z",
    last_seen_running_at: "2026-06-24T07:32:38Z",
    last_seen_completed_at: "2026-06-24T07:36:38Z",
    manual_status_override: false,
    archived_at: null,
    created_at: "2026-06-24T07:32:24Z",
    updated_at: "2026-06-24T07:32:38Z"
  }
];

describe("Codex Kanban App", () => {
  let currentThreads: typeof backendThreads;

  beforeEach(() => {
    localStorage.clear();
    currentThreads = backendThreads.map((thread) => ({ ...thread }));
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string, args?: { threadId?: string; module?: string; sprint?: string; notes?: string; taskType?: BackendThread["task_type"] }) => {
      if (command === "load_board_data") {
        return Promise.resolve({
          threads: currentThreads,
          projects: backendProjects,
          sync_error: null
        });
      }
      if (command === "sync_codex_threads") {
        return Promise.resolve({
          threads: currentThreads,
          projects: backendProjects,
          sync_error: null
        });
      }
      if (command === "mark_thread_reviewed") {
        currentThreads = currentThreads.map((thread) =>
          thread.id === "019ef88b-6207-7122-9f6e-da4d6d52a9ba"
            ? { ...thread, board_status: "reviewed" }
            : thread
        );
      }
      if (command === "archive_thread") {
        currentThreads = currentThreads.map((thread) =>
          thread.id === "019ef88b-6207-7122-9f6e-da4d6d52a9ba"
            ? { ...thread, board_status: "archived", archived_at: "2026-06-24T10:30:00Z" }
            : thread
        );
      }
      if (command === "unarchive_thread") {
        currentThreads = currentThreads.map((thread) =>
          thread.id === "019ef88b-6207-7122-9f6e-da4d6d52a9ba"
            ? { ...thread, board_status: "review_pending", archived_at: null }
            : thread
        );
      }
      if (command === "update_thread_fields" && args?.threadId) {
        currentThreads = currentThreads.map((thread) =>
          thread.id === args.threadId
            ? {
                ...thread,
                task_type: args.taskType ?? null,
                module: args.module ?? thread.module,
                sprint: args.sprint ?? thread.sprint,
                notes: args.notes ?? thread.notes
              }
            : thread
        );
      }
      if (
        command === "mark_thread_reviewed" ||
        command === "archive_thread" ||
        command === "unarchive_thread" ||
        command === "update_thread_fields"
      ) {
        return Promise.resolve({
          threads: currentThreads,
          projects: backendProjects,
          sync_error: null
        });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("loads real Codex data through Tauri commands", async () => {
    render(<App />);

    expect(await screen.findByText("接入真实数据")).toBeInTheDocument();
    expect(screen.queryByText("补齐 ThreadSync 只读同步与事件订阅")).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("load_board_data", undefined);
  });

  test("periodically syncs Codex threads while the page is open", async () => {
    vi.useFakeTimers();
    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("接入真实数据")).toBeInTheDocument();
    currentThreads = [
      ...currentThreads,
      {
        ...backendThreads[1],
        id: "019ef934-periodic-sync",
        title: "定时同步新增会话",
        board_status: "untriaged",
        updated_at: "2026-06-24T11:35:00Z"
      }
    ];
    invokeMock.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(invokeMock).toHaveBeenCalledWith("sync_codex_threads", undefined);
    expect(screen.getByText("定时同步新增会话")).toBeInTheDocument();
  });

  test("switches focused views and shows running/review data", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /运行中/ }));
    expect(await screen.findByText("接入真实数据")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /待人工审核/ }));
    expect(screen.getByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
  });

  test("orders review pending threads before reviewed threads in active view", async () => {
    currentThreads = [
      ...currentThreads,
      {
        ...backendThreads[1],
        id: "019ef934-reviewed-sort",
        title: "已经审核但更新时间更新",
        board_status: "reviewed",
        updated_at: "2026-06-24T11:32:38Z"
      }
    ];

    render(<App />);

    const pendingRow = threadRowFor(await screen.findByText("修正 Grafana 日志 service 名称"));
    const reviewedRow = threadRowFor(screen.getByText("已经审核但更新时间更新"));
    if (!pendingRow || !reviewedRow) throw new Error("测试数据行未渲染");

    expect(
      pendingRow.compareDocumentPosition(reviewedRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test("hides running and untriaged columns in board view", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("tab", { name: /看板/ }));

    expect(screen.getAllByText("待审核")).toHaveLength(2);
    expect(screen.getAllByText("运行中")).toHaveLength(2);
    expect(screen.getAllByText("未分类")).toHaveLength(2);
  });

  test("shows archived cards in board view when archived filter is enabled", async () => {
    const user = userEvent.setup();
    currentThreads = [
      ...currentThreads,
      {
        ...backendThreads[1],
        id: "019ef934-archived-board",
        title: "已归档线程应该显示",
        board_status: "archived",
        archived_at: "2026-06-24T10:30:00Z",
        updated_at: "2026-06-24T10:30:00Z"
      }
    ];

    render(<App />);

    await user.click(await screen.findByRole("tab", { name: /看板/ }));
    await user.click(screen.getByRole("button", { name: "筛选" }));
    await user.click(screen.getByRole("button", { name: "显示归档" }));

    expect(screen.getByText("已归档线程应该显示")).toBeInTheDocument();
  });

  test("edits fixed fields from an expanded row", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText("接入真实数据"));
    const moduleInput = screen.getByDisplayValue("ThreadSync");
    await user.clear(moduleInput);
    await user.type(moduleInput, "Matcher");

    expect(screen.getByDisplayValue("Matcher")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("update_thread_fields", expect.any(Object));
  });

  test("marks reviewed, archives, and restores a thread", async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = threadRowFor(await screen.findByText("修正 Grafana 日志 service 名称"));
    expect(row).toBeTruthy();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "标记已审核" }));
    expect(screen.getByText(/已标记审核完成/)).toBeInTheDocument();

    await user.click(within(row as HTMLElement).getByRole("button", { name: "归档" }));
    expect(screen.getAllByText(/已归档/).length).toBeGreaterThan(0);

    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: /^归档/ }));
    const archivedRow = threadRowFor(screen.getAllByText("修正 Grafana 日志 service 名称")[0]);
    expect(archivedRow).toBeTruthy();
    await user.click(within(archivedRow as HTMLElement).getByRole("button", { name: "恢复归档" }));
    expect(screen.getByText(/已恢复/)).toBeInTheDocument();
  });
});

function threadRowFor(element: HTMLElement) {
  let current: HTMLElement | null = element;
  while (current && !current.className.includes("min-w-[480px]")) {
    current = current.parentElement;
  }
  return current;
}
