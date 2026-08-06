# To Do List 周视图实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**目标：** 为 To Do List 增加基于内部 updated_at 的滚动 168 小时周视图，并保证只有实际变化的任务刷新更新时间。

**架构：** SQLite 仓储用带字段差异条件的 upsert 维护权威 updated_at；前端 TodoTask.updatedAt 仅作为内部元数据。新的纯函数模块负责时间窗口判断和实际变更打戳，TodoListView 只编排按钮、滚动时钟、组合筛选、祖先补全与导航清理。

**技术栈：** Rust、rusqlite、TypeScript、React 18、Vitest、Testing Library、Tauri 2、Tailwind CSS、lucide-react。

## 全局约束

- 时间窗口固定为当前时刻向前滚动 168 小时，包含起点和当前时刻。
- 更新时间只作内部依据，任何界面都不得展示。
- 周视图与搜索、状态筛选按 AND 组合；命中子任务时只补齐祖先。
- 未变化任务不得刷新 updated_at，后端继续拥有持久化时间戳。
- 不新增数据库字段，不改变关联、轮询、完成度/置顶排序和每页 200 条分页。
- 注释、文档和提交信息使用中文。
- 禁止 WorkTree，直接在 main 开发。
- 保留当前工作区已有的 To Do 退格聚焦改动，只暂存本计划产生的 hunk。

---

### Task 1：让仓储只刷新实际变化任务的更新时间

**Files:**
- Modify: src-tauri/src/lib.rs
- Modify: src-tauri/src/repository.rs

**Interfaces:**
- Consumes: Repository::save_todo_tasks(&[TodoTaskInput])
- Produces: 仅持久化字段有差异时执行 update；新任务仍初始化 created_at/updated_at。

- [ ] **Step 1：写失败测试**

在 src-tauri/src/lib.rs 增加：

~~~rust
#[test]
fn repository_todo_snapshot_updates_timestamp_only_for_changed_tasks() {
    let tick = Arc::new(AtomicUsize::new(0));
    let clock_tick = Arc::clone(&tick);
    let repo = Repository::open_in_memory_with_clock(Box::new(move || {
        format!(
            "2026-08-06T08:00:{:02}Z",
            clock_tick.fetch_add(1, Ordering::SeqCst)
        )
    }))
    .unwrap();
    let mut tasks = vec![
        todo_input("changed", TodoTaskStatus::Todo),
        TodoTaskInput {
            position: 1,
            ..todo_input("unchanged", TodoTaskStatus::Todo)
        },
    ];

    let first = repo.save_todo_tasks(&tasks).unwrap();
    let no_op = repo.save_todo_tasks(&tasks).unwrap();
    assert_eq!(no_op[0].updated_at, first[0].updated_at);
    assert_eq!(no_op[1].updated_at, first[1].updated_at);

    tasks[0].title = "已修改".to_string();
    let saved = repo.save_todo_tasks(&tasks).unwrap();
    let changed = saved.iter().find(|task| task.id == "changed").unwrap();
    let unchanged = saved.iter().find(|task| task.id == "unchanged").unwrap();
    assert_ne!(changed.updated_at, first[0].updated_at);
    assert_eq!(unchanged.updated_at, first[1].updated_at);
}
~~~

同组再覆盖：交换两个 position 后两条都更新时间；初次插入 created_at == updated_at。

- [ ] **Step 2：确认测试先失败**

Run: cargo test --manifest-path src-tauri/Cargo.toml repository_todo_snapshot_updates_timestamp_only_for_changed_tasks

Expected: FAIL，no-op 保存刷新了时间。

- [ ] **Step 3：实现 null-safe 差异更新**

在 upsert 的 DO UPDATE 末尾加入：

~~~sql
WHERE todo_tasks.parent_id IS NOT excluded.parent_id
   OR todo_tasks.position IS NOT excluded.position
   OR todo_tasks.title IS NOT excluded.title
   OR todo_tasks.status IS NOT excluded.status
   OR todo_tasks.pinned IS NOT excluded.pinned
   OR todo_tasks.start_date IS NOT excluded.start_date
   OR todo_tasks.expected_end_date IS NOT excluded.expected_end_date
   OR todo_tasks.actual_end_date IS NOT excluded.actual_end_date
   OR todo_tasks.process_tracking IS NOT excluded.process_tracking
   OR todo_tasks.result_review IS NOT excluded.result_review
