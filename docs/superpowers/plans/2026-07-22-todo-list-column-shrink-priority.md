# To Do List 窄屏列宽优先级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 To Do List 在窄屏时为任务和关联 Thread 各优先保留至少 `140px`，先压缩日期与操作列，极窄时再压缩前两列且不产生横向滚动。

**Architecture:** 保持表头和任务行共用 `.todo-grid`，仅通过两阶段 CSS Grid 轨道定义调整收缩优先级。使用读取真实 `index.css` 的 Vitest 回归测试锁定常规和极窄规则，并用浏览器计算样式验证实际列宽与页面溢出。

**Tech Stack:** React 18、TypeScript、Tailwind CSS、原生 CSS Grid、Vitest、Vite 浏览器预览

## Global Constraints

- 任务列和关联 Thread 列在可用空间允许时都至少保留 `140px`。
- 两个日期列先从 `96px` 收缩至 `64px`，操作列先从 `84px` 收缩至 `44px`。
- 视口宽度不超过 `520px` 时，任务列和关联 Thread 列才改为等权继续收缩。
- 保持完整日期值、日期编辑、Thread 标签换行和行操作可用。
- 页面不得因列宽策略产生横向滚动。
- 不修改任务数据、排序、分页、持久化或 Thread 关联逻辑。
- 直接在 `main` 开发，不创建分支，不使用 WorkTree。

---

### Task 1: 锁定并实现普通窄屏收缩优先级

**Files:**
- Create: `src-ui/src/todo/todoGridLayout.test.ts`
- Modify: `src-ui/src/index.css:58-66`

**Interfaces:**
- Consumes: `.todo-grid` 同时应用于 `TodoListView` 的表头与任务行。
- Produces: 常规 `.todo-grid` 五列定义，依次为任务、关联 Thread、预期结束日期、实际结束日期、操作。

