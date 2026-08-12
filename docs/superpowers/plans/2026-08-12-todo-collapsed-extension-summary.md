# To Do 折叠态扩展信息摘要实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在收起的 To Do 任务标题下，以单行、省略号截断的摘要展示全部非空“过程跟踪”和“结果复盘”记录。

**Architecture:** 新建独立的 `TodoCollapsedExtensionSummary` 展示组件，从当前 `TodoTask` 状态派生摘要分组，不保存副本。扩展现有 `MarkdownText` 的样式接口，使摘要能够复用安全 HTTP(S) 命名链接解析，同时强制单行；`TodoListView` 只负责在第一列标题容器中按展开状态挂载该组件。

**Tech Stack:** React 18、TypeScript、Tailwind CSS、Vitest、Testing Library、Vite、Tauri 2。

## Global Constraints

- 直接在 `main` 开发，禁止创建或使用 Git worktree。
- 代码注释、文档和会话使用中文。
- 摘要格式固定为 `过程跟踪：记录1 · 记录2 ｜ 结果复盘：复盘1 · 复盘2`。
- 同一字段展示全部非空记录并保持原顺序；去除展示项首尾空白，但不修改持久化原值。
- 摘要只在收起态显示，固定一行，超宽以省略号截断，不得产生横向滚动。
- HTTP(S) Markdown 命名链接继续显示短名称并可点击；不得放宽协议白名单或使用 `dangerouslySetInnerHTML`。
- 摘要必须位于 `.todo-grid` 第一列内部；五个直接子元素、尾列隐藏顺序和关联 Thread 列不得变化。
- 不修改任务数据模型、SQLite、Rust、Tauri command、搜索、筛选、分页或快照持久化链路。
- 保留工作区中 `docs/agent/coding.md`、`docs/agent/errors.md`、`docs/agent/testing.md` 的既有未提交改动，不得覆盖或意外提交不属于本功能的内容。

## 文件结构

- Modify: `src-ui/src/todo/markdownLinks.tsx` — 允许安全 Markdown 文本调用方覆盖换行样式。
- Modify: `src-ui/src/todo/markdownLinks.test.tsx` — 锁定默认样式不变和单行样式覆盖能力。
- Create: `src-ui/src/todo/TodoCollapsedExtensionSummary.tsx` — 解析两个扩展字段并渲染单行安全摘要。
- Create: `src-ui/src/todo/TodoCollapsedExtensionSummary.test.tsx` — 覆盖拼接、空值、顺序、链接和单行类名。
- Modify: `src-ui/src/todo/TodoListView.tsx` — 在任务第一列标题下按折叠状态挂载摘要。
- Modify: `src-ui/src/todo/TodoListView.test.tsx` — 覆盖折叠/展开、即时更新、五列结构和分页紧凑基线。
- Modify: `docs/agent/coding.md` — 记录折叠摘要的长期代码约束；保留既有未提交内容。
- Modify: `docs/agent/testing.md` — 记录摘要回归与视觉验收范围；保留既有未提交内容。

---

### Task 1: 为安全 Markdown 文本增加单行样式接口

**Files:**
- Modify: `src-ui/src/todo/markdownLinks.tsx:1-40`
- Test: `src-ui/src/todo/markdownLinks.test.tsx:1-30`

**Interfaces:**
- Consumes: 现有 `MarkdownText({ value, onOpenLink })` 及 `cn(...inputs)` Tailwind 合并工具。
- Produces: `MarkdownText({ value, onOpenLink, className })`，其中 `className?: string`；未传入时保留 `whitespace-pre-wrap break-words`，传入冲突类时由 `tailwind-merge` 覆盖默认值。

- [ ] **Step 1: 写入失败测试，锁定默认与单行样式**

在 `markdownLinks.test.tsx` 的 `describe` 末尾添加：

