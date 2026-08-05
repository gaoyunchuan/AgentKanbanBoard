# To Do Root 任务置顶实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 To Do List 增加可持久化的 root 任务置顶、层级变化时的置顶转移，以及不新增表格列的图钉标识和浅绿色整行背景。

**Architecture:** `pinned` 作为任务显式字段贯穿 SQLite、Rust 和 TypeScript；前后端都通过确定性归一化维护“只有 root 可置顶”的约束。前端以完整任务树为排序单元，将置顶 root 树排在现有完成度分组之前，并在现有任务单元格和菜单内完成状态表达与操作。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、Tauri 2、Rust、rusqlite、SQLite、Tailwind CSS、lucide-react。

## Global Constraints

- 仅 root 任务可以由用户置顶或取消置顶。
- 支持多个 root 任务同时置顶；置顶优先级高于现有完成度分组。
- 置顶任务从 root 变为非 root 时，置顶状态自动转移到它当前所属的新 root。
- 不新增表格列；图钉位于现有“任务”单元格且只占一个图标位。
- 仅置顶 root 的主任务行使用浅绿色背景，子任务和展开详情不染色。
- 继续保留快照 upsert 的 `created_at` 语义，不重建或删除用户已有任务数据。
- 代码注释、文档与会话使用中文；直接在 `main` 开发，不使用 WorkTree。

---

## 文件职责

- `src-tauri/db/001_init.sql`：定义新数据库的 `pinned` 列默认值。
- `src-tauri/src/domain.rs`：定义 Rust 输入和输出任务模型的 `pinned` 字段。
- `src-tauri/src/repository.rs`：迁移旧数据库、归一化置顶 root、保存并加载 `pinned`。
- `src-tauri/src/lib.rs`：覆盖迁移、持久化和后端约束测试。
- `src-ui/src/todo/types.ts`：定义前后端 TypeScript 任务模型字段。
- `src-ui/src/todo/todoTree.ts`：提供置顶归一化和完整任务树排序。
- `src-ui/src/todo/todoTree.test.ts`：覆盖置顶排序与 root 转移。
- `src-ui/src/todo/TodoListView.tsx`：接入统一归一化、菜单操作、图标与背景。
- `src-ui/src/todo/TodoListView.test.tsx`：覆盖交互、持久化和视觉类名。
- `docs/agent/coding.md`、`docs/agent/testing.md`：记录稳定业务约束和回归范围。

### Task 1：后端字段、迁移与持久化约束

