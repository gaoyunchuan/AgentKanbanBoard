# Thread 列表排除 Subagent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Codex 的结构化来源字段排除所有 subagent thread，同时立即隐藏项目数据库中已导入的历史 subagent。

**Architecture:** 在领域层提供单一来源判定纯函数，Codex 只读客户端和 `ThreadSync` 同步边界都用它阻止新增 subagent；`Repository::list_threads` 使用同一函数隐藏历史数据。保留历史记录且不新增数据库迁移。

**Tech Stack:** Rust、serde_json、rusqlite、SQLite、Cargo test。

**Source Spec:** `docs/superpowers/specs/2026-07-13-exclude-subagent-threads-design.md`。

## Global Constraints

- 不使用标题、预览、nickname、role 或 agent path 判断 subagent。
- 同时识别 `subagent`、`subAgent`、顶层 `subagent` JSON 和顶层 `subAgent` JSON。
- 无效 JSON 和未知来源默认保留。
- 不删除项目数据库中的历史记录，不增加数据库迁移。
- `load_board_data` 继续保持只读，不触发 Codex 同步或扫描。
- 直接在 `main` 开发，不创建分支或 WorkTree。

## File Map

### 修改

- `src-tauri/src/domain.rs`：提供结构化 subagent 来源判定纯函数。
- `src-tauri/services/ThreadSync.rs`：在只读客户端和通用同步边界过滤 subagent。
- `src-tauri/src/repository.rs`：在列表读取层隐藏历史 subagent。
- `src-tauri/src/lib.rs`：增加来源判定、同步过滤和历史数据回归测试。
- `docs/agent/coding.md`：记录 Thread 列表的结构化来源过滤约束。
- `docs/agent/testing.md`：记录 subagent 过滤回归范围。

---

### Task 1: 结构化来源判定与同步入口过滤

