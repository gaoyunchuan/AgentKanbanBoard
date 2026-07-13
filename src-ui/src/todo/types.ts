export type TodoStatus = "todo" | "in_progress" | "cancelled" | "completed";

export type TodoTask = {
  id: string;
  parentId?: string;
  position: number;
  title: string;
  status: TodoStatus;
  startDate?: string;
  expectedEndDate?: string;
  actualEndDate?: string;
  createdAt?: string;
  processTracking: string;
  resultReview: string;
};

export type BackendTodoTask = {
  id: string;
  parent_id?: string | null;
  position: number;
  title: string;
  status: TodoStatus;
  start_date?: string | null;
  expected_end_date?: string | null;
  actual_end_date?: string | null;
  process_tracking: string;
  result_review: string;
  created_at: string;
  updated_at: string;
};

export type FlatTodoTask = {
  task: TodoTask;
  depth: number;
  hasChildren: boolean;
};
