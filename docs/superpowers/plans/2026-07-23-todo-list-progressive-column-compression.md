# To Do List 动态列宽分阶段压缩实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 To Do List 先动态冻结任务与关联 Thread 的实际宽度，依次压缩并隐藏三个尾列，再按 Thread 到 `180px`、任务到 `240px`、最终 `4:3` 的顺序压缩前两列。

**Architecture:** 新增不依赖 DOM 的列宽纯函数，使用一个专用 hook 通过 `ResizeObserver` 保存自然布局基线并把计算结果写入容器 CSS 自定义属性。表头与任务行继续共用 `.todo-grid`，隐藏状态统一由容器 `data-*` 属性控制；删除旧的固定 `520px/320px` 容器查询。

**Tech Stack:** React 18、TypeScript、原生 ResizeObserver、CSS 自定义属性、Vitest、Testing Library、Vite 浏览器预览

## Global Constraints

- 任务和关联 Thread 的初始宽度必须来自压缩开始前的浏览器计算结果，禁止硬编码为固定初始宽度。
- 三个尾列按操作、实际结束日期、预期结束日期的顺序压缩并完整隐藏。
- 三个尾列全部隐藏前，任务和关联 Thread 必须保持捕获宽度。
- 尾列全部隐藏后，关联 Thread 先单独压缩到 `min(捕获宽度, 180px)`，任务再单独压缩到 `min(捕获宽度, 240px)`。
- 后续按阶段终点宽度比例同步缩小；常规宽屏下比例为 `240:180`，即 `4:3`。
- 尾列隐藏时计算宽度必须为 `0` 且直接子元素必须为 `display: none`，不能残留窄轨道。
- 表头和任务行必须对齐，页面不得产生横向滚动。
- 不修改任务数据、树结构、排序、分页、日期值、持久化或 Thread 关联逻辑。
- 直接在 `main` 开发，不创建 branch 或 WorkTree。

---

### Task 1: 用纯函数锁定完整压缩状态机

**Files:**
- Create: `src-ui/src/todo/todoGridLayout.ts`
- Create: `src-ui/src/todo/todoGridLayoutModel.test.ts`

**Interfaces:**
- Produces: `TodoGridWidths`、`TodoGridLayout` 和 `resolveTodoGridLayout(baseline, availableWidth)`。
- Consumes: 无 DOM 或 React 依赖。

- [x] **Step 1: 编写尾列优先级失败测试**

创建 `todoGridLayoutModel.test.ts`：

```ts
import { describe, expect, test } from "vitest";
import { resolveTodoGridLayout, type TodoGridWidths } from "./todoGridLayout";

const baseline: TodoGridWidths = {
  task: 400,
  thread: 220,
  expected: 96,
  actual: 96,
  actions: 84
};

describe("resolveTodoGridLayout", () => {
  test("先压缩操作列且冻结前两列", () => {
    expect(resolveTodoGridLayout(baseline, 876)).toEqual({
      widths: { ...baseline, actions: 64 },
      hidden: { expected: false, actual: false, actions: false }
    });
  });

  test("操作列低于安全宽度前完整隐藏且不压缩下一列", () => {
    expect(resolveTodoGridLayout(baseline, 855)).toEqual({
      widths: { ...baseline, actions: 0 },
      hidden: { expected: false, actual: false, actions: true }
    });
  });

  test("按操作、实际、预期的顺序压缩并隐藏", () => {
    expect(resolveTodoGridLayout(baseline, 796).hidden).toEqual({
      expected: false,
      actual: false,
      actions: true
    });
    expect(resolveTodoGridLayout(baseline, 759).hidden).toEqual({
      expected: false,
      actual: true,
      actions: true
    });
    expect(resolveTodoGridLayout(baseline, 663).hidden).toEqual({
      expected: true,
      actual: true,
      actions: true
    });
  });
});
```

- [x] **Step 2: 运行测试并确认 RED**

Run:

```bash
cd src-ui
npm test -- --run src/todo/todoGridLayoutModel.test.ts
```

Expected: FAIL；报告找不到 `./todoGridLayout`。

- [x] **Step 3: 编写前两列阶段失败测试**

继续加入：

