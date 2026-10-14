import type { AuditEvent } from '@hlcc/shared';
import type { Db } from '../db.ts';
import { redactText, redactValue } from '../security/redact.ts';

export interface AuditInput {
  actor: string;
  action: string;
  target?: string | null;
  outcome: 'success' | 'failure' | 'denied';
  ip?: string | null;
  detail?: unknown;
}

/** Details are redacted before they are written; callers must not rely on that and pass secrets. */
export function recordAudit(db: Db, e: AuditInput, now: number): void {
  db.prepare(
    'INSERT INTO audit_events (ts, actor, action, target, outcome, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    now,
    redactText(e.actor).slice(0, 100),
    e.action,
    e.target ?? null,
    e.outcome,
    e.ip ?? null,
    e.detail === undefined ? null : JSON.stringify(redactValue(e.detail)),
  );
}

export function listAudit(db: Db, limit: number, beforeId?: number): AuditEvent[] {
  const rows = beforeId
    ? db
        .prepare('SELECT * FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT ?')
        .all(beforeId, limit)
    : db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    actor: String(r.actor),
    action: String(r.action),
    target: (r.target as string | null) ?? null,
    outcome: String(r.outcome),
    ip: (r.ip as string | null) ?? null,
    detail: r.detail ? JSON.parse(String(r.detail)) : null,
  }));
}
