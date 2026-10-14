# Operations

## Health

`GET /api/v1/health` returns `{"status":"ok"}` without authentication and without details; it is used by the container healthcheck. A running process is not proof the data is current: the Overview shows freshness for host and Docker data.

## Reading the dashboard

- **Current / Stale / Unavailable** badges describe the age of each reading. Stale values are dimmed and explicitly labelled.
- **Demo data** means mock mode. In live mode each source (host, Docker, Netdata) shows its own error when it fails; nothing is substituted.
- **Stopped (intentional / unexpected / intent unknown)** comes from the project's _desired state_. Set it on the project page; it records intent only and does not start or stop anything.
- Memory "cap" is a configured limit, not consumption.

## Logs

The API logs structured JSON (pino) to stdout with authorization and cookie headers redacted. Setting `HLCC_LOG_LEVEL=debug` does not add secrets, but treat logs as sensitive anyway.

## Resource target

About 256 MiB for the whole container (compose sets `mem_limit: 256m`). This is a target: **not yet measured**. Measure idle RSS after the first real run and update this page.

## Troubleshooting

| Symptom                                         | Likely cause                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot reach the API"                          | API not running, or the proxy/origin is misconfigured                                                                                                                                                |
| 403 `origin_not_allowed` on writes              | public origin missing from `HLCC_ALLOWED_ORIGINS`                                                                                                                                                    |
| Cookie not kept over HTTPS                      | set `HLCC_COOKIE_SECURE=true` and `HLCC_TRUST_PROXY=true`                                                                                                                                            |
| Setup token unknown                             | development: read `data/setup-token` (it is never logged). Production: the file named by `HLCC_SECRET_SETUP_TOKEN_FILE`. It is ignored once the administrator exists.                                |
| 429 on login                                    | 5 failures in 15 minutes; wait or restart (limiter is in memory)                                                                                                                                     |
| Host metrics "refused"                          | /proc could not be verified as the machine's (Docker Desktop VM, cgroup-virtualised /proc, or Docker unreachable). Fix the cause; `HLCC_HOST_PROC_ASSERT=true` is only for operators who are certain |
| Secondary disk "Not a separate mount"           | the probe directory is on the same filesystem as the root probe, i.e. the disk is not mounted at that path. Mount it and put the probe inside it                                                     |
| Docker data unavailable                         | the proxy is down or unreachable, or `HLCC_DOCKER_URL` is unset; check `docker compose ps` and `DOCKER_GID`                                                                                          |
| Container "health unknown" or restart count "—" | that container's inspect call failed; see the warning on the Containers page                                                                                                                         |
| HTTP check "Blocked by policy"                  | the target resolved to a private or forbidden address; a private target needs the per-project opt-in                                                                                                 |
| Netdata "requires authentication"               | Netdata protects its API; this dashboard never sends credentials                                                                                                                                     |
| Few or no events                                | Docker replays only a small recent buffer; events are best-effort                                                                                                                                    |

## More troubleshooting

| Symptom                                                                        | Likely cause                                                                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Docker data "unavailable", log says "the Docker proxy rejected the credential" | the proxy and API read different credential files, or one was rotated without restarting the other; recreate both           |
| `docker compose up` stops with "required variable ... is missing"              | by design: production refuses to start without it. Run `npm run preflight -- --env-file ...` to see all of them at once     |
| The API will not start and says first-run setup needs a token                  | production needs `HLCC_SECRET_SETUP_TOKEN_FILE` even before the account exists                                              |
| The API will not start and mentions Secure cookies                             | production requires HTTPS; set `HLCC_COOKIE_SECURE=true`, or `HLCC_ALLOW_INSECURE_COOKIES=true` for plain-http testing only |
| Everyone is rate-limited after one person mistypes                             | `HLCC_TRUST_PROXY` is `0` behind a tunnel, so all requests look like one address; set it to `1`                             |
| Disk card says "not a mount point"                                             | the probe directory is missing from the compose volumes, or it is a plain folder rather than a mount                        |
| CPU shows `—` for one sample                                                   | the counters did not advance or were reset between two readings; the next sample recovers                                   |
| "Stored history has a problem"                                                 | disk full, permissions on `HLCC_DATA_PATH`, or a corrupt database; see backup-and-recovery.md                               |
