# 同步 Codex Thread 名称 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让看板名称只使用 Codex 的 `thread.name`，并保持现有结构化 subagent 过滤行为。

**Architecture:** `ReadOnlyCodexClient` 在后台同步时读取 Codex Home 下的 `session_index.jsonl`，建立 Thread id 到 `thread_name` 的最后有效值映射，再与 `state_5.sqlite` 的 Thread 列表合并。SQLite 的 `threads.title` 不再参与看板名称，UI 只读轮询和 Repository 数据流保持不变。

**Tech Stack:** Rust、serde_json、rusqlite、JSONL、Cargo test。

**Source Spec:** `docs/superpowers/specs/2026-07-13-sync-codex-thread-name-design.md`。

## Global Constraints

- 看板名称只使用 Codex 的 `thread.name`，不回退到 `threads.title`。
- 没有名称的 Thread 保持空名称，但不得因此被隐藏。
- 临时 subagent 继续依据结构化来源隐藏，用户主动派生的 Thread 继续显示。
- 名称索引缺失、不可读或包含无效行时，不得阻断 SQLite Thread 同步。
- 同一 Thread 的最后一条有效索引记录生效；空名称会清除先前名称。
- `load_board_data` 保持只读，不解析 Codex 文件或启动 app-server。
- 直接在 `main` 开发，不创建分支或 WorkTree。

## File Map

### 修改

- `src-tauri/services/ThreadSync.rs`：定位名称索引、容错解析 JSONL，并把名称映射合并到 SQLite Thread 列表。
- `src-tauri/src/lib.rs`：增加名称优先、无回退、重复记录和无效行回归测试。
- `docs/agent/coding.md`：记录看板 Thread 名称的唯一来源和同步边界。
- `docs/agent/testing.md`：记录名称同步的回归范围。

---

### Task 1: 从 Codex 名称索引构建看板 Thread 名称

**Files:**
- Modify: `src-tauri/services/ThreadSync.rs`
- Test: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `read_thread_names(path: &Path) -> HashMap<String, String>`。
- Consumes: `session_index.jsonl` 中的 `{ "id": string, "thread_name": string }` 记录。
- Changes: `ReadOnlyCodexClient` 同时保存 `state_db_path` 和 `session_index_path`。

- [ ] **Step 1: 写名称索引优先的失败测试**

修改 `readonly_client_reads_threads_from_codex_state_sqlite`，让临时 SQLite 位于独立目录，并在同目录写入：

```json
{"id":"019ef927-4206-7823-a752-eb0364a6f11b","thread_name":"旧名称"}
不是有效 JSON
{"id":"019ef927-4206-7823-a752-eb0364a6f11b","thread_name":"portal上线checklist"}
```

保留 SQLite 的 `title = '接入真实数据'`，将断言改为：

```rust
assert_eq!(threads[0].title, "portal上线checklist");
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml readonly_client_reads_threads_from_codex_state_sqlite -- --nocapture
```

Expected: FAIL，实际名称仍为 SQLite 的 `接入真实数据`。

- [ ] **Step 3: 实现 JSONL 名称读取和覆盖**

在 `src-tauri/services/ThreadSync.rs` 增加索引记录和解析函数：

```rust
#[derive(Deserialize)]
struct CodexSessionIndexEntry {
    id: String,
    thread_name: Option<String>,
}

fn read_thread_names(path: &Path) -> HashMap<String, String> {
    let Ok(file) = File::open(path) else {
        return HashMap::new();
    };
    let mut names = HashMap::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<CodexSessionIndexEntry>(&line) else {
            continue;
        };
        match entry.thread_name {
            Some(name) if !name.trim().is_empty() => {
                names.insert(entry.id, name);
            }
            _ => {
                names.remove(&entry.id);
            }
        }
    }
    names
}
```

将默认 Codex Home 同时派生为 `state_5.sqlite` 和 `session_index.jsonl`；`with_state_db_path` 从 SQLite 父目录派生索引路径。查询行时先取 id，再设置：

```rust
let id: String = row.get(0)?;
let title = thread_names.get(&id).cloned().unwrap_or_default();
```

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml readonly_client_reads_threads_from_codex_state_sqlite -- --nocapture
```

Expected: PASS，名称为 `portal上线checklist`，有标题的临时 subagent 仍被过滤。

- [ ] **Step 5: 写无名称不回退的失败保护测试**

增加一个 SQLite 中有标题、索引中没有对应 id 的主 Thread，并断言：

```rust
let unnamed = threads.iter().find(|thread| thread.id == "main-without-name").unwrap();
assert!(unnamed.title.is_empty());
```

索引读取实现已经存在，因此为验证测试有效性，先临时把该行恢复为 `row.get(1)?` 运行并确认测试失败，再恢复名称映射实现。

- [ ] **Step 6: 运行名称与来源过滤回归测试**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml readonly_client_reads_threads_from_codex_state_sqlite -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml subagent -- --nocapture
```

Expected: 全部 PASS；无名称主 Thread 保持可见且标题为空，临时 subagent 隐藏。

- [ ] **Step 7: 提交实现**

```bash
git add src-tauri/services/ThreadSync.rs src-tauri/src/lib.rs
git commit -m "fix: sync codex thread names"
```

---

### Task 2: 记录名称同步约束并完整验证

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`

**Interfaces:**
- Consumes: Task 1 的最终名称来源和容错行为。
- Produces: 后续修改 Thread 同步时必须遵守的项目知识。

- [ ] **Step 1: 更新项目知识**

在 `docs/agent/coding.md` 记录：

```markdown
- Thread 看板名称只使用 Codex `session_index.jsonl` 中的 `thread_name`，不回退到 `state_5.sqlite.threads.title`；缺失名称保持为空，名称不得参与 subagent 判定。
```

在 `docs/agent/testing.md` 记录：

```markdown
- 修改 Thread 名称同步时，需要覆盖索引名称覆盖 SQLite 标题、无名称不回退、重复记录最后一条生效、无效 JSONL 行容错，以及空名称主 Thread 与临时 subagent 的展示边界。
```

- [ ] **Step 2: 运行完整验证**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
(cd src-tauri && cargo fmt --check)
npm test --prefix src-ui -- --run
npm run build --prefix src-ui
git diff --check
```

Expected: Rust、前端测试和构建全部退出 0，格式与 diff 检查无输出。

- [ ] **Step 3: 检查需求覆盖和工作区**

Run:

```bash
git diff --stat HEAD~1
git status --short --branch
```

Expected: 变更只涉及计划内文件，`main` 相对远端仅包含本任务和此前本地提交。

- [ ] **Step 4: 提交知识文档**

```bash
git add docs/agent/coding.md docs/agent/testing.md docs/superpowers/plans/2026-07-13-sync-codex-thread-name.md
git commit -m "docs: record codex thread name sync"
```
