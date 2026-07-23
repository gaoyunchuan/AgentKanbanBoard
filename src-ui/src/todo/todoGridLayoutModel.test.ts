import { describe, expect, test } from "vitest";
import { resolveTodoGridLayout, type TodoGridWidths } from "./todoGridLayout";

const baseline: TodoGridWidths = {
  task: 400,
  thread: 220,
  expected: 96,
  actual: 96,
  actions: 84
};

describe("resolveTodoGridLayout", () => {
  test("先压缩操作列且冻结前两列", () => {
    expect(resolveTodoGridLayout(baseline, 876)).toEqual({
      widths: { ...baseline, actions: 64 },
      hidden: { expected: false, actual: false, actions: false }
    });
  });

  test("操作列低于安全宽度前完整隐藏且不压缩下一列", () => {
    expect(resolveTodoGridLayout(baseline, 855)).toEqual({
      widths: { ...baseline, actions: 0 },
      hidden: { expected: false, actual: false, actions: true }
    });
  });

  test("按操作、实际、预期的顺序压缩并隐藏", () => {
    expect(resolveTodoGridLayout(baseline, 796).hidden).toEqual({
      expected: false,
      actual: false,
      actions: true
    });
    expect(resolveTodoGridLayout(baseline, 759).hidden).toEqual({
      expected: false,
      actual: true,
      actions: true
    });
    expect(resolveTodoGridLayout(baseline, 663).hidden).toEqual({
      expected: true,
      actual: true,
      actions: true
    });
  });

  test("尾列全部隐藏后先单独压缩 Thread 到 180", () => {
    expect(resolveTodoGridLayout(baseline, 600).widths).toEqual({
      task: 400,
      thread: 200,
      expected: 0,
      actual: 0,
      actions: 0
    });
    expect(resolveTodoGridLayout(baseline, 580).widths).toEqual({
      task: 400,
      thread: 180,
      expected: 0,
      actual: 0,
      actions: 0
    });
  });

  test("Thread 到 180 后再单独压缩任务到 240", () => {
    expect(resolveTodoGridLayout(baseline, 540).widths).toEqual({
      task: 360,
      thread: 180,
      expected: 0,
      actual: 0,
      actions: 0
    });
    expect(resolveTodoGridLayout(baseline, 420).widths).toEqual({
      task: 240,
      thread: 180,
      expected: 0,
      actual: 0,
      actions: 0
    });
  });

  test("达到 240 和 180 后按 4 比 3 同步缩小", () => {
    expect(resolveTodoGridLayout(baseline, 378).widths).toEqual({
      task: 216,
      thread: 162,
      expected: 0,
      actual: 0,
      actions: 0
    });
  });

  test("捕获宽度低于阈值时不反向放大", () => {
    const narrowBaseline = { ...baseline, task: 200, thread: 160 };
    expect(resolveTodoGridLayout(narrowBaseline, 180).widths).toEqual({
      task: 100,
      thread: 80,
      expected: 0,
      actual: 0,
      actions: 0
    });
  });

  test("极小宽度保持非负且不超过可用宽度", () => {
    const layout = resolveTodoGridLayout(baseline, 1);
    expect(layout.widths.task).toBeGreaterThanOrEqual(0);
    expect(layout.widths.thread).toBeGreaterThanOrEqual(0);
    expect(layout.widths.task + layout.widths.thread).toBeCloseTo(1);
  });
});
