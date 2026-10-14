# Ubuntu preflight checklist

Run this on the server **before** the first deployment, as the deploy user (not root). Everything here is read-only: it changes no ownership or permissions, starts or stops nothing, and does not touch Cloudflare or Tailscale. It never opens a secret file (owner, mode and size only) and never runs `docker inspect`, which would print a container's environment and command, where a tunnel token can live.

```bash
scripts/ubuntu-preflight.sh --secret /srv/hlcc-secrets/docker_proxy_token --secret /srv/hlcc-secrets/setup_token
```

Options: `--secret FILE` (repeatable), `--storage /srv/storage`, `--port 8787`. Secret files that do not exist yet are reported as such, so the script can run before and after provisioning. The script needs no repository checkout of the app beyond the file itself, and `apps/api/test/ubuntupreflight.test.ts` proves with recording stubs that it only calls an allow-list of read-only commands.

## What to compare against

| Section                    | What the output shows                                                                                       | Good looks like                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Docker version, group id   | `docker --version`, `docker compose version`, `getent group docker`                                         | Compose v2 present. Use the printed `DOCKER_GID` in your env file. It must not be `0`                                         |
| Memory                     | `free -h`                                                                                                   | Comfortably more than the stack's limits (about 320 MiB) free, after the existing projects, Netdata and Nextcloud             |
| Disk space                 | `df -h / /srv/storage`                                                                                      | Room for the database (small) and logs (bounded to a few MB per container)                                                    |
| `/srv/storage` mount state | `findmnt /srv/storage`, `lsblk -f`, and a RESULT line                                                       | "is a mount point" on a different device than `/`. If not, the dashboard will flag the disk as "not a separate mount"         |
| Existing networks          | `docker network ls`, containers with their networks                                                         | No existing `hlcc*` names. Note which network `cloudflared` is on: that is how a tunnel could later reach the dashboard       |
| Secret-file ownership      | owner, group, mode, size of each `--secret` path and its directory                                          | Mode 400 or 600. Owner uid 1000 (the container user); otherwise the container cannot read it and you decide how to fix it     |
| Netdata exposure           | listeners on port 19999                                                                                     | Bound to `127.0.0.1` or an internal address. A listener on `0.0.0.0` or `[::]` is reachable from every interface: review that |
| Dashboard port             | listeners on 8787                                                                                           | Nothing listening (the stack binds `127.0.0.1:8787`)                                                                          |
| Tunnel and Tailscale       | `cloudflared` containers (name, networks, published ports), `systemctl is-active`, `tailscale serve status` | Which of the routes exist. **How** they are configured is deliberately not shown                                              |

## Cloudflare Access and Tunnel topology

The server can say what is running, not what Cloudflare enforces. Check these in the Cloudflare dashboard (read-only; do not add routes yet):

1. Zero Trust, Networks, Tunnels: which tunnel the server uses, and its existing public hostnames.
2. Zero Trust, Access, Applications: whether a policy covers the hostname you plan to use, and who is allowed. The dashboard has its own login, but Access in front is the first layer.
3. Whether the tunnel reaches services by container name on a shared Docker network or by `host:port`. This is what `HLCC_TRUST_PROXY` and the compose network design depend on; see "Choosing `HLCC_TRUST_PROXY`" in deployment.md.

## Not covered by a script, on purpose

- Whether the secret files' contents are strong: `npm run preflight` checks that (length, characters, repetition, mode) on your machine or after provisioning, without printing them.
- Whether `/proc` agrees with the Docker daemon: the dashboard's Host card says so after first start.
- Idle memory under load: `docker stats --no-stream` after deployment.
