# Thread 列表排除 Subagent 设计

## 背景

新版 Codex 会把 subagent 会话作为独立 thread 持久化到 `~/.codex/state_5.sqlite`。本项目的只读同步没有真正调用 app-server 的 `thread/list`，而是直接查询 `threads` 表且未限制来源，因此把 subagent 一并导入了看板数据库。

空标题只是部分 subagent 的表象，不能作为判定条件。Codex 0.139.0 的结构化数据提供以下可靠信号：

- 状态库 `thread_source` 为 `subagent`；
- 原始 `source` 是包含 `subagent` 对象的 JSON，其中线程派生类型还包含 `thread_spawn.parent_thread_id`；
- app-server 协议把来源区分为 `subAgent*`，并在 subagent thread 上返回 `parentThreadId`。

## 目标

- 所有 Thread 列表都不展示 subagent，包括有标题的 subagent 和历史已导入数据。
- 后续同步不再把 subagent 写入项目数据库，也不使用 subagent 创建项目记录。
- 标题为空的普通主 thread 仍然保留。
- 不删除历史 subagent 数据，避免破坏人工状态、评论或 Thread/Task 关联。

## 方案选择

### 采用：结构化来源判定与双层过滤

增加一个纯函数，根据来源字段判断 thread 是否为 subagent。兼容当前状态库的 snake_case JSON 形式、app-server 的 camelCase 形式，以及直接的 `subagent` 来源值。

过滤放在两层：

1. `ThreadSync` 同步边界过滤外部返回值，阻止未来 subagent 进入同步、项目匹配和持久化流程。
2. `Repository::list_threads` 过滤项目数据库中的历史 subagent，使升级后的第一次只读加载就能隐藏既有数据，无需等待同步或迁移。

### 不采用：按空标题过滤

空标题与 subagent 不是一一对应关系，会遗漏有标题的 subagent，也可能误伤标题为空的主 thread。

### 不采用：仅在前端过滤

前端过滤只能隐藏当前页面，后端仍会同步、存储和处理 subagent，关联候选等依赖 Thread 列表的路径也容易出现不一致。

## 数据流

```text
Codex state SQLite / Codex client
        │
        ├─ 结构化来源判定：subagent → 丢弃
        │
        └─ 主 thread → 项目匹配 → upsert → 项目数据库

项目数据库
        │
        ├─ 历史 subagent → list_threads 隐藏
        │
        └─ 主 thread → BoardData → 前端列表与关联候选
```

## 判定规则

来源满足任一条件时视为 subagent：

- 去除首尾空白后等于 `subagent` 或 `subAgent`；
- 可解析为 JSON 对象，且顶层包含 `subagent` 或 `subAgent` 字段。

不依赖标题、预览、nickname、role 或 agent path。JSON 无效或来源未知时默认保留，避免未来 Codex 版本新增主 thread 来源后被误过滤。

## 错误处理与兼容性

- 来源 JSON 解析失败时不阻断同步，按非 subagent 处理。
- 不依赖状态库新增的 `thread_source` 列，继续只读取既有 `source` 列，避免旧版 Codex 数据库缺列导致整个同步失败。
- 不增加项目数据库迁移，不删除历史记录。

## 测试与验收

- 纯判定测试覆盖 snake_case、camelCase、直接字符串、普通来源和无效 JSON。
- 同步测试证明 subagent 不会 upsert，主 thread 正常保留。
- 仓储测试证明历史 subagent 不出现在 `list_threads`，标题为空的主 thread 仍可见。
- 执行项目规定的 `cargo test`、`cargo fmt --check`、`npm test -- --run`、`npm run build` 和 `git diff --check`。

