import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import App from "./App";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args)
}));

vi.mock("@/runtime", () => ({
  shouldInvokeTauri: () => false
}));

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

test("普通浏览器使用可交互 demo 数据且关联流程不调用 Tauri", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByText("浏览器预览：待审核 Thread"));
  await user.click(screen.getByRole("combobox", { name: "选择未完成 Task" }));
  await user.click(screen.getByRole("option", { name: /异构实现带外探测/ }));

  expect(await screen.findByRole("button", { name: /打开 Task 异构实现带外探测/ }))
    .toBeInTheDocument();
  expect(invokeMock).not.toHaveBeenCalled();
});
