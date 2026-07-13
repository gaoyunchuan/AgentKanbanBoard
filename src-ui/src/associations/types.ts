import type { BackendThreadTaskLink, ThreadTaskLinkOrigin } from "@/types";

export type ThreadTaskLink = {
  threadId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
};

export type AssociationOption = {
  id: string;
  label: string;
  description?: string;
  group?: "待审核" | "挂起";
  depth: number;
  disabled?: boolean;
  current?: boolean;
};

export type AssociationIntent = {
  kind: "assign" | "unlink";
  threadId: string;
  taskId?: string;
  origin: ThreadTaskLinkOrigin;
};

export type AssociationNoticeState = {
  message: string;
  actionLabel?: "撤销" | "重试";
  threadId?: string;
  previousTaskId?: string;
  failedIntent?: AssociationIntent;
};

export const mapBackendThreadTaskLink = (
  link: BackendThreadTaskLink
): ThreadTaskLink => ({
  threadId: link.thread_id,
  taskId: link.task_id,
  createdAt: link.created_at,
  updatedAt: link.updated_at
});
