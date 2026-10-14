# Architecture

Status key: **built** (exists and tested), **planned** (not built).

## Components

| Component                                    | Status              | Notes                                                                      |
| -------------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `apps/web` React SPA                         | built               | TanStack Query polls every 15 s; an SSE stream only nudges it to refetch   |
| `apps/api` Express API                       | built               | modules: routes → services → repositories; providers and security separate |
| `packages/shared`                            | built               | Zod schemas and pure logic shared by API and web                           |
| SQLite (`node:sqlite`)                       | built               | WAL mode, forward-only numbered migrations                                 |
| Mock provider                                | built               | deterministic demo data shaped like the audited server                     |
| Live providers (Docker, Netdata, host, HTTP) | planned (Phase 3)   | `createLiveProvider` currently fails loudly                                |
| Restricted worker/helper                     | planned (Phase 3/6) | allowlisted operations only                                                |

## Data flow

`Collector` polls the `Provider` every `HLCC_POLL_INTERVAL_MS`, stores the host sample in `metric_samples` (tagged `mock`/`live`), keeps the latest container snapshot in memory, and emits an `update` event for SSE. API handlers compute **freshness at request time** from the sample timestamp, so a stopped collector or restarted API shows `stale`/`unavailable` instead of an old value.

## Key rules encoded in code

- `freshness()` (shared): current ≤ 2.5 intervals, else stale; no reading = unavailable.
- `deriveProjectHealth()` (shared): no data or stale data = `unknown`; stopped is `stopped` unless the desired state is `running` (then `down`).
- Container `stopIntent` derives from the owning project's desired state, so intentional stops are not failures.
- Configured memory limits are returned as `memLimitBytes` and never used to compute usage; host memory comes from the host sample.
- History queries filter by the active source so demo rows never appear in live mode.

## Data model (current)

`users`, `sessions` (hashed token, CSRF token, expiry), `projects` (registry + capabilities + desired state), `metric_samples`, `audit_events`, `schema_migrations`. Planned later: deployments, health checks, alert rules/history, environment metadata and revisions (no plaintext secrets).

## API (v1)

Public: `GET /health` (status only), `GET /auth/status`, `POST /auth/setup|login`. Authenticated: `/overview`, `/metrics/current`, `/metrics/history`, `/projects[/:id[/health]]` (+ `POST`, `PATCH` for registry metadata), `/containers[/:id]`, `/audit`, `/stream`, and `/events`, `/deployments`, `/alerts` which return an explicit "not available" payload. There is no endpoint that runs commands or accepts paths or container operations.

## Planned deployment state machine (Phase 6)

`queued → validating → building → releasing → activating → health_checking → succeeded`, any step → `failed`; `failed`/`succeeded` → `rolling_back → rolled_back | rollback_failed`. Rollback only to previously verified releases recorded with a manifest.
