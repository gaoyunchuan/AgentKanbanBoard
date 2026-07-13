import { describe, expect, test } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";

describe("Tauri 窗口配置", () => {
  test("关闭 Tauri 内部拖放处理器以允许前端 DOM 拖放", () => {
    expect(tauriConfig.app.windows[0].dragDropEnabled).toBe(false);
  });
});
