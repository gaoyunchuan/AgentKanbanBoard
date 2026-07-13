# Thread 与 Todo Task 双向关联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Thread 列表/看板和 To Do List 的展开态中增加低打扰的双向关联，使一个 Thread 最多关联一个 Task、一个 Task 可关联多个 Thread，并支持筛选、迁移、解除、撤销、失败回滚和子 Task 定位。

**Architecture:** SQLite 新增以 `thread_id` 为主键的 `thread_task_links` 表，所有写入通过独立 Tauri command 在单次事务内完成，不进入 `BoardData` 或五秒 Thread 轮询。React 顶层维护按 `thread_id` 索引的共享关联状态；Thread 与 Task 展开面板复用搜索选择器和同一控制器，Todo 任务快照只通过回调同步给顶层候选缓存。

**Tech Stack:** React 18、TypeScript 5.6、Tailwind CSS、Testing Library、Vitest、Tauri 2、Rust、rusqlite、SQLite。

**Source Spec:** `docs/superpowers/specs/2026-07-13-thread-task-association-design.md`。

## Global Constraints

- 一个 Thread 最多关联一个 Task；一个 Task 可以关联零个或多个 Thread。
- Thread 端候选 Task 只允许 `todo`、`in_progress`；Task 端候选 Thread 只允许 `review_pending`、`suspended`。
- 发起对象自身状态不限制关联；状态限制只作用于新建或更换，既有关联在状态变化后保留。
- 已关联其他 Task 的 Thread 可直接迁移到当前 Task，不弹确认框；迁移和解除提供 5 秒撤销。
- 撤销恢复历史关系时不重新应用候选状态过滤，但 Thread 与原 Task 必须仍存在。
- 折叠行不增加关联图标、数量、文案或额外行高；关联只出现在展开态末尾。
- 关联加载不得进入 `list_threads -> BoardData -> React state -> 5 秒刷新` 主链路。
- Thread comments 继续独立懒加载；关联功能不得改变其索引、命令或预取语义。
- To Do 继续使用完整任务快照持久化，并保留 `created_at`；删除 Task 与关联级联清理必须处于同一事务。
- 普通 Vite 浏览器预览不得因缺少 Tauri bridge 产生控制台错误。
- 选择器与触发字段同宽，最大高度 `280px`；Task 每层缩进 `12px`，最多显示 `36px`。
- 在 `650px` 内容宽度、`100%` 系统缩放下不得出现横向滚动，所有关联操作必须可见可用。
- 新增用户可见错误和状态文案使用中文。

## File Map

### 新建

- `src-tauri/db/002_thread_task_links.sql`：关联表、外键和 Task 方向索引。
- `src-ui/src/associations/types.ts`：前后端关联类型、写入来源和提示条状态。
- `src-ui/src/associations/associationModel.ts`：Task/Thread 候选生成、路径、分组和 Todo 定位纯函数。
- `src-ui/src/associations/associationModel.test.ts`：候选、过滤、路径、迁移归属和分页测试。
- `src-ui/src/associations/AssociationPicker.tsx`：可搜索、可键盘操作的 `combobox + listbox`。
- `src-ui/src/associations/AssociationPicker.test.tsx`：键盘、空态、禁用上下文和选择测试。
- `src-ui/src/associations/useThreadTaskLinks.ts`：按 Thread 串行的共享关联控制器、乐观更新、回滚、重试和撤销。
- `src-ui/src/associations/useThreadTaskLinks.test.tsx`：按 Thread 串行、跨 Thread 并行、失败取消队列和撤销测试。
- `src-ui/src/associations/AssociationNotice.tsx`：五秒提示条、撤销/重试和 live region。
- `src-ui/src/associations/ThreadTaskAssociationPanel.tsx`：Thread 展开态单选 Task 面板。
- `src-ui/src/associations/TaskThreadAssociationPanel.tsx`：Task 展开态多 Thread 管理面板。

### 修改

- `src-tauri/src/domain.rs`：`ThreadTaskLinkOrigin`、`ThreadTaskLinkRecord`。
- `src-tauri/src/repository.rs`：启用外键、执行 002 migration、查询和原子写入关联。
- `src-tauri/src/lib.rs`：repository 关系、候选校验、级联、迁移和恢复测试。
- `src-tauri/src/main.rs`：注册加载与更新关联的 Tauri commands。
- `src-ui/src/types.ts`：导出关联后端类型。
- `src-ui/src/App.tsx`：顶层共享状态、Task 候选缓存、Thread 列表/看板面板、Todo 定位和提示条。
- `src-ui/src/App.test.tsx`：命令 mock、Thread 展开交互、迁移、跳转、轮询隔离和窄窗口 DOM 约束。
- `src-ui/src/todo/TodoListView.tsx`：受控回调、定位请求、Task 展开关联区和保存成功回调。
- `src-ui/src/todo/TodoListView.test.tsx`：Task 展开、多 Thread、定位、删除同步和现有 Todo 回归。
- `docs/agent/coding.md`：沉淀关联数据不进入 BoardData/轮询和唯一关系约束。
- `docs/agent/testing.md`：沉淀关联候选、迁移、撤销、级联和 650px 验证范围。
- `design-qa.md`：记录 650px 展开态截图与交互验证证据。

---

### Task 1: SQLite 关系模型与原子 repository API

**Files:**
- Create: `src-tauri/db/002_thread_task_links.sql`
- Modify: `src-tauri/src/domain.rs:52-116`
- Modify: `src-tauri/src/repository.rs:1-54,110-187,845-893`
- Test: `src-tauri/src/lib.rs:14-158`

**Interfaces:**
- Produces: `ThreadTaskLinkOrigin::{Thread, Task, Restore}`。
- Produces: `ThreadTaskLinkRecord { thread_id, task_id, created_at, updated_at }`。
- Produces: `Repository::list_thread_task_links() -> Result<Vec<ThreadTaskLinkRecord>, String>`。
- Produces: `Repository::set_thread_task_link(thread_id: &str, task_id: Option<&str>, origin: ThreadTaskLinkOrigin) -> Result<Option<ThreadTaskLinkRecord>, String>`。
- Consumes: 现有 `BoardStatus`、`TodoTaskStatus`、`save_todo_tasks()` 和 repository clock。

- [ ] **Step 1: 写 repository 失败测试，覆盖唯一关系、候选状态、恢复和级联**

