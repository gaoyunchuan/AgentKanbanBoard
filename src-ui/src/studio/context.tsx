import { createContext, useContext } from "react";
import type { StudioApi } from "./api";
import type { Workspace, StudioTask, Conversation, ConversationDetail } from "./model";

export type DialogState =
  | { kind: "createTask"; parent?: string }
  | { kind: "renameTask" | "dependencies" | "projectTask" | "deleteTask" | "completeTask"; task: string }
  | { kind: "context"; task: string; importTo?: string }
  | { kind: "project"; id?: string }
  | { kind: "models" | "permissions" | "settings" | "inbox" | "deleted" }
  | { kind: "renameConversation"; conversation: string };
export type Panel = "properties" | "context" | "results" | "browser" | "diff" | "workspace" | null;
export type Draft = { text: string; importContext: boolean; attachments: { name: string; input?: unknown; text?: string }[] };
export type StudioState = {
  api: StudioApi;
  data: Workspace;
  detail: ConversationDetail | null;
  task?: StudioTask;
  conversation?: Conversation;
  view: "chat" | "tasks" | "projects";
  panel: Panel;
  setPanel: (panel: Panel) => void;
  openDialog: (dialog: DialogState) => void;
  setView: (view: "chat" | "tasks" | "projects") => void;
  openTask: (id: string) => void;
  openConversation: (id: string) => void;
  locateTask: (id: string) => void;
  inspectTask: (id: string, panel?: Panel) => void;
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
