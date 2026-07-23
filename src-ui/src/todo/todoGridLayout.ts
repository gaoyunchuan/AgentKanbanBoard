export type TodoGridWidths = {
  task: number;
  thread: number;
  expected: number;
  actual: number;
  actions: number;
};

export type TodoGridLayout = {
  widths: TodoGridWidths;
  hidden: {
    expected: boolean;
    actual: boolean;
    actions: boolean;
  };
};

const EXPECTED_MIN_WIDTH = 64;
const ACTUAL_MIN_WIDTH = 64;
const ACTIONS_MIN_WIDTH = 44;
const THREAD_TARGET_WIDTH = 180;
const TASK_TARGET_WIDTH = 240;

type TailResult = {
  width: number;
  hidden: boolean;
  remainingDeficit: number;
};

function resolveTailColumn(
  baselineWidth: number,
  minimumWidth: number,
  deficit: number
): TailResult {
  if (deficit <= 0) {
    return { width: baselineWidth, hidden: false, remainingDeficit: 0 };
  }

  const safeMinimum = Math.min(baselineWidth, minimumWidth);
  const shrinkCapacity = baselineWidth - safeMinimum;
  if (deficit <= shrinkCapacity) {
    return {
      width: baselineWidth - deficit,
      hidden: false,
      remainingDeficit: 0
    };
  }

  if (deficit <= baselineWidth) {
    return { width: 0, hidden: true, remainingDeficit: 0 };
  }

  return {
    width: 0,
    hidden: true,
    remainingDeficit: deficit - baselineWidth
  };
}

export function resolveTodoGridLayout(
  baseline: TodoGridWidths,
  availableWidth: number
): TodoGridLayout {
  const totalWidth = Object.values(baseline).reduce((sum, width) => sum + width, 0);
  let remainingDeficit = Math.max(0, totalWidth - Math.max(0, availableWidth));

  const actions = resolveTailColumn(
    baseline.actions,
    ACTIONS_MIN_WIDTH,
    remainingDeficit
  );
  remainingDeficit = actions.remainingDeficit;

  const actual = resolveTailColumn(
    baseline.actual,
    ACTUAL_MIN_WIDTH,
    remainingDeficit
  );
  remainingDeficit = actual.remainingDeficit;

  const expected = resolveTailColumn(
    baseline.expected,
    EXPECTED_MIN_WIDTH,
    remainingDeficit
  );
  remainingDeficit = expected.remainingDeficit;

  const threadTarget = Math.min(baseline.thread, THREAD_TARGET_WIDTH);
  const threadShrink = Math.min(
    remainingDeficit,
    baseline.thread - threadTarget
  );
  const thread = baseline.thread - threadShrink;
  remainingDeficit -= threadShrink;

  const taskTarget = Math.min(baseline.task, TASK_TARGET_WIDTH);
  const taskShrink = Math.min(
    remainingDeficit,
    baseline.task - taskTarget
  );
  const task = baseline.task - taskShrink;
  remainingDeficit -= taskShrink;

  const targetTotal = task + thread;
  const proportionalTotal = Math.max(0, targetTotal - remainingDeficit);
  const scale = targetTotal === 0 ? 0 : proportionalTotal / targetTotal;

  return {
    widths: {
      task: task * scale,
      thread: thread * scale,
      expected: expected.width,
      actual: actual.width,
      actions: actions.width
    },
    hidden: {
      expected: expected.hidden,
      actual: actual.hidden,
      actions: actions.hidden
    }
  };
}
