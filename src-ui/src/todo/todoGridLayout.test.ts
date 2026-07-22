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

  test("极窄屏最后才让任务和关联 Thread 等权继续收缩", () => {
    expect(css).toContain("@media (max-width: 520px)");
    expect(css).toContain(
      "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 64px 64px 44px;"
    );
  });
});
