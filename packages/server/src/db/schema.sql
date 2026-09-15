-- Idempotent bootstrap migration. Future phases may append new migrations/tables.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  pending_plan_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  -- Prompt 7 widened this CHECK with 'cad' (the shared AgentMode union widened
  -- the same way). Databases created before CAD mode existed are migrated by
  -- db/client.ts, which rebuilds the table once — see ensureCadMode().
  mode TEXT NOT NULL CHECK (mode IN ('ask', 'agent', 'plan', 'cad')),
  tool_calls TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_sequence ON messages(session_id, sequence);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  label TEXT NOT NULL,
  file_snapshots TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diff_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  original_content TEXT NOT NULL,
  proposed_content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS diffs_session_status ON diff_proposals(session_id, status);
INSERT OR IGNORE INTO settings(key, value) VALUES ('schema_version', '1');

-- ---------------------------------------------------------------------------
-- Prompt 5 migration: codebase index. Appended to the same bootstrap file (it
-- is idempotent and re-run on every boot), so no second database file exists.
-- One row set per workspace root: the same server indexes every folder it is
-- ever pointed at, so vectors must never be shared between workspaces.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS index_workspaces (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL UNIQUE,
  model TEXT,
  dimensions INTEGER,
  status TEXT NOT NULL CHECK (status IN ('idle', 'indexing', 'ready', 'error')),
  files INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  last_build_at INTEGER,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS index_files (
  workspace_id TEXT NOT NULL REFERENCES index_workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, relative_path)
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES index_workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL,
  content TEXT NOT NULL,
  vector TEXT NOT NULL,          -- JSON-encoded float array (rounded to 6 dp)
  model TEXT NOT NULL,           -- embedding provider:model that produced it
  dimensions INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS embeddings_workspace ON embeddings(workspace_id);
CREATE INDEX IF NOT EXISTS embeddings_workspace_path ON embeddings(workspace_id, relative_path);
CREATE INDEX IF NOT EXISTS index_files_workspace ON index_files(workspace_id);

INSERT INTO settings(key, value) VALUES ('schema_version', '2')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- ---------------------------------------------------------------------------
-- Wireup engine workstate: the agentic hardware pipeline persists its projects
-- and the component catalog as JSON blobs through the pluggable sink seam. The
-- same forge.sqlite file therefore holds hardware state alongside sessions.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wireup_projects (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wireup_components (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Prompt 7 migration: CAD mode.
--
-- A CAD turn is persisted as a normal chat message with mode = 'cad', so the
-- CHECK above had to accept it. SQLite cannot relax a CHECK in place, so the
-- one-time rebuild for pre-existing databases lives in db/client.ts
-- (ensureCadMode), right after this file runs — it inspects sqlite_master, and
-- is a no-op for every database that already allows 'cad'. Nothing else in the
-- schema is touched: no column, index, or table from Prompts 3-6 changed.
-- ---------------------------------------------------------------------------
INSERT INTO settings(key, value) VALUES ('schema_version', '3')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
