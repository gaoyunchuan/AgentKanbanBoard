# To Do List 窄屏完整隐藏尾部列实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 To Do List 窄屏仍残留日期和操作列的问题，在列表容器变窄时完整隐藏尾部三列，最后才压缩任务与关联 Thread。

**Architecture:** 列表卡片成为 CSS inline-size 容器，表头与任务行继续共用 `.todo-grid`。`@container` 在 `520px` 隐藏第 3～5 个直接子元素并切为两列，在 `320px` 才允许前两列低于 `140px`；不引入 JavaScript 宽度状态。

**Tech Stack:** React 18、TypeScript、原生 CSS Container Queries、Vitest、Testing Library、Vite 浏览器预览

## Global Constraints

- 列表容器不超过 `520px` 时，预期结束日期、实际结束日期和操作三列必须从表头及每个任务行完整隐藏。
- 隐藏必须表现为第 3～5 个直接子元素 `display: none`，不能保留窄轨道或竖排残片。
- 尾部列隐藏后，任务与关联 Thread 在空间允许时均至少保留 `140px`。
- 列表容器不超过 `320px` 时，任务与关联 Thread 才等权继续收缩。
- 页面不得产生横向滚动，表头和任务行必须对齐。
- 不修改任务数据、排序、分页、日期值、持久化或 Thread 关联逻辑。
- 直接在 `main` 开发，不创建分支，不使用 WorkTree。

---

### Task 1: 用失败测试替换错误的极窄规则契约

**Files:**
- Modify: `src-ui/src/todo/todoGridLayout.test.ts`
- Modify: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Consumes: `.todo-grid` 表头与任务行均具有五个顺序一致的直接子元素。
- Produces: `.todo-list-container` 容器契约，以及 `520px` 隐藏尾部列、`320px` 压缩前两列的 CSS 契约。

- [x] **Step 1: 改写 CSS 回归测试**

保留宽屏五列用例，把旧的 `@media` 极窄用例替换为：

```ts
test("窄容器完整隐藏尾部三列并保留任务与 Thread", () => {
  expect(css).toContain("container-type: inline-size;");
  expect(css).toContain("@container (max-width: 520px)");
  expect(css).toContain(
    "grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr);"
  );
  expect(css).toContain(".todo-grid > :nth-child(n + 3)");
  expect(css).toContain("display: none;");
});

test("极窄容器最后才让任务与 Thread 等权收缩", () => {
  expect(css).toContain("@container (max-width: 320px)");
  expect(css).toContain(
    "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);"
  );
});
```

- [x] **Step 2: 增加列表容器契约测试**

在 `TodoListView.test.tsx` 增加：

```tsx
test("列表卡片提供独立的响应式宽度容器", () => {
  render(<TodoListView initialTasks={initialTasks} persistTasks={vi.fn()} />);

  expect(screen.getByText("关联 Thread").closest(".todo-list-container")).not.toBeNull();
});
```

- [x] **Step 3: 运行定向测试并确认 RED**

Run: `cd src-ui && npm test -- --run src/todo/todoGridLayout.test.ts src/todo/TodoListView.test.tsx`

Expected: FAIL；CSS 测试报告缺少容器查询和 `display: none`，组件测试报告找不到 `.todo-list-container`。

### Task 2: 实现两阶段容器查询

**Files:**
- Modify: `src-ui/src/todo/TodoListView.tsx:378`
- Modify: `src-ui/src/index.css:58-68`

**Interfaces:**
- Consumes: Task 1 定义的 `.todo-list-container` 和 `.todo-grid` 契约。
- Produces: 运行时可由 CSS 容器宽度驱动的五列、两列和极窄两列布局。

- [x] **Step 1: 给列表卡片增加容器类**

```tsx
<div className="todo-list-container flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-card shadow-sm">
```

- [x] **Step 2: 写入最小 CSS 容器查询**

```css
.todo-list-container {
  container-type: inline-size;
}

.todo-grid {
  grid-template-columns: minmax(140px, 1fr) minmax(140px, 180px) minmax(64px, 96px) minmax(64px, 96px) minmax(44px, 84px);
}

@container (max-width: 520px) {
  .todo-grid {
    grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr);
  }

  .todo-grid > :nth-child(n + 3) {
    display: none;
  }
}

@container (max-width: 320px) {
  .todo-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
```

删除旧的 `@media (max-width: 520px)` 五列规则。

- [x] **Step 3: 运行定向测试并确认 GREEN**

Run: `cd src-ui && npm test -- --run src/todo/todoGridLayout.test.ts src/todo/TodoListView.test.tsx`

Expected: PASS；两个测试文件全部用例通过。

- [x] **Step 4: 检查实现差异**

