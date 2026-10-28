export type WorkStatus = "queued" | "running" | "waiting" | "review" | "completed" | "paused" | "cancelled" | "attention";

export type TaskConfig = {
  agent_id: string;
  delegated_by: string;
  workspace: string;
  prompt: string;
  acceptance: string;
  review_policy: "human" | "auto";
  blocked_by: string[];
  model?: string | null;
  reasoning_effort?: string | null;
  approval_policy?: string;
  sandbox_mode?: string;
  instructions?: string;
  browser_enabled?: boolean;
};

export type WorkTask = {
  task_id: string;
  title: string;
  parent_id?: string | null;
  status: WorkStatus;
  execution_status: string;
  revision: number;
  config: TaskConfig;
  current_run_id?: string | null;
  thread_id?: string | null;
  wait_reason?: string | null;
  last_error?: string | null;
  result_summary?: string | null;
  continuation_count: number;
  updated_at: string;
};

export type WorkRun = {
  id: string;
  task_id: string;
  generation: number;
  status: string;
  thread_id?: string | null;
  turn_id?: string | null;
  prompt: string;
  error?: string | null;
  started_at: string;
  ended_at?: string | null;
};

export type WorkEvent = {
  id: number;
  task_id: string;
  run_id?: string | null;
  kind: string;
  payload: unknown;
  created_at: string;
};

export type TaskInteraction = {
  id: string;
  task_id: string;
  run_id: string;
  request_id: unknown;
  kind: string;
  method: string;
  payload: unknown;
  status: "pending" | "resolved" | "expired";
  response?: unknown;
  created_at: string;
  resolved_at?: string | null;
};

export type TaskExecutionDetail = {
  task: WorkTask;
  runs: WorkRun[];
  events: WorkEvent[];
  interactions: TaskInteraction[];
};

export type AgentProfile = { id: string; name: string; instructions?: string };
export type WorkbenchData = {
  tasks: WorkTask[];
  agents?: AgentProfile[];
  runtime?: { server_version?: string; status?: string; connected?: boolean; executable?: string; configured_executable?: string; last_error?: string | null; error?: string | null; max_concurrent_tasks?: number };
};

export type TaskAction = "pause" | "resume" | "cancel" | "retry" | "accept" | "rework";
export type ContextAttachment = { type: "localImage"; path: string };

export const workStatusLabels: Record<WorkStatus, string> = {
  queued: "排队中", running: "执行中", waiting: "等待中", review: "待验收",
  completed: "已完成", paused: "已暂停", cancelled: "已取消", attention: "需要处理"
};

export function needsAttention(task: WorkTask) {
  return task.status === "review" || task.status === "attention" ||
    (task.status === "waiting" && !["dependency", "dependencies", "workspace", "capacity", "scheduled"].includes(task.wait_reason ?? ""));
}

export function isCurrentInteraction(interaction: TaskInteraction, task: WorkTask) {
  if (interaction.status !== "pending" || interaction.task_id !== task.task_id ||
      ["completed", "cancelled", "paused"].includes(task.status)) return false;
  // Business questions intentionally survive their yielding turn; the backend
  // expires them when the task generation changes and revalidates on response.
  if (interaction.kind === "question" || interaction.method === "task/question") return task.status === "waiting";
  return interaction.run_id === task.current_run_id;
}
