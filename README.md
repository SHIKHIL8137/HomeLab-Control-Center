# HomeLab Control Center

A lightweight, self-hosted dashboard for a home server: host metrics, Docker containers, registered projects, health, audit history. **Read-only monitoring first**; deployment, environment editing and start/stop come in later phases and only with explicit approval.

> **Status: Phases 1–2 (local foundation + read-only dashboard).** It runs locally with clearly labelled demo data. Live adapters (Docker, Netdata, host, HTTP checks) are **not implemented yet** (Phase 3). It has not been deployed to any server.

## What works today

- First-run setup, login, sessions, CSRF protection, login rate limiting, audit log.
- SQLite persistence with versioned migrations.
- Overview, Projects, Project detail, Containers, Monitoring (history charts), Audit pages.
- Mock mode with demo data, always labelled. **Live mode never falls back to mock data**: with no live adapter it shows "unavailable".
- Stale-data detection: a reading older than 2.5 polling intervals is shown as stale and is never treated as healthy.
- Project registry with a capability policy (only `monitor` exists in this release).

Navigation entries for Deployments, Logs, Alerts and Environment exist but are marked "not available yet" with the planned phase.

## Requirements

Node.js 24+ (uses the built-in `node:sqlite` and native TypeScript execution, so there is no native build step and no API build step). npm 10+.

## Quick start (local, mock mode)

```bash
npm ci
npm run dev        # API on :8787, web on http://localhost:5173
```

On first start the API log prints a one-time **setup token**; open the web app, enter it and choose an admin username and a password of at least 12 characters. To choose the token yourself set `HLCC_SETUP_TOKEN` (16+ characters); it is never echoed.

## Commands

| Command                                 | Purpose                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`                           | API (watch mode) and web dev server                                       |
| `npm run check`                         | format check, lint, typecheck, tests, build, secret scan (CI gate)        |
| `npm test`                              | unit and integration tests (API with supertest, web with Testing Library) |
| `npm run typecheck` / `lint` / `format` | individual quality tools                                                  |
| `npm run build`                         | production web build into `apps/web/dist`                                 |
| `npm run scan`                          | scan tracked and uncommitted files for credentials                        |

Serve the built app from the API (single process): `HLCC_WEB_DIST=apps/web/dist npm run start -w @hlcc/api`.

## Configuration

All settings are environment variables, validated at startup (`apps/api/src/config.ts`). See [.env.example](.env.example). Key ones: `HLCC_MODE` (`mock`|`live`), `HLCC_HOST` (default `127.0.0.1`), `HLCC_DATA_DIR`, `HLCC_POLL_INTERVAL_MS`, `HLCC_RETENTION_HOURS`, `HLCC_COOKIE_SECURE`, `HLCC_ALLOWED_ORIGINS`.

## Repository layout

```
apps/api         Express API: auth, repositories, providers (mock/live), collector, routes
apps/web         React + Vite + Tailwind UI
packages/shared  Zod schemas, types, freshness and project-health logic (used by both)
migrations/      numbered SQL migrations, applied once each
deploy/          Dockerfile and compose.yaml (not yet verified, see docs/deployment.md)
docs/            architecture, security, local development, deployment, backup, operations
scripts/         check-secrets.mjs
```

`apps/worker` from the original plan is intentionally absent: nothing privileged exists yet, so there is nothing for a worker to do. It arrives with Phase 3/6 as a restricted, allowlisted helper.

## Security model (summary)

Single administrator, setup gated by a one-time token, scrypt password hashing, server-side sessions stored as hashes, `HttpOnly` + `SameSite=Strict` cookies, per-session CSRF token, origin check on writes, login rate limiting, security headers, 10 kB body limit, secret redaction in audit records and logs, no shell or Docker access from the API. Details and gaps: [docs/security.md](docs/security.md).

## Known limitations

- No live data yet (Phase 3). No log viewer, alerts, deployments or environment management yet.
- HTTP health URLs can be stored but are not probed yet.
- Connectivity (Wi-Fi, gateway, DNS, Tailscale, Cloudflare Tunnel) is shown as "Not measured".
- Rate limiting and SSE connection counts are in memory (single instance only).
- `deploy/Dockerfile` and `compose.yaml` were written but **not built or run** (no Docker daemon was available during development).
- The dashboard runs on the host it monitors, so it cannot prove the host is off; it can only show that reports stopped.

## GitHub workflow

`main` is stable; use feature branches. CI (`.github/workflows/ci.yml`) runs on **GitHub-hosted** runners only; never point this repository's workflows at the home server's self-hosted runner. Nothing is pushed or deployed without explicit approval. See [docs/deployment.md](docs/deployment.md).