```tsx
  test("允许调用方覆盖换行策略，同时保留默认换行样式", () => {
    const { container, rerender } = render(<MarkdownText value="默认文本" />);
    expect(container.firstElementChild).toHaveClass("whitespace-pre-wrap", "break-words");

    rerender(
      <MarkdownText
        value="单行文本"
        className="whitespace-nowrap break-normal"
      />
    );
    expect(container.firstElementChild).toHaveClass("whitespace-nowrap", "break-normal");
    expect(container.firstElementChild).not.toHaveClass("whitespace-pre-wrap", "break-words");
  });
```

- [ ] **Step 2: 运行测试并确认先失败**

Run:

```bash
cd src-ui && npm test -- src/todo/markdownLinks.test.tsx
```

Expected: FAIL；“单行文本”的根节点仍含 `whitespace-pre-wrap break-words`，且不含 `whitespace-nowrap break-normal`。

- [ ] **Step 3: 实现可覆盖的 `className` 接口**

将 `markdownLinks.tsx` 更新为：

```tsx
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const namedHttpLinkPattern = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;

export function MarkdownText({
  value,
  onOpenLink,
  className
}: {
  value: string;
  onOpenLink?: (url: string) => void;
  className?: string;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  namedHttpLinkPattern.lastIndex = 0;

  while ((match = namedHttpLinkPattern.exec(value)) !== null) {
    if (match.index > cursor) parts.push(value.slice(cursor, match.index));
    const [source, label, url] = match;
    parts.push(
      <a
        key={`${match.index}-${url}`}
        href={url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline decoration-primary/25 underline-offset-2 hover:decoration-primary"
        onClick={(event) => {
          if (!onOpenLink) return;
          event.preventDefault();
          onOpenLink(url);
        }}
      >
        {label}
      </a>
    );
    cursor = match.index + source.length;
  }

  if (cursor < value.length) parts.push(value.slice(cursor));
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {parts}
    </span>
  );
}
```

- [ ] **Step 4: 运行 Markdown 测试并确认通过**

Run:

```bash
cd src-ui && npm test -- src/todo/markdownLinks.test.tsx
```

Expected: PASS；既有 HTTP(S) 白名单、外部打开委托和新增样式测试均为 `0 failed`。

- [ ] **Step 5: 提交本任务**

```bash
git add src-ui/src/todo/markdownLinks.tsx src-ui/src/todo/markdownLinks.test.tsx
git diff --cached --check
git commit -m "feat: 支持 Markdown 单行展示"
```

---

### Task 2: 创建折叠态扩展信息摘要组件

**Files:**
- Create: `src-ui/src/todo/TodoCollapsedExtensionSummary.tsx`
- Create: `src-ui/src/todo/TodoCollapsedExtensionSummary.test.tsx`

**Interfaces:**
- Consumes: `TodoTask`；Task 1 产出的 `MarkdownText({ className })`；`onOpenLink(url: string): void`。
- Produces: `TodoCollapsedExtensionSummary({ task, onOpenLink })`；字段均为空时返回 `null`，否则输出 `role="note"`、可访问名称为“<任务标题>的折叠摘要”的单行节点。

- [ ] **Step 1: 写入失败测试，覆盖拼接、空值和安全链接**

