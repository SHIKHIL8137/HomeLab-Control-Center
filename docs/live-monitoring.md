# Live monitoring (Phase 3)

Everything here was built and tested locally. It has **not** been run against the Ubuntu server. Facts marked
"verified" were observed on a real Docker Engine (Docker Desktop 29.6.1 on Windows) during development; behaviour
on the server is expected to match but is not yet confirmed.

## Docker access: the read-only proxy

The dashboard API never touches the Docker socket. A separate container, `apps/docker-proxy`, is the only holder.
It has no dependencies, listens on an internal-only Docker network and exposes exactly these routes:

| Route                                                   | Used for                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /_ping`                                            | health of the proxy and the daemon                               |
| `GET /info`                                             | daemon memory, CPU count, OS and kernel (to cross-check `/proc`) |
| `GET /containers/json?all=<bool>`                       | inventory                                                        |
| `GET /containers/{id}/json`                             | health state, restart count, exit code, memory cap               |
| `GET /containers/{id}/stats?stream=false&one-shot=true` | one CPU and memory sample                                        |
| `GET /events?since&until&filters`                       | container start/stop/die/oom/health events                       |

Everything else is refused: every non-GET method (405), and logs, exec, archive/export (file reads), attach, top,
changes, images, volumes, networks, secrets and swarm (403). Query strings are validated strictly; the upstream path
is rebuilt from validated parts and the raw URL is never forwarded.

**Responses are rebuilt from an allowlist of fields**, not forwarded. Docker's inspect output contains
`Config.Env`, `Cmd` and healthcheck logs, which can hold secrets; none of them ever reach the API. Event actions are
allowlisted too (`exec_*` events embed full command lines and are dropped).

Verified against a real engine: the exact set of routes above works; `precpu_stats` is empty on a one-shot stats call,
so CPU% is computed from two successive polls; an `until` in the future makes Docker hold the connection open, so the
proxy clamps `until` to the past and every events call is a finite read.

Limits worth knowing:

- **Events are best-effort.** Docker replays only about the last 256 events of any kind, and healthchecks generate
  several per run, so events can be missed. Restart loops are therefore detected from `RestartCount`, not events.
- A socket mount is writable even when marked `:ro`. Safety comes from the proxy being minimal, isolated and filtering
  every request, not from the mount flag.
- The socket's group must be readable by the proxy: set `DOCKER_GID` (Ubuntu: `getent group docker | cut -d: -f3`).
  Do not add the dashboard user to the `docker` group.

## Host metrics: is `/proc` really the host?

Verified experiment: in a container limited to 64 MiB and 0.5 CPU, `/proc/meminfo` reported exactly the Docker
daemon's `MemTotal` (not the container limit, and not the real Windows RAM), `/proc/uptime` reported the Linux VM's
uptime (not the container's age, not Windows'), and `/proc/stat` listed the daemon's CPU count. So `/proc` inside a
container describes **the kernel the Docker daemon runs on**. That is the machine itself only when Docker runs
directly on it, as on the Ubuntu server. Under Docker Desktop it is a VM.

The host adapter therefore refuses to publish numbers as "host" unless it can show that:

1. `/proc` is not virtualised per container (`MemTotal` is not equal to the cgroup memory limit, and `/proc/uptime`
   is not tracking the container's own uptime), and
2. it matches the Docker daemon's own view (`MemTotal` within 2%) **and** the daemon is not in a VM (Docker Desktop /
   WSL2 are detected and refused), or the operator has explicitly set `HLCC_HOST_PROC_ASSERT=true`. An asserted
   reading is labelled "operator-asserted" in the UI.

Verified in the running stack: with the assertion off, the dashboard showed "Host metrics refused: the Docker daemon
runs in a VM"; with it on, it showed the VM's 5.79 GiB, labelled operator-asserted.

## Disks and the secondary mount

Disks are configured explicitly (`HLCC_DISKS`, a JSON list). Mount **empty probe directories**, not `/` or
`/srv/storage`, so the dashboard cannot read anything else there:

```json
[
  { "label": "/", "path": "/probe/root" },
  { "label": "/srv/storage", "path": "/probe/storage", "separate": true }
]
```

Every configured path must be a real **mount point** according to the kernel's mount table (`/proc/self/mountinfo`): a plain folder inside the container would describe the container's own storage, so it is refused. Tmpfs, overlay and similar filesystems are refused as disks. A disk marked `separate` must additionally be on a **different filesystem** (device number) from a valid reference disk. If it is on the
same one, because the secondary disk is not mounted and the path is just a folder on the root filesystem, it is
reported as "not a separate mount" with no sizes. Verified in a real container: two probe directories on one
filesystem produced `not_separate_mount`; a separate volume produced real figures. Place the second probe directory
**inside** the secondary disk's mount (for example `/srv/storage/homelab-control-center/probe`).

## HTTP health checks and SSRF protection

No URL is configured by default and an unconfigured check reads **"Not configured"**, never healthy.

- URLs can only be set by the signed-in administrator, with CSRF protection, and are validated on entry (http/https,
  no credentials, no metadata or link-local addresses, no private addresses without authorization).
- **Enforcement is at connection time**, not just at registration: the destination IP is validated when the socket
  connects, from the very DNS answer that was checked (no second lookup, so DNS rebinding cannot swap it), and again
  from the socket's real remote address. One bad address in a DNS answer rejects the whole answer.
- Every redirect hop is validated again (max 3, no scheme downgrade, no credentials), and a redirect can **never**
  move from an authorised private host to another private host.
- Link-local (169.254/16, fe80::/10), cloud metadata (including AWS's IPv6 address), multicast, reserved, unspecified,
  NAT64 and 6to4 ranges are blocked **even when a project is authorised for private targets**. IPv4-mapped IPv6 and
  numeric obfuscation (`2130706433`, `0x7f.1`) are normalised before checking.
- Private targets (RFC 1918, loopback, Tailscale 100.64/10, ULA) need a per-project opt-in, which is audited.
- Responses are never read; timeouts are 5 s per hop and 10 s overall; at most 3 checks run at once. Results store
  no URL, only a fingerprint, so a query-string token is never persisted, and a changed URL starts from "pending".

Verified in the running stack: a hostname that resolves to 127.0.0.1 (`localtest.me`), registered as if public, was
blocked at connection time; a real public URL answered; an authorised private target answered.

A successful HTTP check can never upgrade a project's health; repeated failures (2 or more) or a policy block can
only degrade it.

## Netdata (optional)

Off unless `HLCC_NETDATA_URL` is set. Read-only: two GET requests for `system.net` and `system.io`, short timeouts,
no redirects, **no credentials sent**. If Netdata asks for authentication the integration reports that and stays
unavailable. Link-local addresses are refused even here. The response format follows Netdata's documented JSON and is
tested against fixtures; it has **not** been tested against a live Netdata.

## Connectivity

| Item                               | Source                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public reachability                | HTTP checks that reached a **public** address, if any are configured                                                                                |
| Cloudflare Tunnel                  | the `cloudflared` container state **plus** an end-to-end public check; a running container alone is reported as "unknown", never healthy            |
| Wi-Fi link, LAN gateway, Tailscale | "Needs host agent": a container cannot see the machine's Wi-Fi or router truthfully. See [host-agent-design.md](host-agent-design.md) (design only) |

## Failure behaviour

Host, Docker and Netdata are collected independently with a 10 s timeout each. One failing does not blank the others;
each failure keeps its own message. Old readings go stale after 2.5 polling intervals and are shown as stale, and
project health from stale container data is "unknown".

## Configuration

| Variable                  | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| `HLCC_MODE`               | `mock` (demo data) or `live` (never falls back to mock)   |
| `HLCC_DOCKER_URL`         | `http://docker-proxy:2375` (plain http, internal network) |
| `HLCC_DISKS`              | JSON list of disks to measure, see above                  |
| `HLCC_HOST_PROC_ASSERT`   | operator asserts `/proc` is the monitored machine's       |
| `HLCC_NETDATA_URL`        | optional Netdata base URL                                 |
| `HLCC_HEALTH_INTERVAL_MS` | HTTP check interval, default 60000                        |
| `HLCC_HEALTH_CONCURRENCY` | parallel checks, default 3                                |

