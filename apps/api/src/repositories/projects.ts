import type { Project, ProjectInput } from '@hlcc/shared';
import type { Db } from '../db.ts';

type Row = Record<string, unknown>;

const toProject = (r: Row): Project => ({
  id: String(r.id),
  name: String(r.name),
  description: String(r.description),
  repoUrl: (r.repo_url as string | null) ?? null,
  deploymentDir: (r.deployment_dir as string | null) ?? null,
  environment: r.environment as Project['environment'],
  desiredState: r.desired_state as Project['desiredState'],
  healthUrl: (r.health_url as string | null) ?? null,
  healthAllowPrivate: Number(r.health_allow_private) === 1,
  containers: JSON.parse(String(r.containers)),
  capabilities: JSON.parse(String(r.capabilities)),
  createdAt: new Date(Number(r.created_at)).toISOString(),
  updatedAt: new Date(Number(r.updated_at)).toISOString(),
});

export const countProjects = (db: Db) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n);

export const listProjects = (db: Db): Project[] =>
  db.prepare('SELECT * FROM projects ORDER BY name').all().map(toProject);

export function getProject(db: Db, id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? toProject(row) : undefined;
}

/** Returns false when the id already exists. */
export function insertProject(db: Db, p: ProjectInput, now: number): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO projects
       (id, name, description, repo_url, deployment_dir, environment, desired_state, health_url,
        health_allow_private, containers, capabilities, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.id,
      p.name,
      p.description,
      p.repoUrl,
      p.deploymentDir,
      p.environment,
      p.desiredState,
      p.healthUrl,
      p.healthAllowPrivate ? 1 : 0,
      JSON.stringify(p.containers),
      JSON.stringify(p.capabilities),
      now,
      now,
    );
  return res.changes === 1;
}

/** Updates registry metadata only; capabilities are deliberately not editable here. */
export function updateProject(
  db: Db,
  id: string,
  patch: Partial<Omit<ProjectInput, 'id' | 'capabilities'>>,
  now: number,
): Project | undefined {
  const current = getProject(db, id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE projects SET name = ?, description = ?, repo_url = ?, deployment_dir = ?, environment = ?,
     desired_state = ?, health_url = ?, health_allow_private = ?, containers = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.description,
    next.repoUrl,
    next.deploymentDir,
    next.environment,
    next.desiredState,
    next.healthUrl,
    next.healthAllowPrivate ? 1 : 0,
    JSON.stringify(next.containers),
    now,
    id,
  );
  return getProject(db, id);
}
