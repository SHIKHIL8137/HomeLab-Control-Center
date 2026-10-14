# Architecture

Status key: **built** (exists and tested), **planned** (not built).

## Components

| Component                                    | Status            | Notes                                                                      |
| -------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `apps/web` React SPA                         | built             | TanStack Query polls every 15 s; an SSE stream only nudges it to refetch   |
| `apps/api` Express API                       | built             | modules: routes → services → repositories; providers and security separate |
| `packages/shared`                            | built             | Zod schemas and pure logic shared by API and web                           |
| SQLite (`node:sqlite`)                       | built             | WAL mode, forward-only numbered migrations                                 |
| Mock provider                                | built             | deterministic demo data shaped like the audited server                     |
| Docker proxy (`apps/docker-proxy`)           | built             | read-only allowlist in front of the socket; the only socket holder         |
| Live adapters: host (/proc), Docker, Netdata | built             | independent sources; each fails and reports on its own                     |
| HTTP health checker + SSRF guard             | built             | connect-time IP validation; results in `health_checks`                     |
| Deployment helper (privileged actions)       | planned (Phase 6) | allowlisted operations only; needs separate approval                       |
| Host agent (Wi-Fi, gateway, Tailscale)       | design only       | see host-agent-design.md                                                   |

## Data flow

`Collector` polls the `Provider` every `HLCC_POLL_INTERVAL_MS`, stores the host sample in `metric_samples` (tagged `mock`/`live`), keeps the latest container snapshot in memory, and emits an `update` event for SSE. API handlers compute **freshness at request time** from the sample timestamp, so a stopped collector or restarted API shows `stale`/`unavailable` instead of an old value.

## Key rules encoded in code

- `freshness()` (shared): current ≤ 2.5 intervals, else stale; no reading = unavailable.
- `deriveProjectHealth()` (shared): no data or stale data = `unknown`; stopped is `stopped` unless the desired state is `running` (then `down`).
- Container `stopIntent` derives from the owning project's desired state, so intentional stops are not failures.
- Configured memory limits are returned as `memLimitBytes` and never used to compute usage; host memory comes from the host sample.
- History queries filter by the active source so demo rows never appear in live mode.

## Data model (current)

`users`, `sessions` (hashed token, CSRF token, expiry), `projects` (registry, capabilities, desired state, health URL and private-target authorization), `metric_samples`, `container_events` (best-effort, bounded by retention), `health_checks` (results keyed by a URL fingerprint, never the URL), `audit_events`, `schema_migrations`. Planned later: deployments, health checks, alert rules/history, environment metadata and revisions (no plaintext secrets).

## API (v1)

Public: `GET /health` (status only), `GET /auth/status`, `POST /auth/setup|login`. Authenticated: `/overview`, `/metrics/current`, `/metrics/history`, `/projects[/:id[/health]]` (+ `POST`, `PATCH` for registry metadata), `/containers[/:id]`, `/audit`, `/stream`, and `/events`, `/deployments`, `/alerts` which return an explicit "not available" payload. There is no endpoint that runs commands or accepts paths or container operations.

## Planned deployment state machine (Phase 6)

`queued → validating → building → releasing → activating → health_checking → succeeded`, any step → `failed`; `failed`/`succeeded` → `rolling_back → rolled_back | rollback_failed`. Rollback only to previously verified releases recorded with a manifest.

## Trust boundaries

See [deployment.md](deployment.md) for the diagram. In short: the browser reaches only the dashboard (through an approved tunnel or Tailscale, then the application login); the dashboard API reaches the Docker proxy on a network with no outside route, authenticated by a shared credential; only the proxy touches the Docker socket, through six fixed read-only routes whose responses are rebuilt from an allowlist; outbound health checks and Netdata requests go through one SSRF guard. The API never receives container environments, commands, logs or the socket itself.

## Data model additions

`migrations/002_live_monitoring.sql` adds `container_events`, `health_checks` and `projects.health_allow_private`; `migrations/003_audit_append_only.sql` makes `audit_events` append-only with triggers. Retention prunes metric samples, container events, health checks and expired sessions only; users, projects and the audit trail are never pruned.