创建 `src-ui/src/todo/TodoCollapsedExtensionSummary.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { TodoTask } from "./types";
import { TodoCollapsedExtensionSummary } from "./TodoCollapsedExtensionSummary";

const baseTask: TodoTask = {
  id: "root",
  position: 0,
  title: "父任务",
  status: "todo",
  pinned: false,
  processTracking: "",
  resultReview: ""
};

describe("TodoCollapsedExtensionSummary", () => {
  test("按过程跟踪、结果复盘顺序拼接全部非空记录", () => {
    render(
      <TodoCollapsedExtensionSummary
        task={{
          ...baseTask,
          processTracking: "  记录一  \n\n[排查记录](https://example.com/trace)",
          resultReview: "复盘一\n  复盘二  "
        }}
        onOpenLink={vi.fn()}
      />
    );

    const summary = screen.getByRole("note", { name: "父任务的折叠摘要" });
    expect(summary).toHaveTextContent(
      "过程跟踪：记录一 · 排查记录 ｜ 结果复盘：复盘一 · 复盘二"
    );
    expect(summary).toHaveClass("truncate");
    expect(screen.getByRole("link", { name: "排查记录" })).toHaveAttribute(
      "href",
      "https://example.com/trace"
    );
  });

  test("仅展示非空字段，两个字段均为空白时不渲染", () => {
    const { rerender } = render(
      <TodoCollapsedExtensionSummary
        task={{ ...baseTask, resultReview: "仅有复盘" }}
        onOpenLink={vi.fn()}
      />
    );
    expect(screen.getByRole("note")).toHaveTextContent("结果复盘：仅有复盘");
    expect(screen.getByRole("note")).not.toHaveTextContent("过程跟踪");

    rerender(
      <TodoCollapsedExtensionSummary
        task={{ ...baseTask, processTracking: " \n ", resultReview: "\n" }}
        onOpenLink={vi.fn()}
      />
    );
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("链接点击委托外部打开入口，危险协议保持普通文本", async () => {
    const user = userEvent.setup();
    const onOpenLink = vi.fn();
    render(
      <TodoCollapsedExtensionSummary
        task={{
          ...baseTask,
          processTracking:
            "[监控面板](http://example.com/dashboard)\n[危险](javascript:alert(1))"
        }}
        onOpenLink={onOpenLink}
      />
    );

    await user.click(screen.getByRole("link", { name: "监控面板" }));
    expect(onOpenLink).toHaveBeenCalledWith("http://example.com/dashboard");
    expect(screen.queryByRole("link", { name: "危险" })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("[危险](javascript:alert(1))");
  });
});
```

- [ ] **Step 2: 运行测试并确认组件缺失导致失败**

Run:

```bash
cd src-ui && npm test -- src/todo/TodoCollapsedExtensionSummary.test.tsx
```

Expected: FAIL，模块 `./TodoCollapsedExtensionSummary` 不存在。

- [ ] **Step 3: 实现摘要解析和渲染组件**

创建 `src-ui/src/todo/TodoCollapsedExtensionSummary.tsx`：