**Files:**
- Modify: `src-tauri/src/domain.rs`
- Modify: `src-tauri/services/ThreadSync.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `domain::is_subagent_source(source: &str) -> bool`。
- Consumes: `SyncedThread::source_kind` 中从 Codex 状态库读取的原始来源文本。

- [ ] **Step 1: 写来源判定和同步过滤失败测试**

在 `src-tauri/src/lib.rs` 的测试模块中导入 `is_subagent_source`，增加：

```rust
#[test]
fn subagent_source_detection_uses_structured_source_instead_of_title() {
    assert!(is_subagent_source("subagent"));
    assert!(is_subagent_source("subAgent"));
    assert!(is_subagent_source(
        r#"{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}"#
    ));
    assert!(is_subagent_source(
        r#"{"subAgent":{"thread_spawn":{"parent_thread_id":"parent"}}}"#
    ));
    assert!(!is_subagent_source("cli"));
    assert!(!is_subagent_source(r#"{"custom":"automation"}"#));
    assert!(!is_subagent_source("not-json"));
}

#[test]
fn thread_sync_excludes_subagents_from_custom_clients() {
    let main_thread = synced_thread("main", "idle", "2026-07-13T08:00:00Z");
    let mut subagent = synced_thread("subagent", "idle", "2026-07-13T08:00:00Z");
    subagent.title = "有标题的 subagent".to_string();
    subagent.source_kind =
        r#"{"subagent":{"thread_spawn":{"parent_thread_id":"main"}}}"#.to_string();
    let sync = ThreadSync::new(Box::new(StaticThreadClient {
        threads: vec![main_thread, subagent],
    }));

    let threads = sync.sync_recent().unwrap();

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, "main");
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml subagent_source_detection_uses_structured_source_instead_of_title -- --nocapture
```

Expected: FAIL，提示 `is_subagent_source` 尚不存在。

- [ ] **Step 3: 实现最小来源判定和同步过滤**

在 `src-tauri/src/domain.rs` 增加：

```rust
pub fn is_subagent_source(source: &str) -> bool {
    let source = source.trim();
    if matches!(source, "subagent" | "subAgent") {
        return true;
    }

    match serde_json::from_str::<Value>(source) {
        Ok(Value::Object(object)) => {
            object.contains_key("subagent") || object.contains_key("subAgent")
        }
        _ => false,
    }
}
```

在 `src-tauri/services/ThreadSync.rs` 导入该函数并增加：

```rust
fn exclude_subagent_threads(threads: Vec<SyncedThread>) -> Vec<SyncedThread> {
    threads
        .into_iter()
        .filter(|thread| !is_subagent_source(&thread.source_kind))
        .collect()
}
```

让 `ReadOnlyCodexClient::call` 收集查询结果后调用 `exclude_subagent_threads`，并让 `ThreadSync::sync_recent` 对任意 `CodexAppServerClient` 返回值再次调用同一过滤函数。

- [ ] **Step 4: 运行两个定向测试并确认 GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml subagent_source_detection_uses_structured_source_instead_of_title -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml thread_sync_excludes_subagents_from_custom_clients -- --nocapture
```

Expected: 两个测试均 PASS。

- [ ] **Step 5: 提交同步边界改动**

```bash
git add src-tauri/src/domain.rs src-tauri/services/ThreadSync.rs src-tauri/src/lib.rs
git commit -m "fix: exclude subagents from thread sync"
```

---

### Task 2: 隐藏历史已导入的 Subagent

**Files:**
- Modify: `src-tauri/src/repository.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `domain::is_subagent_source(source: &str) -> bool`。
- Changes: `Repository::list_threads` 永远不返回来源为 subagent 的记录。

- [ ] **Step 1: 写历史数据过滤失败测试**

在 `src-tauri/src/lib.rs` 增加：

```rust
#[test]
fn repository_hides_historical_subagents_but_keeps_untitled_main_threads() {
    let repo = Repository::open_in_memory().unwrap();
    let mut main_thread = CodexThreadUpsert::minimal("main");
    main_thread.title = String::new();
    main_thread.source_kind = "cli".to_string();
    repo.upsert_thread(main_thread).unwrap();

    let mut subagent = CodexThreadUpsert::minimal("subagent");
    subagent.title = "有标题的 subagent".to_string();
    subagent.source_kind =
        r#"{"subagent":{"thread_spawn":{"parent_thread_id":"main"}}}"#.to_string();
    repo.upsert_thread(subagent).unwrap();

    let threads = repo.list_threads(FilterQuery {
        include_archived: true,
        ..FilterQuery::default()
    }).unwrap();

    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, "main");
    assert!(threads[0].title.is_empty());
}
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml repository_hides_historical_subagents_but_keeps_untitled_main_threads -- --nocapture
```

Expected: FAIL，`threads.len()` 实际为 `2`。

- [ ] **Step 3: 在仓储列表层增加最小过滤**

在 `src-tauri/src/repository.rs` 导入 `is_subagent_source`，把 `list_threads` 的 retain 条件开头改为：

```rust
!is_subagent_source(&thread.source_kind)
    && (query.include_archived || thread.board_status != BoardStatus::Archived)
```

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml repository_hides_historical_subagents_but_keeps_untitled_main_threads -- --nocapture
```

Expected: PASS。

- [ ] **Step 5: 提交历史列表过滤**

```bash
git add src-tauri/src/repository.rs src-tauri/src/lib.rs
git commit -m "fix: hide historical subagent threads"
```

---

### Task 3: 项目知识与完整验证

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`

**Interfaces:**
- Produces: 后续 Thread 同步和测试必须遵循的稳定约束。

- [ ] **Step 1: 更新项目知识**

在 `docs/agent/coding.md` 记录：Thread 列表必须根据 Codex 结构化来源排除 subagent，禁止使用空标题启发式；同步边界和仓储列表需要分别阻止新增与隐藏历史数据。

在 `docs/agent/testing.md` 记录：修改 Thread 来源解析时必须覆盖有标题 subagent、空标题主 thread、无效 JSON、同步入口和历史项目库过滤。

- [ ] **Step 2: 格式化 Rust 并运行完整验证**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cd src-ui
npm test -- --run
npm run build
cd ..
git diff --check
```

Expected: 所有命令退出码为 `0`，测试无失败，`git diff --check` 无输出。

- [ ] **Step 3: 复核改动范围并提交知识文档**

```bash
git status --short
git diff --stat HEAD~2
git add docs/agent/coding.md docs/agent/testing.md
git commit -m "docs: record subagent thread filtering"
```

Expected: 只有本计划列出的代码、测试和文档发生变化。
