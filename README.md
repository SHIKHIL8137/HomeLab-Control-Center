# HomeLab Control Center

A lightweight, self-hosted dashboard for a home server: host metrics, Docker containers, registered projects, health, audit history. **Read-only monitoring first**; deployment, environment editing and start/stop come in later phases and only with explicit approval.

> **Status: release candidate for a deployment review (Phases 1–3 plus hardening).** Everything is built and tested locally, including against a real Docker Engine (Docker Desktop) with the production Compose file. **Nothing has been run on the Ubuntu server and nothing has been deployed.** The Docker proxy is authenticated and allowlisted, secrets are delivered as files, and `npm run preflight` checks the deployment configuration without touching anything. Mock mode shows labelled demo data; live mode never falls back to it. See [docs/deployment.md](docs/deployment.md) for what is verified and what still needs the server.

## What works today

- First-run setup, login, sessions, CSRF protection, login rate limiting, audit log.
- SQLite persistence with versioned migrations.
- Overview, Projects, Project detail, Containers, Monitoring (history charts), Audit pages.
- Mock mode with demo data, always labelled. **Live mode never falls back to mock data**: with no live adapter it shows "unavailable".
- Stale-data detection: a reading older than 2.5 polling intervals is shown as stale and is never treated as healthy.
- Project registry with a capability policy (only `monitor` exists in this release).
- **Live monitoring (Phase 3, see [docs/live-monitoring.md](docs/live-monitoring.md))**:
  - Docker inventory, health, restart counts, memory caps and CPU/memory usage through a **read-only, allowlisting Docker proxy** (the API never sees the socket).
  - Host CPU, memory, swap, load, uptime and disks from `/proc`, **refused unless verified** as the monitored machine's (Docker Desktop VMs are detected), and a secondary disk that is just a folder on the root filesystem is reported as **"not a separate mount"**.
  - HTTP health checks with SSRF protection enforced at connection time (DNS rebinding, redirects, private/metadata ranges); **no URL is configured by default** and an unconfigured check reads "Not configured".
  - Optional read-only Netdata readings; best-effort container events; connectivity that is honest about what it cannot measure.
  - Each source fails independently and says why.

Navigation entries for Deployments, Logs, Alerts and Environment exist but are marked "not available yet" with the planned phase.

## Requirements

Node.js 24+ (uses the built-in `node:sqlite` and native TypeScript execution, so there is no native build step and no API build step). npm 10+.

## Quick start (local, mock mode)

```bash
npm ci
npm run dev        # API on :8787, web on http://localhost:5173
```

On first start in development the API writes a one-time **setup token** to a private file in the data directory (`data/setup-token`) and logs only its path; the token is never logged. Open the web app, enter it and choose an admin username and a password of at least 12 characters. To choose the token yourself set `HLCC_SETUP_TOKEN` or `HLCC_SETUP_TOKEN_FILE` (16+ characters). Production refuses to start first-run setup without a configured token.

## Commands

| Command                                 | Purpose                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`                           | API (watch mode) and web dev server                                                                   |
| `npm run check`                         | format check, lint, typecheck, tests, build, secret scan (CI gate)                                    |
| `npm test`                              | unit and integration tests (API with supertest, web with Testing Library)                             |
| `npm run typecheck` / `lint` / `format` | individual quality tools                                                                              |
| `npm run build`                         | production web build into `apps/web/dist`                                                             |
| `npm run scan`                          | scan tracked and uncommitted files for credentials                                                    |
| `npm run preflight`                     | non-destructive deployment checks (compose structure, secrets, paths, bundle); see docs/deployment.md |

Serve the built app from the API (single process): `HLCC_WEB_DIST=apps/web/dist npm run start -w @hlcc/api`.

## Configuration

All settings are environment variables, validated at startup (`apps/api/src/config.ts`). See [.env.example](.env.example). Key ones: `HLCC_MODE` (`mock`|`live`), `HLCC_HOST` (default `127.0.0.1`), `HLCC_DATA_DIR`, `HLCC_POLL_INTERVAL_MS`, `HLCC_RETENTION_HOURS`, `HLCC_COOKIE_SECURE`, `HLCC_ALLOWED_ORIGINS`.

## Repository layout

```
apps/api         Express API: auth, repositories, providers (mock/live), collector, routes
apps/web         React + Vite + Tailwind UI
packages/shared  Zod schemas, types, freshness and project-health logic (used by both)
migrations/      numbered SQL migrations, applied once each
apps/docker-proxy  Read-only, allowlisting proxy in front of the Docker socket (no dependencies)
deploy/          Dockerfile (api and proxy images) and compose.yaml, built and run locally, not on the server
docs/            architecture, security, local development, deployment, ubuntu-preflight, backup, operations
scripts/         check-secrets.mjs, preflight.mjs, ubuntu-preflight.sh, provision-secrets.sh
```

`apps/worker` from the original plan is intentionally absent: nothing privileged exists yet. The only component that touches Docker is the read-only proxy; a deployment helper arrives with Phase 6 and needs its own approval.

## Security model (summary)

Single administrator, setup gated by a one-time token, scrypt password hashing, server-side sessions stored as hashes, `HttpOnly` + `SameSite=Strict` cookies, per-session CSRF token, origin check on writes, login rate limiting, security headers, 10 kB body limit, secret redaction in audit records and logs, no shell or Docker access from the API. Details and gaps: [docs/security.md](docs/security.md).

## Known limitations

- No log viewer, alerts, deployments or environment management yet (Phases 4–7).
- **Not run on the Ubuntu server.** Host metrics there depend on Docker running directly on that machine; the cross-check is designed to confirm that at runtime, but it has only been exercised against Docker Desktop, where it correctly refused.
- Container events are best-effort (Docker replays only a small recent buffer); restart loops come from restart counts.
- Wi-Fi link, LAN gateway and Tailscale cannot be measured from a container and are shown as "Needs host agent". The host agent is a **design only** ([docs/host-agent-design.md](docs/host-agent-design.md)).
- The Netdata response format is tested against fixtures, not a live Netdata.
- Cloudflare Tunnel health is judged by a public end-to-end check, so it stays "unknown" until a public health URL is configured.
- Rate limiting and SSE connection counts are in memory (single instance only).
- The dashboard runs on the host it monitors, so it cannot prove the host is off; it can only show that reports stopped.
- Idle memory was measured at about 40 MiB (API) and 30 MiB (proxy) under Docker Desktop with 17 containers; the server's figures are not measured.

## GitHub workflow

`main` is stable; use feature branches. CI (`.github/workflows/ci.yml`) runs on **GitHub-hosted** runners only; never point this repository's workflows at the home server's self-hosted runner. Nothing is pushed or deployed without explicit approval. See [docs/deployment.md](docs/deployment.md).
