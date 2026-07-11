# To Do 任务拖放排序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任务拖放根据行内落点执行向前排序、成为子任务或向后排序，并提供明确视觉反馈。

**Architecture:** 在 `todoTree.ts` 中增加无 UI 依赖的相对移动纯函数；`TodoListView.tsx` 仅负责把鼠标纵向位置映射为三种落点，并调用纯函数。拖动提示保存在组件瞬时状态，不进入持久化模型。

**Tech Stack:** React 18、TypeScript、Vitest、Testing Library、Tailwind CSS

## Global Constraints

- 直接使用当前分支，不创建 worktree。
- 不修改数据库结构和任务领域字段。
- 任务状态、日期、过程跟踪、结果复盘在移动后必须保持不变。
- 禁止形成父子循环。

---

### Task 1: 树结构相对移动

**Files:**
- Modify: `src-ui/src/todo/todoTree.ts`
- Test: `src-ui/src/todo/todoTree.test.ts`

**Interfaces:**
- Produces: `moveTaskRelative(tasks, taskId, targetId, placement: "before" | "inside" | "after"): TodoTask[]`

- [ ] **Step 1: 写失败测试**

覆盖根任务向前排序、同级向后排序、跨层级插入到目标同级、`inside` 成为子任务以及移动到自身后代时保持原数据。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: FAIL，提示 `moveTaskRelative` 尚未导出。

- [ ] **Step 3: 实现最小纯函数**

先拒绝自身和后代目标；`inside` 复用子任务语义；`before/after` 取目标的 `parentId` 与相邻位置，移动前先从原同级集合移除，再为新同级集合重建连续 `position`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-ui && npm test -- --run src/todo/todoTree.test.ts`

Expected: PASS。

### Task 2: 三段拖放命中与反馈

**Files:**
- Modify: `src-ui/src/todo/TodoListView.tsx`
- Test: `src-ui/src/todo/TodoListView.test.tsx`

**Interfaces:**
- Consumes: `moveTaskRelative(...)`
- Produces: 行上沿 `before`、中部 `inside`、下沿 `after` 的拖放行为与对应视觉提示。

- [ ] **Step 1: 写失败测试**

通过构造 `dragOver` 的 `clientY` 与目标行 `getBoundingClientRect()`，分别验证上、中、下落点；断言排序结果或 `data-depth`，并验证拖动结束后提示清除。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: FAIL，现有实现始终移动为子任务。

- [ ] **Step 3: 实现拖放状态与最小样式**

增加 `{ taskId, placement }` 瞬时状态；按目标行高度的 25% / 50% / 25% 计算落点；顶部和底部用蓝色横线，中部使用浅蓝背景；`drop` 后调用 `moveTaskRelative` 并清空状态。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-ui && npm test -- --run src/todo/TodoListView.test.tsx`

Expected: PASS。

### Task 3: 完整验证

**Files:**
- Verify only

- [ ] **Step 1: 运行完整前端验证**

Run: `cd src-ui && npm test && npm run build`

Expected: 所有测试通过且 Vite 构建成功。

- [ ] **Step 2: 浏览器验收**

在本地页面验证向上排序、向下排序、成为子任务三条路径，并确认拖放提示与最终层级一致。

- [ ] **Step 3: 检查补丁格式**

Run: `git diff --check`

Expected: 无输出，退出码为 0。
