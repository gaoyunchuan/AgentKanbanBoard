# Todo List 向上新建快捷键 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Todo List 增加 `Cmd+Shift+Enter` 在当前任务正上方创建同级任务的能力，并保留 `Cmd+Enter` 向后创建行为。

**Architecture:** 扩展纯函数 `insertSiblingTask`，用 `before | after` 参数统一计算同级插入位置；视图层只负责把 Shift 修饰键映射为方向，并继续复用现有创建、聚焦、分页和持久化流程。

**Tech Stack:** TypeScript、React 18、Vitest、Testing Library

## Global Constraints

- 代码注释和文档使用中文。
- `Cmd+Shift+Enter` 在当前任务正上方创建同级空任务并自动聚焦。
- `Cmd+Enter` 继续在当前任务正下方创建同级任务。
- 不改变拖放、缩进、提升层级、后端数据结构和快照持久化语义。

---

### Task 1: 支持按方向插入同级任务

**Files:**
- Modify: `src-ui/src/todo/todoTree.ts`
- Test: `src-ui/src/todo/todoTree.test.ts`

**Interfaces:**
- Consumes: `TodoTask[]`、当前任务 ID、新任务对象。
- Produces: `insertSiblingTask(tasks: TodoTask[], taskId: string, newTask: TodoTask, placement?: "before" | "after"): TodoTask[]`；默认方向为 `after`，兼容现有调用。

- [ ] **Step 1: 写入失败的树操作测试**

将现有向后插入测试保留，并新增向前插入及子任务同级插入断言：

