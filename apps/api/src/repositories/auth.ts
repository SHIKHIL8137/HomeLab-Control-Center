import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
}

export function userCount(db: Db): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n);
}

/** Inserts only while the table is empty, in one statement, so concurrent setups cannot both win. */
export function createFirstUser(
  db: Db,
  username: string,
  passwordHash: string,
  now: number,
): number | null {
  const res = db
    .prepare(
      'INSERT INTO users (username, password_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)',
    )
    .run(username, passwordHash, now);
  return res.changes === 1 ? Number(res.lastInsertRowid) : null;
}

export function getUserByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as UserRow | undefined;
}

export interface SessionInfo {
  userId: number;
  username: string;
  csrfToken: string;
}

export function createSession(db: Db, userId: number, now: number, ttlMs: number) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(sha256(token), userId, csrfToken, now, now + ttlMs);
  return { token, csrfToken, expiresAt: now + ttlMs };
}

export function getSession(db: Db, token: string, now: number): SessionInfo | undefined {
  const row = db
    .prepare(
      `SELECT s.user_id AS userId, u.username AS username, s.csrf_token AS csrfToken
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), now);
  return row as SessionInfo | undefined;
}

export function deleteSession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token));
}

export function purgeExpiredSessions(db: Db, now: number): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

export function updatePasswordHash(db: Db, userId: number, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}
