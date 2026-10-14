-- The audit trail is append-only: rows can be added but never changed or removed, not even by a bug
-- in the application. (Retention for audit events is intentionally not implemented; see docs.)
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
