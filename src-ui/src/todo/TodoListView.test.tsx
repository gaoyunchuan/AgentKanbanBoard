import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BoardStatus, ThreadItem } from "@/types";
import type { ThreadTaskLink } from "@/associations/types";
import type { BackendTodoTask, TodoTask } from "./types";
import { mapBackendTodoTask, TodoListView } from "./TodoListView";

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
  afterEach(() => cleanup());

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
    expect(mapped.pinned).toBe(true);

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
      status: index === 200 ? "in_progress" : "todo"
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

  test("拖到任务行上半区或下半区会调整同级顺序并保存", async () => {
    const roots: TodoTask[] = [
      { ...initialTasks[0], id: "a", title: "任务 A", parentId: undefined, position: 0 },
      { ...initialTasks[0], id: "b", title: "任务 B", parentId: undefined, position: 1 },
      { ...initialTasks[0], id: "c", title: "任务 C", parentId: undefined, position: 2 }
    ];
    const persistTasks = vi.fn();
    render(<TodoListView initialTasks={roots} persistTasks={persistTasks} />);

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
    await waitFor(() => expect(persistTasks).toHaveBeenLastCalledWith(roots));
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
