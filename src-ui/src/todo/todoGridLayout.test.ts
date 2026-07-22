import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

describe("To Do List 列宽优先级", () => {
  test("普通窄屏为任务和关联 Thread 保留 140px 并优先压缩其他列", () => {
    expect(css).toContain(
      "grid-template-columns: minmax(140px, 1fr) minmax(140px, 180px) minmax(64px, 96px) minmax(64px, 96px) minmax(44px, 84px);"
    );
  });

  test("窄容器完整隐藏尾部三列并保留任务与 Thread", () => {
    expect(css).toContain("container-type: inline-size;");
    expect(css).toContain("@container (max-width: 520px)");
    expect(css).toContain(
      "grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr);"
    );
    expect(css).toContain(".todo-grid > :nth-child(n + 3)");
    expect(css).toContain("display: none;");
  });

  test("极窄容器最后才让任务与 Thread 等权收缩", () => {
    expect(css).toContain("@container (max-width: 320px)");
    expect(css).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);"
    );
  });
});