Run: `git diff -- src-ui/src/index.css src-ui/src/todo/TodoListView.tsx src-ui/src/todo/todoGridLayout.test.ts src-ui/src/todo/TodoListView.test.tsx`

Expected: 仅包含容器类、两阶段 CSS 和对应回归测试。

### Task 3: 真实浏览器验证计算样式

**Files:**
- Verify: `src-ui/src/index.css`
- Verify: `src-ui/src/todo/TodoListView.tsx`

**Interfaces:**
- Consumes: Task 2 的 CSS 容器查询。
- Produces: 表头与任务行计算样式、列宽、页面溢出和控制台日志证据。

- [x] **Step 1: 启动普通 Vite 浏览器预览**

Run: `cd src-ui && npm run dev -- --host 127.0.0.1 --port 5173`

Expected: 本地 demo 可访问，且不调用 Tauri bridge。

- [x] **Step 2: 进入 To Do List 并开启禅模式**

在正常宽度进入 To Do List，点击“禅模式”隐藏导航，确保列表宽度只受视口和自身内边距影响。

- [x] **Step 3: 验证截图相近窄屏**

把视口设为约 `400 × 768`，读取 `.todo-list-container`、首个 `.todo-grid` 表头和首个 `[data-task-row]`：

- 容器宽度在 `320px` 与 `520px` 之间。
- 表头和首行第 3～5 个直接子元素的 `display` 全部为 `none`。
- 两个可见列宽均不小于 `140px`。
- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`。

- [x] **Step 4: 验证极窄屏**

把视口设为约 `300 × 768`：

- 容器宽度不超过 `320px`。
- 第 3～5 列仍全部为 `display: none`。
- 前两列计算宽度相等且低于 `140px`。
- 页面无横向滚动，浏览器控制台错误为 `0`。

- [x] **Step 5: 恢复浏览器视口并停止预览服务**

重置临时视口，关闭测试页，停止 Vite 服务。

### Task 4: 同步项目知识并完成验证

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`
- Modify: `docs/superpowers/plans/2026-07-22-todo-list-hide-trailing-columns.md`

**Interfaces:**
- Consumes: Task 2–3 已验证的最终行为。
- Produces: 取代旧压缩规则的编码约束、测试约束和执行证据。

- [x] **Step 1: 修正项目知识**

把旧的“日期列压缩至 `64px`、操作列压缩至 `44px`”改为：

```markdown
- To Do List 五列布局以列表容器宽度响应：不超过 `520px` 时完整隐藏两个日期列和操作列，任务与关联 Thread 各保留至少 `140px`；不超过 `320px` 时前两列才等权继续收缩。隐藏列不得残留网格轨道或产生横向滚动。
```

测试知识同步要求检查表头和任务行第 3～5 列计算样式均为 `display: none`，并增加 2026-07-22 修正记录。

- [x] **Step 2: 运行完整前端测试**

Run: `cd src-ui && npm test -- --run`

Expected: PASS；所有测试文件和测试用例通过。

- [x] **Step 3: 运行生产构建**

Run: `cd src-ui && npm run build`

Expected: PASS；TypeScript 检查和 Vite 构建退出码为 `0`。

- [x] **Step 4: 检查差异范围和格式**

Run: `git diff --check && git status --short && git diff --stat HEAD`

Expected: `git diff --check` 无输出；仅包含本计划列出的实现、测试、知识和计划文件。

- [ ] **Step 5: 提交修复**

```bash
git add src-ui/src/index.css src-ui/src/todo/TodoListView.tsx src-ui/src/todo/todoGridLayout.test.ts src-ui/src/todo/TodoListView.test.tsx docs/agent/coding.md docs/agent/testing.md docs/superpowers/plans/2026-07-22-todo-list-hide-trailing-columns.md
git commit -m "fix: 窄屏隐藏 todo 尾部列"
```

## 执行证据

- 定向测试：`2` 个测试文件、`25` 个用例通过。
- `400 × 768` 浏览器验收：列表容器宽 `376px`，任务与关联 Thread 均为 `175px`，后三列计算样式均为 `display: none`、宽度均为 `0`，页面宽度 `400/400px` 无横向溢出。
- `300 × 768` 浏览器验收：列表容器宽 `276px`，任务与关联 Thread 均为 `125px`，后三列仍为 `display: none`、宽度均为 `0`，页面宽度 `300/300px` 无横向溢出。
- 两档浏览器控制台错误均为 `0`，临时视口已恢复，Vite 预览服务已停止。
- 完整前端测试：`13` 个测试文件、`91` 个用例通过。
- 生产构建：TypeScript 检查通过，Vite 成功构建 `1680` 个模块。
- 差异审计：`git diff --check` 无输出，变更仅涉及计划列出的 `7` 个文件。