**Files:**
- Modify: `src-tauri/db/001_init.sql`
- Modify: `src-tauri/src/domain.rs`
- Modify: `src-tauri/src/repository.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `TodoTaskInput.pinned: bool`、`TodoTaskRecord.pinned: bool`。
- Produces: `normalized_pinned_root_ids(tasks: &[TodoTaskInput]) -> HashSet<String>`，供快照 upsert 只写入有效 root 置顶状态。

- [ ] **Step 1：扩展测试夹具并写入失败测试**

在 `todo_input` 中补充 `pinned: false`，再增加两个测试：一个保存置顶 root 后重新加载仍为置顶；另一个把 `pinned: true` 的任务放到新 root 下，断言保存结果中子任务为 `false`、新 root 为 `true`。

```rust
#[test]
fn repository_persists_root_pin_and_transfers_child_pin_to_new_root() {
    let repo = Repository::open_in_memory().unwrap();
    let mut root = todo_input("root", TodoTaskStatus::Todo);
    let mut moving = todo_input("moving", TodoTaskStatus::Todo);
    moving.parent_id = Some("root".to_string());
    moving.pinned = true;

    let saved = repo.save_todo_tasks(&[root.clone(), moving]).unwrap();
    assert!(saved.iter().find(|task| task.id == "root").unwrap().pinned);
    assert!(!saved.iter().find(|task| task.id == "moving").unwrap().pinned);

    root.pinned = true;
    let reloaded = repo.save_todo_tasks(&[root]).unwrap();
    assert!(reloaded[0].pinned);
}
```

为迁移单独创建临时 SQLite 文件，先用旧版 `todo_tasks` 结构写入一条任务，再用 `Repository::open_path` 打开，断言任务可以加载且 `pinned == false`；测试结束删除该明确临时文件。

- [ ] **Step 2：运行后端目标测试并确认失败**

Run: `cd src-tauri && cargo test repository_persists_root_pin_and_transfers_child_pin_to_new_root -- --nocapture && cargo test repository_migrates_existing_todo_tasks_with_unpinned_default -- --nocapture`

Expected: FAIL，错误指向 `TodoTaskInput`/`TodoTaskRecord` 尚无 `pinned` 或旧表尚无迁移列。

- [ ] **Step 3：增加字段和安全迁移**

在 SQL 与 Rust 模型中增加字段：

```sql
pinned INTEGER NOT NULL DEFAULT 0,
```

在 `migrate_schema` 中读取 `PRAGMA table_info(todo_tasks)`；缺少 `pinned` 时执行：

```rust
connection.execute(
    "ALTER TABLE todo_tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    [],
)?;
```

- [ ] **Step 4：实现后端置顶归一化并接入 upsert**

构建 `id -> task` 索引，对每个 `pinned == true` 的输入沿 `parent_id` 向上查找 `parent_id == None` 的 root；缺失父节点或出现环时不产生置顶 root。保存每条任务时只在其 id 属于归一化 root 集合时写入 `1`：

```rust
let pinned_root_ids = normalized_pinned_root_ids(tasks);
for task in tasks {
    let pinned = bool_to_i64(pinned_root_ids.contains(task.id.as_str()));
    // 将 pinned 放在 result_review 之后、created_at 之前，INSERT 与 UPDATE 使用同一值。
}
```

同步更新 SELECT、INSERT 和 `ON CONFLICT DO UPDATE` 的字段序号与 `TodoTaskRecord` 映射。

- [ ] **Step 5：运行 Rust 测试和格式检查**

Run: `cd src-tauri && cargo test`

Expected: PASS。

Run: `cd src-tauri && cargo fmt --check`

Expected: PASS。

- [ ] **Step 6：提交后端变更**

```bash
git add src-tauri/db/001_init.sql src-tauri/src/domain.rs src-tauri/src/repository.rs src-tauri/src/lib.rs
git commit -m "feat: 持久化 todo root 置顶状态"
```

### Task 2：前端置顶归一化与任务树排序

**Files:**
- Modify: `src-ui/src/todo/types.ts`
- Modify: `src-ui/src/todo/todoTree.ts`
- Test: `src-ui/src/todo/todoTree.test.ts`

**Interfaces:**
- Consumes: 后端 snake_case 字段 `pinned: boolean`。
- Produces: `normalizeTodoPins(tasks: TodoTask[]): TodoTask[]`。
- Produces: `TodoTask.pinned: boolean`、`BackendTodoTask.pinned: boolean`。
- Preserves: `flattenTodoTreeByCompletion(tasks, collapsedIds)` 的现有签名。

- [ ] **Step 1：给测试任务补充默认字段并写入失败测试**

测试工厂默认返回 `pinned: false`。增加以下覆盖：

```ts
test("置顶 root 树优先展示且置顶组保持 position", () => {
  const tasks = [
    { ...task("done", undefined, 0), status: "completed" as const },
    { ...task("pinned-b", undefined, 2), pinned: true },
    { ...task("pinned-a", undefined, 1), pinned: true },
    task("open", undefined, 3)
  ];

  expect(flattenTodoTreeByCompletion(tasks).map(({ task }) => task.id)).toEqual([
    "pinned-a", "pinned-b", "open", "done"
  ]);
});

