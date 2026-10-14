# Operations

## Health

`GET /api/v1/health` returns `{"status":"ok"}` without authentication and without details; it is used by the container healthcheck. A running process is not proof the data is current: the Overview shows freshness for host and Docker data.

## Reading the dashboard

- **Current / Stale / Unavailable** badges describe the age of each reading. Stale values are dimmed and explicitly labelled.
- **Demo data** means mock mode. Live mode shows "unavailable" until Phase 3 adapters exist.
- **Stopped (intentional / unexpected / intent unknown)** comes from the project's _desired state_. Set it on the project page; it records intent only and does not start or stop anything.
- Memory "cap" is a configured limit, not consumption.

## Logs

The API logs structured JSON (pino) to stdout with authorization and cookie headers redacted. Setting `HLCC_LOG_LEVEL=debug` does not add secrets, but treat logs as sensitive anyway.

## Resource target

About 256 MiB for the whole container (compose sets `mem_limit: 256m`). This is a target: **not yet measured**. Measure idle RSS after the first real run and update this page.

## Troubleshooting

| Symptom                               | Likely cause                                                     |
| ------------------------------------- | ---------------------------------------------------------------- |
| "Cannot reach the API"                | API not running, or the proxy/origin is misconfigured            |
| 403 `origin_not_allowed` on writes    | public origin missing from `HLCC_ALLOWED_ORIGINS`                |
| Cookie not kept over HTTPS            | set `HLCC_COOKIE_SECURE=true` and `HLCC_TRUST_PROXY=true`        |
| Setup token unknown                   | read the API log, or restart with `HLCC_SETUP_TOKEN` set         |
| 429 on login                          | 5 failures in 15 minutes; wait or restart (limiter is in memory) |
| Everything "unavailable" in live mode | expected until Phase 3                                           |