## Proxy authentication (release-candidate hardening)

The proxy answers only requests carrying `Authorization: Bearer <credential>`; the same credential is mounted into the API. It is checked in constant time and **before** the route allowlist, so an unauthenticated caller learns nothing about which routes exist (every path, method and malformed request returns 401). Network isolation is kept as well (no published port, an `internal` network), but network membership alone is not trusted: a container deliberately attached to that network without the credential receives 401 (verified). Generate, store and rotate the credential as described in [deployment.md](deployment.md).

## How to tell that a number is not current, not measured, or not verified

| You see                             | It means                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Current · 12s ago**               | measured within 2.5 polling intervals                                                                |
| **Stale · last 5m ago**             | the source stopped answering; values are dimmed and are the last known ones, never "healthy"         |
| **Unavailable** / `—`               | nothing trustworthy exists; the reason is shown in a notice (for example "Host metrics refused: …")  |
| **Not configured**                  | you have not set that up (health URL, Netdata); it is never shown as healthy                         |
| **Operator-asserted, not verified** | the host numbers come from `/proc` because the operator said so, not because they were cross-checked |
| **Needs host agent**                | cannot be measured honestly from a container (Wi-Fi link, LAN gateway, Tailscale)                    |
| **Demo data**                       | mock mode; none of it is real                                                                        |
| **Stored history has a problem**    | the database could not be written or read; live readings may still be shown                          |

## Which measurements need a host agent

A container cannot truthfully see the machine's Wi-Fi link, its LAN gateway, Tailscale's state or its boot history, so the dashboard reports them as "Needs host agent". The agent is **design only** ([host-agent-design.md](host-agent-design.md)); nothing is installed. Cloudflare Tunnel health is judged only by a public end-to-end check, so it stays "unknown" until a public health URL is configured.

## Configuring Netdata safely (optional)

Netdata is read-only here and entirely optional. If you use it:

- Set `HLCC_NETDATA_URL` to its base URL (for example `http://192.168.1.113:19999` or a Docker-bridge address). Do not put credentials in the URL; the dashboard will refuse that.
- The dashboard sends two fixed GET requests (`system.net`, `system.io`), no credentials, short timeouts, no redirects, and refuses link-local and metadata addresses and the ports reserved for other protocols. If Netdata requires authentication the dashboard reports "requires authentication" and stays unavailable; it will not be given a token.
- Keep Netdata itself reachable only by trusted clients. The audit saw it listening on all interfaces; bind it to a private address or put it behind an access list, outside this project. **This dashboard does not change Netdata and does not know whether your instance is exposed.**
- The response format follows Netdata's documented JSON and is tested against fixtures, not a live Netdata.

## Failure and shutdown behaviour

Host, Docker and Netdata are collected independently with a 10 s timeout each; one failing never blanks the others. A database error during collection is reported as a storage problem and never crashes the process. On `SIGTERM` the server closes open event streams and exits within seconds; with a stream open it exited with code 0 in about half a second (verified under Docker Desktop).
