# To Do 关联 Thread 打开 Codex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 To Do List 中所有已关联 Thread 入口直接打开 Codex Desktop 对应会话，并移除仅服务于旧应用内 Thread 列表定位的代码。

**Architecture:** `App` 继续持有 `openThread` 副作用和 Tauri runtime 边界，`TodoListView` 与 `TaskThreadAssociationPanel` 只通过 `onOpenThread` 上报点击。删除 To Do → Thread 列表的导航状态和虚拟列表滚动逻辑，保留 Thread → Task 的 `todoNavigationTarget`。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tauri 2、Vite

## Global Constraints

- 直接在 `main` 开发，禁止使用 WorkTree。
- 代码注释、文档和会话使用中文。
- 先写失败测试并确认失败原因，再修改生产代码。
- 普通 Vite 浏览器预览不得调用 Tauri command。
- 不修改 Thread/Task 关联数据、迁移、撤销或懒加载机制。
- 不修改 Thread → Task 的反向应用内定位。
- 不修改数据库、Tauri command 或 `codex://threads/<session-id>` 格式。

---

## 文件结构

- `src-ui/src/App.tsx`：选择 To Do 点击回调、执行 Codex deep link、守住浏览器/Tauri 边界，并移除旧 Thread 列表定位状态。
- `src-ui/src/App.test.tsx`：验证桌面/测试环境点击 To Do 关联 Thread 会调用正确 deep link 且页面不切换。
- `src-ui/src/App.browser.test.tsx`：验证普通浏览器点击关联 Thread 不调用 Tauri。
- `src-ui/src/todo/TodoListView.tsx`：明确折叠行标签的可访问名称。
- `src-ui/src/todo/TodoListView.test.tsx`：验证折叠行和展开详情都把点击委托给同一个 `onOpenThread`。
- `src-ui/src/associations/TaskThreadAssociationPanel.tsx`：明确展开详情条目的可访问名称。
- `docs/agent/coding.md`：记录 To Do 关联 Thread 直接打开 Codex 的稳定约束。
- `docs/agent/testing.md`：记录对应回归范围。

---

### Task 1: 用失败测试固定新的点击语义

**Files:**
- Modify: `src-ui/src/App.test.tsx:390-414`
- Modify: `src-ui/src/App.browser.test.tsx:20-34`
- Modify: `src-ui/src/todo/TodoListView.test.tsx:312-334`

**Interfaces:**
- Consumes: `TodoListView.onOpenThread?: (thread: ThreadItem) => void`
- Produces: 折叠行、展开详情和浏览器 runtime 的行为回归测试

- [x] **Step 1: 将 App 集成测试改为期望打开 Codex**

把旧的“切换并展开应用内对应 Thread”测试改为：

```tsx
test("点击 Todo 关联 Thread 会打开 Codex 并停留在 To Do List", async () => {
  const user = userEvent.setup();
  currentThreadTaskLinks = [
    backendLink("019ef88b-6207-7122-9f6e-da4d6d52a9ba", "demo-1")
  ];
  render(<App />);

  await screen.findByText("修正 Grafana 日志 service 名称");
  await user.click(screen.getByRole("button", { name: /To Do List/ }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("load_thread_task_links", undefined)
  );
  await user.click(
    await screen.findByRole("button", {
      name: "在 Codex 打开 Thread 修正 Grafana 日志 service 名称"
    })
  );

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("open_codex_deeplink", {
      target: "codex://threads/019ef88b-6207-7122-9f6e-da4d6d52a9ba"
    })
  );
  expect(screen.getByRole("heading", { name: "To Do List" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "全部活跃 Threads" })).not.toBeInTheDocument();
});
```

- [x] **Step 2: 扩展 TodoListView 组件测试覆盖两个入口**

将可访问名称期望改为“在 Codex 打开 Thread”，点击折叠标签后再展开任务，并在 `关联 Thread` region 内点击详情条目：

```tsx
const compactButton = screen.getByRole("button", {
  name: "在 Codex 打开 Thread thread-b"
});
await user.click(compactButton);
expect(onOpenThread).toHaveBeenLastCalledWith(threadB);

await user.click(screen.getByRole("button", { name: "展开 父任务" }));
const associationPanel = screen.getByRole("region", { name: "关联 Thread" });
await user.click(
  within(associationPanel).getByRole("button", {
    name: "在 Codex 打开 Thread thread-b"
  })
);
expect(onOpenThread).toHaveBeenLastCalledWith(threadB);
expect(onOpenThread).toHaveBeenCalledTimes(2);
```

- [x] **Step 3: 扩展浏览器测试覆盖点击边界**

在现有 demo 关联流程定位到 Task 后，点击已关联 Thread，并继续断言 `invokeMock` 没有调用：

```tsx
await user.click(screen.getByRole("button", { name: /打开 Task 异构实现带外探测/ }));
await user.click(
  (await screen.findAllByRole("button", {
    name: "在 Codex 打开 Thread 浏览器预览：待审核 Thread"
  }))[0]
);

expect(invokeMock).not.toHaveBeenCalled();
```

- [x] **Step 4: 运行定向测试并确认 RED**

Run:

```bash
cd src-ui && npm test -- --run src/App.test.tsx src/App.browser.test.tsx src/todo/TodoListView.test.tsx
```