```tsx
import { Fragment } from "react";
import { MarkdownText } from "./markdownLinks";
import type { TodoTask } from "./types";

type SummaryGroup = {
  label: "过程跟踪" | "结果复盘";
  lines: string[];
};

function nonEmptyLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function TodoCollapsedExtensionSummary({
  task,
  onOpenLink
}: {
  task: TodoTask;
  onOpenLink: (url: string) => void;
}) {
  const groups: SummaryGroup[] = [
    { label: "过程跟踪", lines: nonEmptyLines(task.processTracking) },
    { label: "结果复盘", lines: nonEmptyLines(task.resultReview) }
  ].filter((group) => group.lines.length > 0) as SummaryGroup[];

  if (groups.length === 0) return null;

  return (
    <div
      role="note"
      aria-label={`${task.title || "未命名任务"}的折叠摘要`}
      className="min-w-0 truncate px-1.5 pb-0.5 text-[10px] leading-4 text-muted-foreground"
    >
      {groups.map((group, groupIndex) => (
        <Fragment key={group.label}>
          {groupIndex > 0 && " ｜ "}
          <span className="font-medium">{group.label}：</span>
          {group.lines.map((line, lineIndex) => (
            <Fragment key={`${lineIndex}-${line}`}>
              {lineIndex > 0 && " · "}
              <MarkdownText
                value={line}
                onOpenLink={onOpenLink}
                className="whitespace-nowrap break-normal"
              />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 运行组件及 Markdown 测试并确认通过**

Run:

```bash
cd src-ui && npm test -- src/todo/TodoCollapsedExtensionSummary.test.tsx src/todo/markdownLinks.test.tsx
```

Expected: PASS；摘要组件和 Markdown 测试全部为 `0 failed`。

- [ ] **Step 5: 提交本任务**

```bash
git add src-ui/src/todo/TodoCollapsedExtensionSummary.tsx src-ui/src/todo/TodoCollapsedExtensionSummary.test.tsx
git diff --cached --check
git commit -m "feat: 添加 todo 折叠摘要组件"
```

---

### Task 3: 将摘要集成到任务标题下方

**Files:**
- Modify: `src-ui/src/todo/TodoListView.tsx:31-50, 576-674`
- Modify: `src-ui/src/todo/TodoListView.test.tsx:387-412, 611-643`

**Interfaces:**
- Consumes: Task 2 产出的 `TodoCollapsedExtensionSummary({ task, onOpenLink })`；现有 `expandedId` 和 `openExternalLink(url)`。
- Produces: 收起态第一列标题下摘要；展开态仍只展示 `ExtensionPanel`；`.todo-grid` 保持五个直接子元素。

- [ ] **Step 1: 写入失败集成测试**

在 `TodoListView.test.tsx` 的扩展信息测试之前添加：

```tsx
  test("收起态在标题下显示单行摘要，展开后隐藏并在再次收起时反映最新内容", async () => {
    const user = userEvent.setup();
    const openLink = vi.fn();
    render(
      <TodoListView
        initialTasks={[
          {
            ...initialTasks[0],
            processTracking: "记录一\n[排查记录](https://example.com/trace)",
            resultReview: "复盘一\n复盘二"
          }
        ]}
        persistTasks={vi.fn()}
        openLink={openLink}
      />
    );

    const row = screen
      .getByDisplayValue("父任务")
      .closest<HTMLElement>("[data-task-row]");
    expect(row).not.toBeNull();
    expect(row?.children).toHaveLength(5);

    const summary = within(row as HTMLElement).getByRole("note", {
      name: "父任务的折叠摘要"
    });
    expect(row?.firstElementChild).toContainElement(summary);
    expect(summary).toHaveClass("truncate");
    expect(summary).toHaveTextContent(
      "过程跟踪：记录一 · 排查记录 ｜ 结果复盘：复盘一 · 复盘二"
    );

    await user.click(within(summary).getByRole("link", { name: "排查记录" }));
    expect(openLink).toHaveBeenCalledWith("https://example.com/trace");
    expect(screen.getByRole("button", { name: "展开 父任务" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开 父任务" }));
    expect(
      screen.queryByRole("note", { name: "父任务的折叠摘要" })
    ).not.toBeInTheDocument();

    const resultSection = screen.getByRole("region", { name: "父任务的结果复盘" });
    await user.click(within(resultSection).getByRole("button", { name: "添加文本" }));
    await user.type(within(resultSection).getByLabelText("结果复盘文本"), "新增结论");
    await user.click(within(resultSection).getByRole("button", { name: "保存" }));

    await user.click(screen.getByRole("button", { name: "收起 父任务" }));
    expect(
      screen.getByRole("note", { name: "父任务的折叠摘要" })
    ).toHaveTextContent("结果复盘：复盘一 · 复盘二 · 新增结论");
  });
```

同时在“列表使用紧凑行高并默认每页显示 200 条”的批量 fixture 中明确清空扩展字段，确保该测试继续验证无摘要任务的紧凑基线：

```tsx
    const manyTasks: TodoTask[] = Array.from({ length: 201 }, (_, index) => ({
      ...initialTasks[0],
      id: `task-${index + 1}`,
      title: `任务 ${String(index + 1).padStart(3, "0")}`,
      position: index,
      parentId: undefined,
      status: index === 200 ? "in_progress" : "todo",
      processTracking: "",
      resultReview: ""
    }));
```

- [ ] **Step 2: 运行集成测试并确认摘要缺失导致失败**

Run:

```bash
cd src-ui && npm test -- src/todo/TodoListView.test.tsx
```

Expected: FAIL，无法找到 `role="note"`、名称为“父任务的折叠摘要”的元素。

- [ ] **Step 3: 在任务第一列集成摘要并保持控件首行对齐**

在 `TodoListView.tsx` 导入组件：

```tsx
import { TodoCollapsedExtensionSummary } from "./TodoCollapsedExtensionSummary";
```

将任务第一列容器类名从：

```tsx
className="relative flex min-w-0 items-center"
```

改为：

```tsx
className="relative flex min-w-0 items-start py-1"
```

为拖拽按钮和展开按钮的既有类名加入 `mt-1`，为置顶 `Pin` 加入 `mt-1.5`，并将状态按钮外层容器改为：

```tsx
<div className="relative mr-2 mt-1">
```

用下面的纵向容器替换现有标题 `<input>`；事件处理保持完整不变：

```tsx
<div className="min-w-0 flex-1">
  <input
    ref={(node) => {
      if (node) titleRefs.current.set(task.id, node);
      else titleRefs.current.delete(task.id);
    }}
    value={task.title}
    aria-label="任务标题"
    placeholder="输入任务描述"
    className={cn(
      "h-7 w-full min-w-0 rounded border border-transparent bg-transparent px-1.5 text-[12px] font-medium outline-none transition-colors focus:border-primary focus:bg-card focus:ring-2 focus:ring-primary/10",
      task.status === "completed" && "text-muted-foreground line-through",
      task.status === "cancelled" &&
        "text-muted-foreground line-through decoration-dashed"
    )}
    onChange={(event) => updateTask(task.id, { title: event.target.value }, false)}
    onBlur={() => void saveSnapshot(tasks)}
    onKeyDown={(event) => {
      if (event.key === "Enter" && event.metaKey) {
        event.preventDefault();
        addSiblingTask(task.id, event.shiftKey ? "before" : "after");
      } else if (event.key === "Tab") {
        event.preventDefault();
        applyTasks(
          event.shiftKey ? outdentTask(tasks, task.id) : indentTask(tasks, task.id),
          { focusId: task.id }
        );
      } else if (event.key === "Backspace" && !task.title && tasks.length > 1) {
        event.preventDefault();
        const index = visibleTasks.findIndex(({ task: item }) => item.id === task.id);
        const nextFocus = visibleTasks[Math.max(0, index - 1)]?.task.id;
        applyTasks(removeTaskTree(tasks, task.id), {
          focusId: nextFocus,
          focusMode: "caret-end",
          focusPage: Math.floor(Math.max(0, index - 1) / todoPageSize) + 1
        });
      }
    }}
  />
  {expandedId !== task.id && (
    <TodoCollapsedExtensionSummary
      task={task}
      onOpenLink={openExternalLink}
    />
  )}
</div>
```

- [ ] **Step 4: 运行摘要、列表及 Markdown 测试并确认通过**

Run:

```bash
cd src-ui && npm test -- src/todo/TodoListView.test.tsx src/todo/TodoCollapsedExtensionSummary.test.tsx src/todo/markdownLinks.test.tsx
```

Expected: PASS；折叠/展开、即时更新、分页紧凑基线和链接相关测试全部为 `0 failed`。

- [ ] **Step 5: 提交本任务**

```bash
git add src-ui/src/todo/TodoListView.tsx src-ui/src/todo/TodoListView.test.tsx
git diff --cached --check
git commit -m "feat: 展示 todo 折叠扩展摘要"
```

---

### Task 4: 维护项目知识并完成全量与视觉验收

**Files:**
- Modify: `docs/agent/coding.md`
- Modify: `docs/agent/testing.md`
- Verify: `src-ui/src/todo/TodoCollapsedExtensionSummary.tsx`
- Verify: `src-ui/src/todo/TodoListView.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 的完整前端实现。
- Produces: 可复核的自动化测试、构建、CSS 截断、响应式布局和项目知识证据。

- [ ] **Step 1: 更新长期编码约束，保留既有未提交内容**

在 `docs/agent/coding.md` 的 To Do 扩展信息约束附近新增：

```markdown
- To Do 任务收起且过程跟踪或结果复盘存在非空记录时，标题下按“过程跟踪在前、结果复盘在后”的固定顺序展示单行摘要；同字段记录以 ` · ` 拼接、字段间以 ` ｜ ` 拼接，超宽省略。摘要必须位于五列网格第一格内部，展开时隐藏，并继续复用 HTTP(S) Markdown 命名链接安全边界。
```

在 `docs/agent/coding.md` 的 Update Notes 末尾新增：

```markdown
- 2026-08-12: 新增 To Do 折叠态过程跟踪与结果复盘单行摘要约束。
```

- [ ] **Step 2: 更新测试知识，保留既有未提交内容**

在 `docs/agent/testing.md` 的 To Do List 测试约束附近新增：

```markdown
- 修改 To Do 折叠摘要时，需要覆盖双字段与单字段、多条记录顺序、空白值、展开隐藏、编辑后即时更新、HTTP(S) 命名链接和危险协议；确认摘要仍位于第一列、网格保持五个直接子元素、无摘要任务保持紧凑行高，并在 1440 × 1024 与 1024 × 768 检查单行省略、列对齐和横向溢出。
```

在 `docs/agent/testing.md` 的 Update Notes 末尾新增：

```markdown
- 2026-08-12: 增加 To Do 折叠态扩展摘要的拼接、安全链接、布局与响应式回归范围。
```

- [ ] **Step 3: 运行完整自动化验证**

Run:

```bash
(cd src-ui && npm test)
(cd src-ui && npm run build)
(cd src-tauri && cargo test)
(cd src-tauri && cargo fmt --check)
git diff --check
```

Expected: 前端测试、TypeScript 检查、Vite 生产构建、Rust 测试和格式检查全部退出码为 `0`；`git diff --check` 无输出。

- [ ] **Step 4: 在普通浏览器完成双尺寸视觉验收**

启动浏览器预览：

```bash
cd src-ui && npm run dev -- --port 4173
```

在 `http://127.0.0.1:4173` 打开 To Do List，并对 demo 任务“异构镜像需要清理管控 agent 的残留状态信息”完成以下检查：

1. `1440 × 1024`：摘要位于标题下，只占一行；过程跟踪在前、结果复盘在后；标题、拖拽、展开、置顶和状态控件首行对齐；五列表头与任务行对齐。
2. 展开任务：主行摘要消失，过程跟踪和结果复盘完整面板保持可见；收起后摘要恢复。
3. `1024 × 768`：长摘要显示省略号，关联 Thread 与尾列压缩/隐藏逻辑不变，页面无横向滚动。
4. 检查摘要节点计算样式：`white-space: nowrap`、`overflow: hidden`、`text-overflow: ellipsis`。
5. 检查浏览器控制台：错误数为 `0`，没有 Tauri bridge 调用错误。

Expected: 五项视觉与控制台检查全部通过；如任一项失败，返回对应 Task 修复并重新运行其定向测试和本步骤。

- [ ] **Step 5: 审核变更边界并保留项目知识改动**

先运行：

```bash
git status --short
git diff -- src-ui/src/todo docs/agent/coding.md docs/agent/testing.md
git log -n 5 --oneline
```

确认 Tasks 1–3 的代码提交均存在，且 `docs/agent/coding.md`、`docs/agent/testing.md` 中原有未提交改动仍保留。由于两份知识文件在本功能开始前已经存在其他未提交修改，不得直接整文件 `git add`；本任务新增的知识行保留在工作区，并在交付说明中明确列出，避免把用户既有改动混入功能提交。

最终应满足：实现代码均已提交；两份项目知识文件包含本功能新增约束；`docs/agent/errors.md` 未被本功能修改；工作区其余既有改动保持原样。
