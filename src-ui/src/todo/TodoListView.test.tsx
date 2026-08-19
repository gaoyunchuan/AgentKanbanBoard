import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BoardStatus, ThreadItem } from "@/types";
import type { ThreadTaskLink } from "@/associations/types";
import type { BackendTodoTask, TodoTask } from "./types";
import { demoTasks, mapBackendTodoTask, mapTodoTaskInput, TodoListView } from "./TodoListView";
import { TODO_RECENCY_WINDOW_MS } from "./todoRecency";

const initialTasks: TodoTask[] = [
  {
    id: "root",
    position: 0,
    title: "父任务",
    status: "todo",
    pinned: false,
    expectedEndDate: "2026-07-15",
    processTracking: "  普通记录  \n\n[排查记录](https://example.com/trace)\n保留内容",
    resultReview: ""
  },
  {
    id: "child",
    parentId: "root",
    position: 0,
    title: "子任务",
    status: "in_progress",
    pinned: false,
    processTracking: "",
    resultReview: ""
  }
];

const associationThread = (id: string, boardStatus: BoardStatus): ThreadItem => ({
  id,
  title: id,
  preview: "",
  projectId: "project",
  cwd: "/repo",
  branch: "main",
  boardStatus,
  codexStatus: "idle",
  subStatus: "",
  taskType: "unset",
  module: "",
  sprint: "",
  updatedAt: "2026-07-13",
  createdAt: "2026-07-13",
  notes: "",
  comments: []
});

const associationLink = (threadId: string, taskId: string): ThreadTaskLink => ({
  threadId,
  taskId,
  createdAt: "2026-07-13T08:00:00Z",
  updatedAt: "2026-07-13T08:00:00Z"
});

function dragOverAt(element: HTMLElement, clientY: number) {
  const event = createEvent.dragOver(element);
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}

