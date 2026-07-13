CREATE TABLE IF NOT EXISTS thread_task_links (
  thread_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES codex_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES todo_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_task_links_task
  ON thread_task_links(task_id, thread_id);