在 `src-tauri/src/lib.rs` 的测试模块中导入 `ThreadTaskLinkOrigin`，增加以下辅助函数和测试。测试数据必须先插入真实 Thread 与 Todo Task，不能绕过外键。

```rust
fn todo_input(id: &str, status: TodoTaskStatus) -> TodoTaskInput {
    TodoTaskInput {
        id: id.to_string(),
        parent_id: None,
        position: 0,
        title: id.to_string(),
        status,
        start_date: None,
        expected_end_date: None,
        actual_end_date: None,
        process_tracking: String::new(),
        result_review: String::new(),
    }
}

#[test]
fn repository_thread_task_links_enforce_cardinality_and_candidate_statuses() {
    let repo = Repository::open_in_memory().unwrap();
    repo.upsert_thread(CodexThreadUpsert::minimal("review-thread")).unwrap();
    repo.mark_reviewed("review-thread").unwrap();
    repo.save_todo_tasks(&[
        todo_input("todo", TodoTaskStatus::Todo),
        todo_input("done", TodoTaskStatus::Completed),
    ]).unwrap();

    let linked = repo
        .set_thread_task_link("review-thread", Some("todo"), ThreadTaskLinkOrigin::Thread)
        .unwrap()
        .unwrap();
    assert_eq!(linked.task_id, "todo");
    assert!(repo
        .set_thread_task_link("review-thread", Some("done"), ThreadTaskLinkOrigin::Thread)
        .unwrap_err()
        .contains("未完成"));

    let moved = repo
        .set_thread_task_link("review-thread", Some("done"), ThreadTaskLinkOrigin::Restore)
        .unwrap()
        .unwrap();
    assert_eq!(moved.task_id, "done");
    assert_eq!(repo.list_thread_task_links().unwrap().len(), 1);
}

#[test]
fn repository_task_origin_requires_review_pending_or_suspended_thread() {
    let repo = Repository::open_in_memory().unwrap();
    repo.upsert_thread(CodexThreadUpsert::minimal("running-thread")).unwrap();
    repo.upsert_thread(CodexThreadUpsert::minimal("suspended-thread")).unwrap();
    repo.save_todo_tasks(&[todo_input("task", TodoTaskStatus::Todo)]).unwrap();

    assert!(repo
        .set_thread_task_link("running-thread", Some("task"), ThreadTaskLinkOrigin::Task)
        .unwrap_err()
        .contains("待审核或挂起"));
    repo.add_thread_comment(ThreadCommentInput {
        thread_id: "suspended-thread".to_string(),
        author: "我".to_string(),
        body: "等待后续处理".to_string(),
        suspend_until: Some("2026-07-14T08:00:00Z".to_string()),
    }).unwrap();
    assert!(repo
        .set_thread_task_link("suspended-thread", Some("task"), ThreadTaskLinkOrigin::Task)
        .unwrap()
        .is_some());
}

#[test]
fn repository_todo_snapshot_delete_cascades_thread_links() {
    let repo = Repository::open_in_memory().unwrap();
    repo.upsert_thread(CodexThreadUpsert::minimal("thread")).unwrap();
    repo.save_todo_tasks(&[todo_input("task", TodoTaskStatus::Todo)]).unwrap();
    repo.set_thread_task_link("thread", Some("task"), ThreadTaskLinkOrigin::Restore).unwrap();

    repo.save_todo_tasks(&[]).unwrap();
    assert!(repo.list_thread_task_links().unwrap().is_empty());
}
```

