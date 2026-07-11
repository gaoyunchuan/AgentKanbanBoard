# 视图快捷键与禅模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持 `Cmd+1` 切换“全部活跃”、`Cmd+2` 切换 To Do List，并让两个视图共享且保持禅模式。

**Architecture:** 在 `App` 顶层注册窗口级键盘监听，匹配精确的 macOS `Cmd+数字` 后只更新现有 `view` 状态。调整顶栏条件渲染，让禅模式按钮在 To Do List 中也可用，同时保留看板专属操作的原有边界。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、Tauri WebView

## Global Constraints

- 快捷键只在应用窗口内生效，不注册操作系统级全局快捷键。
- 只支持 macOS `Cmd` 修饰键，不把 `Ctrl` 作为等价修饰键。
- 快捷键在输入控件聚焦时仍然生效。
- 只有未同时按下 `Ctrl`、`Alt`、`Shift` 的 `Cmd+1` 和 `Cmd+2` 才触发。
- 捕获快捷键后必须调用 `preventDefault()`。
- 快捷键只能更新 `view`，不能修改 `zenMode`、`sidebarMode`、`summaryOpen` 或其他页面状态。
- To Do List 显示禅模式按钮，但不显示同步和打开 Codex 操作。
- 不新增依赖，不修改后端命令与 To Do 数据结构，不持久化视图或禅模式。
- 代码注释与文档使用中文。

---

### Task 1: 全局视图快捷键与跨视图禅模式

**Files:**
- Modify: `src-ui/src/App.test.tsx:290-380`
- Modify: `src-ui/src/App.tsx:133-140`
- Modify: `src-ui/src/App.tsx:367-525`
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`

**Interfaces:**
- Consumes: `ViewKey`、`setView`、`zenMode`、`setZenMode`、`sidebarMode`。
- Produces: 窗口级 `keydown` 行为：精确的 `Cmd+1 -> active`、`Cmd+2 -> todos`；所有视图共用的禅模式按钮。

- [ ] **Step 1: 编写快捷键与禅模式失败测试**

在 `src-ui/src/App.test.tsx` 的 To Do List 与禅模式测试附近加入以下用例：

```tsx
test("switches between active and To Do List with Cmd+1 and Cmd+2", async () => {
  render(<App />);

  const searchInput = await screen.findByPlaceholderText("搜索 thread、项目、模块");
  searchInput.focus();
  const switchToTodos = new KeyboardEvent("keydown", {
    key: "2",
    metaKey: true,
    bubbles: true,
    cancelable: true
  });
  searchInput.dispatchEvent(switchToTodos);

  expect(switchToTodos.defaultPrevented).toBe(true);
  expect(await screen.findByRole("button", { name: "新建任务" })).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "1", metaKey: true });
  expect(await screen.findByRole("heading", { name: "全部活跃 Threads" })).toBeInTheDocument();
});

test("ignores non-exact view shortcuts", async () => {
  render(<App />);

  await screen.findByText("修正 Grafana 日志 service 名称");
  fireEvent.keyDown(window, { key: "2", ctrlKey: true });
  fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: true });

  expect(screen.queryByRole("button", { name: "新建任务" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "全部活跃 Threads" })).toBeInTheDocument();
});

