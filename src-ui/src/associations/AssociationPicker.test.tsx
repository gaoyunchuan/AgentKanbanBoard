import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { AssociationPicker } from "./AssociationPicker";

test("支持搜索、方向键选择、Enter 确认和 Esc 还焦点", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <AssociationPicker
      label="选择未完成 Task"
      getOptions={(query) =>
        [
          { id: "parent", label: "父任务", depth: 0 },
          { id: "child", label: "子任务", depth: 1, description: "父任务 / 子任务" }
        ].filter((option) => option.label.includes(query.trim()))
      }
      onSelect={onSelect}
    />
  );

  const trigger = screen.getByRole("combobox", { name: "选择未完成 Task" });
  await user.click(trigger);
  await user.type(screen.getByRole("searchbox"), "子任务");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onSelect).toHaveBeenCalledWith("child");

  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

test("禁用上下文不可选择，空结果显示中文空态", async () => {
  const user = userEvent.setup();
  render(
    <AssociationPicker
      label="选择 Task"
      getOptions={(query) =>
        query === "不存在"
          ? []
          : [{ id: "parent", label: "已完成父任务", depth: 0, disabled: true }]
      }
      onSelect={vi.fn()}
    />
  );
  await user.click(screen.getByRole("combobox", { name: "选择 Task" }));
  expect(screen.getByRole("option", { name: /已完成父任务/ })).toHaveAttribute(
    "aria-disabled",
    "true"
  );
  await user.type(screen.getByRole("searchbox"), "不存在");
  expect(screen.getByText("没有符合条件的结果，可尝试其他关键词")).toBeInTheDocument();
});