```ts
test("尾列全部隐藏后先单独压缩 Thread 到 180", () => {
  expect(resolveTodoGridLayout(baseline, 600).widths).toEqual({
    task: 400,
    thread: 200,
    expected: 0,
    actual: 0,
    actions: 0
  });
  expect(resolveTodoGridLayout(baseline, 580).widths).toEqual({
    task: 400,
    thread: 180,
    expected: 0,
    actual: 0,
    actions: 0
  });
});

test("Thread 到 180 后再单独压缩任务到 240", () => {
  expect(resolveTodoGridLayout(baseline, 540).widths).toEqual({
    task: 360,
    thread: 180,
    expected: 0,
    actual: 0,
    actions: 0
  });
  expect(resolveTodoGridLayout(baseline, 420).widths).toEqual({
    task: 240,
    thread: 180,
    expected: 0,
    actual: 0,
    actions: 0
  });
});

test("达到 240 和 180 后按 4 比 3 同步缩小", () => {
  expect(resolveTodoGridLayout(baseline, 378).widths).toEqual({
    task: 216,
    thread: 162,
    expected: 0,
    actual: 0,
    actions: 0
  });
});

test("捕获宽度低于阈值时不反向放大", () => {
  const narrowBaseline = { ...baseline, task: 200, thread: 160 };
  expect(resolveTodoGridLayout(narrowBaseline, 180).widths).toEqual({
    task: 100,
    thread: 80,
    expected: 0,
    actual: 0,
    actions: 0
  });
});

test("极小宽度保持非负且不超过可用宽度", () => {
  const layout = resolveTodoGridLayout(baseline, 1);
  expect(layout.widths.task).toBeGreaterThanOrEqual(0);
  expect(layout.widths.thread).toBeGreaterThanOrEqual(0);
  expect(layout.widths.task + layout.widths.thread).toBeCloseTo(1);
});
```

- [x] **Step 4: 实现最小纯函数**

创建 `todoGridLayout.ts`：

```ts
export type TodoGridWidths = {
  task: number;
  thread: number;
  expected: number;
  actual: number;
  actions: number;
};

export type TodoGridLayout = {
  widths: TodoGridWidths;
  hidden: {
    expected: boolean;
    actual: boolean;
    actions: boolean;
  };
};

const EXPECTED_MIN_WIDTH = 64;
const ACTUAL_MIN_WIDTH = 64;
const ACTIONS_MIN_WIDTH = 44;
const THREAD_TARGET_WIDTH = 180;
const TASK_TARGET_WIDTH = 240;

type TailResult = {
  width: number;
  hidden: boolean;
  remainingDeficit: number;
};

function resolveTailColumn(
  baselineWidth: number,
  minimumWidth: number,
  deficit: number
): TailResult {
  if (deficit <= 0) {
    return { width: baselineWidth, hidden: false, remainingDeficit: 0 };
  }

  const safeMinimum = Math.min(baselineWidth, minimumWidth);
  const shrinkCapacity = baselineWidth - safeMinimum;
  if (deficit <= shrinkCapacity) {
    return {
      width: baselineWidth - deficit,
      hidden: false,
      remainingDeficit: 0
    };
  }

  if (deficit <= baselineWidth) {
    return { width: 0, hidden: true, remainingDeficit: 0 };
  }

  return {
    width: 0,
    hidden: true,
    remainingDeficit: deficit - baselineWidth
  };
}

export function resolveTodoGridLayout(
  baseline: TodoGridWidths,
  availableWidth: number
): TodoGridLayout {
  const totalWidth = Object.values(baseline).reduce((sum, width) => sum + width, 0);
  let remainingDeficit = Math.max(0, totalWidth - Math.max(0, availableWidth));

  const actions = resolveTailColumn(
    baseline.actions,
    ACTIONS_MIN_WIDTH,
    remainingDeficit
  );
  remainingDeficit = actions.remainingDeficit;

  const actual = resolveTailColumn(
    baseline.actual,
    ACTUAL_MIN_WIDTH,
    remainingDeficit
  );
  remainingDeficit = actual.remainingDeficit;

  const expected = resolveTailColumn(
    baseline.expected,
    EXPECTED_MIN_WIDTH,
    remainingDeficit
  );
  remainingDeficit = expected.remainingDeficit;

  const threadTarget = Math.min(baseline.thread, THREAD_TARGET_WIDTH);
  const threadShrink = Math.min(
    remainingDeficit,
    baseline.thread - threadTarget
  );
  const thread = baseline.thread - threadShrink;
  remainingDeficit -= threadShrink;

  const taskTarget = Math.min(baseline.task, TASK_TARGET_WIDTH);
  const taskShrink = Math.min(
    remainingDeficit,
    baseline.task - taskTarget
  );
  const task = baseline.task - taskShrink;
  remainingDeficit -= taskShrink;

  const targetTotal = task + thread;
  const proportionalTotal = Math.max(0, targetTotal - remainingDeficit);
  const scale = targetTotal === 0 ? 0 : proportionalTotal / targetTotal;

  return {
    widths: {
      task: task * scale,
      thread: thread * scale,
      expected: expected.width,
      actual: actual.width,
      actions: actions.width
    },
    hidden: {
      expected: expected.hidden,
      actual: actual.hidden,
      actions: actions.hidden
    }
  };
}
```

