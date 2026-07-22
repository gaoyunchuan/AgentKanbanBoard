# To Do List 默认每页 200 条实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 To Do List 固定分页大小从 `50` 调整为 `200`，并保持搜索、筛选和关联定位的分页语义。

**Architecture:** `TodoListView` 继续以单一 `todoPageSize` 常量驱动页数、切片和 `todoTargetPage` 调用，只修改常量值。视图测试使用 `201` 条任务覆盖第一页、第二页和关联定位边界；通用 `todoTargetPage` 仍接受调用方传入的页大小，不修改其接口。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、Vite

## Global Constraints

- 默认每页展示 `200` 条可见任务。
- 超过 `200` 条时继续使用现有上一页、下一页分页。
- 搜索或状态筛选变化后继续重置到第一页。
- 从 Thread 关联定位 Task 时继续根据排序后的任务位置自动进入正确页。
- 不修改任务排序、树结构、筛选、持久化、关联逻辑、后端接口或数据库。
- 直接在 `main` 开发，不创建分支，不使用 WorkTree。

---

### Task 1: 用 201 条边界锁定分页与关联定位行为

**Files:**
- Modify: `src-ui/src/todo/TodoListView.test.tsx:368-393,456-480`
- Modify: `src-ui/src/todo/TodoListView.tsx:92`

**Interfaces:**
- Consumes: `todoTargetPage(tasks: TodoTask[], taskId: string, pageSize: number): number | undefined`。
- Produces: `todoPageSize = 200`，供页数、列表切片和关联定位共同使用。

- [x] **Step 1: 把现有分页测试改为 201 条边界**

```tsx
test("列表使用紧凑行高并默认每页显示 200 条", async () => {
  const user = userEvent.setup();
  const manyTasks: TodoTask[] = Array.from({ length: 201 }, (_, index) => ({
    ...initialTasks[0],
    id: `task-${index + 1}`,
    title: `任务 ${String(index + 1).padStart(3, "0")}`,
    position: index,
    parentId: undefined
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
});
```

- [x] **Step 2: 把导航测试改为定位第 201 条**

将导航测试中的任务数量改为 `201`，把最后一条 `task-201` 设为完成态，并断言：

```tsx
expect(await screen.findByDisplayValue("任务 201")).toHaveFocus();
expect(screen.getByText("第 2 / 2 页 · 共 201 条")).toBeInTheDocument();
expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
```

- [x] **Step 3: 运行定向测试并确认因旧页大小失败**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: FAIL；分页测试实际第一页仍只有 `50` 条，导航第 `201` 条进入第 `5` 页，证明失败来自旧 `todoPageSize = 50`。

- [x] **Step 4: 写入最小实现**

```ts
const todoPageSize = 200;
```

- [x] **Step 5: 运行定向测试并确认通过**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: PASS；`TodoListView.test.tsx` 全部用例通过。

### Task 2: 同步项目知识并完成验证

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`
- Modify: `docs/superpowers/plans/2026-07-22-todo-list-page-size-200.md`

**Interfaces:**
- Consumes: Task 1 已验证的每页 `200` 条行为。
- Produces: 后续 To Do List 修改必须保留的 `200/201` 分页回归约束和执行证据。

- [x] **Step 1: 更新项目知识**

在 `docs/agent/coding.md` 记录分页和关联定位共用 `200` 条页大小；把 `docs/agent/testing.md` 中“每页 50 条分页”更新为“每页 200 条分页”，并增加：

```markdown
- 2026-07-22: To Do List 默认分页大小从 50 调整为 200，回归边界改为 200/201 条并覆盖关联定位第二页。
```

- [x] **Step 2: 运行完整前端测试**

Run: `cd src-ui && npm test -- --run`

Expected: PASS；所有测试文件和测试用例通过。

- [x] **Step 3: 运行生产构建**

Run: `cd src-ui && npm run build`

Expected: PASS；TypeScript 检查和 Vite 构建退出码为 `0`。

- [x] **Step 4: 检查差异范围和格式**

Run: `git diff --check && git status --short && git diff --stat HEAD`

Expected: `git diff --check` 无输出；仅包含分页常量、分页测试、项目测试知识和本计划进度。

- [x] **Step 5: 提交实现**

```bash
git add src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx docs/agent/testing.md docs/superpowers/plans/2026-07-22-todo-list-page-size-200.md
git commit -m "feat: 将 todo 默认页大小改为 200"
```

## 执行结果

- RED：旧 `todoPageSize = 50` 下，201 条分页测试实际只渲染 50 条，第 201 条关联定位也无法得到 `2 / 2` 页码。
- GREEN：修改为 `200` 后，`TodoListView.test.tsx` 的 21 个定向用例通过。
- 边界：201 条时第一页 200 条、第二页 1 条；状态筛选得到恰好 200 条时为单页，并从第二页复位；搜索与第 201 条关联定位均通过。
- 全量测试：13 个测试文件、89 个用例全部通过。
- 构建：TypeScript 检查和 Vite 生产构建成功。
- 差异检查：`git diff --check` 无输出，改动仅涉及分页常量、分页测试、项目知识和计划记录。
