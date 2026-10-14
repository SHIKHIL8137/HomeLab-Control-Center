# CI/CD: merge to `main` deploys to the home server

Merging a pull request into `main` runs CI. When every check passes, the same workflow deploys that exact commit to the home server. Nothing is pulled by the server and nothing listens for GitHub: the workflow pushes one release archive over Tailscale to a key that can run exactly one command.

```
merge to main
   |
   v
GitHub Actions (hosted runner)
   check + deployment jobs must pass
   |
   |  deploy job: joins the tailnet as ephemeral tag:ci,
   |  git archive HEAD | ssh deploy-key "deploy <commit> <tree>"
   v
home server: forced command = ~/hlcc/bin/hlcc-deploy   (server-resident, NOT part of a release)
   1. verify the unpacked files hash to <tree>          6. start ONLY the homelab-control-center project
   2. refuse if the server is busy (load >= 4)          7. wait for health, then smoke-test:
   3. back up the database to /srv/storage, check it       health 200, unauthenticated /overview is 401,
   4. tag current images :previous                         no Docker socket inside the API container
   5. build at lowest CPU/IO priority                   8. any failure after step 4: previous images restored
```

## What protects what

| Risk                                          | Control                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Someone runs arbitrary commands with the key  | `authorized_keys` forces `command=` and `restrict`; the script accepts only `deploy <40 hex> <40 hex>` and ignores everything else                                       |
| A tampered or partial upload                  | The server hashes the unpacked files and refuses unless they equal the tree CI built                                                                                     |
| A bad release breaks the dashboard            | Health and security smoke tests; automatic rollback to the previous images; a verified database backup is taken first                                                    |
| A deploy hurts the other apps on the server   | Only `--project-name homelab-control-center` commands, no prune, no volume or network changes, refuses to build while the load is high, builds at lowest priority        |
| Unreviewed code reaching production           | **Branch protection on `main`** (below): the pipeline deploys whatever lands on `main`, so what protects production is who can merge there                               |
| The deploy script being replaced by a release | It lives in `~/hlcc/bin`, outside the release directories. A release can never replace it; you reinstall it by hand after reviewing a change to `scripts/hlcc-deploy.sh` |

The honest limit: a pipeline that deploys code trusts that code. A malicious change merged to `main` could, for example, edit the Compose file. Branch protection, GitHub two-factor authentication and reading the diff are the real gate; the controls above limit what a leaked CI key can do and make mistakes recoverable.

## One-time setup (nothing here has been done yet)

### 1. GitHub (repository settings)

- **Branch protection on `main`**: require a pull request, require the status checks `check` and `deployment`, disallow direct pushes and force pushes.
- **Environment `production`** (Settings, Environments): optionally add yourself as a required reviewer if you want a manual "approve deploy" click after CI passes.
- **Secrets** (Settings, Secrets and variables, Actions):

| Secret                | Value                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `TS_OAUTH_CLIENT_ID`  | Tailscale OAuth client id (step 2)                                                      |
| `TS_OAUTH_SECRET`     | Tailscale OAuth client secret (step 2)                                                  |
| `DEPLOY_SSH_KEY`      | the private half of the deploy key (step 3)                                             |
| `DEPLOY_USER`         | `shikhil`                                                                               |
| `HOMESERVER_HOST`     | the server's Tailscale name or IP (`100.88.33.71`)                                      |
| `HOMESERVER_HOST_KEY` | the server's SSH host public key, e.g. `ssh-ed25519 AAAA...` (`ssh-keyscan -t ed25519`) |

### 2. Tailscale (admin console)

- Add `tag:ci` to the tag owners, create an **OAuth client** with the scope `auth_keys` limited to `tag:ci`.
- Add an access rule that lets `tag:ci` reach the server on **port 22 only**. The runner joins as an ephemeral node, so it disappears after the job.

### 3. The deploy key and the server

On your laptop, create a key that is used for nothing else:

```bash
ssh-keygen -t ed25519 -f hlcc-ci-deploy -C hlcc-ci -N ""
```

Put the private file in the `DEPLOY_SSH_KEY` secret, then delete it locally. On the server (as `shikhil`):

