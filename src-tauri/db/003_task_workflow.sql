-- The task tree remains the business record. Execution state, attempts and human
-- requests are durable and never inferred from an idle chat or a final sentence.
CREATE TABLE IF NOT EXISTS work_tasks (
  task_id TEXT PRIMARY KEY REFERENCES todo_tasks(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','review','completed','paused','cancelled','attention')),
  revision INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 0,
  current_run_id TEXT,
  thread_id TEXT,
  wait_reason TEXT,
  last_error TEXT,
  result_summary TEXT,
  continuation_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_dependencies (
  task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
  blocked_by TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE RESTRICT,
  PRIMARY KEY(task_id, blocked_by),
  CHECK(task_id <> blocked_by)
);
CREATE INDEX IF NOT EXISTS idx_work_dependencies_blocker ON work_dependencies(blocked_by, task_id);
CREATE TABLE IF NOT EXISTS work_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  prompt TEXT NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(task_id, generation)
);
CREATE INDEX IF NOT EXISTS idx_work_runs_task ON work_runs(task_id, generation);
CREATE TABLE IF NOT EXISTS work_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_events_task ON work_events(task_id, id);
CREATE TABLE IF NOT EXISTS work_interactions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
  request_id_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','resolved','expired')),
  response_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(run_id, request_id_json)
);
CREATE INDEX IF NOT EXISTS idx_work_interactions_pending ON work_interactions(task_id, status);