~~~

SQL 前写中文决策注释：完整快照会重复提交未变化任务，条件更新保证 updated_at 表达单任务真实变动。

- [ ] **Step 4：验证并提交**

~~~bash
cargo test --manifest-path src-tauri/Cargo.toml repository_todo_snapshot
cargo fmt --manifest-path src-tauri/Cargo.toml --check
git add src-tauri/src/lib.rs src-tauri/src/repository.rs
git diff --cached --check
git commit -m "fix: 仅刷新有变动的 todo 时间"
~~~

Expected: 测试与格式检查 PASS。

---

### Task 2：建立前端内部更新时间与纯函数边界

**Files:**
- Modify: src-ui/src/todo/types.ts
- Create: src-ui/src/todo/todoRecency.ts
- Create: src-ui/src/todo/todoRecency.test.ts
- Modify: src-ui/src/todo/TodoListView.tsx
- Modify: src-ui/src/todo/TodoListView.test.tsx

**Interfaces:**
- Produces: TodoTask.updatedAt?: string
- Produces: TODO_RECENCY_WINDOW_MS
- Produces: isTodoTaskRecentlyUpdated(task, nowMs)
- Produces: stampChangedTodoTasks(previous, next, nowIso)
- Produces: 映射 updated_at，但保存输入不输出更新时间。

- [ ] **Step 1：写纯函数和映射失败测试**

~~~ts
const baseTask = (updatedAt?: string): TodoTask => ({
  id: "task", position: 0, title: "任务", status: "todo", pinned: false,
  processTracking: "", resultReview: "", updatedAt
});

test("168 小时双边界命中，过期、未来、缺失和无效时间不命中", () => {
  const now = Date.parse("2026-08-06T12:00:00Z");
  expect(isTodoTaskRecentlyUpdated(baseTask(new Date(now - TODO_RECENCY_WINDOW_MS).toISOString()), now)).toBe(true);
  expect(isTodoTaskRecentlyUpdated(baseTask(new Date(now).toISOString()), now)).toBe(true);
  expect(isTodoTaskRecentlyUpdated(baseTask(new Date(now - TODO_RECENCY_WINDOW_MS - 1).toISOString()), now)).toBe(false);
  expect(isTodoTaskRecentlyUpdated(baseTask(new Date(now + 1).toISOString()), now)).toBe(false);
  expect(isTodoTaskRecentlyUpdated(baseTask(), now)).toBe(false);
  expect(isTodoTaskRecentlyUpdated(baseTask("invalid"), now)).toBe(false);
});

test("只给新增或持久化字段实际变化的任务打戳", () => {
  const previous = [baseTask("2026-07-01T00:00:00Z")];
  expect(stampChangedTodoTasks(previous, [{ ...previous[0] }], "2026-08-06T12:00:00Z")).toEqual(previous);
  expect(stampChangedTodoTasks(previous, [{ ...previous[0], title: "已修改" }], "2026-08-06T12:00:00Z")[0].updatedAt)
    .toBe("2026-08-06T12:00:00Z");
});
~~~

映射测试增加：

~~~ts
expect(mapped.updatedAt).toBe("2026-07-13T12:00:00");
expect(mapTodoTaskInput(mapped)).not.toHaveProperty("updated_at");
~~~

- [ ] **Step 2：运行并确认失败**

Run: npm --prefix src-ui test -- --run src/todo/todoRecency.test.ts src/todo/TodoListView.test.tsx

Expected: FAIL，类型、模块或映射不存在。

- [ ] **Step 3：实现内部模型和纯函数**

types.ts 增加 updatedAt?: string。todoRecency.ts 实现：

~~~ts
export const TODO_RECENCY_WINDOW_MS = 168 * 60 * 60 * 1000;
const persistedFields: (keyof TodoTask)[] = [
  "parentId", "position", "title", "status", "pinned", "startDate",
  "expectedEndDate", "actualEndDate", "processTracking", "resultReview"
];

