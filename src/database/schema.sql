CREATE TABLE IF NOT EXISTS jira_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  email TEXT NOT NULL,
  api_token TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jira_connection_id INTEGER,
  jira_key TEXT,
  description TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (jira_connection_id) REFERENCES jira_connections(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS time_slices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  start_time TEXT NOT NULL, -- ISO8601
  end_time TEXT, -- Nullable if currently tracking
  notes TEXT,
  synced_to_jira INTEGER DEFAULT 0,
  jira_worklog_id TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_time_slices_jira_worklog_id
  ON time_slices(jira_worklog_id)
  WHERE jira_worklog_id IS NOT NULL;
