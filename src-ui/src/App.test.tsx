import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App";
import type {
  BackendThread,
  BackendThreadComment,
  BackendThreadTaskLink,
  BoardData
} from "./types";
import type { BackendTodoTask } from "./todo/types";

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
    updated_at: "2026-06-24T10:23:20Z",
    comments: [
      {
        id: 1,
        thread_id: "019ef927-4206-7823-a752-eb0364a6f11b",
        author: "我",
        body: "先记录同步间隔需要调整。",
        created_at: "2026-06-24T10:25:00Z",
        updated_at: "2026-06-24T10:25:00Z",
        edited_at: null
      },
      {
        id: 2,
        thread_id: "019ef927-4206-7823-a752-eb0364a6f11b",
        author: "我",
        body: "补充离线态提示。",
        created_at: "2026-06-24T10:26:00Z",
        updated_at: "2026-06-24T10:26:00Z",
        edited_at: "2026-06-24T10:27:00Z"
      }
    ]
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
    updated_at: "2026-06-24T07:32:38Z",
    comments: []
  }
];

const backendTodoTasks: BackendTodoTask[] = [
  {
    id: "root",
    parent_id: null,
    position: 0,
    title: "父任务",
    status: "todo",
    pinned: false,
    start_date: null,
    expected_end_date: null,
    actual_end_date: null,
    process_tracking: "",
    result_review: "",
    created_at: "2026-07-13T08:00:00Z",
    updated_at: "2026-07-13T08:00:00Z"
  },
  {
    id: "child",
    parent_id: "root",
    position: 0,
    title: "子任务",
    status: "in_progress",
    pinned: false,
    start_date: null,
    expected_end_date: null,
    actual_end_date: null,
    process_tracking: "",
    result_review: "",
    created_at: "2026-07-13T08:00:00Z",
    updated_at: "2026-07-13T08:00:00Z"
  }
];

const backendLink = (threadId: string, taskId: string): BackendThreadTaskLink => ({
  thread_id: threadId,
  task_id: taskId,
  created_at: "2026-07-13T08:00:00Z",
  updated_at: "2026-07-13T08:00:00Z"
});

const manyBackendThreads = (count: number): BoardData["threads"] =>
  Array.from({ length: count }, (_, index) => ({
    ...backendThreads[1],
    id: `019ef88b-6207-7122-9f6e-da4d6d52${String(index).padStart(4, "0")}`,
    title: `虚拟测试记录 ${String(index + 1).padStart(3, "0")}`,
    updated_at: new Date(Date.UTC(2026, 5, 24, 23, 59 - index, 0)).toISOString(),
    comments: []
  }));