- [x] **Step 5: 运行纯函数测试并确认 GREEN**

Run:

```bash
cd src-ui
npm test -- --run src/todo/todoGridLayoutModel.test.ts
```

Expected: PASS；所有尾列、Thread、任务和比例边界用例通过。

- [x] **Step 6: 提交纯函数**

```bash
git add src-ui/src/todo/todoGridLayout.ts src-ui/src/todo/todoGridLayoutModel.test.ts
git commit -m "feat: 定义 todo 列宽分阶段压缩模型"
```

### Task 2: 用 ResizeObserver 保存动态基线并驱动 CSS 状态

**Files:**
- Create: `src-ui/src/todo/useTodoGridLayout.ts`
- Create: `src-ui/src/todo/useTodoGridLayout.test.tsx`

**Interfaces:**
- Consumes: `resolveTodoGridLayout` 和 `TodoGridWidths`。
- Produces: `useTodoGridLayout(containerRef)`；在容器写入五个 `--todo-*-column-width` 属性以及 `data-todo-*-hidden` 状态。

- [x] **Step 1: 编写观察器失败测试**

创建 `useTodoGridLayout.test.tsx`：

```tsx
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTodoGridLayout } from "./useTodoGridLayout";

const baselineWidths = [400, 220, 96, 96, 84];
let availableWidth = 896;
let resizeCallback: ResizeObserverCallback;
let activeObserver: ResizeObserverTestDouble;
const disconnect = vi.fn();

class ResizeObserverTestDouble {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
    activeObserver = this;
  }

  observe() {}
  unobserve() {}
  disconnect() {
    disconnect();
  }
}

function Harness() {
  const containerRef = useRef<HTMLDivElement>(null);
  useTodoGridLayout(containerRef);
  return (
    <div ref={containerRef} data-testid="container">
      <div data-todo-grid-header data-testid="header">
        {baselineWidths.map((_, index) => <div key={index} />)}
      </div>
    </div>
  );
}

function prepareLayout() {
  const view = render(<Harness />);
  const header = view.getByTestId("header");
  Object.defineProperty(header, "clientWidth", {
    configurable: true,
    get: () => availableWidth
  });
  Array.from(header.children).forEach((element, index) => {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      width: baselineWidths[index],
      height: 0,
      x: 0,
      y: 0,
      top: 0,
      right: baselineWidths[index],
      bottom: 0,
      left: 0,
      toJSON: () => ({})
    });
  });
  triggerResize();
  return {
    ...view,
    container: view.getByTestId("container")
  };
}

function triggerResize() {
  resizeCallback([], activeObserver as unknown as ResizeObserver);
}

function setAvailableWidth(width: number) {
  availableWidth = width;
}

function columnVariables(container: HTMLElement) {
  const read = (property: string) =>
    Number.parseFloat(container.style.getPropertyValue(property));
  return {
    task: read("--todo-task-column-width"),
    thread: read("--todo-thread-column-width")
  };
}

describe("useTodoGridLayout", () => {
  beforeEach(() => {
    availableWidth = 896;
    disconnect.mockClear();
    vi.stubGlobal("ResizeObserver", ResizeObserverTestDouble);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("冻结动态前两列并按顺序隐藏尾列", () => {
    const { container } = prepareLayout();

    setAvailableWidth(796);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 220 });
    expect(container).toHaveAttribute("data-todo-actions-hidden");
    expect(container).not.toHaveAttribute("data-todo-actual-hidden");

    setAvailableWidth(759);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 220 });
    expect(container).toHaveAttribute("data-todo-actual-hidden");
    expect(container).not.toHaveAttribute("data-todo-expected-hidden");

    setAvailableWidth(663);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 220 });
    expect(container).toHaveAttribute("data-todo-expected-hidden");
  });

  test("尾列隐藏后依次执行 Thread、任务和比例阶段", () => {
    const { container } = prepareLayout();

    setAvailableWidth(600);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 200 });

    setAvailableWidth(580);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 180 });

    setAvailableWidth(540);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 360, thread: 180 });

    setAvailableWidth(378);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 216, thread: 162 });
  });

  test("恢复到基线宽度时清除临时布局并在卸载时断开观察", () => {
    const view = prepareLayout();
    setAvailableWidth(600);
    triggerResize();

    setAvailableWidth(896);
    triggerResize();
    expect(
      view.container.style.getPropertyValue("--todo-task-column-width")
    ).toBe("");

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
```