```ts
test("可在当前任务之前或之后插入同级任务", () => {
  const tasks = [task("a", undefined, 0), task("b", undefined, 1)];

  const insertedAfter = insertSiblingTask(tasks, "a", task("after", undefined, 0, ""));
  expect(flattenTodoTree(insertedAfter).map(({ task }) => task.id)).toEqual([
    "a",
    "after",
    "b"
  ]);

  const insertedBefore = insertSiblingTask(
    tasks,
    "b",
    task("before", undefined, 0, ""),
    "before"
  );
  expect(flattenTodoTree(insertedBefore).map(({ task }) => task.id)).toEqual([
    "a",
    "before",
    "b"
  ]);
});

test("向前插入时继承当前任务的父级", () => {
  const tasks = [
    task("root", undefined, 0),
    task("first", "root", 0),
    task("second", "root", 1)
  ];
  const changed = insertSiblingTask(
    tasks,
    "second",
    task("new", undefined, 0, ""),
    "before"
  );

  expect(changed.find((item) => item.id === "new")).toMatchObject({
    parentId: "root",
    position: 1
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: FAIL，TypeScript 或断言显示 `insertSiblingTask` 尚不支持第四个 `before` 参数。

- [ ] **Step 3: 实现最小方向参数**

将插入位置改为根据方向计算，默认保持向后：

```ts
export function insertSiblingTask(
  tasks: TodoTask[],
  taskId: string,
  newTask: TodoTask,
  placement: "before" | "after" = "after"
): TodoTask[] {
  const current = tasks.find((task) => task.id === taskId);
  if (!current) return normalizeTodoPositions([...tasks, newTask]);
  const position = current.position + (placement === "after" ? 1 : 0);
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
```

- [ ] **Step 4: 运行树操作测试并确认通过**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: PASS，全部树操作测试通过。

### Task 2: 接入键盘快捷键与界面提示

**Files:**
- Modify: `src-ui/src/App.tsx`
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Test: `src-ui/src/App.test.tsx`
- Test: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Consumes: Task 1 产出的 `insertSiblingTask(..., placement)`。
- Produces: `Cmd+Enter` 向后插入、`Cmd+Shift+Enter` 向前插入的标题输入框交互。

- [ ] **Step 1: 写入失败的组件交互测试**

将现有快捷键测试改为覆盖提示、向后和向前插入，并验证新建任务获得焦点：

```tsx
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
```

- [ ] **Step 2: 运行组件测试并确认失败**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: FAIL，页面提示仍为旧文本，且 `Cmd+Shift+Enter` 仍向后插入。

- [ ] **Step 3: 接入方向并更新提示**

把提示更新为：

```ts
const [message, setMessage] = useState(
  "⌘⇧Enter 向上新建 · ⌘Enter 向后新建 · Tab 缩进 · Shift+Tab 提升层级"
);
```

让创建方法接收方向：

```ts
const addSiblingTask = (taskId: string, placement: "before" | "after" = "after") => {
  const id = createId();
  applyTasks(insertSiblingTask(tasks, taskId, emptyTask(id, undefined, 0), placement), {
    focusId: id
  });
};
```

在标题输入框键盘事件中根据 Shift 状态选择方向：

```tsx
if (event.key === "Enter" && event.metaKey) {
  event.preventDefault();
  addSiblingTask(task.id, event.shiftKey ? "before" : "after");
}
```

- [ ] **Step 4: 运行 TodoListView 测试并确认通过**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: PASS，全部 TodoListView 测试通过。

- [ ] **Step 5: 写入失败的应用顶部提示测试**

在打开 To Do List 的应用测试中加入：

```tsx
expect(
  screen.getByText(
    "用树形任务拆解工作，日期双击编辑，⌘⇧Enter 向上新建，⌘Enter 向后新建，Tab 调整层级。"
  )
).toBeInTheDocument();
```

- [ ] **Step 6: 运行顶部提示测试并确认失败**

Run: `cd src-ui && npm test -- --run src/App.test.tsx -t "opens the independent To Do List page from the sidebar"`

Expected: FAIL，应用顶部仍显示旧的 `⌘+Enter 新建` 文案。

- [ ] **Step 7: 更新应用顶部提示**

将 To Do List 说明更新为：

```tsx
"用树形任务拆解工作，日期双击编辑，⌘⇧Enter 向上新建，⌘Enter 向后新建，Tab 调整层级。"
```

- [ ] **Step 8: 运行顶部提示测试并确认通过**

Run: `cd src-ui && npm test -- --run src/App.test.tsx -t "opens the independent To Do List page from the sidebar"`

Expected: PASS，顶部提示测试通过。

### Task 3: 全量验证并提交

**Files:**
- Verify: `docs/agent/coding.md`
- Verify: `docs/agent/testing.md`
- Verify: `src-ui/src/App.tsx`
- Verify: `src-ui/src/App.test.tsx`
- Verify: `src-ui/src/todo/todoTree.ts`
- Verify: `src-ui/src/todo/todoTree.test.ts`
- Verify: `src-ui/src/todo/TodoListView.tsx`
- Verify: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的完整改动。
- Produces: 可复核的测试、构建和差异检查结果。

- [ ] **Step 1: 运行前端全量测试**

Run: `cd src-ui && npm test -- --run`

Expected: PASS，全部测试通过。

- [ ] **Step 2: 运行前端构建**

Run: `cd src-ui && npm run build`

Expected: PASS，TypeScript 检查及 Vite 构建成功。

- [ ] **Step 3: 检查代码差异**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 无输出；状态仅包含本计划、项目知识及六个预期源码/测试文件。

- [ ] **Step 4: 提交实现**

```bash
git add docs/superpowers/plans/2026-07-11-todo-insert-before-shortcut.md \
  docs/agent/coding.md \
  docs/agent/testing.md \
  src-ui/src/App.tsx \
  src-ui/src/App.test.tsx \
  src-ui/src/todo/todoTree.ts \
  src-ui/src/todo/todoTree.test.ts \
  src-ui/src/todo/TodoListView.tsx \
  src-ui/src/todo/TodoListView.test.tsx
git commit -m "feat: add todo insert-before shortcut"
```
