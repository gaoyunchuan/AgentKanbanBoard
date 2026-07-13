# To Do List Priority, Thread Column, and Date Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 To Do List 按顶层任务树完成度自动分组展示，在第二列展示全部关联 Thread，并压缩、补齐日期体验。

**Architecture:** 排序由 `todoTree.ts` 中的纯函数派生，不改写数据库位置；`TodoListView` 负责紧凑列布局、默认日期和只读添加日期；现有 `useThreadTaskLinks` 增加可重试的加载错误状态，并由进入 To Do 页面触发一次独立加载。数据库 schema 与 Thread 五秒轮询链路保持不变。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、Tailwind CSS、Tauri 2、Rust/rusqlite。

## Global Constraints

- 直接在 `main` 开发，禁止 WorkTree，代码注释和文档使用中文。
- `completed` 和 `cancelled` 都按完成态计算；只对顶层任务树分组，子任务顺序不单独重排。
- 展示顺序固定为“全部未完成 → 部分未完成 → 全部已完成”，同组内保持 `position`。
- 关联 Thread 列展示全部可点击紧凑标签，允许换行，不进入 `BoardData` 或五秒轮询。
- 新建根任务、子任务、前插同级、后插同级的预期结束日期均为本地日历明天；已有数据不回填。
- 起始日期不展示但继续保存；添加日期使用 `created_at`，按本地时区显示 `YYYY-MM-DD` 且不可编辑。
- 预期和实际结束日期保持完整 `YYYY-MM-DD`，列宽各约 `96px`。
- 约 650px 内容宽度不产生横向溢出。

---

### Task 1: 顶层任务树完成度排序与跨组拖拽保护

**Files:**
- Modify: `src-ui/src/todo/todoTree.ts`
- Test: `src-ui/src/todo/todoTree.test.ts`
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Test: `src-ui/src/todo/TodoListView.test.tsx`
- Modify: `src-ui/src/associations/associationModel.ts`
- Test: `src-ui/src/associations/associationModel.test.ts`

**Interfaces:**
- Produces: `TodoTreeCompletion = "all_incomplete" | "partially_incomplete" | "all_complete"`
- Produces: `todoTreeCompletion(tasks: TodoTask[], taskId: string): TodoTreeCompletion`
- Produces: `flattenTodoTreeByCompletion(tasks: TodoTask[], collapsedIds?: Set<string>): FlatTodoTask[]`
- Consumes: existing `normalizeTodoPositions` and `flattenTodoTree`

- [x] **Step 1: Write failing pure-function tests**

Add tests that construct three root trees in persisted order `complete`, `partial`, `incomplete`, then expect derived order `incomplete`, `partial + child`, `complete`. Include a cancelled-only tree and assert it belongs to `all_complete`:

```ts
expect(flattenTodoTreeByCompletion(tasks).map(({ task }) => task.id)).toEqual([
  "incomplete",
  "partial",
  "partial-child",
  "complete"
]);
expect(todoTreeCompletion(cancelledTree, "cancelled-root")).toBe("all_complete");
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: FAIL because the two exported functions do not exist.

- [x] **Step 3: Implement minimal completion grouping**

In `todoTree.ts`, collect each root and its descendants, classify statuses, stable-sort roots by the rank below, then flatten each tree without changing child order:

```ts
export type TodoTreeCompletion =
  | "all_incomplete"
  | "partially_incomplete"
  | "all_complete";

const completionRank: Record<TodoTreeCompletion, number> = {
  all_incomplete: 0,
  partially_incomplete: 1,
  all_complete: 2
};

const isDone = (task: TodoTask) =>
  task.status === "completed" || task.status === "cancelled";
```

Keep malformed/orphan tasks stable at the end, matching the current defensive behavior.

- [x] **Step 4: Use derived order in the view and add a failing cross-group drag test**

Replace display-only calls that calculate visible rows and focus pages with `flattenTodoTreeByCompletion`. Update `todoTargetPage` in `associationModel.ts` to use the same derived order so cross-view navigation opens the correct page. Keep mutation helpers on persisted `position` order. Add a view test that drags an incomplete root onto a completed root and expects no `persistTasks` call and unchanged display order. Add an association-model test where a completed task is persisted first but moves to the second page after grouping.

- [x] **Step 5: Implement cross-group drag guard**

Before setting a drop target and before applying a drop, compare the dragged and target root completion groups. Reject only root-to-root drops whose groups differ; keep existing child same-level behavior unchanged.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts src/todo/TodoListView.test.tsx src/associations/associationModel.test.ts`