Expected: FAIL。失败点应为旧可访问名称、仍切换到 Thread 列表、没有浏览器预览提示或触发了 Tauri；不得是测试语法或 fixture 错误。

---

### Task 2: 恢复 Codex deep link 并删除旧导航

**Files:**
- Modify: `src-ui/src/App.tsx:217-263,444-453,703-728,803-815,1217-1281,1325`
- Modify: `src-ui/src/todo/TodoListView.tsx:709-715`
- Modify: `src-ui/src/associations/TaskThreadAssociationPanel.tsx:66-72`

**Interfaces:**
- Consumes: `associationPersistenceEnabled: boolean`、`openThread(thread: ThreadItem): Promise<void>`
- Produces: To Do 两个入口统一调用 `openThread`；浏览器预览不调用 Tauri

- [x] **Step 1: 给 openThread 增加浏览器 runtime 边界**

在 session 校验前增加：

```tsx
if (!associationPersistenceEnabled) {
  setToast("浏览器预览不支持打开 Codex，请在桌面端使用");
  return;
}
```

桌面端继续复用现有 UUID 校验、`openCodexDeepLink` 和 toast 逻辑。

- [x] **Step 2: 将 To Do 回调恢复为 openThread**

在现有 `TodoListView` 调用中只替换这一行：

```tsx
onOpenThread={openThread}
```

- [x] **Step 3: 删除旧 To Do → Thread 列表导航代码**

删除以下内容：

```tsx
const [threadNavigationTarget, setThreadNavigationTarget] = useState<{
  threadId: string;
  requestId: number;
}>();

const navigateToThread = useCallback((thread: ThreadItem) => {
  // 整个回调删除
}, []);
```

同时从 `ThreadList` 调用和类型中删除 `navigationTarget`，删除依赖它的 `useEffect`，并删除仅供该 effect 查找元素的 `data-thread-id={thread.id}`。`todoNavigationTarget`、`navigateToTodoTask` 与 `ThreadAssociationBindings.onNavigateTask` 保持不变。

- [x] **Step 4: 更新两个入口的可访问名称**

在 `TaskThreadTags` 和 `TaskThreadAssociationPanel` 中统一使用：

```tsx
aria-label={`在 Codex 打开 Thread ${thread.title}`}
```

视觉样式、图标和 `onClick={() => onOpenThread(thread)}` 委托保持不变。

- [x] **Step 5: 运行定向测试并确认 GREEN**

Run:

```bash
cd src-ui && npm test -- --run src/App.test.tsx src/App.browser.test.tsx src/todo/TodoListView.test.tsx
```

Expected: 三个测试文件全部 PASS，控制台没有未处理异常。

- [x] **Step 6: 提交行为修复**

```bash
git add src-ui/src/App.tsx src-ui/src/App.test.tsx \
  src-ui/src/App.browser.test.tsx src-ui/src/todo/TodoListView.tsx \
  src-ui/src/todo/TodoListView.test.tsx \
  src-ui/src/associations/TaskThreadAssociationPanel.tsx
git commit -m "fix: open todo threads in Codex"
```

---

### Task 3: 同步项目知识并完成全量验证

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`

**Interfaces:**
- Consumes: Task 2 已验证的最终行为
- Produces: 后续修改必须遵守的稳定编码与测试约束

- [x] **Step 1: 更新编码知识**

将旧的“点击后在应用内切换并定位、展开对应 Thread”改为：

```markdown
- To Do List 折叠行第二列和展开详情展示全部关联 Thread；点击任一关联 Thread 都直接打开 Codex Desktop 对应会话并保持 To Do 页面，不再切换到应用内 Thread 列表；普通浏览器预览不得调用 Tauri。
```

在 Update Notes 增加 2026-07-14 记录。

- [x] **Step 2: 更新测试知识**

将旧的应用内 Thread 定位回归要求改为：

```markdown
- To Do 关联 Thread 点击回归需要覆盖折叠标签和展开详情均调用正确 `codex://threads/<session-id>`、点击后保持 To Do 页面、无效 session 不调用 Tauri、普通浏览器预览不调用 Tauri，以及 Thread → Task 反向定位不受影响。
```

在 Update Notes 增加 2026-07-14 记录。

- [x] **Step 3: 运行前端全量测试**

Run:

```bash
cd src-ui && npm test -- --run
```

Expected: 所有测试文件与测试用例 PASS。

- [x] **Step 4: 运行生产构建**

Run:

```bash
cd src-ui && npm run build
```

Expected: TypeScript 检查和 Vite build 成功，退出码为 0。

- [x] **Step 5: 检查差异质量与范围**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Expected: `git diff --check` 无输出；仅出现本计划列出的项目知识文件改动，行为代码已在 Task 2 提交。

- [x] **Step 6: 提交知识更新**

```bash
git add docs/agent/coding.md docs/agent/testing.md
git commit -m "docs: record todo Codex navigation"
```

## 执行结果

- RED：3 个定向测试按预期因旧可访问名称和旧应用内跳转失败。
- GREEN：`src/App.test.tsx`、`src/App.browser.test.tsx`、`src/todo/TodoListView.test.tsx` 共 52 个用例通过。
- 全量测试：12 个测试文件、87 个用例全部通过。
- 生产构建：TypeScript 检查和 Vite build 成功。
- 差异检查：`git diff --check` 无输出，最终工作区干净。
