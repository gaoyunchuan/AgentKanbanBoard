# 同步 Codex Thread 名称设计

## 背景

Codex Desktop 列表展示 app-server 的 `thread.name`，AgentKanbanBoard 当前却读取
`state_5.sqlite` 中的 `threads.title`。后者通常是首条用户消息，因此同一个 Thread
在两个应用中会显示不同名称，用户也难以通过名称识别主动派生的 Thread。

已确认样例 `019f5aba-f0a1-7d61-9ee1-98249e57675a`：Codex 显示
`portal上线checklist`，而 `threads.title` 是完整的首条用户消息。

## 目标与验收标准

- 看板名称只使用 Codex 的 `thread.name`，不再回退到 `threads.title`。
- 样例 Thread 在下一次后台同步后显示为 `portal上线checklist`。
- Codex 重命名 Thread 后，看板在后续后台同步中更新名称。
- 没有 `thread.name` 的 Thread 名称保持为空，但不因此被隐藏。
- 临时 subagent 继续依据结构化来源隐藏；用户主动派生的 Thread 继续显示。
- `load_board_data` 保持只读，不在 UI 轮询路径中解析 Codex 文件或启动 app-server。

## 方案选择

### 采用方案：后台同步时读取名称索引

在现有 `ReadOnlyCodexClient` 读取 `state_5.sqlite` 的同时，读取同一 Codex Home
下的 `session_index.jsonl`，按 Thread id 取得 `thread_name`。数据库仍提供 Thread
列表和其他字段，名称只来自索引。

优点：

- 与 Codex 当前显示名称一致。
- 复用现有后台同步和单飞机制，不增加 UI 轮询负担。
- 不需要每五秒启动并初始化 app-server 进程。

约束：

- 名称索引不存在、不可读、记录缺失或名称为空时，该 Thread 名称为空。
- JSONL 末尾可能在并发写入时暂时不完整；无效行应跳过，不能阻断整个 Thread 同步。
- 同一 Thread 出现多条有效记录时，以文件中最后一条记录为准。

### 未采用方案：每次同步启动 app-server

app-server 的 `thread/list` 能直接返回 `thread.name`，但当前同步周期较短；频繁启动、
初始化和分页读取进程会扩大实现与运行成本。若未来项目维护长连接 app-server 客户端，
可以再替换名称索引读取实现，外部行为无需变化。

### 未采用方案：继续使用 `threads.title`

该字段与 Codex 用户界面名称语义不同，无法解决两个应用名称不一致的问题。

## 数据流

1. `start_codex_sync` 触发现有后台同步。
2. `ReadOnlyCodexClient` 读取 `session_index.jsonl`，构建 `Thread id -> thread_name` 映射。
3. `ReadOnlyCodexClient` 只读查询 `state_5.sqlite`，构建 Thread 列表。
4. 每个 `SyncedThread.title` 仅取名称映射中的值；缺失时使用空字符串。
5. 现有结构化来源过滤排除临时 subagent。
6. Repository upsert 更新看板中的名称，随后 UI 的只读刷新展示结果。

## 错误处理

- 名称索引缺失或无法读取：使用空名称继续同步，数据库读取错误仍按现有方式返回失败。
- 单行 JSON 无效：跳过该行，避免 Codex 并发追加导致同步失败。
- `thread_name` 不是非空字符串：视为无名称。
- 名称处理不参与 subagent 判断，避免重新引入“空名称即 subagent”的错误规则。

## 测试

- 先增加失败测试，证明名称索引中的 `thread_name` 会覆盖 SQLite 的长标题。
- 覆盖无索引记录时名称为空，确认没有标题回退。
- 覆盖重复记录最后一条生效、无效 JSONL 行不阻断同步。
- 保留并运行现有主动派生 Thread/临时 subagent 来源过滤回归测试。
- 完整运行 Rust、前端、构建、格式和 diff 检查。
