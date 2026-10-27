-- Additive migration. The business tree and old execution history are retained.
CREATE TABLE IF NOT EXISTS task_preferences (
  task_id TEXT PRIMARY KEY REFERENCES todo_tasks(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  archived_at TEXT,
  last_conversation_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('auto','manual')),
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  config_json TEXT NOT NULL,
  thread_id TEXT,
  current_run_id TEXT,
  runtime_status TEXT NOT NULL DEFAULT 'init',
  pinned INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_main ON chat_conversations(task_id) WHERE mode='auto';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_thread ON chat_conversations(thread_id) WHERE thread_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS chat_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('chat','extract')),
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT,
  thread_id TEXT,
  turn_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  source_boundary INTEGER,
  result_id TEXT,
  output TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_active_run ON chat_runs(conversation_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES chat_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_events_conversation ON chat_events(conversation_id,id);
CREATE TABLE IF NOT EXISTS chat_requests (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
  request_id_json TEXT NOT NULL,
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,request_id_json)
);
CREATE TABLE IF NOT EXISTS task_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES todo_tasks(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE RESTRICT,
  source_run_id TEXT,
  source_boundary INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL,
  stage TEXT NOT NULL,
  markdown TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed','withdrawn')),
  usable INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT REFERENCES task_results(id),
  created_at TEXT NOT NULL,
  error TEXT,
  UNIQUE(conversation_id,source_run_id,method,source_boundary)
);
CREATE INDEX IF NOT EXISTS idx_results_task ON task_results(task_id,created_at,id);
CREATE TABLE IF NOT EXISTS chat_pending_changes (
  task_id TEXT PRIMARY KEY REFERENCES todo_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
