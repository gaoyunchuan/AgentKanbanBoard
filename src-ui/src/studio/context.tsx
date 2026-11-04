import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { TaskQuery } from "./taskFilters";
import type { StudioApi } from "./api";
import type { Workspace, StudioTask, Conversation, ConversationDetail } from "./model";
import type { TaskConfig } from "../workbench/types";

export type View = "chat" | "tasks" | "projects" | "attention" | "settings";
export type DialogState =
  | { kind: "createTask"; parent?: string }
  | { kind: "dependencies" | "projectTask" | "deleteTask" | "completeTask"; task: string }
  | { kind: "context"; task: string; importTo?: string }
  | { kind: "bindCodex"; task: string }
  | { kind: "project"; id?: string }
  | { kind: "models" | "permissions" | "deleted" }
  | { kind: "taskState"; task: string; state: "todo" | "in_progress" | "completed" | "cancelled" }
  | { kind: "renameConversation" | "deleteConversation" | "recoverConnection"; conversation: string };
export type Panel = "content" | "properties" | "context" | "results" | "browser" | "diff" | "workspace" | "files" | "terminal" | null;
export type ModelConfig = Pick<TaskConfig, 'model' | 'reasoning_effort'>;
export type Draft = { text: string; projectId?: string; modelConfig?: ModelConfig; importContext: boolean; attachments: { name: string; input?: unknown; text?: string }[] };
export type StudioState = {
  taskQuery: TaskQuery;
  setTaskQuery: Dispatch<SetStateAction<TaskQuery>>;
  api: StudioApi;
  data: Workspace;
  detail: ConversationDetail | null;
  task?: StudioTask;
  conversation?: Conversation;
  view: View;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  panelRevision?:number;
  inspectorOpen?:boolean;
  inspectorTab?:'content'|'properties';
  setInspectorOpen?:Dispatch<SetStateAction<boolean>>;
  overlayOpen?:boolean;
  toolRequest?: {kind:'files'|'terminal'|'diff'|'browser';sequence:number;target?:string};
  openTool?: (kind:'files'|'terminal'|'diff'|'browser',target?:string) => void;
  openDialog: (dialog: DialogState) => void;
  setView: (view: View) => void;
  openTask: (id: string) => void;
  openConversation: (id: string) => void;
  locateTask: (id: string) => void;
  taskReveal: string | null;
  completeTaskReveal: (id: string) => void;
  inspectTask: (id: string, panel?: Panel) => void;
  changeTaskState: (task: StudioTask, state: "todo" | "in_progress" | "completed" | "cancelled") => void;
  newConversation: (taskId: string) => Promise<void>;
  refresh: () => Promise<void>;
  command: <T = unknown>(method: string, params?: Record<string, unknown>, success?: string) => Promise<T>;
  notify: (message: string) => void;
  busy: boolean;
};
export const StudioContext = createContext<StudioState | null>(null);
export function useStudio() {
  const value = useContext(StudioContext);
  if (!value) throw new Error("缺少会话工作区");
  return value;
}