test("置顶任务缩进后把置顶状态转移到新 root", () => {
  const tasks = [task("target", undefined, 0), { ...task("moving", undefined, 1), pinned: true }];
  const changed = normalizeTodoPins(indentTask(tasks, "moving"));

  expect(changed.find(({ id }) => id === "target")?.pinned).toBe(true);
  expect(changed.find(({ id }) => id === "moving")?.pinned).toBe(false);
});
```

另加跨层级 `moveTaskRelative` 的转移断言，证明拖放路径使用同一归一化规则。

- [ ] **Step 2：运行树测试并确认失败**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: FAIL，`normalizeTodoPins` 未导出，置顶任务尚未优先排序。

- [ ] **Step 3：实现纯函数归一化**

`normalizeTodoPins` 先建立任务索引，再收集所有置顶任务当前所属的有效 root id，最后只让这些 root 保持 `pinned: true`：

```ts
export function normalizeTodoPins(tasks: TodoTask[]): TodoTask[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const pinnedRootIds = new Set<string>();
  for (const task of tasks) {
    if (!task.pinned) continue;
    const rootId = findTodoRootId(tasksById, task.id);
    if (rootId) pinnedRootIds.add(rootId);
  }
  return tasks.map((task) => ({
    ...task,
    pinned: !task.parentId && pinnedRootIds.has(task.id)
  }));
}
```

`findTodoRootId` 使用 visited 集合阻止父链环；父节点缺失时返回 `undefined`，不保留无效置顶。

- [ ] **Step 4：让置顶 root 树优先于完成度排序**

在 `flattenTodoTreeByCompletion` 的 block 排序器中先比较 root 的 `pinned`。两个置顶 root 直接按原 block index 排序；两个未置顶 root 再沿用 `completionRank` 和 index：

```ts
const leftPinned = Boolean(left.items[0]?.task.pinned);
const rightPinned = Boolean(right.items[0]?.task.pinned);
if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
if (leftPinned && rightPinned) return left.index - right.index;
```

- [ ] **Step 5：运行树测试与 TypeScript 构建**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: PASS。

Run: `cd src-ui && npm run build`

Expected: 首次可能列出尚未补充 `pinned` 的 UI 夹具位置；逐一补为明确的 `false`，直到 PASS，不将字段改为可选以掩盖遗漏。

- [ ] **Step 6：提交树模型变更**

```bash
git add src-ui/src/todo/types.ts src-ui/src/todo/todoTree.ts src-ui/src/todo/todoTree.test.ts
git commit -m "feat: 归一化 todo 置顶任务树"
```

### Task 3：菜单、图钉和浅绿色整行反馈

**Files:**
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Test: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Consumes: `normalizeTodoPins(tasks: TodoTask[]): TodoTask[]`。
- Consumes: `TodoTask.pinned: boolean`。
- Produces: root 菜单“置顶/取消置顶”、`data-pinned="true"` 主任务行和“已置顶 <任务名>”图标可访问名称。

- [ ] **Step 1：补齐 UI 夹具并写入失败交互测试**

`initialTasks` 和独立后端夹具增加 `pinned`。新增测试：

```tsx
test("root 可置顶且子任务菜单不提供置顶操作", async () => {
  const user = userEvent.setup();
  const persistTasks = vi.fn().mockResolvedValue(undefined);
  render(<TodoListView initialTasks={initialTasks} persistTasks={persistTasks} />);

  await user.click(screen.getByRole("button", { name: "设置 父任务" }));
  await user.click(screen.getByRole("menuitem", { name: "置顶" }));
  expect(screen.getByRole("img", { name: "已置顶 父任务" })).toBeInTheDocument();
  await waitFor(() => expect(persistTasks).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: "root", pinned: true })])
  ));

  await user.click(screen.getByRole("button", { name: "设置 子任务" }));
  expect(screen.queryByRole("menuitem", { name: "置顶" })).not.toBeInTheDocument();
});
```

再断言置顶 root 行具有 `data-pinned="true"` 和 `bg-emerald-50`，子任务行没有；表头仍为现有五个 grid 子元素且不存在“置顶”列标题。

- [ ] **Step 2：运行 UI 目标测试并确认失败**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: FAIL，菜单项、图标和浅绿色背景尚不存在。

- [ ] **Step 3：在统一入口接入归一化和字段映射**

让 `applyTasks` 先归一化 position，再调用 `normalizeTodoPins`，保证所有层级变化立即转移置顶；`mapBackendTodoTask` 和 `mapTodoTaskInput` 显式映射 `pinned`，`newTask` 与 demo 数据默认 `false`：

```ts
const normalized = normalizeTodoPins(normalizeTodoPositions(next));
```

- [ ] **Step 4：扩展现有菜单而不新增列**

从 `lucide-react` 引入 `Pin`、`PinOff`。`StatusMenu` 新增可选回调 `onTogglePinned?: () => void`；仅 `depth === 0` 时传入。菜单项文案根据当前状态为“置顶”或“取消置顶”，点击后更新快照并关闭菜单。

在任务单元格中仅为 `depth === 0 && task.pinned` 渲染一个图钉：

```tsx
<Pin
  role="img"
  aria-label={`已置顶 ${task.title || "未命名任务"}`}
  className="mr-1 h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300"
