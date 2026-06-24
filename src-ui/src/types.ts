export type BoardStatus =
  | "untriaged"
  | "running"
  | "review_pending"
  | "reviewed"
  | "archived";

export type TaskType = "feature" | "bugfix" | "review" | "docs" | "ops";

export type Project = {
  id: string;
  name: string;
  path: string;
  originUrl?: string;
  promptTemplate?: string;
  aliases: string[];
  active: boolean;
};

export type ThreadItem = {
  id: string;
  codexSessionId?: string;
  title: string;
  preview: string;
  projectId: string;
  cwd: string;
  branch: string;
  boardStatus: BoardStatus;
  codexStatus: string;
  subStatus: string;
  taskType: TaskType;
  module: string;
  sprint: string;
  updatedAt: string;
  createdAt: string;
  lastSeenRunningAt?: string;
  archivedAt?: string;
  notes: string;
};

export type FilterState = {
  search: string;
  projectId: string;
  boardStatus: string;
  taskType: string;
  sprint: string;
  showArchived: boolean;
};
