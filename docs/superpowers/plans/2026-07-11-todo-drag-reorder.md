# 恢复 To Do 任务拖放排序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让拖拽手柄始终可见，并让目标行上、下半区稳定执行同级向前、向后排序，不再通过拖放改变任务层级。

**Architecture:** 保留 `todoTree.ts` 的相对移动纯函数和现有快照持久化链路，只收窄 `TodoListView.tsx` 的 UI 拖放语义。组件根据指针相对目标行中线的位置生成 `before` 或 `after`，拖放结束仍由 `applyTasks` 归一化并保存完整快照。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、Playwright

## Global Constraints

- 直接在当前 `main` 开发，不创建分支或 worktree。
- 只修改拖放交互及其测试，不修改数据库结构和任务领域字段。
- 创建子任务继续使用 `Tab` 或“子任务”按钮。
- 拖动任务时保留任务全部后代、状态、日期和扩展字段。
- 不操作桌面壳中的用户现有任务数据。

---

### Task 1: 拖放排序交互

**Files:**
- Modify: `src-ui/src/todo/TodoListView.tsx:120-130,390-455`
- Test: `src-ui/src/todo/TodoListView.test.tsx:378-455`

**Interfaces:**
- Consumes: `moveTaskRelative(tasks, taskId, targetId, placement)` 与 `applyTasks(next)`。
- Produces: 只可能为 `"before" | "after"` 的 UI 落点，以及默认可见的拖拽手柄。

- [x] **Step 1: 写拖拽手柄常显的失败测试**

```tsx
test("拖拽手柄默认可见", () => {
  render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

  expect(screen.getByRole("button", { name: "拖动 主任务" })).not.toHaveClass("opacity-0");
});
```

- [x] **Step 2: 写上、下半区排序且不改变层级的失败测试**

使用高度 40px、顶部 100px 的目标行：`clientY = 116` 必须得到 `before`，`clientY = 124` 必须得到 `after`。拖放后断言标题顺序、`data-depth="0"` 和 `persistTasks` 收到的新快照。

```tsx
const persistTasks = vi.fn();
render(<TodoListView initialTasks={roots} persistTasks={persistTasks} />);

fireEvent.dragStart(screen.getByRole("button", { name: "拖动 任务 C" }));
dragOverAt(rowA, 116);
expect(rowA).toHaveAttribute("data-drop-placement", "before");
fireEvent.drop(rowA, { clientY: 116 });
expect(screen.getByDisplayValue("任务 C").closest("[data-task-row]")).toHaveAttribute("data-depth", "0");
```

- [x] **Step 3: 运行组件测试，确认因旧交互失败**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: FAIL；手柄仍含 `opacity-0`，`clientY = 116/124` 仍得到 `inside` 或子任务层级。

- [x] **Step 4: 实现最小拖放语义修改**

在 `TodoListView.tsx` 中把落点计算收敛为目标行中线两侧，并在 `drop` 时重新计算兜底，禁止产生 `inside`：

```tsx
function taskDropPlacement(clientY: number, rect: Pick<DOMRect, "top" | "height">): TaskDropPlacement {
  return clientY - rect.top < rect.height / 2 ? "before" : "after";
}
```

移除 `inside` 高亮分支，并把手柄样式从悬停显示改为默认使用 `text-muted-foreground/50`。

- [x] **Step 5: 运行组件和树测试，确认通过**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx src/todo/todoTree.test.ts`

Expected: PASS；两个测试文件全部通过。

- [x] **Step 6: 提交交互修复**

```bash
git add src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx
git commit -m "fix: restore todo drag reordering"
```

### Task 2: 完整验证

**Files:**
- Verify: `src-ui/src/todo/TodoListView.tsx`
- Verify: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Consumes: Task 1 的拖放交互。
- Produces: 自动化测试、构建、格式和真实浏览器拖放证据。

- [x] **Step 1: 运行完整前端测试**

Run: `cd src-ui && npm test -- --run`

Expected: 所有测试文件通过，失败数为 0。

- [x] **Step 2: 运行生产构建**

Run: `cd src-ui && npm run build`

Expected: TypeScript 与 Vite 构建退出码为 0。

- [x] **Step 3: 运行真实浏览器拖放探针**

用浏览器 demo 数据把一个根任务拖到另一个根任务的上半区和下半区，断言 DOM 标题顺序发生对应变化、任务深度仍为 0、拖拽手柄计算样式非透明且控制台无应用错误。

- [x] **Step 4: 检查补丁格式和工作区边界**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 无输出；只保留用户原有的 `AGENTS.md`、`.superpowers/` 变更和本任务预期文件状态。
