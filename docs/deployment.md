# Deployment

**Nothing has been deployed.** Deployment to the Ubuntu server needs separate explicit approval. This page is the plan, not a record.

## Preconditions (verify on the server first)

- `/srv/projects/homelab-control-center` does not exist or is empty. Never reuse an existing project directory.
- `/srv/storage` is actually mounted (`findmnt /srv/storage`) before using it for data.
- Free memory headroom (`MemAvailable`, PSI) can fit a 256 MiB container; check actual usage, not container limits.
- No port conflict: the compose file publishes only `127.0.0.1:8787`. Known bindings from the audit include 8080/8081 on loopback and 19999 (Netdata, currently on all interfaces).

## Plan

1. Push to a **private** repo after approval of repository and branch. The remote proposed by the owner is `https://github.com/SHIKHIL8137/HomeLab-Control-Center.git`; confirm it is private before pushing.
2. On the server: clone into the new directory as a dedicated, unprivileged user that is **not** in the `docker` group and has no sudo.
3. Create the data directory outside the code directory, owned by the container user, mode 700.
4. `docker compose -f deploy/compose.yaml up -d --build` (mock mode first, loopback only).
5. Check `curl 127.0.0.1:8787/api/v1/health`, complete first-run setup, confirm data survives `docker compose restart`.
6. Remote access only after reviewing the current Cloudflare Tunnel and Tailscale setup: add a hostname through the tunnel dashboard with Cloudflare Access in front, or use Tailscale Serve. Do not edit existing ingress rules without approval.

## Not verified

- `deploy/Dockerfile` and `deploy/compose.yaml` have **not been built or run** (Docker Desktop was not running during development). Build and test them locally first.
- The container runs as the image's `node` user; the bind-mounted data directory must be writable by that UID.

## Guardrails

No Docker socket mount, no `docker system prune`, no volume deletion, no changes to DevWorkspace, DevConnect, Nextcloud, Netdata or cloudflared. Starting DevConnect is out of scope: its `auth-service` fails on an empty `GOOGLE_CLIENT_ID` and `payment-service` on an empty `RAZORPAY_KEY_ID` (from the audit), and no values are to be invented.
