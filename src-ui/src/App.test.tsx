import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("not running in Tauri"))
}));

describe("Codex Kanban App", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  test("switches focused views and shows running/review/archived data", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /运行中/ }));
    expect(screen.getByText("补齐 ThreadSync 只读同步与事件订阅")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /待人工审核/ }));
    expect(screen.getByText("状态映射：review_pending 稳定窗口")).toBeInTheDocument();

    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: /^归档/ }));
    expect(screen.getByText("旧同步方案：直接解析 session 文件")).toBeInTheDocument();
  });

  test("edits fixed fields from an expanded row", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getAllByText("ProjectMatcher 支持最长路径优先")[0]);
    const moduleInput = screen.getByDisplayValue("ProjectMatcher");
    await user.clear(moduleInput);
    await user.type(moduleInput, "Matcher");

    expect(screen.getByDisplayValue("Matcher")).toBeInTheDocument();
  });

  test("marks reviewed, archives, and restores a thread", async () => {
    const user = userEvent.setup();
    render(<App />);

    const row = threadRowFor(screen.getAllByText("状态映射：review_pending 稳定窗口")[0]);
    expect(row).toBeTruthy();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "标记已审核" }));
    expect(screen.getByText(/已标记审核完成/)).toBeInTheDocument();

    await user.click(within(row as HTMLElement).getByRole("button", { name: "归档" }));
    expect(screen.getAllByText(/已归档/).length).toBeGreaterThan(0);

    await user.click(within(screen.getByRole("navigation")).getByRole("button", { name: /^归档/ }));
    const archivedRow = threadRowFor(screen.getAllByText("状态映射：review_pending 稳定窗口")[0]);
    expect(archivedRow).toBeTruthy();
    await user.click(within(archivedRow as HTMLElement).getByRole("button", { name: "恢复归档" }));
    expect(screen.getByText(/已恢复/)).toBeInTheDocument();
  });
});

function threadRowFor(element: HTMLElement) {
  let current: HTMLElement | null = element;
  while (current && !current.className.includes("min-w-[480px]")) {
    current = current.parentElement;
  }
  return current;
}
