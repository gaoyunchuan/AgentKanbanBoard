-- 本地数据库路径：~/.codex-kanban/app.db
-- 首版只持久化 Codex thread 快照和人工字段，不写回 Codex Desktop。

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  origin_url TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'codex',
  codex_status TEXT NOT NULL DEFAULT 'unknown',
  raw_status TEXT NOT NULL DEFAULT 'unknown',
  codex_sub_status TEXT NOT NULL DEFAULT '',
  board_status TEXT NOT NULL DEFAULT 'untriaged'
    CHECK (board_status IN ('untriaged', 'running', 'review_pending', 'reviewed', 'archived')),
  task_type TEXT NOT NULL DEFAULT ''
    CHECK (task_type IN ('', 'feature', 'bugfix', 'review', 'docs', 'ops')),
  module TEXT NOT NULL DEFAULT '',
  sprint TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_running_at TEXT,
  last_seen_completed_at TEXT,
  manual_status_override INTEGER NOT NULL DEFAULT 0,
  manual_status_updated_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS filter_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  filters_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codex_threads_project ON codex_threads(project_id);
CREATE INDEX IF NOT EXISTS idx_codex_threads_board_status ON codex_threads(board_status);
CREATE INDEX IF NOT EXISTS idx_codex_threads_updated_at ON codex_threads(updated_at);
