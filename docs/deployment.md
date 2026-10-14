# Deployment

**Nothing has been deployed.** Deployment to the Ubuntu server needs separate, explicit approval. This page describes how the release candidate is meant to be deployed, and which facts only the server can confirm. Run `npm run preflight` first; it refuses to pass while any blocking item below is unresolved.

## Trust boundaries

```
 browser --HTTPS--> tunnel / Tailscale --> 127.0.0.1:8787 --> [hlcc API + web]
                                                                  |  Bearer credential
                                         internal network, no route out
                                                                  v
                                                       [docker-proxy] --> /var/run/docker.sock
```

| Boundary                       | What protects it                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Internet to dashboard          | Cloudflare Access / Tailscale in front, then the application's own login, CSRF token and rate limiting               |
| Dashboard to Docker proxy      | A shared credential on every request (constant-time check), on a network with no outside route and no published port |
| Proxy to Docker                | Six fixed GET routes, strict URL form, response fields rebuilt from an allowlist (no environments, commands or logs) |
| Dashboard to health-check URLs | SSRF guard: connect-time IP validation, redirect re-validation, blocked ranges and ports                             |

**The Docker socket is the one thing here that can be dangerous.** Mounting it read-only (`:ro`) does **not** make Docker API requests read-only: it only stops the file being replaced. The proxy is therefore a deliberately tiny container with no published port, an authenticated and allowlisted interface, a read-only root, no capabilities and a 64 MiB limit. A compromise of the proxy exposes container names, states and health, but not environments, commands or logs, because those are never forwarded. The dashboard API and web containers never get the socket.

## Required configuration

The production file `deploy/compose.yaml` refuses to render if any of these is missing. Put the non-secret ones in an env file kept **outside the repository**.