describe("TodoListView", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("列表卡片提供独立的响应式宽度容器", () => {
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    expect(screen.getByText("关联 Thread").closest(".todo-list-container")).not.toBeNull();
    expect(screen.getByText("任务").closest("[data-todo-grid-header]")).not.toBeNull();
  });

  test("完成任务时写入实际结束日期，再次点击可恢复", async () => {
    const user = userEvent.setup();
    const persistTasks = vi.fn().mockResolvedValue(undefined);
    render(
      <TodoListView
        initialTasks={initialTasks}
        persistTasks={persistTasks}
        today={() => "2026-07-11"}
      />
    );

    await user.click(screen.getByRole("button", { name: "完成 父任务" }));
    expect(screen.getByLabelText("父任务的实际结束日期")).toHaveTextContent("2026-07-11");
    expect(screen.getByRole("button", { name: "恢复 父任务" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复 父任务" }));
    expect(screen.getByLabelText("父任务的实际结束日期")).toHaveTextContent("—");
  });

  test("状态菜单使用不透明背景", () => {
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "完成 父任务" }));

    expect(screen.getByRole("menu")).toHaveClass("bg-card");
  });

  test("root 可从现有菜单置顶并显示紧凑图钉和浅绿色整行", async () => {
    const user = userEvent.setup();
    const persistTasks = vi.fn().mockResolvedValue(undefined);
    render(<TodoListView initialTasks={initialTasks} persistTasks={persistTasks} />);

    await user.click(screen.getByRole("button", { name: "设置 父任务" }));
    await user.click(screen.getByRole("menuitem", { name: "置顶" }));

    const rootRow = screen.getByDisplayValue("父任务").closest("[data-task-row]");
    const childRow = screen.getByDisplayValue("子任务").closest("[data-task-row]");
    expect(rootRow).toHaveAttribute("data-pinned", "true");
    expect(rootRow).toHaveClass("bg-emerald-50");
    expect(childRow).not.toHaveAttribute("data-pinned", "true");
    expect(childRow).not.toHaveClass("bg-emerald-50");
    expect(screen.getByRole("img", { name: "已置顶 父任务" })).toBeInTheDocument();

    const header = screen.getByText("任务").closest("[data-todo-grid-header]");
    expect(header?.children).toHaveLength(5);
    expect(within(header as HTMLElement).queryByText("置顶")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(persistTasks).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: "root", pinned: true })])
      )
    );

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    expect(screen.getByText("过程跟踪").closest(".grid")).not.toHaveClass("bg-emerald-50");
  });

  test("已置顶 root 可从现有菜单取消置顶", async () => {
    const user = userEvent.setup();
    const persistTasks = vi.fn().mockResolvedValue(undefined);
    render(
      <TodoListView
        initialTasks={[{ ...initialTasks[0], pinned: true }, initialTasks[1]]}
        persistTasks={persistTasks}
      />
    );

    await user.click(screen.getByRole("button", { name: "设置 父任务" }));
    await user.click(screen.getByRole("menuitem", { name: "取消置顶" }));

    expect(screen.queryByRole("img", { name: "已置顶 父任务" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(persistTasks).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: "root", pinned: false })])
      )
    );
  });

  test("子任务菜单不提供置顶操作", async () => {
    const user = userEvent.setup();
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "设置 子任务" }));

    expect(screen.queryByRole("menuitem", { name: "置顶" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "取消置顶" })).not.toBeInTheDocument();
  });

  test("置顶 root 缩进后持久化快照只保留新 root 置顶", async () => {
    const user = userEvent.setup();
    const persistTasks = vi.fn().mockResolvedValue(undefined);
    const pinnedRoots: TodoTask[] = [
      { ...initialTasks[0], id: "target", title: "目标 root", pinned: true },
      {
        ...initialTasks[0],
        id: "moving",
        title: "待缩进 root",
        position: 1,
        pinned: true
      }
    ];
    render(<TodoListView initialTasks={pinnedRoots} persistTasks={persistTasks} />);

    screen.getByDisplayValue("待缩进 root").focus();
    await user.keyboard("{Tab}");

    await waitFor(() => {
      const latest = persistTasks.mock.calls[persistTasks.mock.calls.length - 1]?.[0] as TodoTask[];
      expect(latest.find((task) => task.id === "target")).toMatchObject({ pinned: true });
      expect(latest.find((task) => task.id === "moving")).toMatchObject({
        parentId: "target",
        pinned: false
      });
    });
  });

  test("拖拽手柄默认可见", () => {
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    expect(screen.getByRole("button", { name: "拖动 父任务" })).not.toHaveClass("opacity-0");
  });

  test("点击状态菜单外部时关闭菜单", () => {
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "完成 父任务" }));
    const menu = screen.getByRole("menu");
    fireEvent.click(menu);
    expect(menu).toBeInTheDocument();

    fireEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("设置按钮打开的菜单不会被同一次冒泡触发的外部处理关闭", () => {
    const closeAfterOpeningClick = () => fireEvent.click(document.body);
    document.addEventListener("click", closeAfterOpeningClick, { once: true });
    try {
      render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: "设置 父任务" }));

      expect(screen.getByRole("menu")).toBeInTheDocument();
    } finally {
      document.removeEventListener("click", closeAfterOpeningClick);
    }
  });

  test("双击日期单元格后原位进入日期编辑", async () => {
    const user = userEvent.setup();
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    await user.dblClick(screen.getByLabelText("父任务的预期结束日期"));
    const editor = screen.getByLabelText("编辑父任务的预期结束日期");
    expect(editor).toHaveValue("2026-07-15");
    await user.clear(editor);
    await user.type(editor, "2026-07-18");
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("父任务的预期结束日期")).toHaveTextContent("2026-07-18");
  });

  test("日期原生控件更新值后立即确认也会保存最新日期", async () => {
    const user = userEvent.setup();
    render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

    await user.dblClick(screen.getByLabelText("父任务的预期结束日期"));
    const editor = screen.getByLabelText("编辑父任务的预期结束日期") as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(editor, "2026-07-19");
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.getByLabelText("父任务的预期结束日期")).toHaveTextContent("2026-07-19");
  });

  test("后端创建时间映射到任务并在展开详情显示本地日期", async () => {
    const backendTask: BackendTodoTask = {
      id: "backend",
      parent_id: null,
      position: 0,
      title: "后端任务",
      status: "todo",
      pinned: true,
      start_date: "2026-07-11",
      expected_end_date: null,
      actual_end_date: null,
      process_tracking: "",
      result_review: "",
      created_at: "2026-07-13T12:00:00",
      updated_at: "2026-07-13T12:00:00"
    };
    const mapped = mapBackendTodoTask(backendTask);
    expect(mapped.createdAt).toBe("2026-07-13T12:00:00");
    expect(mapped.updatedAt).toBe("2026-07-13T12:00:00");
    expect(mapped.pinned).toBe(true);
    expect(mapTodoTaskInput(mapped)).not.toHaveProperty("updated_at");

    const user = userEvent.setup();
    render(<TodoListView initialTasks={[mapped]} persistTasks={vi.fn()} />);
    expect(screen.getByText("关联 Thread")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开 后端任务" }));

    expect(screen.getByText("添加日期：2026-07-13")).toBeInTheDocument();
    expect(screen.queryByText("起始日期")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("后端任务的起始日期")).not.toBeInTheDocument();
  });

  test("四种新建入口都把预期结束日期设为本地明天", async () => {
    const user = userEvent.setup();
    const persistTasks = vi.fn().mockResolvedValue(undefined);
    render(
      <TodoListView
        initialTasks={initialTasks}
        persistTasks={persistTasks}
        today={() => "2026-12-31"}
      />
    );

    await user.click(screen.getByRole("button", { name: "新建任务" }));
    await user.click(screen.getByRole("button", { name: "为 父任务 添加子任务" }));
    const parentTitle = screen.getByDisplayValue("父任务");
    parentTitle.focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    screen.getByDisplayValue("父任务").focus();
    await user.keyboard("{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");

    await waitFor(() => {
      const latestCall = persistTasks.mock.calls[persistTasks.mock.calls.length - 1]?.[0] as TodoTask[];
      expect(latestCall).toHaveLength(6);
    });
    const latest = persistTasks.mock.calls[persistTasks.mock.calls.length - 1]?.[0] as TodoTask[];
    const created = latest.filter((task) => !initialTasks.some((item) => item.id === task.id));
    expect(created).toHaveLength(4);
    expect(created.every((task) => task.expectedEndDate === "2027-01-01")).toBe(true);
    expect(created.every((task) => task.createdAt?.startsWith("2026-12-31"))).toBe(true);
    expect(created.every((task) => task.pinned === false)).toBe(true);
  });

  test("Enter 不创建任务，Cmd+Enter 向后创建，Cmd+Shift+Enter 向前创建", async () => {
    const user = userEvent.setup();
    render(<TodoListView initialTasks={[]} persistTasks={vi.fn()} />);
    expect(
      screen.getByText("⌘⇧Enter 向上新建 · ⌘Enter 向后新建 · Tab 缩进 · Shift+Tab 提升层级")
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建任务" }));
    const firstTitle = await screen.findByLabelText("任务标题");
    await user.type(firstTitle, "父任务");
    await user.keyboard("{Enter}");
    expect(screen.getAllByLabelText("任务标题")).toHaveLength(1);

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    let titles = screen.getAllByLabelText("任务标题");
    expect(titles).toHaveLength(2);
    expect(titles[1]).toHaveFocus();
    await user.type(titles[1], "后方任务");

    await user.keyboard("{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
    titles = screen.getAllByLabelText("任务标题");
    expect(titles).toHaveLength(3);
    expect(titles[1]).toHaveFocus();
    expect(titles.map((title) => (title as HTMLInputElement).value)).toEqual([
      "父任务",
      "",
      "后方任务"
    ]);
    expect(titles[1].closest("[data-task-row]")).toHaveAttribute("data-depth", "0");

    await user.type(titles[1], "新子任务");
    await user.keyboard("{Tab}");
    expect(screen.getByDisplayValue("新子任务").closest("[data-task-row]")).toHaveAttribute(
      "data-depth",
      "1"
    );
  });

  test("空标题任务按 Backspace 删除后将上一任务的光标折叠在末尾", async () => {
    const user = userEvent.setup();
    const tasks: TodoTask[] = [
      {
        ...initialTasks[0],
        id: "previous",
        parentId: undefined,
        position: 0,
        title: "上一任务"
      },
      {
        ...initialTasks[0],
        id: "empty",
        parentId: undefined,
        position: 1,
        title: ""
      }
    ];
    render(<TodoListView initialTasks={tasks} persistTasks={vi.fn()} />);

    const emptyTitle = screen
      .getAllByLabelText("任务标题")
      .find((input) => (input as HTMLInputElement).value === "") as HTMLInputElement;
    emptyTitle.focus();
    await user.keyboard("{Backspace}");

    const previousTitle = screen.getByDisplayValue("上一任务") as HTMLInputElement;
    await waitFor(() => expect(previousTitle).toHaveFocus());
    expect(previousTitle.selectionStart).toBe(4);
    expect(previousTitle.selectionEnd).toBe(4);

    await user.keyboard("{Backspace}");
    expect(previousTitle).toHaveValue("上一任");
  });

  test("收起态在标题下显示单行摘要，展开后隐藏并在再次收起时反映最新内容", async () => {
    const user = userEvent.setup();
    const openLink = vi.fn();
    render(
      <TodoListView
        initialTasks={[
          {
            ...initialTasks[0],
            processTracking: "记录一\n[排查记录](https://example.com/trace)",
            resultReview: "复盘一\n复盘二"
          }
        ]}
        persistTasks={vi.fn()}
        openLink={openLink}
      />
    );

    const row = screen
      .getByDisplayValue("父任务")
      .closest<HTMLElement>("[data-task-row]");
    expect(row).not.toBeNull();
    expect(row?.children).toHaveLength(5);

    const summary = within(row as HTMLElement).getByRole("note", {
      name: "父任务的折叠摘要"
    });
    expect(row?.firstElementChild).toContainElement(summary);
    expect(summary).toHaveClass("truncate");
    expect(summary).toHaveTextContent(
      "过程跟踪：记录一 · 排查记录 ｜ 结果复盘：复盘一 · 复盘二"
    );

    await user.click(within(summary).getByRole("link", { name: "排查记录" }));
    expect(openLink).toHaveBeenCalledWith("https://example.com/trace");
    expect(screen.getByRole("button", { name: "展开 父任务" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    expect(
      screen.queryByRole("note", { name: "父任务的折叠摘要" })
    ).not.toBeInTheDocument();

    const resultSection = screen.getByRole("region", { name: "父任务的结果复盘" });
    await user.click(within(resultSection).getByRole("button", { name: "添加文本" }));
    await user.type(within(resultSection).getByLabelText("结果复盘文本"), "新增结论");
    await user.click(within(resultSection).getByRole("button", { name: "保存" }));

    await user.click(screen.getByRole("button", { name: "收起 父任务" }));
    expect(
      screen.getByRole("note", { name: "父任务的折叠摘要" })
    ).toHaveTextContent("结果复盘：复盘一 · 复盘二 · 新增结论");
  });

  test("子任务横向树连接线固定在标题首行中心且不随折叠摘要改变", () => {
    render(
      <TodoListView
        initialTasks={[
          { ...initialTasks[0], processTracking: "" },
          { ...initialTasks[1], processTracking: "子任务记录" },
          {
            ...initialTasks[1],
            id: "plain-child",
            position: 1,
            title: "无摘要子任务"
          }
        ]}
        persistTasks={vi.fn()}
      />
    );

    const summaryRow = screen
      .getByDisplayValue("子任务")
      .closest<HTMLElement>("[data-task-row]");
    const plainRow = screen
      .getByDisplayValue("无摘要子任务")
      .closest<HTMLElement>("[data-task-row]");
    const summaryLine = summaryRow?.firstElementChild?.querySelector("span.border-t");
    const plainLine = plainRow?.firstElementChild?.querySelector("span.border-t");

    expect(summaryLine).toHaveClass("top-[18px]");
    expect(summaryLine).not.toHaveClass("top-1/2");
    expect(plainLine).toHaveClass("top-[18px]");
  });

  test("展开扩展信息后可显示命名链接，并在分栏内提交 HTTP 链接", async () => {
    const user = userEvent.setup();
    const openLink = vi.fn();
    render(
      <TodoListView
        initialTasks={initialTasks}
        persistTasks={vi.fn()}
        openLink={openLink}
      />
    );

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    await user.click(screen.getByRole("link", { name: "排查记录" }));
    await waitFor(() => expect(openLink).toHaveBeenCalledWith("https://example.com/trace"));

    const processSection = screen.getByRole("region", { name: "父任务的过程跟踪" });
    await user.click(within(processSection).getByRole("button", { name: "添加链接" }));
    const labelInput = within(processSection).getByLabelText("显示名称");
    expect(processSection.parentElement).toHaveClass("grid-cols-1", "lg:grid-cols-2");
    expect(processSection).toHaveClass("min-w-0");
    expect(labelInput.parentElement).toHaveClass("min-w-0");
    await user.type(labelInput, "监控面板");
    await user.type(within(processSection).getByLabelText("URL"), "http://example.com/dashboard");
    await user.click(within(processSection).getByRole("button", { name: "保存链接" }));
    expect(within(processSection).getByRole("link", { name: "监控面板" })).toBeInTheDocument();
  });

  test("任意状态 Task 展开后可关联多个待审核和挂起 Thread", async () => {
    const user = userEvent.setup();
    const onAssignThread = vi.fn().mockResolvedValue(undefined);
    render(
      <TodoListView
        initialTasks={[{ ...initialTasks[0], status: "completed" }]}
        persistTasks={vi.fn()}
        threads={[
          associationThread("pending", "review_pending"),
          associationThread("suspended", "suspended"),
          associationThread("running", "running")
        ]}
        projectNames={new Map([["project", "AgentKanbanBoard"]])}
        linksByThread={new Map()}
        onAssignThread={onAssignThread}
        onUnlinkThread={vi.fn()}
        onOpenThread={vi.fn()}
        onExpandTask={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    await user.click(screen.getByRole("combobox", { name: "关联 Thread" }));
    expect(screen.getByRole("option", { name: /pending/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /suspended/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /running/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /pending/ }));
    expect(onAssignThread).toHaveBeenCalledWith("pending", "root");
  });

  test("已关联其他 Task 的 Thread 显示原归属并直接迁移", async () => {
    const user = userEvent.setup();
    const onAssignThread = vi.fn().mockResolvedValue(undefined);
    render(
      <TodoListView
        initialTasks={initialTasks}
        persistTasks={vi.fn()}
        threads={[associationThread("pending", "review_pending")]}
        projectNames={new Map([["project", "AgentKanbanBoard"]])}
        linksByThread={new Map([["pending", associationLink("pending", "other-task")]])}
        onAssignThread={onAssignThread}
        onUnlinkThread={vi.fn()}
        onOpenThread={vi.fn()}
        onExpandTask={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    await user.click(screen.getByRole("combobox", { name: "关联 Thread" }));
    expect(screen.getByText(/当前关联：other-task/)).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /pending/ }));
    expect(onAssignThread).toHaveBeenCalledWith("pending", "root");
  });

  test("折叠行第二列展示全部关联 Thread 标签并可直接打开", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    const threadA = associationThread("thread-a", "review_pending");
    const threadB = associationThread("thread-b", "suspended");
    render(
      <TodoListView
        initialTasks={initialTasks}
        persistTasks={vi.fn()}
        threads={[threadA, threadB]}
        linksByThread={new Map([
          ["thread-a", associationLink("thread-a", "root")],
          ["thread-b", associationLink("thread-b", "root")]
        ])}
        onAssignThread={vi.fn()}
        onUnlinkThread={vi.fn()}
        onOpenThread={onOpenThread}
      />
    );

    expect(
      screen.getByRole("button", { name: "在 Codex 打开 Thread thread-a" })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "在 Codex 打开 Thread thread-b" })
    );
    expect(onOpenThread).toHaveBeenLastCalledWith(threadB);

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    const associationPanel = screen.getByRole("region", { name: "关联 Thread" });
    await user.click(
      within(associationPanel).getByRole("button", {
        name: "在 Codex 打开 Thread thread-b"
      })
    );
    expect(onOpenThread).toHaveBeenLastCalledWith(threadB);
    expect(onOpenThread).toHaveBeenCalledTimes(2);
  });

  test("进入列表加载关联，失败后可从第二列强制重试", async () => {
    const user = userEvent.setup();
    const onLoadThreadLinks = vi.fn().mockRejectedValue(new Error("读取失败"));
    render(
      <TodoListView
        initialTasks={initialTasks}
        persistTasks={vi.fn()}
        linksLoadError="关联加载失败"
        onLoadThreadLinks={onLoadThreadLinks}
      />
    );

    await waitFor(() => expect(onLoadThreadLinks).toHaveBeenCalledWith());
    await user.click(screen.getAllByRole("button", { name: "重试关联加载" })[0]);
    expect(onLoadThreadLinks).toHaveBeenLastCalledWith(true);
  });

  test("导航目标会清空筛选、切页、展开、滚动并聚焦深层子 Task", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    const tasks = Array.from({ length: 201 }, (_, index) => ({
      ...initialTasks[0],
      id: `task-${index + 1}`,
      title: `任务 ${index + 1}`,
      position: index,
      parentId: undefined,
      status: index === 200 ? ("completed" as const) : ("todo" as const)
    }));
    const persistTasks = vi.fn();
    const { rerender } = render(
      <TodoListView initialTasks={tasks} persistTasks={persistTasks} />
    );
    await userEvent.setup().type(screen.getByRole("textbox", { name: "搜索任务" }), "不存在");
    rerender(
      <TodoListView
        initialTasks={tasks}
        persistTasks={persistTasks}
        navigationTarget={{ taskId: "task-201", requestId: 1 }}
      />
    );

    expect(await screen.findByDisplayValue("任务 201")).toHaveFocus();
    expect(screen.getByText("第 2 / 2 页 · 共 201 条")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  test("双击扩展内容可逐条编辑文本和命名链接", async () => {
    const user = userEvent.setup();
    const openLink = vi.fn();
    const persistTasks = vi.fn();
    render(<TodoListView initialTasks={initialTasks} persistTasks={persistTasks} openLink={openLink} />);

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    const processSection = screen.getByRole("region", { name: "父任务的过程跟踪" });

    await user.dblClick(within(processSection).getByText("普通记录"));
    const textEditor = within(processSection).getByLabelText("编辑过程跟踪第1条文本");
    await user.clear(textEditor);
    await user.type(textEditor, "更新记录{Enter}");
    expect(within(processSection).getByText("更新记录")).toBeInTheDocument();
    expect(within(processSection).getByText("保留内容")).toBeInTheDocument();
    const lastPersistedTasks = persistTasks.mock.calls[persistTasks.mock.calls.length - 1]?.[0] as TodoTask[];
    expect(lastPersistedTasks.find((task) => task.id === "root")?.processTracking).toBe(
      "更新记录\n\n[排查记录](https://example.com/trace)\n保留内容"
    );

    await user.dblClick(within(processSection).getByRole("link", { name: "排查记录" }));
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(openLink).not.toHaveBeenCalled();
    const urlEditor = within(processSection).getByLabelText("编辑链接 URL");
    await user.clear(urlEditor);
    await user.type(urlEditor, "https://");
    expect(within(processSection).getByRole("button", { name: "保存编辑链接" })).toBeDisabled();
    await user.clear(urlEditor);
    await user.type(urlEditor, "https://example.com bad");
    expect(within(processSection).getByRole("button", { name: "保存编辑链接" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(within(processSection).getByRole("link", { name: "排查记录" })).toHaveAttribute(
      "href",
      "https://example.com/trace"
    );

    await user.dblClick(within(processSection).getByRole("link", { name: "排查记录" }));
    const nextLabelEditor = within(processSection).getByLabelText("编辑链接名称");
    const nextUrlEditor = within(processSection).getByLabelText("编辑链接 URL");
    await user.clear(nextLabelEditor);
    await user.type(nextLabelEditor, "修复验证");
    await user.clear(nextUrlEditor);
    await user.type(nextUrlEditor, "http://example.com/fixed");
    await user.click(within(processSection).getByRole("button", { name: "保存编辑链接" }));
    expect(within(processSection).getByRole("link", { name: "修复验证" })).toHaveAttribute(
      "href",
      "http://example.com/fixed"
    );

    await user.dblClick(within(processSection).getByText("保留内容"));
    const cancelEditor = within(processSection).getByLabelText("编辑过程跟踪第3条文本");
    await user.clear(cancelEditor);
    await user.type(cancelEditor, "不应保存{Escape}");
    expect(within(processSection).getByText("保留内容")).toBeInTheDocument();
    expect(within(processSection).queryByText("不应保存")).not.toBeInTheDocument();
  });

  test("列表使用紧凑行高并默认每页显示 200 条", async () => {
    const user = userEvent.setup();
    const manyTasks: TodoTask[] = Array.from({ length: 201 }, (_, index) => ({
      ...initialTasks[0],
      id: `task-${index + 1}`,
      title: `任务 ${String(index + 1).padStart(3, "0")}`,
      position: index,
      parentId: undefined,
      status: index === 200 ? "in_progress" : "todo",
      processTracking: "",
      resultReview: ""
    }));
    render(<TodoListView initialTasks={manyTasks} persistTasks={vi.fn()} />);

    expect(screen.getAllByLabelText("任务标题")).toHaveLength(200);
    expect(screen.getByText("第 1 / 2 页 · 共 201 条")).toBeInTheDocument();
    expect(screen.getByDisplayValue("任务 001").closest("[data-task-row]")).toHaveClass("min-h-9");
    expect(screen.getByDisplayValue("任务 001")).toHaveClass("text-[12px]");

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getAllByLabelText("任务标题")).toHaveLength(1);
    expect(screen.getByDisplayValue("任务 201")).toBeInTheDocument();
    expect(screen.getByText("第 2 / 2 页 · 共 201 条")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "搜索任务" }), "任务 001");
    expect(screen.getByText("第 1 / 1 页 · 共 1 条")).toBeInTheDocument();
    expect(screen.getAllByLabelText("任务标题")).toHaveLength(1);
    expect(screen.getAllByLabelText("任务标题")[0]).toHaveValue("任务 001");

    await user.clear(screen.getByRole("textbox", { name: "搜索任务" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "状态筛选" }), "todo");
    expect(screen.getByText("第 1 / 1 页 · 共 200 条")).toBeInTheDocument();
    expect(screen.getAllByLabelText("任务标题")).toHaveLength(200);
  });

  test("周视图筛选过去 168 小时任务并只补齐祖先", async () => {
    const user = userEvent.setup();
    const now = Date.parse("2026-08-06T12:00:00Z");
    const recent = "2026-08-05T12:00:00Z";
    const old = "2026-07-20T12:00:00Z";
    const tasks: TodoTask[] = [
      { ...initialTasks[0], id: "parent", title: "旧父任务", position: 0, updatedAt: old },
      {
        ...initialTasks[1],
        id: "recent-child",
        parentId: "parent",
        title: "近期子任务",
        position: 0,
        updatedAt: recent
      },
      {
        ...initialTasks[1],
        id: "old-sibling",
        parentId: "parent",
        title: "旧兄弟",
        position: 1,
        updatedAt: old
      },
      {
        ...initialTasks[0],
        id: "recent-completed",
        title: "近期已完成",
        position: 1,
        status: "completed",
        updatedAt: recent
      },
      {
        ...initialTasks[0],
        id: "invalid",
        title: "无效时间",
        position: 2,
        updatedAt: "invalid"
      }
    ];
    render(
      <TodoListView
        initialTasks={tasks}
        persistTasks={vi.fn()}
        now={() => now}
      />
    );

    const weekButton = screen.getByRole("button", { name: "周视图" });
    expect(weekButton).toHaveAttribute("aria-pressed", "false");
    await user.click(weekButton);

    expect(weekButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByDisplayValue("旧父任务")).toBeInTheDocument();
    expect(screen.getByDisplayValue("近期子任务")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("旧兄弟")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("近期已完成")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("无效时间")).not.toBeInTheDocument();
    expect(screen.queryByText(recent)).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "搜索任务" }), "近期");
    await user.selectOptions(screen.getByRole("combobox", { name: "状态筛选" }), "in_progress");
    expect(screen.getByDisplayValue("旧父任务")).toBeInTheDocument();
    expect(screen.getByDisplayValue("近期子任务")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("近期已完成")).not.toBeInTheDocument();
  });

  test("周视图删除空任务后聚焦上一条可见任务", async () => {
    const user = userEvent.setup();
    const now = Date.parse("2026-08-06T12:00:00Z");
    const tasks: TodoTask[] = [
      {
        ...initialTasks[0],
        id: "recent-previous",
        position: 0,
        title: "近期上一任务",
        updatedAt: "2026-08-05T12:00:00Z"
      },
      {
        ...initialTasks[0],
        id: "old-hidden",
        position: 1,
        title: "过期隐藏任务",
        updatedAt: "2026-07-20T12:00:00Z"
      },
      {
        ...initialTasks[0],
        id: "recent-empty",
        position: 2,
        title: "",
        updatedAt: "2026-08-05T12:00:00Z"
      }
    ];
    render(
      <TodoListView
        initialTasks={tasks}
        persistTasks={vi.fn()}
        now={() => now}
      />
    );

    await user.click(screen.getByRole("button", { name: "周视图" }));
    expect(screen.queryByDisplayValue("过期隐藏任务")).not.toBeInTheDocument();

    const emptyTitle = screen
      .getAllByLabelText("任务标题")
      .find((input) => (input as HTMLInputElement).value === "") as HTMLInputElement;
    emptyTitle.focus();
    await user.keyboard("{Backspace}");

    const previousTitle = screen.getByDisplayValue("近期上一任务") as HTMLInputElement;
    await waitFor(() => expect(previousTitle).toHaveFocus());
    expect(previousTitle.selectionStart).toBe(previousTitle.value.length);
    expect(previousTitle.selectionEnd).toBe(previousTitle.value.length);
  });

  test("周视图跨页删除空任务后按可见顺序定位分页并聚焦", async () => {
    const user = userEvent.setup();
    const now = Date.parse("2026-08-06T12:00:00Z");
    const tasks: TodoTask[] = Array.from({ length: 601 }, (_, index) => [
      ...(
        index < 250
          ? [{
              ...initialTasks[0],
              id: `old-${index}`,
              title: `过期任务 ${index}`,
              updatedAt: "2026-07-20T12:00:00Z"
            }]
          : []
      ),
      {
        ...initialTasks[0],
        id: `recent-${index}`,
        title: index === 250 ? "" : `近期任务 ${index}`,
        updatedAt: "2026-08-05T12:00:00Z"
      }
    ]).flat().map((task, position) => ({ ...task, position }));
    render(
      <TodoListView
        initialTasks={tasks}
        persistTasks={vi.fn()}
        now={() => now}
      />
    );

    await user.click(screen.getByRole("button", { name: "周视图" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));
    const emptyTitle = screen
      .getAllByLabelText("任务标题")
      .find((input) => (input as HTMLInputElement).value === "") as HTMLInputElement;
    expect(emptyTitle).toHaveValue("");

    emptyTitle.focus();
    await user.keyboard("{Backspace}");

    const previousTitle = await screen.findByDisplayValue("近期任务 249");
    await waitFor(() => expect(previousTitle).toHaveFocus());
    expect(screen.getByText("第 2 / 3 页 · 共 600 条")).toBeInTheDocument();
  });

  test("切换周视图回到第一页，跨视图定位时关闭周视图", async () => {
    const user = userEvent.setup();
    const now = Date.parse("2026-08-06T12:00:00Z");
    const recent = "2026-08-05T12:00:00Z";
    const tasks: TodoTask[] = Array.from({ length: 201 }, (_, index) => ({
      ...initialTasks[0],
      id: `week-${index}`,
      title: index === 200 ? "旧定位任务" : `近期任务 ${index}`,
      position: index,
      updatedAt: index === 200 ? "2026-07-20T12:00:00Z" : recent
    }));
    const props = {
      initialTasks: tasks,
      persistTasks: vi.fn(),
      now: () => now
    };
    const { rerender } = render(<TodoListView {...props} />);

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("第 2 / 2 页 · 共 201 条")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "周视图" }));
    expect(screen.getByText("第 1 / 1 页 · 共 200 条")).toBeInTheDocument();

    rerender(
      <TodoListView
        {...props}
        navigationTarget={{ taskId: "week-200", requestId: 1 }}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "周视图" })).toHaveAttribute(
        "aria-pressed",
        "false"
      )
    );
    expect(screen.getByDisplayValue("旧定位任务")).toBeInTheDocument();
  });

  test("当前会话编辑后会立即命中周视图", async () => {
    const user = userEvent.setup();
    const now = Date.parse("2026-08-06T12:00:00Z");
    render(
      <TodoListView
        initialTasks={[
          {
            ...initialTasks[0],
            id: "edited",
            title: "旧任务",
            updatedAt: "2026-07-20T12:00:00Z"
          }
        ]}
        persistTasks={vi.fn()}
        now={() => now}
      />
    );

    const title = screen.getByDisplayValue("旧任务");
    await user.clear(title);
    await user.type(title, "刚刚修改");
    await user.click(screen.getByRole("button", { name: "周视图" }));

    expect(screen.getByDisplayValue("刚刚修改")).toBeInTheDocument();
  });

  test("周视图每分钟推进滚动窗口", () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-08-06T12:00:00Z");
    const updatedAt = new Date(now - TODO_RECENCY_WINDOW_MS + 30_000).toISOString();
    render(
      <TodoListView
        initialTasks={[
          { ...initialTasks[0], id: "expiring", title: "即将过期", updatedAt }
        ]}
        persistTasks={vi.fn()}
        now={() => now}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "周视图" }));
    expect(screen.getByDisplayValue("即将过期")).toBeInTheDocument();

    act(() => {
      now += 60_000;
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByDisplayValue("即将过期")).not.toBeInTheDocument();
  });

  test("浏览器 demo 可演示近期、过期和近期子任务的祖先", async () => {
    const user = userEvent.setup();
    const now = Date.parse("2026-08-06T12:00:00Z");
    render(
      <TodoListView
        initialTasks={demoTasks(now)}
        persistTasks={vi.fn()}
        now={() => now}
      />
    );

    await user.click(screen.getByRole("button", { name: "周视图" }));

    expect(screen.getByDisplayValue("西北中卫质量链路验收")).toBeInTheDocument();
    expect(screen.getByDisplayValue("异构镜像需要清理管控 agent 的残留状态信息")).toBeInTheDocument();
    expect(screen.getByDisplayValue("异构实现带外探测 from 方文奇")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("云助手标准输出放大一些")).not.toBeInTheDocument();
  });

  test("顶层任务树按全部未完成、部分未完成、全部已完成展示", () => {
    const groupedTasks: TodoTask[] = [
      { ...initialTasks[0], id: "done", title: "全部已完成", parentId: undefined, position: 0, status: "completed" },
      { ...initialTasks[0], id: "open", title: "全部未完成", parentId: undefined, position: 1, status: "todo" },
      { ...initialTasks[0], id: "partial", title: "部分未完成", parentId: undefined, position: 2, status: "todo" },
      { ...initialTasks[1], id: "partial-child", title: "已完成子任务", parentId: "partial", position: 0, status: "cancelled" }
    ];

    render(<TodoListView initialTasks={groupedTasks} persistTasks={vi.fn()} />);

    expect(
      screen.getAllByLabelText("任务标题").map((input) => (input as HTMLInputElement).value)
    ).toEqual(["全部未完成", "部分未完成", "已完成子任务", "全部已完成"]);
  });

  test("跨完成度分组拖拽不改变持久化顺序", async () => {
    const roots: TodoTask[] = [
      { ...initialTasks[0], id: "done", title: "已完成任务", parentId: undefined, position: 0, status: "completed" },
      { ...initialTasks[0], id: "open", title: "未完成任务", parentId: undefined, position: 1, status: "todo" }
    ];
    const persistTasks = vi.fn();
    render(<TodoListView initialTasks={roots} persistTasks={persistTasks} />);

    const doneRow = screen.getByDisplayValue("已完成任务").closest("[data-task-row]") as HTMLElement;
    vi.spyOn(doneRow, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: 100,
      toJSON: () => ({})
    });
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动 未完成任务" }));
    dragOverAt(doneRow, 116);
    fireEvent.drop(doneRow, { clientY: 116 });

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(persistTasks).not.toHaveBeenCalled();
    expect(
      screen.getAllByLabelText("任务标题").map((input) => (input as HTMLInputElement).value)
    ).toEqual(["未完成任务", "已完成任务"]);
  });

  test("拖到任务行上半区或下半区会保存同级顺序且不刷新业务活动时间", async () => {
    const roots: TodoTask[] = [
      { ...initialTasks[0], id: "a", title: "任务 A", parentId: undefined, position: 0 },
      { ...initialTasks[0], id: "b", title: "任务 B", parentId: undefined, position: 1 },
      { ...initialTasks[0], id: "c", title: "任务 C", parentId: undefined, position: 2 }
    ];
    const persistTasks = vi.fn();
    const now = Date.parse("2026-08-06T12:00:00Z");
    render(
      <TodoListView
        initialTasks={roots}
        persistTasks={persistTasks}
        now={() => now}
      />
    );

    const rowA = screen.getByDisplayValue("任务 A").closest("[data-task-row]") as HTMLElement;
    vi.spyOn(rowA, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: 100,
      toJSON: () => ({})
    });
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动 任务 C" }));
    dragOverAt(rowA, 116);
    expect(rowA).toHaveAttribute("data-drop-placement", "before");
    fireEvent.drop(rowA, { clientY: 116 });
    expect(screen.getAllByLabelText("任务标题").map((input) => (input as HTMLInputElement).value)).toEqual([
      "任务 C",
      "任务 A",
      "任务 B"
    ]);

    const rowB = screen.getByDisplayValue("任务 B").closest("[data-task-row]") as HTMLElement;
    vi.spyOn(rowB, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: 100,
      toJSON: () => ({})
    });
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动 任务 C" }));
    dragOverAt(rowB, 124);
    expect(rowB).toHaveAttribute("data-drop-placement", "after");
    fireEvent.drop(rowB, { clientY: 124 });
    expect(screen.getAllByLabelText("任务标题").map((input) => (input as HTMLInputElement).value)).toEqual([
      "任务 A",
      "任务 B",
      "任务 C"
    ]);
    expect(screen.getByDisplayValue("任务 C").closest("[data-task-row]")).toHaveAttribute(
      "data-depth",
      "0"
    );
    await waitFor(() =>
      expect(persistTasks).toHaveBeenLastCalledWith(roots)
    );
  });

  test("拖到任务行中线后方只调整顺序，拖动结束会清除提示", () => {
    const roots: TodoTask[] = [
      { ...initialTasks[0], id: "a", title: "任务 A", parentId: undefined, position: 0 },
      { ...initialTasks[0], id: "b", title: "任务 B", parentId: undefined, position: 1 }
    ];
    render(<TodoListView initialTasks={roots} persistTasks={vi.fn()} />);

    const rowB = screen.getByDisplayValue("任务 B").closest("[data-task-row]") as HTMLElement;
    vi.spyOn(rowB, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 140,
      height: 40,
      left: 0,
      right: 600,
      width: 600,
      x: 0,
      y: 100,
      toJSON: () => ({})
    });
    fireEvent.dragStart(screen.getByRole("button", { name: "拖动 任务 A" }));
    dragOverAt(rowB, 120);
    expect(rowB).toHaveAttribute("data-drop-placement", "after");
    fireEvent.dragEnd(screen.getByRole("button", { name: "拖动 任务 A" }));
    expect(rowB).not.toHaveAttribute("data-drop-placement");

    fireEvent.dragStart(screen.getByRole("button", { name: "拖动 任务 A" }));
    dragOverAt(rowB, 120);
    fireEvent.drop(rowB, { clientY: 120 });

    expect(screen.getByDisplayValue("任务 A").closest("[data-task-row]")).toHaveAttribute(
      "data-depth",
      "0"
    );
    expect(screen.getAllByLabelText("任务标题").map((input) => (input as HTMLInputElement).value)).toEqual([
      "任务 B",
      "任务 A"
    ]);
  });
});
