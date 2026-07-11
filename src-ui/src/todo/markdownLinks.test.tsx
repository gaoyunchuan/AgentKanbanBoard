import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { MarkdownText } from "./markdownLinks";

describe("MarkdownText", () => {
  test("仅把 http(s) Markdown 命名链接渲染为可点击链接", () => {
    render(
      <MarkdownText value="记录见 [排查记录](https://example.com/trace)，不要打开 [危险](javascript:alert(1))" />
    );

    expect(screen.getByRole("link", { name: "排查记录" })).toHaveAttribute(
      "href",
      "https://example.com/trace"
    );
    expect(screen.queryByRole("link", { name: "危险" })).not.toBeInTheDocument();
    expect(screen.getByText(/危险/)).toBeInTheDocument();
  });

  test("点击命名链接交给外部打开入口", async () => {
    const user = userEvent.setup();
    const onOpenLink = vi.fn();
    render(
      <MarkdownText value="[监控面板](http://example.com/dashboard)" onOpenLink={onOpenLink} />
    );

    await user.click(screen.getByRole("link", { name: "监控面板" }));
    expect(onOpenLink).toHaveBeenCalledWith("http://example.com/dashboard");
  });
});