/>
```

- [ ] **Step 5：增加整行绿色状态并保留交互反馈**

在主任务行增加 `data-pinned`，并让置顶样式优先于普通展开背景：

```tsx
depth === 0 && task.pinned
  ? "bg-emerald-50 hover:bg-emerald-100/80 dark:bg-emerald-950/35 dark:hover:bg-emerald-950/50"
  : expandedId === task.id
    ? "bg-accent/55"
    : "hover:bg-accent/35"
```

不要把绿色类名放到包裹主行与扩展面板的外层节点，确保展开详情不染色。

- [ ] **Step 6：运行 UI 测试与完整前端测试**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: PASS。

Run: `cd src-ui && npm test -- --run`

Expected: PASS。

Run: `cd src-ui && npm run build`

Expected: PASS。

- [ ] **Step 7：提交 UI 变更**

```bash
git add src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx
git commit -m "feat: 添加 todo root 置顶交互"
```

### Task 4：项目知识、全量验证与视觉验收

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`

**Interfaces:**
- Consumes: 已完成的数据库、树模型和 UI 行为。
- Produces: 可复核的长期约束、回归范围和最终验证证据。

- [ ] **Step 1：更新项目知识**

在 `docs/agent/coding.md` 记录：置顶状态只属于 root；层级变化必须转移到新 root；置顶排序高于完成度；图钉不得新增表格列；只有置顶 root 主行使用绿色。

在 `docs/agent/testing.md` 记录迁移、持久化、排序、层级转移、菜单权限、单图标布局、绿色主行与两档视觉验收范围，并添加 2026-08-05 更新说明。

- [ ] **Step 2：运行全量确定性验证**

Run: `cd src-ui && npm test -- --run`

Expected: PASS。

Run: `cd src-ui && npm run build`

Expected: PASS。

Run: `cd src-tauri && cargo test`

Expected: PASS。

Run: `cd src-tauri && cargo fmt --check`

Expected: PASS。

Run: `git diff --check`

Expected: 无输出，退出码为 0。

- [ ] **Step 3：执行浏览器视觉验收**

启动普通 Vite demo，在 1440 × 1024 与 1024 × 768 分别检查：

- 表头仍只有任务、关联 Thread、预期结束日期、实际结束日期和操作轨道，没有置顶列。
- 图钉只占任务单元格内一个图标位，标题、展开、状态和拖拽仍可操作。
- 浅绿色覆盖置顶 root 的完整主任务行，子任务和展开详情保持原背景。
- 页面无横向溢出，控制台错误为 0。

- [ ] **Step 4：提交知识文档并检查工作树**

```bash
git add docs/agent/coding.md docs/agent/testing.md
git commit -m "docs: 记录 todo root 置顶约束"
git status --short
```

Expected: 工作树为空。