| Variable                        | Meaning                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DOCKER_GID`                    | numeric id of the host's `docker` group (`getent group docker \| cut -d: -f3`); never `0`               |
| `HLCC_SECRET_DOCKER_TOKEN_FILE` | path of a file holding the proxy credential (32+ random characters)                                     |
| `HLCC_SECRET_SETUP_TOKEN_FILE`  | path of a file holding the one-time first-run setup token (16+ characters)                              |
| `HLCC_DATA_PATH`                | absolute directory for the database, **outside** the repository and release directory                   |
| `HLCC_PROBE_ROOT`               | empty directory on the root filesystem (measured for disk usage)                                        |
| `HLCC_PROBE_STORAGE`            | empty directory **inside** the secondary disk's mount (never `/srv/storage` itself)                     |
| `HLCC_DISKS`                    | `[{"label":"/","path":"/probe/root"},{"label":"/srv/storage","path":"/probe/storage","separate":true}]` |
| `HLCC_TRUST_PROXY`              | number of reverse proxies in front (cloudflared = `1`), so the real client address is used; default `0` |
| `HLCC_COOKIE_SECURE`            | `true` (default). Production refuses `false` unless `HLCC_ALLOW_INSECURE_COOKIES=true`                  |

Optional: `HLCC_PORT` (default 8787, bound to `127.0.0.1`), `HLCC_NETDATA_URL`, `HLCC_ALLOWED_ORIGINS`, `HLCC_POLL_INTERVAL_MS` (minimum 5000), `HLCC_RETENTION_HOURS`, `HLCC_HEALTH_INTERVAL_MS`, `HLCC_HOST_PROC_ASSERT` (leave `false`; see live-monitoring.md).

### Choosing `HLCC_TRUST_PROXY` (the hop count)

The value is the number of reverse proxies between the browser and the API that you control. It decides which address the login rate limiter and the audit log record as "the client". Getting it wrong fails in one of two ways:

- **Too low** (e.g. `0` behind a tunnel): every request appears to come from the proxy. One person mistyping a password locks **everyone** out, and the audit log shows the proxy's address for every sign-in.
- **Too high**: the API trusts addresses the client wrote into `X-Forwarded-For` itself, so an attacker can pick their own address and sidestep the per-address login limit.

Do not guess; read the topology and then confirm it from a live request.

**1. Count the hops from the real topology.** A hop is a proxy that opens its own connection to the next one and appends to `X-Forwarded-For`. Count only proxies that sit _between the browser and this API_.

| Topology (browser to API)                                        | `HLCC_TRUST_PROXY` | Why                                                                 |
| ---------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| Cloudflare edge, then `cloudflared`, then API                    | `1`                | Cloudflare's edge is not a hop you reach; the peer is `cloudflared` |
| Cloudflare edge, `cloudflared`, a local nginx/Caddy, then API    | `2`                | Two proxies you operate append to the chain                         |
| `tailscale serve` on the host, then API                          | `1`                | `tailscaled` is the peer and adds the tailnet client's address      |
| Browser straight to `127.0.0.1:8787` (SSH tunnel, local testing) | `0`                | Nothing forwards; the peer is the client                            |

The compose file publishes the API on `127.0.0.1` only, so anything that reaches it is a proxy on the server itself. The audit showed the existing tunnel as a container, so confirm on the server whether it reaches the API through the host port or a shared Docker network; that does not change the count, but it changes which address you see as the peer.

**2. Confirm it with evidence.** Sign in through the real route (the route you will actually use, not a shortcut) and open **Settings, Network identity**. It shows the address the server used for your session, the direct peer, the `X-Forwarded-For` chain, and the address each hop count from 0 to 3 would select. Choose the **smallest** hop count whose address is your real public address (check it against what an external "what is my IP" page says). Anything higher than that adds exposure for no benefit. The page only reports; the value is set in your env file and applied by restarting `hlcc`. Repeat the check through each route you use (tunnel and Tailscale can differ), and if they differ, prefer exposing only one route to the API. The page's arithmetic is tested against Express's own result for hop counts 0 to 3.

Before the first deployment you can only decide a provisional value from the table; first sign-in over the real route happens after deployment, so plan to restart once with the confirmed value. Start with `1` if the tunnel is the first route, since `0` locks everyone out together and `1` wrongly trusted at worst lets a direct-to-port caller (impossible while bound to loopback) pick an address.

### Generating and rotating secrets

Use the provisioning script. It creates two independent random files (32 random bytes each, 43 characters) **outside any Git repository** with mode 400, never overwrites or reads an existing file, refuses to run as root, and never prints a value:

```bash
scripts/provision-secrets.sh /srv/hlcc-secrets     # run as the user with uid 1000; creates the directory with mode 700
scripts/ubuntu-preflight.sh --secret /srv/hlcc-secrets/docker_proxy_token --secret /srv/hlcc-secrets/setup_token
```

Then point `HLCC_SECRET_DOCKER_TOKEN_FILE` and `HLCC_SECRET_SETUP_TOKEN_FILE` at those two files. If your deploy user is not uid 1000, ownership is your decision (the script changes none); the container user must be able to read the files. Keep a copy of both in a password manager. To rotate, move the old file aside and run the script again for the missing name. Both the proxy and the API refuse a credential that is short, contains unexpected characters, or is trivially repetitive, and the preflight checks the file mode.

**Rotating the proxy credential:** write the new value into the secret file, then `docker compose up -d --force-recreate docker-proxy hlcc` so both containers read it together. Until both restart, the API's requests are refused with 401 and Docker data shows as unavailable, which is the safe failure. Treat a suspected leak as a reason to rotate immediately. Secrets are delivered as mounted files, so they do not appear in `docker inspect`, `docker compose config` or logs (verified locally).

The first-run setup token is only used once; after the administrator account exists it is ignored, and a leftover token file is removed at start.

## Preflight

```bash
npm run build                                              # so the bundle can be scanned
npm run preflight -- --env-file /path/to/your.env          # add --allow-local-paths only for a dry run on a laptop
```

It prints results in groups and exits non-zero on any failure. It never starts a container and never prints a secret value.

| Group                    | Meaning                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `verified-locally`       | needs only this repository (migrations, Dockerfile policy, secret scan, bundle scan) |
| `requires-docker-cli`    | needs the `docker compose` CLI to render the file (not the engine)                   |
| `requires-admin-config`  | needs the values you provide (secrets, paths, disks, cookies)                        |
| `requires-docker-engine` | **listed, not run**: image builds, health, negative tests                            |
| `requires-ubuntu-host`   | **listed, not run**: read-only commands to run on the server                         |

## Deploying (after approval)

1. Push to a **private** repository (done separately, with approval).
2. On the server, clone into `/srv/projects/homelab-control-center` (verify it does not exist first).
3. Run `docs/ubuntu-preflight.md`, then create the data and probe directories and the secrets (`scripts/provision-secrets.sh`). Back up what the backup document lists before the first deployment.
4. `npm run preflight -- --env-file ...` must have no failures.
5. `docker compose --env-file ... -f deploy/compose.yaml up -d --build`.
6. Check `docker compose ps` (both healthy), then `curl -s 127.0.0.1:8787/api/v1/health`.
7. Complete first-run setup in a browser through the approved route, using the setup token from its file.
8. On the dashboard's Host card, confirm it says "cross-checked against the Docker daemon" (not "operator-asserted") and that the secondary disk is not flagged "not a separate mount".
9. Only then consider remote access (Cloudflare Access in front, or Tailscale Serve). Do not edit existing tunnel ingress rules without approval.

For a local demo with no Docker access, use `docker compose -f deploy/compose.local.yaml up --build` instead. It contains no credentials: the app generates a one-time setup token into its data volume, which you read with `docker compose -f deploy/compose.local.yaml exec hlcc cat /data/setup-token`. It is a separate file on purpose and must not be used on a server.

## Migrations

Migrations are numbered SQL files in `migrations/`, applied in order at every start, each in its own transaction. A start takes the database's write lock first, so two instances starting together cannot both apply one. A failing migration rolls back completely and is **not** recorded; the process then refuses to start, so a half-migrated database is never used. Migrations are forward-only: to undo one, restore the backup taken before the upgrade (see backup-and-recovery.md). Never edit an applied migration; add a new one.

## Rollback

1. Stop the stack: `docker compose -f deploy/compose.yaml stop`.
2. Restore the database backup taken before the upgrade into `HLCC_DATA_PATH` (only needed if a migration ran).
3. Check out the previous release and `up -d --build`.

Because the audit table is append-only and the database lives outside the containers, rolling the code back never loses data by itself. Tag the running image before an upgrade if you want an instant rollback: `docker tag homelab-control-center:local homelab-control-center:previous`.

## Updating the pinned base image

`deploy/Dockerfile` pins the Node base image by digest, so builds are reproducible. That also means security patches reach you only when you bump it:

```bash
docker pull node:24-alpine
docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}'
```

Put that digest in `ARG NODE_IMAGE=node:24-alpine@sha256:...`, rebuild, run the tests, and redeploy. The preflight fails if the pin is removed.

## What was verified locally, and what was not

Verified on a laptop with Docker Desktop (not the server): both images build from the pinned digest with `--ignore-scripts`; both run as a non-root user with healthchecks; the production compose file refuses to render without its required settings; the stack starts with the proxy healthy before the API; the proxy rejects missing, wrong and malformed credentials and mutating or non-allowlisted requests (a stranger container placed on the internal network gets 401, one on the default network cannot reach it); the API has no socket; secrets appear nowhere in `docker inspect`, rendered config or logs; first-run setup works from a mounted secret file; data and the administrator account survive a restart and the setup token is refused afterwards; shutdown with an open event stream took 0.5 s with exit code 0; idle memory about 41 MiB (API) and 30 MiB (proxy). These measurements are from Docker Desktop, not from the M93p.

**Not verified (needs the Ubuntu server):** that `/proc` cross-checks against the server's Docker daemon; the docker group id; that `/srv/storage` is a separate mount and the probe directories behave; the real memory use; Netdata against a live instance; the Cloudflare Access and tunnel configuration; that the secret files' ownership lets uid 1000 read them. The preflight lists the read-only commands for each.

## Guardrails

The dashboard API and web containers never get the Docker socket (only the authenticated, allowlisting `docker-proxy` mounts it). No `docker system prune`, no volume deletion, no changes to DevWorkspace, DevConnect, Nextcloud, Netdata or cloudflared. Starting DevConnect is out of scope: its `auth-service` fails on an empty `GOOGLE_CLIENT_ID` and `payment-service` on an empty `RAZORPAY_KEY_ID` (from the audit), and no values are to be invented.