export function isTodoTaskRecentlyUpdated(task: TodoTask, nowMs: number) {
  if (!task.updatedAt) return false;
  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isNaN(updatedAtMs)) return false;
  return updatedAtMs >= nowMs - TODO_RECENCY_WINDOW_MS && updatedAtMs <= nowMs;
}

export function stampChangedTodoTasks(previous: TodoTask[], next: TodoTask[], nowIso: string) {
  const previousById = new Map(previous.map((task) => [task.id, task]));
  return next.map((task) => {
    const before = previousById.get(task.id);
    const changed = !before || persistedFields.some((field) => before[field] !== task[field]);
    return changed ? { ...task, updatedAt: nowIso } : { ...task, updatedAt: before.updatedAt };
  });
}
~~~

mapBackendTodoTask 加入 updatedAt: task.updated_at；导出 mapTodoTaskInput 供测试，且不加入 updated_at。

- [ ] **Step 4：验证并只提交新 hunk**

~~~bash
npm --prefix src-ui test -- --run src/todo/todoRecency.test.ts src/todo/TodoListView.test.tsx
npm --prefix src-ui run build
git add src-ui/src/todo/types.ts src-ui/src/todo/todoRecency.ts src-ui/src/todo/todoRecency.test.ts
git add -p src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx
git diff --cached --check
git commit -m "feat: 建立 todo 变动时间模型"
~~~

Expected: 测试与构建 PASS，退格聚焦 hunk 未被暂存。

---

### Task 3：接入周视图按钮、组合筛选和滚动窗口

**Files:**
- Modify: src-ui/src/todo/TodoListView.tsx
- Modify: src-ui/src/todo/TodoListView.test.tsx

**Interfaces:**
- Consumes: todoRecency 纯函数与 TodoTask.updatedAt
- Produces: TodoListView 新增 now?: () => number，默认 Date.now
- Produces: 名称为“周视图”、带 aria-pressed 的按钮。

- [ ] **Step 1：写 UI 失败测试**

固定 now，构造旧父任务、近期子任务、旧兄弟、近期已完成 root、无效时间 root：

~~~tsx
render(<TodoListView initialTasks={weekTasks} persistTasks={vi.fn()} now={() => now} />);
const weekButton = screen.getByRole("button", { name: "周视图" });
expect(weekButton).toHaveAttribute("aria-pressed", "false");
await user.click(weekButton);
expect(weekButton).toHaveAttribute("aria-pressed", "true");
expect(screen.getByDisplayValue("旧父任务")).toBeInTheDocument();
expect(screen.getByDisplayValue("近期子任务")).toBeInTheDocument();
expect(screen.queryByDisplayValue("旧兄弟")).not.toBeInTheDocument();
expect(screen.queryByDisplayValue("无效时间")).not.toBeInTheDocument();
await user.selectOptions(screen.getByRole("combobox", { name: "状态筛选" }), "completed");
expect(screen.getByDisplayValue("近期已完成")).toBeInTheDocument();
~~~

另测：201 条数据第 2 页启用后回第 1 页；navigationTarget 关闭周视图；编辑旧任务后再启用立即命中；DOM 不出现更新时间。

- [ ] **Step 2：写滚动到期测试并确认失败**

用 fake timers：任务距离边界还有 30 秒，启用后可见；推进 60 秒后消失；finally 恢复真实计时器。

Run: npm --prefix src-ui test -- --run src/todo/TodoListView.test.tsx

Expected: FAIL，按钮和计时逻辑不存在。

- [ ] **Step 3：实现状态、时钟与筛选**

~~~tsx
const [weekViewEnabled, setWeekViewEnabled] = useState(false);
const [recencyNow, setRecencyNow] = useState(() => now());
useEffect(() => {
  if (!weekViewEnabled) return;
  setRecencyNow(now());
  const timer = window.setInterval(() => setRecencyNow(now()), 60_000);
  return () => window.clearInterval(timer);
}, [now, weekViewEnabled]);
~~~