- [x] **Step 2: 运行 hook 测试并确认 RED**

Run:

```bash
cd src-ui
npm test -- --run src/todo/useTodoGridLayout.test.tsx
```

Expected: FAIL；报告找不到 `useTodoGridLayout`。

- [x] **Step 3: 实现布局 hook**

创建 `useTodoGridLayout.ts`，包含以下结构：

```ts
import { useLayoutEffect } from "react";
import type { RefObject } from "react";
import {
  resolveTodoGridLayout,
  type TodoGridLayout,
  type TodoGridWidths
} from "./todoGridLayout";

const widthProperties = {
  task: "--todo-task-column-width",
  thread: "--todo-thread-column-width",
  expected: "--todo-expected-column-width",
  actual: "--todo-actual-column-width",
  actions: "--todo-actions-column-width"
} satisfies Record<keyof TodoGridWidths, string>;

function contentWidth(element: HTMLElement) {
  const style = getComputedStyle(element);
  return Math.max(
    0,
    element.clientWidth -
      Number.parseFloat(style.paddingLeft || "0") -
      Number.parseFloat(style.paddingRight || "0")
  );
}

function readWidths(header: HTMLElement): TodoGridWidths | undefined {
  const children = Array.from(header.children).slice(0, 5);
  if (children.length !== 5) return undefined;
  const [task, thread, expected, actual, actions] = children.map(
    (element) => element.getBoundingClientRect().width
  );
  if ([task, thread, expected, actual, actions].some((width) => width <= 0)) {
    return undefined;
  }
  return { task, thread, expected, actual, actions };
}

function applyLayout(container: HTMLElement, layout: TodoGridLayout) {
  for (const [column, property] of Object.entries(widthProperties)) {
    container.style.setProperty(
      property,
      `${layout.widths[column as keyof TodoGridWidths]}px`
    );
  }
  container.toggleAttribute("data-todo-expected-hidden", layout.hidden.expected);
  container.toggleAttribute("data-todo-actual-hidden", layout.hidden.actual);
  container.toggleAttribute("data-todo-actions-hidden", layout.hidden.actions);
}

function clearLayout(container: HTMLElement) {
  for (const property of Object.values(widthProperties)) {
    container.style.removeProperty(property);
  }
  container.removeAttribute("data-todo-expected-hidden");
  container.removeAttribute("data-todo-actual-hidden");
  container.removeAttribute("data-todo-actions-hidden");
}

export function useTodoGridLayout(
  containerRef: RefObject<HTMLDivElement>
) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const header = container.querySelector<HTMLElement>("[data-todo-grid-header]");
    if (!header) return;

    let baseline: TodoGridWidths | undefined;

    const update = () => {
      const availableWidth = contentWidth(header);
      if (availableWidth <= 0) return;

      if (!baseline) {
        baseline = readWidths(header);
        if (!baseline) return;
      }

      const baselineTotal = Object.values(baseline).reduce(
        (sum, width) => sum + width,
        0
      );
      if (availableWidth >= baselineTotal) {
        clearLayout(container);
        baseline = readWidths(header) ?? baseline;
        return;
      }

      applyLayout(
        container,
        resolveTodoGridLayout(baseline, availableWidth)
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);
}
```

实现时保留中文注释解释“隐藏后空白不能回填到前两列”和“恢复到基线后重新进入自然布局”两个非直观约束。

- [x] **Step 4: 运行 hook 与模型测试并确认 GREEN**

Run:

```bash
cd src-ui
npm test -- --run src/todo/todoGridLayoutModel.test.ts src/todo/useTodoGridLayout.test.tsx
```

Expected: PASS。

