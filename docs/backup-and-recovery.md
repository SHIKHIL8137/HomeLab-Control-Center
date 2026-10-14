# Backup and recovery

Status: **procedures only**. The audit found no scheduled backups on the server and this application does not create any. Whether a backup job exists on the server, and whether a restore has been rehearsed, are server-side questions.

## What there is to back up

Everything the dashboard needs lives in one directory, `HLCC_DATA_PATH` (mounted at `/data`):

| File                         | Contents                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hlcc.db`                    | the SQLite database: `users`, `sessions`, `projects`, `metric_samples`, `container_events`, `health_checks`, `audit_events`, `schema_migrations` |
| `hlcc.db-wal`, `hlcc.db-shm` | SQLite's write-ahead log and shared memory; part of the live database, never copy them on their own                                              |

Not in the database and not backed up by it: the secret files (`HLCC_SECRET_*_FILE`), your env file, and the repository. Keep copies of those separately and securely. **Losing the secret files is harmless** (generate new ones; see deployment.md), but losing the database means losing the administrator account, history and the audit trail.

## Before the first deployment

The dashboard's own database does not exist yet, so there is nothing of it to back up. What to do first, because a deployment must not make anything harder to recover:

| Before deploying, make sure you have                                                                                                           | Why                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your own copy of the **env file**                                                                                                              | Not in Git, and the deployment cannot start without it                                                                                                          |
| The **two secret files** stored in a password manager or other encrypted store                                                                 | They are generated once (see deployment.md). Losing them is recoverable by regenerating, but a stored copy avoids a restart-and-rotate under pressure           |
| A record of the current **Cloudflare Access policy and tunnel public hostnames** (screenshots or exported notes from the Cloudflare dashboard) | Nothing here changes them, but you need to be able to put them back if a later step goes wrong. The tunnel token itself is a secret: do not paste it into notes |
| Confirmation that existing projects' own backups (Nextcloud data on `/srv/storage`, DevConnect and DevWorkspace databases) are as you expect   | The audit found no scheduled backups on the server. This release does not touch those projects, mounts none of their data and cannot restore them               |
| A place for dashboard backups on a **different disk**                                                                                          | See below; decide this before the first backup is needed                                                                                                        |

After the first successful sign-in, take a first backup straight away so a restore point exists from day one.

## Taking a consistent backup

Prefer SQLite's own online backup, which is safe while the dashboard runs. It writes a new file and **refuses to overwrite an existing one**, so use a name that is unique for each run (the date and time here):

```bash
docker compose -f deploy/compose.yaml exec hlcc node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/data/hlcc.db');
const f='/data/backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.db';
db.exec(\"VACUUM INTO '\"+f+\"'\");
console.log(f);
"
```

Then **verify it before trusting it**, and copy it to **another disk** (not inside the container, and ideally not the physical disk holding `/data`):

```bash
docker compose -f deploy/compose.yaml exec hlcc node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1],{readOnly:true});
console.log(db.prepare('PRAGMA integrity_check').get());
" /data/backup-<the name printed above>.db
```

It must print `{ integrity_check: 'ok' }` (Node may show `[Object: null prototype]` in front of it). Backups contain password hashes and the audit trail: keep them mode 600 and treat them as secrets. Alternatively stop the stack (`docker compose stop`) and copy `hlcc.db` after the WAL has been checkpointed on clean shutdown. Take a backup **before every upgrade**, because migrations are forward-only.

Both the online backup and restoring it (including a backup older than the current migrations, which is upgraded on start) are exercised by `apps/api/test/backup.test.ts` against the real migrations. That proves the procedure works, not that your server's disks, permissions or schedule do; rehearse one restore on the server before relying on it.

Rules: never delete backups automatically to free space; the dashboard does not prune them. Retention and schedule are decisions for the owner.

## Restoring

1. `docker compose -f deploy/compose.yaml stop`.
2. Move the damaged `hlcc.db`, `hlcc.db-wal` and `hlcc.db-shm` aside (do not delete them yet).
3. Copy the backup to `HLCC_DATA_PATH/hlcc.db`, owned by uid 1000, mode 600.
4. `docker compose … up -d`. The application applies any migrations the backup predates, in order.
5. Sign in, check the audit page, then discard the old files once you are satisfied.

## Recovery scenarios

| Situation                                  | What to do                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Failed upgrade** (a migration failed)    | The failing migration is rolled back and not recorded, and the process refuses to start. Fix or revert the release; the database is unchanged and needs no restore.                                                                                                                          |
| **Upgrade that worked but must be undone** | Stop, restore the pre-upgrade backup, check out the previous release, start.                                                                                                                                                                                                                 |
| **Failed rollback**                        | The previous images and the database are both untouched by a rollback attempt; redo the steps above. Keep the pre-upgrade backup until the new release has run cleanly.                                                                                                                      |
| **Power loss or unclean reboot**           | SQLite recovers its write-ahead log on the next open. The last few seconds of history may be missing, and readings are shown as stale until collection resumes. Containers restart by policy. The audited server has had an unclean reboot, so expect this.                                  |
| **Lost administrator password**            | Stop the stack; with a backup of the database in hand, delete the `users` and `sessions` rows (`sqlite3` or a one-off `node:sqlite` script). On the next start, first-run setup is available again and needs the setup token. (The audit table is append-only, so existing audit rows stay.) |
| **Corrupted database**                     | Restore the latest backup. If there is none, `hlcc.db` can be recreated empty: you lose the account, history and audit trail but nothing else, because the dashboard only observes.                                                                                                          |
| **Compromised credential**                 | Rotate it (deployment.md). The proxy credential gives access only to the allowlisted read-only routes.                                                                                                                                                                                       |

## Storage warnings

The Overview shows each disk's used and available space and flags a secondary disk that is not actually mounted. A low-disk alert rule arrives with Phase 4; until then, watch the Disks card. A full disk makes database writes fail; the dashboard then shows "Stored history has a problem" while still showing live readings, and it does not crash.
