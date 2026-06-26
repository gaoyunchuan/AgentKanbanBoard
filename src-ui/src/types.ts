export type BoardStatus =
  | "untriaged"
  | "running"
  | "review_pending"
  | "reviewed"
  | "suspended"
  | "archived";

export type TaskType = "unset" | "feature" | "bugfix" | "review" | "docs" | "ops";

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
  suspendedUntil?: string;
  archivedAt?: string;
  notes: string;
  comments: ThreadComment[];
};

export type ThreadComment = {
  id: number;
  threadId: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt?: string;
};

export type FilterState = {
  search: string;
  projectId: string;
  boardStatus: string;
  taskType: string;
  sprint: string;
  showArchived: boolean;
};

export type BackendProject = {
  id: string;
  name: string;
  path: string;
  origin_url?: string | null;
  aliases: string[];
  active: boolean;
};

export type BackendThread = {
  id: string;
  project_id?: string | null;
  title: string;
  preview: string;
  cwd: string;
  branch: string;
  source_kind: string;
  codex_status: string;
  codex_sub_status: string;
  board_status: BoardStatus;
  task_type?: Exclude<TaskType, "unset"> | null;
  module: string;
  sprint: string;
  notes: string;
  first_seen_at: string;
  last_seen_running_at?: string | null;
  last_seen_completed_at?: string | null;
  manual_status_override: boolean;
  manual_status_updated_at?: string | null;
  suspended_until?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
  comments?: BackendThreadComment[];
};

export type BackendThreadComment = {
  id: number;
  thread_id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
  edited_at?: string | null;
};

export type BoardData = {
  threads: BackendThread[];
  projects: BackendProject[];
  sync_error?: string | null;
};