Expected: PASS; same-group drag tests remain green and new cross-group test passes.

- [x] **Step 7: Commit the task**

```bash
git add src-ui/src/todo/todoTree.ts src-ui/src/todo/todoTree.test.ts \
  src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx \
  src-ui/src/associations/associationModel.ts src-ui/src/associations/associationModel.test.ts
git commit -m "feat: sort todo trees by completion"
```

### Task 2: 添加日期、默认明天与紧凑日期列

**Files:**
- Modify: `src-ui/src/todo/types.ts`
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Modify: `src-ui/src/index.css`
- Test: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Produces: optional `TodoTask.createdAt?: string`
- Produces: `nextLocalDate(value: string): string`
- Consumes: `BackendTodoTask.created_at`

- [x] **Step 1: Write failing date/model tests**

Cover backend mapping, expansion metadata, all four creation paths, and removal of the start-date column:

```ts
expect(mapBackendTodoTask(backendTask).createdAt).toBe("2026-07-13T16:30:00Z");
expect(screen.getByText("添加日期：2026-07-14")).toBeInTheDocument();
expect(screen.queryByText("起始日期")).not.toBeInTheDocument();
expect(createdTask.expectedEndDate).toBe("2027-01-01");
```

Use `today={() => "2026-12-31"}` so the test is deterministic. Assert that root, child, before-sibling, and after-sibling tasks all receive `2027-01-01`.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: FAIL because `createdAt` is not mapped or rendered and new tasks have no default end date.

- [x] **Step 3: Extend the frontend model and date helpers**

Add `createdAt?: string` to `TodoTask`. Map `created_at` in `mapBackendTodoTask`. Build all new tasks through one factory that receives `today()`:

```ts
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
```

Implement calendar addition through local date components, not millisecond addition, to avoid DST errors.

- [x] **Step 4: Render local created date and remove start-date UI**

Remove `startDate` from `DateField` and from the list header/row while keeping `TodoTask.startDate` and `mapTodoTaskInput.start_date`. Add the metadata strip at the start of `ExtensionPanel`:

```tsx
<div className="col-span-full border-b px-2.5 py-2 text-[10px] text-muted-foreground">
  添加日期：{formatLocalCreatedDate(task.createdAt)}
</div>
```

Existing tasks without `createdAt` render `添加日期：—`.

- [x] **Step 5: Compact the grid**

Change `.todo-grid` to five columns in this exact order:

```css
.todo-grid {
  grid-template-columns: minmax(0, 1fr) 180px 96px 96px 84px;
}
```

Ensure row children use `min-w-0`; keep full date strings and existing double-click editors.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: PASS, including existing date editing and new default/metadata tests.

- [x] **Step 7: Commit the task**

```bash
git add src-ui/src/todo/types.ts src-ui/src/todo/TodoListView.tsx \
  src-ui/src/todo/TodoListView.test.tsx src-ui/src/index.css
git commit -m "feat: streamline todo dates"
```

### Task 3: 折叠行 Thread 标签与可重试加载

**Files:**
- Modify: `src-ui/src/associations/useThreadTaskLinks.ts`
- Test: `src-ui/src/associations/useThreadTaskLinks.test.tsx`
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Test: `src-ui/src/todo/TodoListView.test.tsx`
- Modify: `src-ui/src/App.tsx`
- Test: `src-ui/src/App.test.tsx`

**Interfaces:**
- Produces from hook: `loadError?: string`
- Adds Todo props: `linksLoading?: boolean`, `linksLoadError?: string`, `onLoadThreadLinks?: (force?: boolean) => Promise<void>`
- Consumes: existing `linksByThread`, `threads`, `onOpenThread`

- [x] **Step 1: Write failing hook error/retry test**

Configure `load_thread_task_links` to reject once and resolve on retry. Assert loading clears, `loadError` is set, and `loadLinks(true)` clears it and populates links:

```ts
await expect(result.current.loadLinks()).rejects.toThrow("读取失败");
expect(result.current.loadError).toBe("关联加载失败");
await result.current.loadLinks(true);
expect(result.current.loadError).toBeUndefined();
```

- [x] **Step 2: Implement hook load error state**

Set `loadError` to `undefined` before loading, set it to `关联加载失败` in `catch`, rethrow so callers can decide whether to show a toast, and return it from the hook. Keep `loadedRef` false after failure so retry works.

- [x] **Step 3: Write failing Thread-column view tests**

Render a task with two linked threads and assert both compact buttons are visible and clickable without expanding. Add loading, empty, and failure/retry cases:

```ts
expect(screen.getByRole("button", { name: "打开 Thread thread-a" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "打开 Thread thread-b" })).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "重试关联加载" }));
expect(onLoadThreadLinks).toHaveBeenCalledWith(true);
```

- [x] **Step 4: Implement `TaskThreadTags` and mount loading**

Add a focused internal component that filters `threads` through `linksByThread.get(thread.id)?.taskId === task.id`, renders all titles as wrapping compact buttons, and delegates clicks to `onOpenThread`. In a mount effect call `onLoadThreadLinks?.()` once and catch the rejected promise because the prop state renders the error.

Do not remove `TaskThreadAssociationPanel` from the expanded section.

- [x] **Step 5: Wire App state and test the lifecycle boundary**

Pass these bindings from `App`:

```tsx
linksLoading={associations.loading}
linksLoadError={associations.loadError}
onLoadThreadLinks={associations.loadLinks}
```

Keep `onExpandTask` as a defensive `loadLinks` call with an explicit rejection catch. Update the App test to assert opening To Do calls `load_thread_task_links` but the five-second `load_board_data` refresh does not cause additional association loads.

- [x] **Step 6: Run association and view tests and confirm GREEN**

Run: `cd src-ui && npm test -- --run src/associations/useThreadTaskLinks.test.tsx src/todo/TodoListView.test.tsx src/App.test.tsx`

Expected: PASS; compact tags, retry, and lazy-boundary assertions are green.

- [x] **Step 7: Commit the task**

```bash
git add src-ui/src/associations/useThreadTaskLinks.ts \
  src-ui/src/associations/useThreadTaskLinks.test.tsx src-ui/src/todo/TodoListView.tsx \
  src-ui/src/todo/TodoListView.test.tsx src-ui/src/App.tsx src-ui/src/App.test.tsx
git commit -m "feat: show todo thread links in list"
```

### Task 4: 项目知识、全量验证与视觉验收

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`

**Interfaces:**
- Consumes: completed Tasks 1–3
- Produces: durable project constraints and reproducible verification evidence

- [x] **Step 1: Update maintained project knowledge**

Record the new completion-group order, Thread second-column loading boundary, hidden start date, `created_at` detail display, and default-next-day rule in `docs/agent/coding.md`. Add corresponding sorting, creation-path, Thread label, 650px layout, and date regression coverage to `docs/agent/testing.md`.

- [x] **Step 2: Run frontend verification**

Run:

```bash
cd src-ui
npm test -- --run
npm run build
```

Expected: all Vitest suites pass and Vite production build exits 0.

- [x] **Step 3: Run Rust and repository verification**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cd src-tauri && cargo fmt --check
cd .. && git diff --check
```

Expected: all Rust tests pass, formatting is clean, and no whitespace errors are reported.

- [x] **Step 4: Run browser visual checks**

Start the browser preview and verify 1440×1024 and 1024×768 viewports plus an approximately 650px To Do content area. Check:

- group order and intact parent/child trees;
- all Thread tags wrap inside the second column and open their Thread;
- full date strings fit the 96px columns;
- start date is absent and added date appears after expansion;
- no horizontal overflow or browser console errors;
- browser demo does not call a Tauri bridge.

Save screenshots under `docs/images/` only if they add durable review value; otherwise report exact viewport evidence in the final handoff.

- [x] **Step 5: Commit knowledge updates and any verification fixes**

```bash
git add docs/agent/coding.md docs/agent/testing.md src-ui src-tauri
git commit -m "docs: record todo priority layout rules"
```

Do not create an empty commit if verification required no code or documentation changes.