test("keeps zen mode while shortcuts switch views", async () => {
  const user = userEvent.setup();
  render(<App />);

  await screen.findByText("修正 Grafana 日志 service 名称");
  await user.click(screen.getByRole("button", { name: "禅模式" }));

  fireEvent.keyDown(window, { key: "2", metaKey: true });
  expect(await screen.findByRole("button", { name: "新建任务" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出禅模式" })).toBeInTheDocument();

  fireEvent.keyDown(window, { key: "1", metaKey: true });
  expect(await screen.findByRole("heading", { name: "全部活跃 Threads" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.queryByText("同步与队列概览")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "退出禅模式" }));
  expect(screen.getByRole("navigation")).toBeInTheDocument();
  expect(screen.getByText("同步与队列概览")).toBeInTheDocument();
});

test("offers zen mode directly in To Do List without board actions", async () => {
  const user = userEvent.setup();
  render(<App />);

  await screen.findByText("修正 Grafana 日志 service 名称");
  fireEvent.keyDown(window, { key: "2", metaKey: true });

  const zenButton = await screen.findByRole("button", { name: "禅模式" });
  expect(screen.queryByRole("button", { name: "同步" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开 Codex" })).not.toBeInTheDocument();

  await user.click(zenButton);
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出禅模式" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行新增用例并确认失败原因正确**

Run:

```bash
cd src-ui
npm test -- --run src/App.test.tsx
```

Expected: FAIL；To Do List 不会响应 `Cmd+2`，并且 To Do List 中找不到“禅模式”或“退出禅模式”按钮。

- [ ] **Step 3: 实现窗口级快捷键监听**

在 `App` 的状态声明之后增加 effect：

```tsx
useEffect(() => {
  const handleViewShortcut = (event: KeyboardEvent) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    const nextView: ViewKey | undefined =
      event.key === "1" ? "active" : event.key === "2" ? "todos" : undefined;
    if (!nextView) return;

    event.preventDefault();
    setView(nextView);
  };

  window.addEventListener("keydown", handleViewShortcut);
  return () => window.removeEventListener("keydown", handleViewShortcut);
}, []);
```

- [ ] **Step 4: 让 To Do List 使用共享禅模式按钮**

将顶栏右侧调整为始终渲染容器与禅模式按钮，只对看板专属内容保留 `view !== "todos"` 条件：

```tsx
<div className="flex items-center gap-2">
  {view !== "todos" && (
    <div className="hidden max-w-[320px] truncate rounded border bg-secondary/55 px-2 py-1 text-[11px] text-muted-foreground md:block">
      {toast}
    </div>
  )}
  <Button
    variant={zenMode ? "secondary" : "outline"}
    size="sm"
    aria-pressed={zenMode}
    onClick={() => setZenMode((current) => !current)}
  >
    <Focus className="h-3.5 w-3.5" />
    {zenMode ? "退出禅模式" : "禅模式"}
  </Button>
  {view !== "todos" && (
    <>
      <Button variant="outline" size="sm" onClick={syncOnce}>
        <RotateCcw className="h-3.5 w-3.5" />
        同步
      </Button>
      <Button size="sm" onClick={() => openProject("agent-kanban")}>
        <ExternalLink className="h-3.5 w-3.5" />
        打开 Codex
      </Button>
    </>
  )}
</div>
```

- [ ] **Step 5: 运行前端定向测试并确认通过**

Run:

```bash
cd src-ui
npm test -- --run src/App.test.tsx
```

Expected: PASS；`App.test.tsx` 中所有用例通过。

- [ ] **Step 6: 更新项目知识**

在 `docs/agent/coding.md` 的 Current Knowledge 中增加：

```markdown
- 应用内全局视图快捷键使用 `Cmd+1` 打开“全部活跃”、`Cmd+2` 打开 To Do List；监听只更新 `view`，必须保留禅模式和导航状态，且 To Do List 顶栏也必须提供禅模式按钮。
```

在 `docs/agent/testing.md` 的 Current Knowledge 中增加：

```markdown
- 修改视图快捷键或禅模式时，需要覆盖输入控件聚焦下的 `Cmd+1`/`Cmd+2`、非目标修饰键、To Do List 禅模式入口、跨视图保持禅模式以及退出后的导航恢复。
```

- [ ] **Step 7: 运行完整验证**

Run:

```bash
cd src-ui
npm test -- --run
npm run build
cd ..
git diff --check
```

Expected: 前端测试全部 PASS；TypeScript/Vite 构建成功；`git diff --check` 无输出且退出码为 0。

- [ ] **Step 8: 提交实现**

```bash
git add src-ui/src/App.tsx src-ui/src/App.test.tsx docs/agent/coding.md docs/agent/testing.md docs/superpowers/plans/2026-07-11-view-shortcuts-zen-mode.md
git commit -m "feat: add view shortcuts with shared zen mode"
```
