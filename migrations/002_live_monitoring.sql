-- Phase 3: container events, HTTP health-check history, per-project private-target authorization.

-- Bounded by retention (pruned by the collector). Docker's own replay buffer is small, so this is
-- best-effort history, not an audit trail.
CREATE TABLE container_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  container TEXT NOT NULL,
  action TEXT NOT NULL,
  exit_code INTEGER,
  UNIQUE (source, ts, container, action)
);
CREATE INDEX idx_container_events_source_ts ON container_events(source, ts);

-- "target_fp" fingerprints the configured URL + authorization, so results for an old URL are
-- never shown for a new one. The URL itself is not stored here (it may carry a query token).
CREATE TABLE health_checks (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  project_id TEXT NOT NULL,
  target_fp TEXT NOT NULL,
  state TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT,
  target_class TEXT
);
CREATE INDEX idx_health_checks_project ON health_checks(project_id, source, target_fp, ts);

ALTER TABLE projects ADD COLUMN health_allow_private INTEGER NOT NULL DEFAULT 0;
