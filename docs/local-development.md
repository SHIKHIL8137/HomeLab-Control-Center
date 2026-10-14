# Local development

1. `node -v` must be 24 or newer. `npm ci`.
2. `npm run dev` starts the API on `127.0.0.1:8787` and Vite on `http://localhost:5173` (Vite proxies `/api`, so cookies and origin checks behave as in production).
3. The setup token is written to `data/setup-token` (the log shows only the path, never the token); or set `HLCC_SETUP_TOKEN` in a local `.env` (git-ignored). The file is deleted once setup completes.
4. Data lives in `./data/hlcc.db` (git-ignored). Delete the folder to reset, including the admin account.

## Mock vs live

`HLCC_MODE=mock` (default) serves demo data, labelled by a banner and "Demo data" badges, and makes no network requests. `HLCC_MODE=live` uses the real adapters and never falls back to mock data; with nothing configured every integration reports itself unavailable. See [live-monitoring.md](live-monitoring.md).

Live mode on a laptop with Docker Desktop will (correctly) refuse host metrics, because `/proc` there describes Docker's VM. To exercise the Docker side locally, run `apps/docker-proxy` against your Docker engine and point `HLCC_DOCKER_URL` at it, or use `deploy/compose.yaml` with `DOCKER_GID=0` (Docker Desktop's socket is root-owned). Use uniquely named test containers and remove them afterwards.

## Tests

`npm test` runs all workspaces. API tests use an in-memory SQLite database, a fake clock and a fake provider, so no network or server is touched. Web tests use jsdom. Adapter tests run against recorded real Docker responses (`apps/api/test/fixtures/docker`), local fake servers and temporary procfs fixtures; the SSRF tests make real connections to loopback servers. There are no automated end-to-end browser tests; the UI was checked manually in a browser, and the Compose stack was smoke-tested by hand against Docker Desktop (see [deployment.md](deployment.md)).

## Adding a migration

Add `migrations/NNN_description.sql` (next number). It runs once, inside a transaction, at startup. Never edit an applied migration.

## Node note

The API runs `.ts` directly through Node's type stripping, so source uses `.ts` import extensions, no enums, and no constructor parameter properties (`erasableSyntaxOnly` enforces this).
