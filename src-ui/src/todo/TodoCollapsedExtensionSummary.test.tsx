import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
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

afterEach(() => {
  cleanup();
});

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