- [x] **Step 5: 提交观察器适配层**

```bash
git add src-ui/src/todo/useTodoGridLayout.ts src-ui/src/todo/useTodoGridLayout.test.tsx
git commit -m "feat: 动态捕获 todo 列宽压缩基线"
```

### Task 3: 接入 TodoListView 并删除错误静态断点

**Files:**
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Modify: `src-ui/src/todo/TodoListView.test.tsx`
- Modify: `src-ui/src/index.css`
- Modify: `src-ui/src/todo/todoGridLayout.test.ts`

**Interfaces:**
- Consumes: `useTodoGridLayout(containerRef)` 和 hook 写入的 CSS 自定义属性、`data-*` 状态。
- Produces: 表头与所有任务行共享的运行时五列布局。

- [ ] **Step 1: 改写 CSS 契约失败测试**

把旧 `520px/320px` 用例替换为：

```ts
test("运行时宽度变量统一驱动五列", () => {
  expect(css).toContain(
    "var(--todo-task-column-width, minmax(140px, 1fr))"
  );
  expect(css).toContain(
    "var(--todo-thread-column-width, minmax(140px, 180px))"
  );
  expect(css).toContain("var(--todo-expected-column-width, minmax(64px, 96px))");
  expect(css).toContain("var(--todo-actual-column-width, minmax(64px, 96px))");
  expect(css).toContain("var(--todo-actions-column-width, minmax(44px, 84px))");
});

test("三个尾列分别完整隐藏", () => {
  expect(css).toContain("[data-todo-actions-hidden]");
  expect(css).toContain("[data-todo-actual-hidden]");
  expect(css).toContain("[data-todo-expected-hidden]");
  expect(css).toContain("display: none;");
});

test("不再使用固定容器断点压缩前两列", () => {
  expect(css).not.toContain("@container (max-width: 520px)");
  expect(css).not.toContain("@container (max-width: 320px)");
});
```

在 `TodoListView.test.tsx` 的容器契约用例中增加：

```tsx
expect(screen.getByText("任务").closest("[data-todo-grid-header]")).not.toBeNull();
```

- [ ] **Step 2: 运行接线测试并确认 RED**

Run:

```bash
cd src-ui
npm test -- --run src/todo/todoGridLayout.test.ts src/todo/TodoListView.test.tsx
```

Expected: FAIL；CSS 仍包含旧容器查询，表头缺少 `data-todo-grid-header`。

- [ ] **Step 3: 在组件安装 hook**

在 `TodoListView.tsx`：

```tsx
import { useTodoGridLayout } from "./useTodoGridLayout";

// TodoListView 顶层 hooks 区域
const listContainerRef = useRef<HTMLDivElement>(null);
useTodoGridLayout(listContainerRef);

// 列表容器
<div
  ref={listContainerRef}
  className="todo-list-container ..."
>

// 表头
<div
  data-todo-grid-header
  className="todo-grid grid ..."
>
```

- [ ] **Step 4: 用 CSS 变量和独立隐藏状态替换固定断点**

把 `.todo-grid` 改为：

```css
.todo-grid {
  grid-template-columns:
    var(--todo-task-column-width, minmax(140px, 1fr))
    var(--todo-thread-column-width, minmax(140px, 180px))
    var(--todo-expected-column-width, minmax(64px, 96px))
    var(--todo-actual-column-width, minmax(64px, 96px))
    var(--todo-actions-column-width, minmax(44px, 84px));
}

.todo-list-container[data-todo-expected-hidden] .todo-grid > :nth-child(3),
.todo-list-container[data-todo-actual-hidden] .todo-grid > :nth-child(4),
.todo-list-container[data-todo-actions-hidden] .todo-grid > :nth-child(5) {
  display: none;
}
```

删除两个旧 `@container` 块。保留 `.todo-list-container { container-type: inline-size; }`，使容器继续明确建立独立 inline-size 布局边界。

- [ ] **Step 5: 运行 Todo 定向测试并确认 GREEN**

Run:

```bash
cd src-ui
npm test -- --run \
  src/todo/todoGridLayoutModel.test.ts \
  src/todo/useTodoGridLayout.test.tsx \
  src/todo/todoGridLayout.test.ts \
  src/todo/TodoListView.test.tsx
```

Expected: PASS。

- [ ] **Step 6: 提交组件与样式接线**

