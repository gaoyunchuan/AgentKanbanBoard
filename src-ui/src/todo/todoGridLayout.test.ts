import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

describe("To Do List 列宽优先级", () => {
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
});