直接匹配增加 (!weekViewEnabled || isTodoTaskRecentlyUpdated(task, recencyNow))，继续复用祖先补全。切换时重置分页；导航定位执行 setWeekViewEnabled(false)。

- [ ] **Step 4：让会话内变更立即打内部时间戳**

~~~ts
const normalized = normalizeTodoPins(normalizeTodoPositions(next));
const timestamped = stampChangedTodoTasks(tasks, normalized, new Date(now()).toISOString());
setTasks(timestamped);
onTasksChange?.(timestamped);
~~~

焦点页码和 saveSnapshot 使用 timestamped。中文注释说明前端打戳仅用于即时筛选，后端时间仍权威。

- [ ] **Step 5：加入按钮**

~~~tsx
<Button
  type="button"
  size="sm"
  variant={weekViewEnabled ? "secondary" : "outline"}
  aria-pressed={weekViewEnabled}
  onClick={() => {
    setRecencyNow(now());
    setWeekViewEnabled((enabled) => !enabled);
  }}
>
  <CalendarDays className="h-3.5 w-3.5" />
  周视图
</Button>
~~~

按钮位于状态筛选旁；不得增加更新时间列、tooltip 或详情文本。

- [ ] **Step 6：验证并只提交 UI hunk**

~~~bash
npm --prefix src-ui test -- --run src/todo/todoRecency.test.ts src/todo/TodoListView.test.tsx src/todo/todoTree.test.ts src/todo/todoGridLayout.test.ts src/associations/associationModel.test.ts
git add -p src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx
git diff --cached --check
git commit -m "feat: 添加 todo 周视图筛选"
~~~

Expected: 所列测试 PASS，退格聚焦、树排序、分页、定位和布局不回归。

---

### Task 4：补齐 demo、知识和验收证据

**Files:**
- Modify: src-ui/src/todo/TodoListView.tsx
- Modify: src-ui/src/todo/TodoListView.test.tsx
- Modify: docs/agent/coding.md
- Modify: docs/agent/testing.md
- Create: docs/images/todo-list-week-view-1440.png
- Create: docs/images/todo-list-week-view-1024.png

**Interfaces:**
- Produces: demo 同时包含近期与过期任务。
- Produces: 项目知识记录周视图和更新时间约束。

- [ ] **Step 1：补 demo 与测试**

demoTasks 增加可选 nowMs = Date.now()；至少一个 root 和一个子任务使用 nowMs - 24 小时，另一个 root 使用 nowMs - 8 天。测试启用周视图后近期 demo 可见、过期 demo 不见。

- [ ] **Step 2：更新项目知识**

coding.md 增加：To Do 周视图使用内部 updated_at 筛选滚动 168 小时，前端不得展示；完整快照只有实际变化任务可刷新时间，子任务命中时只保留祖先。

testing.md 增加：覆盖 168 小时双边界、无效/未来时间、组合筛选、祖先补全、分页、导航、即时命中，以及仓储 no-op 不刷新。两个 Update Notes 增加 2026-08-06 条目，不改已有退格条目。

- [ ] **Step 3：运行全量验证**

~~~bash
npm --prefix src-ui test -- --run
npm --prefix src-ui run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
git diff --check
~~~

Expected: 所有命令退出码 0。

- [ ] **Step 4：两档视觉验收**

运行 npm --prefix src-ui run dev，在 1440 × 1024 与 1024 × 768 检查按钮位置/按下态、筛选与祖先规则、无更新时间、无横向溢出、控制台零错误和无 Tauri bridge 错误。截图保存为 docs/images/todo-list-week-view-1440.png 与 docs/images/todo-list-week-view-1024.png。

- [ ] **Step 5：提交 demo、截图和知识 hunk**

~~~bash
git add docs/images/todo-list-week-view-1440.png docs/images/todo-list-week-view-1024.png
git add -p src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx docs/agent/coding.md docs/agent/testing.md
git diff --cached --check
git commit -m "docs: 记录 todo 周视图约束"
~~~

- [ ] **Step 6：逐项审计**

对照设计文档 8 条验收标准，逐条记录代码、测试、命令或截图证据；任何一项证据不足时继续补实现或验证。
