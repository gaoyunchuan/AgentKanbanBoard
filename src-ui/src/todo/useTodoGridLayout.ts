import { useLayoutEffect } from "react";
import type { RefObject } from "react";
import {
  resolveTodoGridLayout,
  type TodoGridLayout,
  type TodoGridWidths
} from "./todoGridLayout";

const widthProperties = {
  task: "--todo-task-column-width",
  thread: "--todo-thread-column-width",
  expected: "--todo-expected-column-width",
  actual: "--todo-actual-column-width",
  actions: "--todo-actions-column-width"
} satisfies Record<keyof TodoGridWidths, string>;

function contentWidth(element: HTMLElement) {
  const style = getComputedStyle(element);
  return Math.max(
    0,
    element.clientWidth -
      Number.parseFloat(style.paddingLeft || "0") -
      Number.parseFloat(style.paddingRight || "0")
  );
}

function readWidths(header: HTMLElement): TodoGridWidths | undefined {
  const children = Array.from(header.children).slice(0, 5);
  if (children.length !== 5) return undefined;
  const [task, thread, expected, actual, actions] = children.map(
    (element) => element.getBoundingClientRect().width
  );
  if ([task, thread, expected, actual, actions].some((width) => width <= 0)) {
    return undefined;
  }
  return { task, thread, expected, actual, actions };
}

function applyLayout(container: HTMLElement, layout: TodoGridLayout) {
  for (const [column, property] of Object.entries(widthProperties)) {
    container.style.setProperty(
      property,
      `${layout.widths[column as keyof TodoGridWidths]}px`
    );
  }
  container.toggleAttribute("data-todo-expected-hidden", layout.hidden.expected);
  container.toggleAttribute("data-todo-actual-hidden", layout.hidden.actual);
  container.toggleAttribute("data-todo-actions-hidden", layout.hidden.actions);
}

function clearLayout(container: HTMLElement) {
  for (const property of Object.values(widthProperties)) {
    container.style.removeProperty(property);
  }
  container.removeAttribute("data-todo-expected-hidden");
  container.removeAttribute("data-todo-actual-hidden");
  container.removeAttribute("data-todo-actions-hidden");
}

export function useTodoGridLayout(
  containerRef: RefObject<HTMLDivElement>
) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const header = container.querySelector<HTMLElement>("[data-todo-grid-header]");
    if (!header) return;

    let baseline: TodoGridWidths | undefined;

    const update = () => {
      const availableWidth = contentWidth(header);
      if (availableWidth <= 0) return;

      if (!baseline) {
        baseline = readWidths(header);
        if (!baseline) return;
      }

      const baselineTotal = Object.values(baseline).reduce(
        (sum, width) => sum + width,
        0
      );
      if (availableWidth >= baselineTotal) {
        clearLayout(container);
        baseline = readWidths(header) ?? baseline;
        return;
      }

      // 尾列隐藏后释放的空白不能回填前两列，否则会破坏动态冻结宽度。
      applyLayout(
        container,
        resolveTodoGridLayout(baseline, availableWidth)
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);
}
