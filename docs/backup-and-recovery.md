# Backup and recovery

Status: **plan only**. The audit found no scheduled backups on the server; this application adds none yet.

## What to back up

- `hlcc.db` (SQLite, WAL mode): use `sqlite3 hlcc.db ".backup file"` or stop the container; never copy the `-wal` file alone.
- Configuration: the environment file and compose overrides (not the repo).
- Phase 7 only: the secret-store encryption key, stored **separately** from the database and its backups, with its own recovery procedure.

## Rules

- Backups go outside the container and outside the release directory, ideally on a different disk than the live data.
- Never delete backups automatically to free space; warn instead.
- Retention and schedule are to be decided with the owner before write operations are enabled.

## Recovery scenarios (to be rehearsed before Phase 6)

- **Failed upgrade:** stop the container, restore the previous image tag, restore the last database backup if a migration ran.
- **Power loss / unclean reboot:** SQLite WAL recovers on open. Collected history may lose the last seconds; samples are marked stale until the collector runs again. The audited server has had an unclean reboot, so this is expected.
- **Lost admin password:** stop the API, delete the `users` and `sessions` rows (or the database), restart to get a new setup token.
- **Failed rollback (Phase 6):** the previous release directory is kept; reactivate it manually via the `current` symlink.