- [ ] **Step 2: 运行测试并确认因接口缺失而失败**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml repository_thread_task_links -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml repository_task_origin_requires -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml repository_todo_snapshot_delete_cascades -- --nocapture
```

Expected: FAIL，提示 `ThreadTaskLinkOrigin` 或 `set_thread_task_link` 不存在。

- [ ] **Step 3: 新增 migration 与领域类型**

创建 `src-tauri/db/002_thread_task_links.sql`：

```sql
CREATE TABLE IF NOT EXISTS thread_task_links (
  thread_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES codex_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_task_links_task
  ON thread_task_links(task_id, thread_id);
```

在 `src-tauri/src/domain.rs` 增加：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadTaskLinkOrigin {
    Thread,
    Task,
    Restore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadTaskLinkRecord {
    pub thread_id: String,
    pub task_id: String,
    pub created_at: String,
    pub updated_at: String,
}
```

在 `src-tauri/src/repository.rs`：

1. 添加 `const THREAD_TASK_LINKS_SQL: &str = include_str!("../db/002_thread_task_links.sql");`。
2. 在 `Connection::open*` 后、执行任何 schema SQL 前执行 `connection.pragma_update(None, "foreign_keys", "ON")?;`。
3. 在 `migrate_schema()` 完成旧 `codex_threads` rebuild 后执行 `connection.execute_batch(THREAD_TASK_LINKS_SQL)?;`，保证老库不会先创建指向 legacy 表的外键。
4. `list_thread_task_links()` 按 `thread_id` 排序读取四个字段。
5. `set_thread_task_link()` 使用 `rusqlite::Transaction::new_unchecked(..., TransactionBehavior::Immediate)`；先验证对象存在和来源对应状态，再在同一事务内 upsert 或 delete。

核心写入必须保持以下结构：

```rust
pub fn set_thread_task_link(
    &self,
    thread_id: &str,
    task_id: Option<&str>,
    origin: ThreadTaskLinkOrigin,
) -> Result<Option<ThreadTaskLinkRecord>, String> {
    let transaction = rusqlite::Transaction::new_unchecked(
        &self.connection,
        rusqlite::TransactionBehavior::Immediate,
    ).map_err(|error| error.to_string())?;

    let thread_status = transaction
        .query_row(
            "SELECT board_status FROM codex_threads WHERE id = ?1",
            params![thread_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Thread 不存在".to_string())?;

    let Some(task_id) = task_id else {
        transaction
            .execute("DELETE FROM thread_task_links WHERE thread_id = ?1", params![thread_id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(None);
    };

    let task_status = transaction
        .query_row(
            "SELECT status FROM todo_tasks WHERE id = ?1",
            params![task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Task 不存在".to_string())?;

    if origin == ThreadTaskLinkOrigin::Thread
        && !matches!(task_status.as_str(), "todo" | "in_progress")
    {
        return Err("只能关联未完成或进行中的 Task".to_string());
    }
    if origin == ThreadTaskLinkOrigin::Task
        && !matches!(thread_status.as_str(), "review_pending" | "suspended")
    {
        return Err("只能关联待审核或挂起的 Thread".to_string());
    }

    let now = self.now_text();
    transaction
        .execute(
            "INSERT INTO thread_task_links (thread_id, task_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(thread_id) DO UPDATE SET
               task_id = excluded.task_id,
               updated_at = excluded.updated_at",
            params![thread_id, task_id, now],
        )
        .map_err(|error| error.to_string())?;
    let created_at = transaction
        .query_row(
            "SELECT created_at FROM thread_task_links WHERE thread_id = ?1",
            params![thread_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(Some(ThreadTaskLinkRecord {
        thread_id: thread_id.to_string(),
        task_id: task_id.to_string(),
        created_at,
        updated_at: now,
    }))
}
```

- [ ] **Step 4: 运行定向与全量 Rust 测试**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml repository_thread_task_links -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml repository_task_origin_requires -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml repository_todo_snapshot_delete_cascades -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Expected: 所有命令 exit `0`，Rust 测试 `0 failed`。

- [ ] **Step 5: 提交 persistence 层**

```bash
git add src-tauri/db/002_thread_task_links.sql \
  src-tauri/src/domain.rs src-tauri/src/repository.rs src-tauri/src/lib.rs
git commit -m "feat: persist thread task links"
```

### Task 2: Tauri 关联 commands 与序列化契约

**Files:**
- Modify: `src-tauri/src/main.rs:1-9,145-168,484-539,550-571`
- Modify: `src-ui/src/types.ts:1-110`
- Test: `src-tauri/src/main.rs:484-539`

**Interfaces:**
- Consumes: Task 1 的 `Repository::{list_thread_task_links,set_thread_task_link}`。
- Produces: command `load_thread_task_links() -> Result<Vec<ThreadTaskLinkRecord>, String>`。
- Produces: command `update_thread_task_link(thread_id: String, task_id: Option<String>, origin: ThreadTaskLinkOrigin) -> Result<Option<ThreadTaskLinkRecord>, String>`。
- Produces: TypeScript `BackendThreadTaskLink`、`ThreadTaskLinkOrigin`。

- [ ] **Step 1: 写 command 来源序列化失败测试**

在 `src-tauri/src/main.rs` 测试模块增加：

```rust
#[test]
fn thread_task_link_origin_uses_snake_case_command_values() {
    assert_eq!(
        serde_json::from_str::<ThreadTaskLinkOrigin>(r#""thread""#).unwrap(),
        ThreadTaskLinkOrigin::Thread
    );
    assert_eq!(
        serde_json::from_str::<ThreadTaskLinkOrigin>(r#""task""#).unwrap(),
        ThreadTaskLinkOrigin::Task
    );
    assert_eq!(
        serde_json::from_str::<ThreadTaskLinkOrigin>(r#""restore""#).unwrap(),
        ThreadTaskLinkOrigin::Restore
    );
}
```

- [ ] **Step 2: 运行测试并确认缺少 command 类型导入或接口**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml thread_task_link_origin_uses_snake_case -- --nocapture
```

Expected: FAIL，测试模块尚未导入 `ThreadTaskLinkOrigin`，或 command 尚未实现。

- [ ] **Step 3: 实现并注册两个 commands**

在 `src-tauri/src/main.rs` 增加：

```rust
#[tauri::command]
fn load_thread_task_links() -> Result<Vec<ThreadTaskLinkRecord>, String> {
    open_repository()?.list_thread_task_links()
}

#[tauri::command]
fn update_thread_task_link(
    thread_id: String,
    task_id: Option<String>,
    origin: ThreadTaskLinkOrigin,
) -> Result<Option<ThreadTaskLinkRecord>, String> {
    open_repository()?.set_thread_task_link(&thread_id, task_id.as_deref(), origin)
}
```

把 `load_thread_task_links`、`update_thread_task_link` 加入 `tauri::generate_handler!`。在 `src-ui/src/types.ts` 增加：

```typescript
export type ThreadTaskLinkOrigin = "thread" | "task" | "restore";

export type BackendThreadTaskLink = {
  thread_id: string;
  task_id: string;
  created_at: string;
  updated_at: string;
};
```

不要修改 `BoardData`，也不要让 `load_board_data` 调用关联查询。

- [ ] **Step 4: 运行 command 定向测试、Rust 全量测试和前端类型检查**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml thread_task_link_origin_uses_snake_case -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
npm --prefix src-ui run build
```

Expected: 所有命令 exit `0`；前端 TypeScript 无错误。

- [ ] **Step 5: 提交 command 契约**

```bash
git add src-tauri/src/main.rs src-ui/src/types.ts
git commit -m "feat: expose thread task link commands"
```

### Task 3: 关联候选纯函数与可访问搜索选择器

**Files:**
- Create: `src-ui/src/associations/types.ts`
- Create: `src-ui/src/associations/associationModel.ts`
- Create: `src-ui/src/associations/associationModel.test.ts`
- Create: `src-ui/src/associations/AssociationPicker.tsx`
- Create: `src-ui/src/associations/AssociationPicker.test.tsx`

**Interfaces:**
- Produces: `ThreadTaskLink { threadId, taskId, createdAt, updatedAt }`。
- Produces: `AssociationOption { id, label, description?, group?, depth, disabled?, current? }`。
- Produces: `buildTaskAssociationOptions(tasks, currentTaskId, query)`。
- Produces: `buildThreadAssociationOptions(threads, linksByThread, currentTaskId, projectNames, query)`。
- Produces: `todoTargetPage(tasks, taskId, pageSize)`。
- Produces: `<AssociationPicker label getOptions value? onOpen onSelect />`，其中 `getOptions(query)` 负责根据搜索词返回候选。

- [ ] **Step 1: 写候选与分页失败测试**

创建 `associationModel.test.ts`，至少覆盖以下断言：

```typescript
const task = (
  id: string,
  parentId: string | undefined,
  status: TodoStatus,
  position = 0
): TodoTask => ({
  id,
  parentId,
  position,
  title: id,
  status,
  processTracking: "",
  resultReview: ""
});

const thread = (id: string, boardStatus: BoardStatus): ThreadItem => ({
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

const link = (threadId: string, taskId: string): ThreadTaskLink => ({
  threadId,
  taskId,
  createdAt: "2026-07-13T08:00:00Z",
  updatedAt: "2026-07-13T08:00:00Z"
});

test("Task 候选保留已完成祖先作为禁用上下文，并排除已完成叶子", () => {
  const options = buildTaskAssociationOptions(
    [
      task("parent", undefined, "completed"),
      task("child", "parent", "todo"),
      task("done", undefined, "completed")
    ],
    undefined,
    ""
  );

  expect(options.find((option) => option.id === "parent")).toMatchObject({ disabled: true });
  expect(options.find((option) => option.id === "child")).toMatchObject({ depth: 1 });
  expect(options.find((option) => option.id === "done")).toBeUndefined();
});

test("搜索子 Task 时扁平展示完整父级路径", () => {
  const options = buildTaskAssociationOptions(
    [task("root", undefined, "todo"), task("child", "root", "in_progress")],
    undefined,
    "child"
  );
  expect(options).toEqual([
    expect.objectContaining({ id: "child", depth: 0, description: "root / child" })
  ]);
});

test("当前已关联的终态 Task 固定在顶部且不可重新选择", () => {
  const options = buildTaskAssociationOptions(
    [task("done", undefined, "completed"), task("open", undefined, "todo")],
    "done",
    ""
  );
  expect(options[0]).toMatchObject({
    id: "done",
    current: true,
    disabled: true,
    description: "当前关联"
  });
});

test("Thread 候选只保留待审核和挂起，并显示旧 Task 归属", () => {
  const options = buildThreadAssociationOptions(
    [thread("pending", "review_pending"), thread("running", "running")],
    new Map([["pending", link("pending", "old-task")]]),
    "new-task",
    new Map([["project", "AgentKanbanBoard"]]),
    ""
  );
  expect(options).toHaveLength(1);
  expect(options[0]).toMatchObject({ id: "pending", group: "待审核" });
  expect(options[0].description).toContain("当前关联：old-task");
});

test("Todo 定位按树顺序计算分页", () => {
  const tasks = Array.from({ length: 51 }, (_, index) =>
    task(`task-${index + 1}`, undefined, "todo", index)
  );
  expect(todoTargetPage(tasks, "task-51", 50)).toBe(2);
});
```

- [ ] **Step 2: 写选择器键盘失败测试**

创建 `AssociationPicker.test.tsx`：

```typescript
test("支持搜索、方向键选择、Enter 确认和 Esc 还焦点", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <AssociationPicker
      label="选择未完成 Task"
      getOptions={(query) =>
        [
          { id: "parent", label: "父任务", depth: 0 },
          { id: "child", label: "子任务", depth: 1, description: "父任务 / 子任务" }
        ].filter((option) => option.label.includes(query.trim()))
      }
      onSelect={onSelect}
    />
  );

  const trigger = screen.getByRole("combobox", { name: "选择未完成 Task" });
  await user.click(trigger);
  await user.type(screen.getByRole("searchbox"), "子任务");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onSelect).toHaveBeenCalledWith("child");

  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

test("禁用上下文不可选择，空结果显示中文空态", async () => {
  const user = userEvent.setup();
  render(
    <AssociationPicker
      label="选择 Task"
      getOptions={(query) =>
        query === "不存在"
          ? []
          : [{ id: "parent", label: "已完成父任务", depth: 0, disabled: true }]
      }
      onSelect={vi.fn()}
    />
  );
  await user.click(screen.getByRole("combobox", { name: "选择 Task" }));
  expect(screen.getByRole("option", { name: /已完成父任务/ })).toHaveAttribute("aria-disabled", "true");
  await user.type(screen.getByRole("searchbox"), "不存在");
  expect(screen.getByText("没有符合条件的结果，可尝试其他关键词")).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行测试并确认模块缺失**

Run:

```bash
npm --prefix src-ui test -- --run src/associations/associationModel.test.ts src/associations/AssociationPicker.test.tsx
```

Expected: FAIL，提示模块不存在。

- [ ] **Step 4: 实现最小纯函数和选择器**

`types.ts` 定义前端模型及 mapper：

```typescript
export type ThreadTaskLink = {
  threadId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
};

export type AssociationOption = {
  id: string;
  label: string;
  description?: string;
  group?: "待审核" | "挂起";
  depth: number;
  disabled?: boolean;
  current?: boolean;
};

export type AssociationNoticeState = {
  message: string;
  actionLabel?: "撤销" | "重试";
  threadId?: string;
  previousTaskId?: string;
  failedIntent?: {
    kind: "assign" | "unlink";
    threadId: string;
    taskId?: string;
    origin: ThreadTaskLinkOrigin;
  };
};

export const mapBackendThreadTaskLink = (link: BackendThreadTaskLink): ThreadTaskLink => ({
  threadId: link.thread_id,
  taskId: link.task_id,
  createdAt: link.created_at,
  updatedAt: link.updated_at
});
```

`associationModel.ts` 必须使用现有 `flattenTodoTree()` 保持 Todo 树顺序；无搜索时只为拥有可选后代的终态祖先保留禁用上下文，搜索时只返回匹配的可选 Task。Thread 分组顺序固定为待审核、挂起，组内保持传入 `threads` 顺序。搜索统一使用 `trim().toLocaleLowerCase()` 子串匹配。

`AssociationPicker.tsx` 接收 `getOptions: (query: string) => AssociationOption[]`，由组件保存 query 并在每次输入后调用。组件使用按钮或输入作为 `role="combobox"`，下拉使用 `role="listbox"`，候选使用 `role="option"`；`aria-expanded`、`aria-controls`、`aria-activedescendant` 必须随状态更新。容器使用 `max-h-[280px] overflow-y-auto`，缩进使用 `Math.min(option.depth * 12, 36)`。

组件核心实现按以下结构完成，不引入新的 UI 依赖：

```tsx
type Props = {
  label: string;
  valueLabel?: string;
  getOptions: (query: string) => AssociationOption[];
  onOpen?: () => void | Promise<void>;
  onSelect: (id: string) => void;
};

export function AssociationPicker({ label, valueLabel, getOptions, onOpen, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const options = getOptions(query);
  const selectable = options.filter((option) => !option.disabled);
  const active = selectable[Math.min(activeIndex, Math.max(0, selectable.length - 1))];

  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const choose = (id: string) => {
    onSelect(id);
    close();
  };

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
        className="flex h-8 w-full min-w-0 items-center justify-between rounded-md border bg-card px-2 text-[12px]"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void onOpen?.();
        }}
      >
        <span className="truncate">{valueLabel || label}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full rounded-md border bg-card shadow-md">
          <Input
            ref={searchRef}
            role="searchbox"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") close();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, selectable.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              }
              if (event.key === "Enter" && active) choose(active.id);
            }}
          />
          <div id={listId} role="listbox" className="max-h-[280px] overflow-y-auto p-1">
            {options.length === 0 ? (
              <div className="px-2 py-4 text-center text-[11px] text-muted-foreground">
                没有符合条件的结果，可尝试其他关键词
              </div>
            ) : options.map((option) => (
              <button
                key={option.id}
                id={`${listId}-${option.id}`}
                type="button"
                role="option"
                aria-disabled={option.disabled || undefined}
                aria-selected={option.id === active?.id}
                disabled={option.disabled}
                className="block w-full rounded px-2 py-1.5 text-left text-[12px] hover:bg-accent disabled:opacity-55"
                style={{ paddingLeft: `${8 + Math.min(option.depth * 12, 36)}px` }}
                onClick={() => choose(option.id)}
              >
                <span className="block truncate">{option.label}</span>
                {option.description && <span className="block truncate text-[10px] text-muted-foreground">{option.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 运行定向测试并提交**

Run:

```bash
npm --prefix src-ui test -- --run src/associations/associationModel.test.ts src/associations/AssociationPicker.test.tsx
npm --prefix src-ui run build
```

Expected: 测试和 build 均 exit `0`。

```bash
git add src-ui/src/associations
git commit -m "feat: add association picker models"
```

### Task 4: 共享关联控制器、串行队列和提示条

**Files:**
- Create: `src-ui/src/associations/useThreadTaskLinks.ts`
- Create: `src-ui/src/associations/useThreadTaskLinks.test.tsx`
- Create: `src-ui/src/associations/AssociationNotice.tsx`

**Interfaces:**
- Consumes: Task 2 的 `load_thread_task_links`、`update_thread_task_link`。
- Produces: `useThreadTaskLinks({ enabled, invokeCommand? })`，返回 `linksByThread`、`loading`、`savingThreadIds`、`notice`、`loadLinks()`、`assign()`、`unlink()`、`runNoticeAction()`、`dismissNotice()`、`reconcileTaskIds()`。
- Produces: `assign(threadId, taskId, origin: "thread" | "task")` 和 `unlink(threadId)`。
- Produces: `<AssociationNotice notice onAction onDismiss />`。

- [ ] **Step 1: 写控制器失败测试**

创建 `useThreadTaskLinks.test.tsx`，使用 deferred Promise 验证同 Thread 串行、不同 Thread 并行和失败策略：

```typescript
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const backendLink = (threadId: string, taskId: string): BackendThreadTaskLink => ({
  thread_id: threadId,
  task_id: taskId,
  created_at: "2026-07-13T08:00:00Z",
  updated_at: "2026-07-13T08:00:00Z"
});

function associationInvokeMock(initial: BackendThreadTaskLink[]) {
  let links = [...initial];
  return vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "load_thread_task_links") return Promise.resolve([...links]);
    if (command !== "update_thread_task_link") return Promise.resolve(null);
    const threadId = String(args?.threadId);
    const taskId = args?.taskId == null ? undefined : String(args.taskId);
    links = links.filter((item) => item.thread_id !== threadId);
    if (!taskId) return Promise.resolve(null);
    const next = backendLink(threadId, taskId);
    links.push(next);
    return Promise.resolve(next);
  });
}

test("同一 Thread 串行、不同 Thread 并行", async () => {
  const first = deferred<BackendThreadTaskLink | null>();
  const invokeCommand = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "load_thread_task_links") return Promise.resolve([]);
    if (args?.threadId === "a" && args.taskId === "one") return first.promise;
    return Promise.resolve(backendLink(String(args?.threadId), String(args?.taskId)));
  });
  const { result } = renderHook(() =>
    useThreadTaskLinks({ enabled: true, invokeCommand })
  );

  act(() => {
    void result.current.assign("a", "one", "thread");
    void result.current.assign("a", "two", "thread");
    void result.current.assign("b", "three", "thread");
  });

  expect(invokeCommand).toHaveBeenCalledWith("update_thread_task_link", {
    threadId: "a", taskId: "one", origin: "thread"
  });
  expect(invokeCommand).toHaveBeenCalledWith("update_thread_task_link", {
    threadId: "b", taskId: "three", origin: "thread"
  });
  expect(invokeCommand).not.toHaveBeenCalledWith("update_thread_task_link", {
    threadId: "a", taskId: "two", origin: "thread"
  });

  first.resolve(backendLink("a", "one"));
  await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
    "update_thread_task_link",
    { threadId: "a", taskId: "two", origin: "thread" }
  ));
});

test("前序保存失败会取消同 Thread 后续操作并重载持久化状态", async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error("写入失败"))
    .mockResolvedValueOnce([backendLink("a", "persisted")]);
  const { result } = renderHook(() =>
    useThreadTaskLinks({ enabled: true, invokeCommand })
  );

  await act(async () => {
    await result.current.loadLinks();
  });
  await act(async () => {
    void result.current.assign("a", "one", "thread");
    void result.current.assign("a", "two", "thread");
  });
  await waitFor(() => expect(result.current.linksByThread.get("a")?.taskId).toBe("persisted"));
  expect(result.current.notice?.message).toContain("后续操作已取消");
});

test("迁移与解除提供五秒撤销，恢复使用 restore 来源", async () => {
  vi.useFakeTimers();
  const invokeCommand = associationInvokeMock([backendLink("a", "old")]);
  const { result } = renderHook(() =>
    useThreadTaskLinks({ enabled: true, invokeCommand })
  );
  await act(async () => { await result.current.loadLinks(); });
  await act(async () => { await result.current.assign("a", "new", "task"); });
  await act(async () => { await result.current.runNoticeAction(); });
  expect(invokeCommand).toHaveBeenLastCalledWith("update_thread_task_link", {
    threadId: "a", taskId: "old", origin: "restore"
  });
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current.notice).toBeUndefined();
  vi.useRealTimers();
});

test("普通浏览器模式只更新本地 demo 状态，不调用 Tauri", async () => {
  const invokeCommand = vi.fn();
  const { result } = renderHook(() =>
    useThreadTaskLinks({ enabled: false, invokeCommand })
  );
  await act(async () => { await result.current.loadLinks(); });
  await act(async () => {
    await result.current.assign("demo-thread", "demo-task", "thread");
  });
  expect(result.current.linksByThread.get("demo-thread")?.taskId).toBe("demo-task");
  expect(invokeCommand).not.toHaveBeenCalled();
});

test("同一 Thread 的新操作会使旧撤销失效", async () => {
  const invokeCommand = associationInvokeMock([backendLink("a", "old")]);
  const { result } = renderHook(() =>
    useThreadTaskLinks({ enabled: true, invokeCommand })
  );
  await act(async () => { await result.current.loadLinks(); });
  await act(async () => { await result.current.assign("a", "new", "task"); });
  expect(result.current.notice?.actionLabel).toBe("撤销");
  await act(async () => { await result.current.unlink("a"); });
  expect(result.current.notice?.previousTaskId).not.toBe("old");
});
```

- [ ] **Step 2: 运行测试并确认 hook 缺失**

Run:

```bash
npm --prefix src-ui test -- --run src/associations/useThreadTaskLinks.test.tsx
```

Expected: FAIL，提示 `useThreadTaskLinks` 不存在。

- [ ] **Step 3: 实现控制器的唯一队列策略**

控制器必须遵守以下实现顺序：

1. `enabled=true` 时，`loadLinks()` 只在首次展开或 `force=true` 时调用 `load_thread_task_links`，映射为 `Map<threadId, link>`。
2. `enabled=false` 时不调用 Tauri；加载返回空 Map，写入生成本地 demo record，保证普通 Vite 预览可完整交互且控制台无 bridge 错误。
3. `assign()`/`unlink()` 先记录旧 link 并乐观更新共享 Map。
4. 每个 `threadId` 使用独立 Promise chain；同 Thread 新操作只排队，不立即 invoke；不同 Thread 可并行。
5. 写入成功后用后端 record 确认；超过 `300ms` 把 threadId 加入 `savingThreadIds`。
6. 失败且无后续任务时恢复旧 link，展示“关联保存失败，已恢复原状态”和“重试”。
7. 失败且有后续任务时取消后续任务，强制 `loadLinks(true)`，展示“后续操作已取消，请重新操作”；不自动重放。
8. 成功迁移或解除时保存 `{ threadId, previousTaskId }`，展示五秒撤销；同 Thread 新操作立即清除旧撤销。
9. `runNoticeAction()` 对撤销调用 `origin: "restore"`；对重试基于最新 Map 重放失败 intent。
10. `reconcileTaskIds(validIds)` 只在 Todo 快照保存成功后删除指向不存在 Task 的本地 link。

`AssociationNotice.tsx` 使用 `role="status" aria-live="polite"`，仅在有 notice 时渲染；action 按钮使用明确文字“撤销”或“重试”。

- [ ] **Step 4: 运行 hook 测试、全部前端测试和 build**

Run:

```bash
npm --prefix src-ui test -- --run src/associations/useThreadTaskLinks.test.tsx
npm --prefix src-ui test -- --run
npm --prefix src-ui run build
```

Expected: 所有测试 `0 failed`，build exit `0`。

- [ ] **Step 5: 提交共享控制器**

```bash
git add src-ui/src/associations/useThreadTaskLinks.ts \
  src-ui/src/associations/useThreadTaskLinks.test.tsx \
  src-ui/src/associations/AssociationNotice.tsx
git commit -m "feat: manage shared thread task links"
```

### Task 5: Thread 列表与看板展开态关联 Task

**Files:**
- Create: `src-ui/src/associations/ThreadTaskAssociationPanel.tsx`
- Modify: `src-ui/src/App.tsx:130-340,520-669,1034-1246,1564-1723`
- Modify: `src-ui/src/todo/TodoListView.tsx:768-782`
- Modify: `src-ui/src/App.test.tsx:1-260,699-832`

**Interfaces:**
- Consumes: Task 3 的 Task options 与 `AssociationPicker`。
- Consumes: Task 4 的共享控制器。
- Produces: Thread 列表和看板卡片展开区末尾的 `<ThreadTaskAssociationPanel>`。
- Produces: 顶层 `todoTasksCache`、`loadTodoTasksForAssociation()`、`navigateToTodoTask(taskId)`。
- Produces: `todoNavigationTarget?: { taskId: string; requestId: number }`，供 Task 6 消费。

- [ ] **Step 1: 扩展 App command mock 并写 Thread 端失败测试**

在 `App.test.tsx` 的默认 `invokeMock` 中加入：

```typescript
let currentThreadTaskLinks: BackendThreadTaskLink[] = [];
const backendTodoTasks: BackendTodoTask[] = [
  {
    id: "root",
    parent_id: null,
    position: 0,
    title: "父任务",
    status: "todo",
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

if (command === "load_thread_task_links") return Promise.resolve(currentThreadTaskLinks);
if (command === "load_todo_tasks") return Promise.resolve(backendTodoTasks);
if (command === "update_thread_task_link") {
  const { threadId, taskId } = args as { threadId: string; taskId?: string | null };
  currentThreadTaskLinks = currentThreadTaskLinks.filter((link) => link.thread_id !== threadId);
  if (!taskId) return Promise.resolve(null);
  const next = {
    thread_id: threadId,
    task_id: taskId,
    created_at: "2026-07-13T08:00:00Z",
    updated_at: "2026-07-13T08:00:00Z"
  };
  currentThreadTaskLinks.push(next);
  return Promise.resolve(next);
}
```

新增测试：

```typescript
test("Thread 展开后按需加载关联，并可选择子 Task", async () => {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /待人工审核/ }));
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
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.queryByText("关联 Task")).not.toBeInTheDocument();
  expect(invokeMock).not.toHaveBeenCalledWith("load_thread_task_links", undefined);
  vi.useRealTimers();
});

test("点击已关联 Task 切换 Todo 视图并发出定位请求", async () => {
  const user = userEvent.setup();
  currentThreadTaskLinks = [backendLink("019ef88b-6207-7122-9f6e-da4d6d52a9ba", "child")];
  render(<App />);
  await user.click(screen.getByRole("button", { name: /待人工审核/ }));
  await user.click(await screen.findByText("修正 Grafana 日志 service 名称"));
  await user.click(await screen.findByRole("button", { name: "打开 Task 子任务" }));
  expect(await screen.findByRole("heading", { name: "To Do List" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行 App 定向测试并确认 UI 缺失**

Run:

```bash
npm --prefix src-ui test -- --run src/App.test.tsx
```

Expected: 新测试 FAIL，找不到“选择未完成 Task”或 `load_thread_task_links` 调用。

- [ ] **Step 3: 实现 ThreadTaskAssociationPanel 与顶层数据接线**

`ThreadTaskAssociationPanel` props 固定为：

```typescript
type ThreadTaskAssociationPanelProps = {
  thread: ThreadItem;
  link?: ThreadTaskLink;
  tasks: TodoTask[];
  loading: boolean;
  saving: boolean;
  onEnsureTasks: () => Promise<void>;
  onAssign: (threadId: string, taskId: string) => Promise<void>;
  onUnlink: (threadId: string) => Promise<void>;
  onNavigateTask: (taskId: string) => void;
};
```

在 App 顶层：

1. 在 App 顶层用 `shouldInvokeTauri()` 计算 `associationPersistenceEnabled`，创建 `const associations = useThreadTaskLinks({ enabled: associationPersistenceEnabled })`。
2. 把 `TodoListView.tsx` 中的 `demoTasks()` 改为命名导出。保存 `todoTasksCache` 与 `todoTasksLoaded`；`loadTodoTasksForAssociation()` 仅在首次打开 Task picker 时运行：Tauri 环境调用现有 `load_todo_tasks`，普通 Vite 环境直接使用 `demoTasks()`，不得调用 bridge。
3. `toggleListRow()`、`toggleBoardCard()` 只在即将展开时调用 `associations.loadLinks()`，不得在可见行预取或周期刷新中调用。
4. 把同一 `ThreadTaskAssociationPanel` 放在 `ThreadList` 展开区和 `BoardView` 展开卡片的末尾。
5. `navigateToTodoTask()` 设置 `view="todos"` 和递增 `requestId`；不要改变禅模式或导航状态。
6. 在 App 主容器末尾渲染 `AssociationNotice`，只有 notice 存在时出现。
7. 列表虚拟行继续依赖 `measureElement()` 实测高度；关联面板出现后调用 `rowVirtualizer.measure()`，折叠估算仍为 `64`。

- [ ] **Step 4: 运行 Thread 定向测试、全部 App 测试和 build**

Run:

```bash
npm --prefix src-ui test -- --run src/App.test.tsx
npm --prefix src-ui run build
```

Expected: 新增关联测试通过；现有同步、评论、列表虚拟化、看板和快捷键测试全部通过。

- [ ] **Step 5: 提交 Thread 端交互**

```bash
git add src-ui/src/associations/ThreadTaskAssociationPanel.tsx \
  src-ui/src/App.tsx src-ui/src/App.test.tsx src-ui/src/todo/TodoListView.tsx
git commit -m "feat: link threads to todo tasks"
```

### Task 6: Todo 展开态关联多个 Thread 与深层定位

**Files:**
- Create: `src-ui/src/associations/TaskThreadAssociationPanel.tsx`
- Modify: `src-ui/src/todo/TodoListView.tsx:24-49,60-188,263-464,576-587`
- Modify: `src-ui/src/todo/TodoListView.test.tsx:1-280`
- Modify: `src-ui/src/App.tsx:520-669`
- Modify: `src-ui/src/App.test.tsx:1-260`

**Interfaces:**
- Consumes: Task 4 的共享关联控制器和 Task 5 的 `todoNavigationTarget`。
- Produces: Todo props `threads`、`projectNames`、`linksByThread`、`navigationTarget`、`onTasksChange`、`onTasksPersisted`、`onExpandTask`、`onAssignThread`、`onUnlinkThread`、`onOpenThread`。
- Produces: Task 展开区末尾的 `<TaskThreadAssociationPanel>`。

- [ ] **Step 1: 写 Todo 端关联、迁移和定位失败测试**

扩展 `TodoListView` 的可注入 props，测试使用真实前端模型而不是 Tauri mock：

```typescript
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

test("导航目标会清空筛选、切页、展开、滚动并聚焦深层子 Task", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const tasks = Array.from({ length: 51 }, (_, index) => ({
    ...initialTasks[0],
    id: `task-${index + 1}`,
    title: `任务 ${index + 1}`,
    position: index,
    status: index === 50 ? "completed" as const : "todo" as const
  }));
  const { rerender } = render(<TodoListView initialTasks={tasks} persistTasks={vi.fn()} />);
  await userEvent.setup().type(screen.getByRole("textbox", { name: "搜索任务" }), "不存在");
  rerender(
    <TodoListView
      initialTasks={tasks}
      persistTasks={vi.fn()}
      navigationTarget={{ taskId: "task-51", requestId: 1 }}
    />
  );
  expect(await screen.findByDisplayValue("任务 51")).toHaveFocus();
  expect(screen.getByText("第 2 / 2 页 · 共 51 条")).toBeInTheDocument();
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
});
```

- [ ] **Step 2: 运行 Todo 定向测试并确认 props/UI 缺失**

Run:

```bash
npm --prefix src-ui test -- --run src/todo/TodoListView.test.tsx
```

Expected: FAIL，提示新增 props 或 `TaskThreadAssociationPanel` 不存在。

- [ ] **Step 3: 实现 TaskThreadAssociationPanel 与 Todo 回调**

`TaskThreadAssociationPanel` props 固定为：

```typescript
type TaskThreadAssociationPanelProps = {
  task: TodoTask;
  threads: ThreadItem[];
  projectNames: Map<string, string>;
  linksByThread: Map<string, ThreadTaskLink>;
  savingThreadIds: Set<string>;
  onAssign: (threadId: string, taskId: string) => Promise<void>;
  onUnlink: (threadId: string) => Promise<void>;
  onOpenThread: (thread: ThreadItem) => void;
};
```

修改 `TodoListView`：

1. `onTasksChange(tasks)` 在每次 `applyTasks()` 后触发，让 App 更新候选缓存。
2. `onTasksPersisted(tasks)` 只在 `saveSnapshot()` 成功后触发；App 调用 `associations.reconcileTaskIds(new Set(tasks.map(({ id }) => id)))`。
3. 展开 Task 时调用 `onExpandTask?.(task.id)`，由 App 触发 `associations.loadLinks()`。
4. `ExtensionPanel` 改为接收 `children`，在过程跟踪/结果复盘的 grid 之后追加全宽 `TaskThreadAssociationPanel`；折叠 Task 时不渲染。
5. `navigationTarget` effect 先设置 `query=""`、`statusFilter="all"`，再按 `todoTargetPage()` 设置页码和 `expandedId`；目标行渲染后调用 `scrollIntoView({ block: "center" })` 并聚焦标题输入框。
6. 目标不存在时调用 `onNavigationError?.("关联的 Task 已不存在")`，不改变当前筛选和页码。
7. 已关联 Thread 行显示标题、中文状态、打开 Codex 和解除按钮；无关联时只显示“关联 Thread”入口。

在 `App.tsx` 向 `TodoListView` 传入完整 threads（不是 `visibleThreads`），保证 Task picker 能看见所有待审核/挂起候选；状态过滤由纯函数完成。

- [ ] **Step 4: 运行 Todo、App 和全部前端测试**

Run:

```bash
npm --prefix src-ui test -- --run src/todo/TodoListView.test.tsx src/App.test.tsx
npm --prefix src-ui test -- --run
npm --prefix src-ui run build
```

Expected: 所有测试 `0 failed`，build exit `0`；现有 Todo 创建、拖放、日期、扩展信息、分页和快捷键行为保持通过。

- [ ] **Step 5: 提交 Todo 端交互**

```bash
git add src-ui/src/associations/TaskThreadAssociationPanel.tsx \
  src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx \
  src-ui/src/App.tsx src-ui/src/App.test.tsx
git commit -m "feat: link todo tasks to threads"
```

### Task 7: 完整验证、650px 视觉验收与项目知识更新

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`
- Modify: `design-qa.md`
- Verify: `src-tauri/db/002_thread_task_links.sql`
- Verify: `src-tauri/src/domain.rs`
- Verify: `src-tauri/src/repository.rs`
- Verify: `src-tauri/src/main.rs`
- Verify: `src-ui/src/associations/*`
- Verify: `src-ui/src/App.tsx`
- Verify: `src-ui/src/todo/TodoListView.tsx`

**Interfaces:**
- Consumes: Tasks 1-6 的完整实现。
- Produces: 全量自动化证据、650px 实机截图、无控制台错误的交互证据和项目知识约束。

- [ ] **Step 1: 运行完整自动化验证**

Run:

```bash
npm --prefix src-ui test -- --run
npm --prefix src-ui run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
git diff --check
```

Expected: 所有命令 exit `0`；前后端测试 `0 failed`；无格式或 whitespace 错误。

- [ ] **Step 2: 启动浏览器预览并准备真实交互数据**

Run:

```bash
npm --prefix src-ui run dev
```

Expected: Vite 输出本地 URL；浏览器控制台无 Tauri bridge 错误。普通浏览器 demo 数据至少包含：根 Task、子 Task、已完成 Task、待审核 Thread、挂起 Thread、已关联其他 Task 的 Thread。

- [ ] **Step 3: 在 650px 内容宽度完成 Thread 端验收**

逐项操作并截图：

1. 折叠 Thread 与基线行高相同，无关联图标或数量。
2. 展开任意状态 Thread 后，关联区位于详情末尾。
3. Task picker 与字段同宽，高度不超过 280px，深层缩进不超过 36px。
4. 搜索子 Task 时显示父级路径；完成/取消叶子不进入候选。
5. 选择、更换、解除、保存中、失败重试和五秒撤销均不造成横向滚动。
6. 点击已关联 Task 后切换 To Do、清除筛选、定位并聚焦目标。

- [ ] **Step 4: 在 650px 内容宽度完成 Task 端验收**

逐项操作并截图：

1. 折叠 Task 保持原行高，展开后关联区位于过程跟踪/结果复盘之后。
2. picker 只显示待审核与挂起 Thread，按状态分组并保留当前列表顺序。
3. 已关联其他 Task 的 Thread 显示原归属，选择后立即迁移。
4. 一个 Task 可显示多个 Thread，一个 Thread 不会同时出现在两个 Task。
5. Thread 状态变化、Task 完成或取消后既有关联仍保留。
6. 关联失败回滚、队列取消和撤销提示通过鼠标与键盘均可操作。

- [ ] **Step 5: 更新 design QA 与项目知识**

在 `design-qa.md` 记录：

- 源设计：`docs/superpowers/specs/2026-07-13-thread-task-association-design.md`。
- 视口：650px 内容宽度、100% 缩放。
- Thread 折叠/展开、Task picker、Task 展开/迁移、撤销和错误态截图路径。
- 控制台错误数量。
- 自动化命令和通过结果。
- `final result: passed`；若任何 P0/P1 未修复则写 `final result: blocked`。

在 `docs/agent/coding.md` 增加：关联表以 `thread_id` 唯一、按需加载、不进入 BoardData/五秒轮询、状态变化不自动解绑、Task snapshot 删除通过外键级联。

在 `docs/agent/testing.md` 增加：候选状态、子 Task 路径、原子迁移、按 Thread 串行、五秒撤销、Task 删除级联、650px 无横向滚动和浏览器无 Tauri 错误。

- [ ] **Step 6: 复跑验证并提交最终证据**

Run:

```bash
npm --prefix src-ui test -- --run
npm --prefix src-ui run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
git diff --check
```

Expected: 所有命令 exit `0`，`design-qa.md` 包含 `final result: passed`。

```bash
git add docs/agent/coding.md docs/agent/testing.md design-qa.md
git commit -m "docs: verify thread task associations"
```

## Plan Self-Review Checklist

- [x] Spec coverage：基数、候选状态、子 Task、迁移、解除、五秒撤销、失败回滚、队列取消、状态竞态、删除级联、导航和 650px 均有任务覆盖。
- [x] 未决标记扫描：计划不包含待填写段落、模糊的后续实现要求或未定义接口。
- [x] Type consistency：Rust 使用 `ThreadTaskLinkOrigin` / `ThreadTaskLinkRecord`；TypeScript 使用 `ThreadTaskLinkOrigin` / `BackendThreadTaskLink` / `ThreadTaskLink`。
- [x] Command consistency：所有前端写入使用 `update_thread_task_link { threadId, taskId, origin }`；读取使用 `load_thread_task_links`。
- [x] Polling boundary：关联读取只由展开态触发，`BoardData`、`load_board_data`、评论预取和五秒刷新保持不变。
- [x] Verification：每个实现任务均包含失败测试、定向通过、全量验证和独立提交。