```bash
mkdir -p ~/hlcc/bin
install -m 755 /srv/projects/homelab-control-center/scripts/hlcc-deploy.sh ~/hlcc/bin/hlcc-deploy   # reviewed copy
```

and add **one line** to `~/.ssh/authorized_keys` (the public half; `from=` limits it to Tailscale addresses):

```
command="/home/shikhil/hlcc/bin/hlcc-deploy",restrict,from="100.64.0.0/10" ssh-ed25519 AAAA...hlcc-ci
```

### 4. Public hostname with sign-in (Cloudflare)

Order matters: protect first, publish second.

1. **Cloudflare Zero Trust, Access, Applications, Add, Self-hosted**: domain `server.kavlien.store`. Add an **Allow** policy for your own email address(es), with the One-time PIN login method. Nobody else gets as far as the login page.
2. **Server env file** (`~/hlcc/hlcc.env`): add `HLCC_TUNNEL_NETWORK=true` and set `HLCC_ALLOWED_ORIGINS=https://server.kavlien.store`. Keep `HLCC_TRUST_PROXY=0` for now.
3. Apply it once by hand (a normal deploy applies it too):
   ```bash
   cd /srv/projects/homelab-control-center
   docker compose --project-name homelab-control-center --env-file ~/hlcc/hlcc.env \
     -f deploy/compose.yaml -f deploy/compose.tunnel.yaml up -d --no-build
   ```
   This attaches only the dashboard to the existing `cloudflare-proxy` network under the name `hlcc-dashboard`. No existing container is touched. Note that the dashboard then shares that network with `cloudflared`, nginx and Nextcloud; it publishes nothing there.
4. **Tunnels, your tunnel, Public Hostname, Add**: `server.kavlien.store`, service `HTTP`, URL `hlcc-dashboard:8787`. (If the tunnel page says it is locally managed rather than remotely managed, stop here and ask: the route must then be added in the tunnel's config file, which is a change to the existing deployment.)
5. Sign in at `https://server.kavlien.store`: the Cloudflare PIN first, then the dashboard's own login (the same administrator account you created over the SSH tunnel).
6. Open Settings, **Network identity**. With `HLCC_TRUST_PROXY=0` it shows the tunnel's address as the "client". Choose the smallest hop count whose row shows your real public address (expected: `1`), set `HLCC_TRUST_PROXY=1` in the env file and run step 3 again. Until then every visitor shares one rate-limit bucket.

## Day to day

- **Deploy**: merge to `main`. The deploy job logs the script's progress. A failed deploy shows red, the old version keeps running, and the log names the database backup taken beforehand.
- **Redeploy the same commit**: re-run the workflow; the script reports "already deployed" and exits.
- **Rollback by hand**: `docker tag homelab-control-center:previous homelab-control-center:local` (and the same for `homelab-control-center-docker-proxy`), then the `up -d --no-build` command above. Rollback restores code only; restoring data is a separate, deliberate step (backup-and-recovery.md).
- **Logs**: `~/hlcc/deploy.log` on the server. Releases are kept in `/srv/projects/homelab-control-center/releases/<commit>`; the script never deletes them.
- **Revoke CI access**: remove the one line from `authorized_keys`, or delete the `DEPLOY_SSH_KEY` secret.
- **Changing the deploy script**: edit `scripts/hlcc-deploy.sh`, review, merge, then reinstall it on the server (step 3). Merges do not do this for you, by design.

## What a failed deploy looks like

| Message                             | Meaning                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `tree mismatch`                     | the upload differs from what CI built; nothing was changed                                  |
| `server busy (load ... >= 4)`       | the server was too loaded to build safely; re-run the workflow later (exit code 75)         |
| `not a mount point`                 | `/srv/storage` is not mounted, so there is nowhere safe for the backup; nothing was changed |
| `backup failed its integrity check` | nothing was built or restarted                                                              |
| `ROLLED BACK to ...`                | the new release failed its health or security checks; the previous version is running again |
| `ROLLBACK DID NOT COMPLETE`         | look at `docker compose --project-name homelab-control-center ps` on the server             |