```bash
git add \
  src-ui/src/todo/TodoListView.tsx \
  src-ui/src/todo/TodoListView.test.tsx \
  src-ui/src/index.css \
  src-ui/src/todo/todoGridLayout.test.ts
git commit -m "fix: 按优先级压缩 todo 列"
```

### Task 4: 连续缩放验收、知识同步与最终审计

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`
- Modify: `docs/superpowers/plans/2026-07-23-todo-list-progressive-column-compression.md`

**Interfaces:**
- Consumes: Task 1–3 的最终运行时行为。
- Produces: 真实浏览器计算样式证据、完整测试/构建结果和最新项目约束。

- [ ] **Step 1: 启动普通 Vite 预览并进入 To Do List 禅模式**

Run:

```bash
cd src-ui
npm run dev -- --host 127.0.0.1 --port 5173
```

在浏览器进入 To Do List 并开启禅模式。先在 `1000 × 768` 读取表头五列作为动态基线，不把期望值写死到实现中。

- [ ] **Step 2: 连续缩小视口并记录每个阶段**

依次设置视口宽度 `1000、900、850、800、760、700、470、428`，每次读取：

- `.todo-list-container` 宽度。
- 表头与首个 `[data-task-row]` 五个直接子元素的计算宽度和 `display`。
- 五个 CSS 自定义属性。
- 三个 `data-todo-*-hidden` 状态。
- `document.documentElement.scrollWidth/clientWidth`。

Expected：

- `900px`：任务和 Thread 等于 `1000px` 捕获值，操作列已隐藏或处于最先压缩阶段，其他尾列尚未越级。
- `850px`：任务和 Thread 仍等于捕获值，操作在实际之前隐藏。
- `800px`：实际在预期之前隐藏或完成压缩，任务和 Thread 仍冻结。
- `760px` 附近：三个尾列全部隐藏且宽度均为 `0`，前两列仍为捕获值。
- `700px`：由于当前自然 Thread 基线通常已经是 `180px`，Thread 保持 `180px`，任务开始单独压缩。
- `470px` 附近：任务为 `240px`、Thread 为 `180px`。
- `428px` 附近：任务约 `216px`、Thread 约 `162px`，比例为 `4:3`。
- 所有档位表头与首行对齐且无横向溢出。
- 浏览器控制台错误为 `0`。

具体临界点允许受边框和内边距影响，以捕获基线和纯函数计算结果为权威；不得用固定断点反推验收结果。

- [ ] **Step 3: 恢复视口并停止预览**

按相反方向恢复视口，确认列按反向顺序恢复；重置临时视口，完成浏览器标签清理并停止 Vite 服务。

- [ ] **Step 4: 修正项目知识**

把 `docs/agent/coding.md` 的旧 `520px/320px` 规则替换为：

```markdown
- To Do List 五列布局使用运行时计算宽度：压缩开始时冻结任务和关联 Thread 的实际宽度，按操作、实际结束日期、预期结束日期的顺序压缩并完整隐藏尾列；尾列全部隐藏后，关联 Thread 先压缩至 `180px`，任务再压缩至 `240px`，随后两列按 `4:3` 同步缩小。隐藏列不得残留网格轨道或产生横向滚动。
```

把 `docs/agent/testing.md` 的静态断点验收改为连续缩放验收，并增加 2026-07-23 Update Note。

- [ ] **Step 5: 运行完整验证**

Run:

```bash
cd src-ui
npm test -- --run
npm run build
cd ..
git diff --check
git status --short
git diff --stat HEAD
```

Expected：

- 所有 Vitest 测试通过。
- TypeScript 检查和 Vite 生产构建通过。
- `git diff --check` 无输出。
- 变更仅包含本计划列出的实现、测试、知识和计划文件。

- [ ] **Step 6: 记录执行证据并提交**

在本计划末尾追加真实浏览器测量值、测试数量、构建结果和差异审计结果，然后：

```bash
git add \
  docs/agent/coding.md \
  docs/agent/testing.md \
  docs/superpowers/plans/2026-07-23-todo-list-progressive-column-compression.md
git commit -m "docs: 记录 todo 分阶段列宽验收"
```

- [ ] **Step 7: 提交后复验**

重新运行：

```bash
cd src-ui
npm test -- --run
npm run build
cd ..
git diff --check
git status --short
git log -4 --oneline
```

Expected：测试和构建继续通过，工作区干净，最近提交覆盖模型、观察器、组件样式和验收文档。
