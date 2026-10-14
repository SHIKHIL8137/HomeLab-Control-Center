# Local development

1. `node -v` must be 24 or newer. `npm ci`.
2. `npm run dev` starts the API on `127.0.0.1:8787` and Vite on `http://localhost:5173` (Vite proxies `/api`, so cookies and origin checks behave as in production).
3. Copy the setup token from the API log, or set `HLCC_SETUP_TOKEN` in a local `.env` (git-ignored).
4. Data lives in `./data/hlcc.db` (git-ignored). Delete the folder to reset, including the admin account.

## Mock vs live

`HLCC_MODE=mock` (default) serves demo data, labelled by a banner and "Demo data" badges. `HLCC_MODE=live` currently has no adapters, so the UI shows "unavailable" and the collector error; this is intentional.

## Tests

`npm test` runs all workspaces. API tests use an in-memory SQLite database, a fake clock and a fake provider, so no network or server is touched. Web tests use jsdom. There are no end-to-end browser tests yet; the UI was checked manually in a browser against the built app.

## Adding a migration

Add `migrations/NNN_description.sql` (next number). It runs once, inside a transaction, at startup. Never edit an applied migration.

## Node note

The API runs `.ts` directly through Node's type stripping, so source uses `.ts` import extensions, no enums, and no constructor parameter properties (`erasableSyntaxOnly` enforces this).