describe("Codex Kanban App", () => {
  let currentThreads: typeof backendThreads;
  let currentCommentsByThread: Record<string, BackendThreadComment[]>;
  let currentThreadTaskLinks: BackendThreadTaskLink[];

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible"
    });
    currentThreads = backendThreads.map((thread) => ({ ...thread, comments: [] }));
    currentCommentsByThread = Object.fromEntries(
      backendThreads.map((thread) => [thread.id, [...(thread.comments ?? [])]])
    );
    currentThreadTaskLinks = [];
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string, args?: { threadId?: string; taskId?: string | null; commentId?: number; body?: string; suspendUntil?: string; module?: string; sprint?: string; notes?: string; taskType?: BackendThread["task_type"]; path?: string }) => {
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
      if (command === "start_codex_sync") {
        return Promise.resolve({
          in_progress: true,
          last_started_at: "2026-07-03T12:00:00Z",
          last_finished_at: null,
          last_error: null
        });
      }
      if (command === "load_thread_comments" && args?.threadId) {
        return Promise.resolve(currentCommentsByThread[args.threadId] ?? []);
      }
      if (command === "load_thread_task_links") {
        return Promise.resolve([...currentThreadTaskLinks]);
      }
      if (command === "load_todo_tasks") {
        return Promise.resolve(backendTodoTasks);
      }
      if (command === "update_thread_task_link" && args?.threadId) {
        currentThreadTaskLinks = currentThreadTaskLinks.filter(
          (link) => link.thread_id !== args.threadId
        );
        if (!args.taskId) return Promise.resolve(null);
        const next = backendLink(args.threadId, args.taskId);
        currentThreadTaskLinks.push(next);
        return Promise.resolve(next);
      }
      if (command === "open_project_in_vscode" && args?.path) {
        return Promise.resolve(args.path);
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
      if (command === "create_thread_comment" && args?.threadId && args.body) {
        const body = args.body;
        const nextComment = {
          id: 3,
          thread_id: args.threadId,
          author: "我",
          body,
          created_at: "2026-06-24T10:28:00Z",
          updated_at: "2026-06-24T10:28:00Z",
          edited_at: null
        };
        currentCommentsByThread[args.threadId] = [
          nextComment,
          ...(currentCommentsByThread[args.threadId] ?? [])
        ];
        currentThreads = currentThreads.map((thread) =>
          thread.id === args.threadId
            ? {
                ...thread,
                board_status: args.suspendUntil ? "suspended" : thread.board_status,
                suspended_until: args.suspendUntil ?? thread.suspended_until
              }
            : thread
        );
      }
      if (command === "update_thread_comment" && args?.commentId && args.body) {
        const body = args.body;
        currentCommentsByThread = Object.fromEntries(
          Object.entries(currentCommentsByThread).map(([threadId, comments]) => [
            threadId,
            comments.map((comment) =>
              comment.id === args.commentId
                ? {
                    ...comment,
                    body,
                    updated_at: "2026-06-24T10:29:00Z",
                    edited_at: "2026-06-24T10:29:00Z"
                  }
                : comment
            )
          ])
        );
        currentThreads = currentThreads.map((thread) => ({
          ...thread,
          comments: ((thread as any).comments ?? []).map((comment: BackendThreadComment) =>
            comment.id === args.commentId
              ? {
                  ...comment,
                  body,
                  updated_at: "2026-06-24T10:29:00Z",
                  edited_at: "2026-06-24T10:29:00Z"
                }
              : comment
          )
        }));
      }
      if (
        command === "mark_thread_reviewed" ||
        command === "archive_thread" ||
        command === "unarchive_thread" ||
        command === "update_thread_fields" ||
        command === "create_thread_comment" ||
        command === "update_thread_comment"
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

    expect(await screen.findByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    expect(screen.queryByText("接入真实数据")).not.toBeInTheDocument();
    expect(screen.queryByText("补齐 ThreadSync 只读同步与事件订阅")).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("load_board_data", undefined);
  });

  test("does not show debug polling controls in the toolbar", async () => {
    render(<App />);

    expect(await screen.findByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步" })).toBeInTheDocument();
    expect(screen.queryByText(/OpenSpec:/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止同步" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止刷新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止解析" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "只读轮询" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭评论" })).not.toBeInTheDocument();
  });

  test("opens the independent To Do List page from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("修正 Grafana 日志 service 名称");
    await user.click(screen.getByRole("button", { name: /To Do List/ }));

    expect(screen.getByRole("heading", { name: "To Do List" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建任务" })).toBeInTheDocument();
    expect(
      screen.getByText("用树形任务拆解工作，日期双击编辑，⌘⇧Enter 向上新建，⌘Enter 向后新建，Tab 调整层级。")
    ).toBeInTheDocument();
    expect(screen.queryByText("同步与队列概览")).not.toBeInTheDocument();
  });

  test("进入 To Do List 只独立加载一次关联，不加入周期刷新", async () => {
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /To Do List/ }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("load_thread_task_links", undefined);
    const loadCount = invokeMock.mock.calls.filter(
      ([command]) => command === "load_thread_task_links"
    ).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "load_thread_task_links")
    ).toHaveLength(loadCount);
  });

  test("点击 Todo 关联 Thread 会打开 Codex 并停留在 To Do List", async () => {
    const user = userEvent.setup();
    currentThreadTaskLinks = [
      backendLink("019ef88b-6207-7122-9f6e-da4d6d52a9ba", "demo-1")
    ];
    render(<App />);

    await screen.findByText("修正 Grafana 日志 service 名称");
    await user.click(screen.getByRole("button", { name: /To Do List/ }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("load_thread_task_links", undefined)
    );
    await user.click(
      await screen.findByRole("button", {
        name: "在 Codex 打开 Thread 修正 Grafana 日志 service 名称"
      })
    );

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("open_codex_deeplink", {
        target: "codex://threads/019ef88b-6207-7122-9f6e-da4d6d52a9ba"
      })
    );
    expect(screen.getByRole("heading", { name: "To Do List" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "全部活跃 Threads" })).not.toBeInTheDocument();
  });

  test("Thread 展开后按需加载关联，并可选择子 Task", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText("修正 Grafana 日志 service 名称"));
    expect(invokeMock).toHaveBeenCalledWith("load_thread_task_links", undefined);

    await user.click(screen.getByRole("combobox", { name: "选择未完成 Task" }));
    await user.type(screen.getByRole("searchbox"), "子任务");
    await user.click(screen.getByRole("option", { name: /子任务/ }));

    expect(invokeMock).toHaveBeenCalledWith("update_thread_task_link", {
      threadId: "019ef88b-6207-7122-9f6e-da4d6d52a9ba",
      taskId: "child",
      origin: "thread"
    });
  });

  test("折叠 Thread 不显示关联信息且轮询不加载关联", async () => {
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByText("关联 Task")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("load_thread_task_links", undefined);
  });

  test("点击已关联 Task 切换 Todo 视图并发出定位请求", async () => {
    const user = userEvent.setup();
    currentThreadTaskLinks = [
      backendLink("019ef88b-6207-7122-9f6e-da4d6d52a9ba", "child")
    ];
    render(<App />);

    await user.click(await screen.findByText("修正 Grafana 日志 service 名称"));
    await user.click(await screen.findByRole("button", { name: "打开 Task 子任务" }));
    expect(await screen.findByRole("heading", { name: "To Do List" })).toBeInTheDocument();
  });

  test("switches between active and To Do List with Cmd+1 and Cmd+2", async () => {
    render(<App />);

    const searchInput = await screen.findByPlaceholderText("搜索 thread、项目、模块");
    searchInput.focus();
    const switchToTodos = new KeyboardEvent("keydown", {
      key: "2",
      metaKey: true,
      bubbles: true,
      cancelable: true
    });
    fireEvent(searchInput, switchToTodos);

    expect(switchToTodos.defaultPrevented).toBe(true);
    expect(await screen.findByRole("button", { name: "新建任务" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(await screen.findByRole("heading", { name: "全部活跃 Threads" })).toBeInTheDocument();
  });

  test("ignores non-exact view shortcuts", async () => {
    render(<App />);

    await screen.findByText("修正 Grafana 日志 service 名称");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: true });

    expect(screen.queryByRole("button", { name: "新建任务" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "全部活跃 Threads" })).toBeInTheDocument();
  });

  test("keeps zen mode while shortcuts switch views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("修正 Grafana 日志 service 名称");
    await user.click(screen.getByRole("button", { name: "禅模式" }));

    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(await screen.findByRole("button", { name: "新建任务" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出禅模式" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(await screen.findByRole("heading", { name: "全部活跃 Threads" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText("同步与队列概览")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "退出禅模式" }));
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("同步与队列概览")).toBeInTheDocument();
  });

  test("offers zen mode directly in To Do List without board actions", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("修正 Grafana 日志 service 名称");
    fireEvent.keyDown(window, { key: "2", metaKey: true });

    const zenButton = await screen.findByRole("button", { name: "禅模式" });
    expect(screen.queryByRole("button", { name: "同步" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开 Codex" })).not.toBeInTheDocument();

    await user.click(zenButton);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出禅模式" })).toBeInTheDocument();
  });

  test("uses multi-select status filters by default and removes unused filters", async () => {
    const user = userEvent.setup();
    currentThreads = [
      ...currentThreads,
      {
        ...backendThreads[1],
        id: "019ef934-suspended-filter",
        title: "等待窗口期后继续处理",
        board_status: "suspended",
        suspended_until: "2026-07-09T09:30:00Z",
        updated_at: "2026-07-08T09:30:00Z"
      }
    ];

    render(<App />);

    expect(await screen.findByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    expect(screen.getByText("等待窗口期后继续处理")).toBeInTheDocument();
    expect(screen.queryByText("接入真实数据")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "筛选" }));

    expect(screen.getByRole("checkbox", { name: "待审核" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "挂起" })).toBeChecked();
    expect(screen.queryByText("类型")).not.toBeInTheDocument();
    expect(screen.queryByText("Sprint")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "显示归档" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "运行中" }));

    expect(await screen.findByText("接入真实数据")).toBeInTheDocument();
  });

  test("can fully hide the sidebar to recover list width", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "收起导航" }));
    expect(screen.getByRole("navigation")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "隐藏导航" }));
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开导航" }));
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });

  test("zen mode hides the menu and sync summary then restores them", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("同步与队列概览")).toBeInTheDocument();

    const zenButton = screen.getByRole("button", { name: "禅模式" });
    const syncButton = screen.getByRole("button", { name: "同步" });
    expect(zenButton.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(zenButton);

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText("同步与队列概览")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出禅模式" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "退出禅模式" }));

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("同步与队列概览")).toBeInTheDocument();
  });

  test("opens the thread project in VS Code and copies the session id from row actions", async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<App />);

    const row = threadRowFor(await screen.findByText("修正 Grafana 日志 service 名称"));
    expect(row).toBeTruthy();
    const actionButtons = within(row as HTMLElement).getAllByRole("button").slice(-5);

    expect(actionButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "打开 Codex",
      "标记已审核",
      "打开 VS Code",
      "复制 session id",
      "归档"
    ]);

    const copyButton = within(row as HTMLElement).getByRole("button", { name: "复制 session id" });
    expect(copyButton).not.toBeDisabled();
    await user.click(copyButton);

    await waitFor(() =>
      expect(writeTextMock).toHaveBeenCalledWith("019ef88b-6207-7122-9f6e-da4d6d52a9ba")
    );
    expect(await screen.findByText("已复制 session id")).toBeInTheDocument();

    const refreshedRow = threadRowFor(screen.getByText("修正 Grafana 日志 service 名称"));
    expect(refreshedRow).toBeTruthy();
    await user.click(within(refreshedRow as HTMLElement).getByRole("button", { name: "打开 VS Code" }));

    expect(invokeMock).toHaveBeenCalledWith("open_project_in_vscode", {
      path: "/Users/gaoyunchuan/workspace/go/agentgrid-observability"
    });
  });

  test("periodically syncs Codex threads while the page is open", async () => {
    vi.useFakeTimers();
    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    currentThreads = [
      ...currentThreads,
      {
        ...backendThreads[1],
        id: "019ef934-periodic-sync",
        title: "定时同步新增会话",
        board_status: "review_pending",
        updated_at: "2026-06-24T11:35:00Z"
      }
    ];
    invokeMock.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(invokeMock).toHaveBeenCalledWith("start_codex_sync", undefined);
    expect(invokeMock).toHaveBeenCalledWith("load_board_data", undefined);
    expect(screen.getByText("定时同步新增会话")).toBeInTheDocument();
  });

  test("skips periodic Codex sync while the page is hidden", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden"
    });
    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    invokeMock.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(invokeMock).not.toHaveBeenCalledWith("start_codex_sync", undefined);
  });

  test("virtualizes large thread lists instead of rendering every row", async () => {
    currentThreads = manyBackendThreads(250);

    render(<App />);

    expect(await screen.findByText("虚拟测试记录 001")).toBeInTheDocument();
    expect(screen.queryByText("虚拟测试记录 250")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("thread-list-row").length).toBeLessThan(80);
  });

  test("keeps periodic sync silent when sync reports an error", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((command: string) => {
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
          sync_error: "后台同步失败"
        });
      }
      if (command === "start_codex_sync") {
        return Promise.resolve({
          in_progress: false,
          last_started_at: "2026-07-03T12:00:00Z",
          last_finished_at: "2026-07-03T12:00:01Z",
          last_error: "后台同步失败"
        });
      }
      if (command === "open_codex_deeplink") {
        throw new Error("自动同步不应打开 deep link");
      }
      return Promise.resolve(null);
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<App />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.queryByText("后台同步失败")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("open_codex_deeplink", expect.anything());
    expect(warnSpy).toHaveBeenCalledWith("后台同步失败");
    warnSpy.mockRestore();
  });

  test("shows sync result only when sync is requested manually", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((command: string) => {
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
          sync_error: "手动同步失败"
        });
      }
      if (command === "start_codex_sync") {
        return Promise.resolve({
          in_progress: true,
          last_started_at: "2026-07-03T12:00:00Z",
          last_finished_at: null,
          last_error: null
        });
      }
      return Promise.resolve(null);
    });
    render(<App />);

    expect(await screen.findByText("修正 Grafana 日志 service 名称")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "同步" }));

    expect(await screen.findByText("已启动后台同步")).toBeInTheDocument();
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
    const user = userEvent.setup();
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

    await user.click(screen.getByRole("button", { name: "筛选" }));
    await user.click(screen.getByRole("checkbox", { name: "已审核" }));

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

    expect(screen.getByLabelText("待审核列")).toBeInTheDocument();
    expect(screen.getByLabelText("已审核列")).toBeInTheDocument();
    expect(screen.getByLabelText("已归档列")).toBeInTheDocument();
    expect(screen.queryByLabelText("运行中列")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("未分类列")).not.toBeInTheDocument();
  });

  test("shows archived cards in archived board view", async () => {
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

    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: /^归档/ }));
    await user.click(await screen.findByRole("tab", { name: /看板/ }));

    expect(screen.getByText("已归档线程应该显示")).toBeInTheDocument();
  });

  test("edits fixed fields from an expanded row", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /运行中/ }));
    await user.click(await screen.findByText("接入真实数据"));
    const moduleInput = screen.getByDisplayValue("ThreadSync");
    await user.clear(moduleInput);
    await user.type(moduleInput, "Matcher");

    expect(screen.getByDisplayValue("Matcher")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("update_thread_fields", expect.any(Object));
  });

  test("loads the latest comment for visible list rows asynchronously", async () => {
    const user = userEvent.setup();
    currentThreads = currentThreads.map((thread) => ({ ...thread, comments: [] }));
    currentCommentsByThread["019ef927-4206-7823-a752-eb0364a6f11b"] = [
      {
        id: 2,
        thread_id: "019ef927-4206-7823-a752-eb0364a6f11b",
        author: "我",
        body: "补充离线态提示。",
        created_at: "2026-06-24T10:26:00Z",
        updated_at: "2026-06-24T10:26:00Z",
        edited_at: "2026-06-24T10:27:00Z"
      },
      {
        id: 1,
        thread_id: "019ef927-4206-7823-a752-eb0364a6f11b",
        author: "我",
        body: "先记录同步间隔需要调整。",
        created_at: "2026-06-24T10:25:00Z",
        updated_at: "2026-06-24T10:25:00Z",
        edited_at: null
      }
    ];
    let resolveComments: ((comments: BackendThreadComment[]) => void) | undefined;
    invokeMock.mockImplementation((command: string, args?: { threadId?: string }) => {
      if (command === "load_board_data") {
        return Promise.resolve({
          threads: currentThreads,
          projects: backendProjects,
          sync_error: null
        });
      }
      if (
        command === "load_thread_comments" &&
        args?.threadId === "019ef927-4206-7823-a752-eb0364a6f11b"
      ) {
        return new Promise<BackendThreadComment[]>((resolve) => {
          resolveComments = resolve;
        });
      }
      if (command === "load_thread_comments" && args?.threadId) {
        return Promise.resolve(currentCommentsByThread[args.threadId] ?? []);
      }
      return Promise.resolve(null);
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: /运行中/ }));
    expect(await screen.findByText("接入真实数据")).toBeInTheDocument();
    expect(screen.queryByText(/补充离线态提示/)).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("load_thread_comments", {
      threadId: "019ef927-4206-7823-a752-eb0364a6f11b"
    });
    expect(invokeMock).not.toHaveBeenCalledWith("sync_codex_threads", undefined);

    await act(async () => {
      resolveComments?.(currentCommentsByThread["019ef927-4206-7823-a752-eb0364a6f11b"]);
    });

    expect(await screen.findByText(/补充离线态提示/)).toBeInTheDocument();
    expect(screen.queryByText("先记录同步间隔需要调整。")).not.toBeInTheDocument();
  });

  test("adds and edits comments from an expanded list row", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /运行中/ }));
    await user.click(await screen.findByText("接入真实数据"));
    expect(screen.getByText("先记录同步间隔需要调整。")).toBeInTheDocument();
    expect(screen.getByText("补充离线态提示。")).toBeInTheDocument();
    expect(screen.getByText("已编辑")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("添加评论..."), "新增排查备注");
    await user.click(screen.getByRole("button", { name: "保存评论" }));

    expect(invokeMock).toHaveBeenCalledWith("create_thread_comment", {
      threadId: "019ef927-4206-7823-a752-eb0364a6f11b",
      body: "新增排查备注"
    });
    expect(await screen.findByText("新增排查备注")).toBeInTheDocument();

    const comment = screen.getByText("补充离线态提示。").closest("[data-comment-id]");
    if (!comment) throw new Error("评论未渲染");
    await user.click(within(comment as HTMLElement).getByRole("button", { name: "编辑评论" }));
    const editor = within(comment as HTMLElement).getByDisplayValue("补充离线态提示。");
    await user.clear(editor);
    await user.type(editor, "补充离线态提示，避免误触。");
    await user.click(within(comment as HTMLElement).getByRole("button", { name: "保存编辑" }));

    expect(invokeMock).toHaveBeenCalledWith("update_thread_comment", {
      commentId: 2,
      body: "补充离线态提示，避免误触。"
    });
    expect(await screen.findByText("补充离线态提示，避免误触。")).toBeInTheDocument();
  });

  test("suspends a thread when a comment is saved with wake time", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText("修正 Grafana 日志 service 名称"));
    await user.type(screen.getByPlaceholderText("添加评论..."), "等明天日志补齐后再看");
    await user.click(screen.getByRole("checkbox", { name: "挂起" }));
    await user.type(screen.getByLabelText("唤醒时间"), "2026-06-27T09:30");
    await user.click(screen.getByRole("button", { name: "保存评论" }));

    expect(invokeMock).toHaveBeenCalledWith("create_thread_comment", {
      threadId: "019ef88b-6207-7122-9f6e-da4d6d52a9ba",
      body: "等明天日志补齐后再看",
      suspendUntil: new Date("2026-06-27T09:30").toISOString()
    });
    expect(await screen.findByText("等明天日志补齐后再看")).toBeInTheDocument();
    expect(screen.getByText(/挂起至/)).toBeInTheDocument();
  });

  test("marks reviewed, archives, and restores a thread", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "筛选" }));
    await user.click(screen.getByRole("checkbox", { name: "已审核" }));
    await user.click(screen.getByRole("checkbox", { name: "已归档" }));

    let row = threadRowFor(await screen.findByText("修正 Grafana 日志 service 名称"));
    expect(row).toBeTruthy();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "标记已审核" }));
    expect(screen.getByText(/已标记审核完成/)).toBeInTheDocument();

    row = threadRowFor(screen.getByText("修正 Grafana 日志 service 名称"));
    expect(row).toBeTruthy();
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