- [x] **Step 1: 编写普通窄屏失败测试**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("To Do List 列宽优先级", () => {
  test("普通窄屏为任务和关联 Thread 保留 140px 并优先压缩其他列", () => {
    expect(css).toContain(
      "grid-template-columns: minmax(140px, 1fr) minmax(140px, 180px) minmax(64px, 96px) minmax(64px, 96px) minmax(44px, 84px);"
    );
  });
});
```

- [x] **Step 2: 运行测试并确认因旧列定义失败**

Run: `cd src-ui && npm test -- --run src/todo/todoGridLayout.test.ts`

Expected: FAIL；输出显示期望的新 `grid-template-columns` 不存在，当前 CSS 仍包含 `minmax(0, 1fr) 180px 96px 96px 84px`。

- [x] **Step 3: 写入最小常规网格实现**

```css
.todo-grid {
  grid-template-columns: minmax(140px, 1fr) minmax(140px, 180px) minmax(64px, 96px) minmax(64px, 96px) minmax(44px, 84px);
}
```

删除原有 `900px` 断点中把 Thread 列单独改为固定 `140px` 的重复规则；常规规则本身已覆盖该行为并允许其他三列优先收缩。

- [x] **Step 4: 运行测试并确认通过**

Run: `cd src-ui && npm test -- --run src/todo/todoGridLayout.test.ts`

Expected: PASS，1 个测试通过。

### Task 2: 锁定并实现极窄降级规则

**Files:**
- Modify: `src-ui/src/todo/todoGridLayout.test.ts`
- Modify: `src-ui/src/index.css:58-68`

**Interfaces:**
- Consumes: Task 1 的常规五列定义。
- Produces: `@media (max-width: 520px)` 极窄规则；前两列等权收缩，后三列保持紧凑宽度。

- [x] **Step 1: 编写极窄阶段失败测试**

在同一个 `describe` 中增加：

```ts
test("极窄屏最后才让任务和关联 Thread 等权继续收缩", () => {
  expect(css).toContain("@media (max-width: 520px)");
  expect(css).toContain(
    "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 64px 64px 44px;"
  );
});
```

- [x] **Step 2: 运行测试并确认因极窄规则缺失而失败**

Run: `cd src-ui && npm test -- --run src/todo/todoGridLayout.test.ts`

Expected: FAIL；普通窄屏用例通过，极窄用例显示缺少 `520px` 断点或等权列定义。

- [x] **Step 3: 写入最小极窄规则**

```css
@media (max-width: 520px) {
  .todo-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 64px 64px 44px;
  }
}
```

- [x] **Step 4: 运行定向测试并确认通过**

Run: `cd src-ui && npm test -- --run src/todo/todoGridLayout.test.ts`

Expected: PASS，2 个测试通过。

- [x] **Step 5: 检查改动范围**

Run: `git diff -- src-ui/src/index.css src-ui/src/todo/todoGridLayout.test.ts`

Expected: 只包含 `.todo-grid` 两阶段规则和对应回归测试，不包含 React、数据或关联逻辑改动。

### Task 3: 完整验证与视觉验收

**Files:**
- Verify: `src-ui/src/index.css`
- Verify: `src-ui/src/todo/todoGridLayout.test.ts`

**Interfaces:**
- Consumes: Task 1–2 的 CSS 与回归测试。
- Produces: 自动化测试、构建和实际浏览器计算样式证据。

- [x] **Step 1: 运行完整前端测试**

Run: `cd src-ui && npm test -- --run`

Expected: PASS，所有测试文件和用例通过，无失败用例。

- [x] **Step 2: 运行生产构建**

Run: `cd src-ui && npm run build`

Expected: PASS，TypeScript 检查与 Vite 构建均以退出码 `0` 完成。

- [x] **Step 3: 启动普通浏览器预览**

Run: `cd src-ui && npm run dev -- --host 127.0.0.1`

Expected: Vite 输出可访问的本地地址；浏览器 demo 不调用 Tauri bridge。

- [x] **Step 4: 验证约 650px 内容宽度**

在 `700 × 768` 左右视口打开 To Do List，通过浏览器计算 `.todo-grid` 的 `grid-template-columns` 和每列边界：

- 任务列宽度不小于 `140px`。
- 关联 Thread 列宽度不小于 `140px`。
- 两个日期列和操作列小于各自宽屏最大值。
- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`。
- Thread 标签允许换行，日期值与行操作仍可见。

- [x] **Step 5: 验证极窄视口**

在 `480 × 768` 视口重复检查：

- 任务列和关联 Thread 列宽度相等且均低于 `140px`。
- 两个日期列为 `64px`，操作列为 `44px`。
- `document.documentElement.scrollWidth <= document.documentElement.clientWidth`。
- 浏览器控制台错误为 `0`。

- [x] **Step 6: 运行差异检查**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 退出码为 `0`；状态仅包含本计划列出的实现文件和计划进度更新。

- [ ] **Step 7: 提交实现**

```bash
git add src-ui/src/index.css src-ui/src/todo/todoGridLayout.test.ts docs/superpowers/plans/2026-07-22-todo-list-column-shrink-priority.md
git commit -m "fix: 调整 todo 窄屏列宽优先级"
```

## 执行结果

- RED：普通窄屏和极窄屏用例分别在对应规则缺失时按预期失败；测试路径错误先修正后重新取得有效 RED。
- GREEN：定向测试 2 个用例通过；完整前端测试 13 个测试文件、89 个用例全部通过。
- 构建：TypeScript 检查和 Vite 生产构建成功。
- 浏览器验收：`700 × 768` 视口下五列计算宽度为 `140 / 140 / 64 / 64 / 44px`；`480 × 768` 极窄视口下为 `20 / 20 / 64 / 64 / 44px`。
- 溢出与日志：两档视口均满足 `scrollWidth === clientWidth`，浏览器控制台错误为 `0`。
