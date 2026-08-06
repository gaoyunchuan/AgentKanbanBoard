# To Do 空任务删除后光标归位实施计划

> **执行要求：** 在当前会话内逐步执行，并使用测试驱动开发完成回归验证。

**目标：** 空标题任务按 Backspace 删除后，上一任务获得焦点，光标折叠在标题末尾，不再全文选中。

**实现方式：** 为现有待聚焦状态附加选区模式。默认模式继续全文选中；只有空标题 Backspace 删除路径指定“光标末尾”，聚焦副作用据此调用 `setSelectionRange`。

**技术栈：** React、TypeScript、Vitest、Testing Library。

## 全局约束

- 只修改空标题任务按 Backspace 删除的行为。
- 菜单删除和新建、缩进等现有聚焦行为保持不变。
- 直接在 `main` 开发，不创建分支或 WorkTree。

---

### 任务 1：增加回归测试并最小化修复

**文件：**

- 修改：`src-ui/src/todo/TodoListView.test.tsx`
- 修改：`src-ui/src/todo/TodoListView.tsx`

**接口：**

- 输入：空标题任务的标题输入框收到 `Backspace`。
- 输出：删除该任务；上一可见任务的标题输入框获得焦点，且 `selectionStart`、`selectionEnd` 都等于标题长度。

- [x] 编写失败测试：构造“上一任务 + 空任务”，在空任务中按 Backspace，断言上一任务获得焦点且选区折叠在末尾；再按 Backspace，断言只删除末尾一个字符。
- [x] 单独运行该测试，确认当前实现因全文选中而失败。
- [x] 增加聚焦选区模式，并只在空标题 Backspace 删除路径使用末尾模式。
- [x] 运行 `TodoListView` 测试，确认回归测试和原有测试通过。
- [x] 运行前端完整测试、构建及 `git diff --check`，保存验收证据。
