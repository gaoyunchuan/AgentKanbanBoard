import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useTodoGridLayout } from "./useTodoGridLayout";

const baselineWidths = [400, 220, 96, 96, 84];
let availableWidth = 896;
let resizeCallback: ResizeObserverCallback;
let activeObserver: ResizeObserverTestDouble;
const disconnect = vi.fn();

class ResizeObserverTestDouble {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
    activeObserver = this;
  }

  observe() {}
  unobserve() {}
  disconnect() {
    disconnect();
  }
}

function Harness() {
  const containerRef = useRef<HTMLDivElement>(null);
  useTodoGridLayout(containerRef);
  return (
    <div ref={containerRef} data-testid="container">
      <div data-todo-grid-header data-testid="header">
        {baselineWidths.map((_, index) => <div key={index} />)}
      </div>
    </div>
  );
}

function prepareLayout() {
  const view = render(<Harness />);
  const header = view.getByTestId("header");
  Object.defineProperty(header, "clientWidth", {
    configurable: true,
    get: () => availableWidth
  });
  Array.from(header.children).forEach((element, index) => {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      width: baselineWidths[index],
      height: 0,
      x: 0,
      y: 0,
      top: 0,
      right: baselineWidths[index],
      bottom: 0,
      left: 0,
      toJSON: () => ({})
    });
  });
  triggerResize();
  return {
    ...view,
    container: view.getByTestId("container")
  };
}

function triggerResize() {
  resizeCallback([], activeObserver as unknown as ResizeObserver);
}

function setAvailableWidth(width: number) {
  availableWidth = width;
}

function columnVariables(container: HTMLElement) {
  const read = (property: string) =>
    Number.parseFloat(container.style.getPropertyValue(property));
  return {
    task: read("--todo-task-column-width"),
    thread: read("--todo-thread-column-width")
  };
}

describe("useTodoGridLayout", () => {
  beforeEach(() => {
    availableWidth = 896;
    disconnect.mockClear();
    vi.stubGlobal("ResizeObserver", ResizeObserverTestDouble);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("冻结动态前两列并按顺序隐藏尾列", () => {
    const { container } = prepareLayout();

    setAvailableWidth(796);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 220 });
    expect(container).toHaveAttribute("data-todo-actions-hidden");
    expect(container).not.toHaveAttribute("data-todo-actual-hidden");

    setAvailableWidth(759);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 220 });
    expect(container).toHaveAttribute("data-todo-actual-hidden");
    expect(container).not.toHaveAttribute("data-todo-expected-hidden");

    setAvailableWidth(663);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 220 });
    expect(container).toHaveAttribute("data-todo-expected-hidden");
  });

  test("尾列隐藏后依次执行 Thread、任务和比例阶段", () => {
    const { container } = prepareLayout();

    setAvailableWidth(600);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 200 });

    setAvailableWidth(580);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 400, thread: 180 });

    setAvailableWidth(540);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 360, thread: 180 });

    setAvailableWidth(378);
    triggerResize();
    expect(columnVariables(container)).toEqual({ task: 216, thread: 162 });
  });

  test("恢复到基线宽度时清除临时布局并在卸载时断开观察", () => {
    const view = prepareLayout();
    setAvailableWidth(600);
    triggerResize();

    setAvailableWidth(896);
    triggerResize();
    expect(
      view.container.style.getPropertyValue("--todo-task-column-width")
    ).toBe("");

    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
