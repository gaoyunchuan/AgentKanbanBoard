# To Do 关联 Thread 打开 Codex 设计

## 背景与根因

To Do List 的折叠行和展开详情都通过 `onOpenThread` 处理已关联 Thread 的点击。提交 `c001741` 将该回调从现有的 `openThread` 替换为 `navigateToThread`，因此点击后会切换到应用内 Thread 列表并定位、展开对应行，而不是打开 Codex Desktop 会话。

## 目标

- To Do List 折叠行中的关联 Thread 标签直接打开对应 Codex 会话。
- To Do List 展开详情中的已关联 Thread 条目采用相同行为。
- 点击后继续停留在 To Do List，不切换到应用内 Thread 列表。
- 保留 Thread 看板现有的“打开 Codex”行为、校验和失败兜底。

## 非目标

- 不修改 Thread 与 Task 的关联、迁移、撤销或懒加载机制。
- 不修改从 Thread 看板定位并展开关联 Task 的反向导航。
- 不新增同时提供“应用内定位”和“打开 Codex”的双入口。
- 不修改数据库、Tauri command 或 Codex deep link 格式。

## 方案

### 组件职责

`App` 继续统一持有打开 Codex 的副作用。To Do List 的两个关联 Thread 入口只接收并调用 `onOpenThread`，不自行拼接 deep link，也不直接调用 Tauri。

`App` 向 `TodoListView` 传入现有 `openThread`：

1. 校验 `codexSessionId` 是否为有效 UUID。
2. 构造 `codex://threads/<session-id>`。
3. 通过 `open_codex_deeplink` 打开 Codex Desktop。
4. 成功或失败均通过现有 toast 反馈；失败时继续复制 deep link 作为兜底。

普通 Vite 浏览器预览没有 Tauri bridge。点击关联 Thread 时不得调用 Tauri，只提示该能力需要在桌面端使用；桌面端和测试环境保持现有调用能力。

### 清理旧导航

删除只服务于“To Do → 应用内 Thread 列表定位”的代码：

- `navigateToThread` 回调。
- `threadNavigationTarget` 状态。
- `ThreadList` 的对应 `navigationTarget` 参数、虚拟列表滚动和聚焦逻辑。
- 为该旧行为增加的集成测试。

保留 `todoNavigationTarget` 及其相关逻辑，因为它承担不同方向的“Thread → Task”定位。

### 可访问语义

两个入口的可访问名称明确为“在 Codex 打开 Thread <标题>”，使行为与实际目标一致。视觉布局和关联标签样式保持不变。

## 错误处理

- session ID 缺失或格式无效：不调用 Tauri，展示现有无效 session 提示。
- 桌面端打开失败：复制 deep link，并展示现有失败提示。
- 普通浏览器预览：不调用 Tauri，提示需要使用桌面端。

## 测试与验收

前端测试覆盖：

1. 点击折叠行关联 Thread 标签会调用 `open_codex_deeplink`，参数为对应 deep link。
2. 点击展开详情的已关联 Thread 条目执行相同调用。
3. 点击后仍停留在 To Do List，不出现应用内 Thread 列表定位行为。
4. 普通浏览器预览点击关联 Thread 不调用 Tauri。
5. Thread 看板原有“打开 Codex”和“Thread → Task”定位测试继续通过。

交付前运行：

- `npm test -- --run`
- `npm run build`
- `git diff --check`

同步更新 `docs/agent/coding.md` 与 `docs/agent/testing.md`，将 To Do 关联 Thread 的稳定行为改为直接打开 Codex Desktop。

