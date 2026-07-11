import { describe, expect, test } from "vitest";
import { shouldInvokeTauri } from "./runtime";

describe("shouldInvokeTauri", () => {
  test("桌面壳和测试环境允许调用，普通浏览器预览静默降级", () => {
    expect(shouldInvokeTauri(true, "development")).toBe(true);
    expect(shouldInvokeTauri(false, "test")).toBe(true);
    expect(shouldInvokeTauri(false, "development")).toBe(false);
    expect(shouldInvokeTauri(false, "production")).toBe(false);
  });
});
