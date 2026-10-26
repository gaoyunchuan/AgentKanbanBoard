import { invoke } from "@tauri-apps/api/core";
import type { ContextAttachment, TaskAction, TaskConfig, TaskExecutionDetail, WorkbenchData } from "./types";

export const workbenchApi = {
  load: () => invoke<WorkbenchData>("load_workbench"),
  detail: (taskId: string) => invoke<TaskExecutionDetail>("load_task_execution", { taskId }),
  delegate: (taskId: string, config: TaskConfig) => invoke("delegate_task", { taskId, config }),
  action: (taskId: string, action: TaskAction, expectedRevision: number, feedback?: string) =>
    invoke("task_action", { taskId, action, expectedRevision, feedback: feedback ?? null }),
  message: (taskId: string, text: string, expectedRunId?: string | null, attachments: ContextAttachment[] = []) =>
    invoke("send_task_message", { taskId, text, expectedRunId: expectedRunId ?? null, attachments }),
  respond: (taskId: string, interactionId: string, runId: string, response: unknown) =>
    invoke("respond_task_interaction", { taskId, interactionId, runId, response })
};

export type WorkbenchApi = typeof workbenchApi;
