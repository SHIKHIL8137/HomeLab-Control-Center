-- Phase 1-2 schema. Later phases add deployments, alerts, env metadata via new numbered files.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Only a SHA-256 of the session token is stored, so a leaked database cannot be replayed.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_url TEXT,
  deployment_dir TEXT,
  environment TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  health_url TEXT,
  containers TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '["monitor"]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Host samples only. "source" keeps mock and live rows apart so demo data never shows in live mode.
CREATE TABLE metric_samples (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  cpu_percent REAL,
  mem_used INTEGER,
  mem_total INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX idx_metric_samples_source_ts ON metric_samples(source, ts);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL,
  ip TEXT,
  detail TEXT
);
