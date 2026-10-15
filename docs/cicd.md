# CI/CD: merge to `main` deploys to the home server

Merging a pull request into `main` runs CI. When every check passes and the `production` environment approves, the same workflow deploys that exact commit to the home server. Nothing is pulled by the server and nothing listens for GitHub: the workflow pushes one release archive over Tailscale to a key that can run exactly two commands, `check` and `deploy`.

```
merge to main
   |
   v
GitHub Actions (hosted runner)
   check + deployment jobs must pass, then the `production` environment approves
   |
   |  join the tailnet as an ephemeral tag:ci node
   |  scripts/ci-remote.sh check    -> read-only report; stops here if the server is not ready
   |  scripts/ci-remote.sh deploy   -> git archive HEAD | ssh "deploy <commit> <tree>"
   v
home server: forced command = ~/hlcc/bin/hlcc-deploy   (server-resident, NOT part of a release)
   1. refuse anything but `check` or `deploy <40 hex> <40 hex>`; validate paths and the env file
   2. refuse if .deploy-in-progress exists (an earlier deploy never finished)
   3. receive a bounded plain-tar archive, validate EVERY entry, then extract files only
   4. verify the extracted files hash to <tree>              7. write .deploy-in-progress, tag images :previous,
   5. refuse if load, memory or disk are short                   build one image at a time
   6. back up the database to /srv/storage, check the backup 8. start ONLY the homelab-control-center project,
                                                                 wait for health, smoke-test
   9. only then record the commit in .deployed-sha and remove the marker; any failure after 7 restores the
      previous images, and the marker is removed only once the previous version is verified healthy again
```

## What protects what

| Risk                                          | Control                                                                                                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone runs arbitrary commands with the key  | `authorized_keys` forces `command=` and `restrict`; the script accepts only `check` and `deploy <40 hex> <40 hex>` and treats everything else as an error. It takes no paths or settings from the SSH client                        |
| A tampered or partial upload                  | Plain tar only (a compressed archive is refused); size, entry-count and expanded-size limits; absolute paths, `..`, duplicates, links and special files rejected; a missing end-of-archive refused; the files must hash to the tree |
| A bad release breaks the dashboard            | Health and security smoke tests; automatic rollback to the previous images; a verified database backup is taken first                                                                                                               |
| An interrupted deploy is mistaken for success | `.deployed-sha` changes only after verification. `.deploy-in-progress` stays until success or a verified rollback; while it exists the script refuses to run (below)                                                                |
| A deploy hurts the other apps on the server   | Only `--project-name homelab-control-center` commands, no prune, no volume or network changes, one image built at a time, and a refusal to start when load, memory or disk are short                                                |
| Unreviewed code reaching production           | **Branch protection on `main`** and the **`production` environment** (below): the pipeline deploys whatever lands on `main`, so who can merge there, and who must approve, is what protects production                              |
| The deploy script being replaced by a release | It lives in `~/hlcc/bin`, outside the release directories. A release can never replace it; you reinstall it by hand after reviewing a change to `scripts/hlcc-deploy.sh`                                                            |

Honest limits:

- A pipeline that deploys code trusts that code. A malicious change merged to `main` could, for example, edit the Compose file. The tree hash proves the upload is what CI built, not that it is benign.
- Building happens inside Docker's daemon, so nothing in the script can throttle it. The load, memory and disk checks run before the build, and a build of two small images has been seen to peak at a load of about 2 on this server, but a very busy moment can still slow the other apps while it runs. The Compose file's memory limits cap the running dashboard, not the build.
- A rollback restores code only. Migrations are forward-only: if a new release changed the database before it failed, the old code runs against the newer schema. The pre-deploy backup is the way back (restoring is manual, see backup-and-recovery.md).

## One-time setup

### 1. GitHub (repository settings)

- **Branch protection on `main`**: require a pull request and the status checks `check` and `deployment`; disallow direct pushes and force pushes.
- **Environment `production`** (Settings, Environments): add yourself as a **required reviewer** (the manual approval click) and set **Deployment branches** to `main` only. This is what stops a feature branch or pull request from reaching the server, so do it before adding the secrets.
- **Secrets** (Settings, Secrets and variables, Actions, tab **Secrets**, not Variables): a value saved as a variable arrives empty in the job.

| Secret                | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `TS_OAUTH_CLIENT_ID`  | the Tailscale OAuth client id (step 2); the short id, not the whole credential           |
| `TS_OAUTH_SECRET`     | the Tailscale OAuth client secret (step 2), shown once when the client is created        |
| `DEPLOY_SSH_KEY`      | the private half of the deploy key (step 3)                                              |
| `DEPLOY_USER`         | `shikhil` (never `root`; the workflow refuses it)                                        |
| `HOMESERVER_HOST`     | the server's Tailscale IP or name, exactly as the SSH command should use it              |
| `HOMESERVER_HOST_KEY` | **one complete `known_hosts` line**: `<HOMESERVER_HOST> ssh-ed25519 AAAA...` (see below) |

Never put any of these in a file in the repository. The secret scanner rejects Tailscale credentials and private keys in tracked files.

**Getting `HOMESERVER_HOST_KEY` safely.** On the server, read the host key's fingerprint from its own file, then compare it with what the network presents; only then store the line:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub          # on the server: note the SHA256:... value
ssh-keyscan -t ed25519 100.88.33.71 > hostkey.txt          # from your laptop
ssh-keygen -lf hostkey.txt                                 # must show the same SHA256:... value
```

If the fingerprints match, the contents of `hostkey.txt` (`100.88.33.71 ssh-ed25519 AAAA...`) are the secret's value. `scripts/ci-known-hosts.sh` refuses anything that is not exactly one line starting with `HOMESERVER_HOST`, of type ssh-ed25519, and the job log prints the fingerprint it trusts so you can compare. Strict host-key checking stays on.

### 2. Tailscale (admin console)

- Add `tag:ci` to the tag owners and create an **OAuth client** with the `auth_keys` scope (write) restricted to `tag:ci`.
- Add an access rule letting `tag:ci` reach the server on **port 22 only**. The runner joins as an ephemeral node, so it disappears after the job.
- If a run fails with `OAuth identity empty`, the Tailscale action received an empty client id: the secret is missing, is a variable, or is stored on a different environment than the job uses. The workflows now fail earlier with the names of the empty secrets.

### 3. The deploy key and the server

On your laptop, create a key that is used for nothing else:

```bash
ssh-keygen -t ed25519 -f hlcc-ci-deploy -C hlcc-ci -N ""
```

Put the private file in the `DEPLOY_SSH_KEY` secret, then delete it from the laptop. On the server (as `shikhil`), install the **reviewed** script, and compare its hash with the one in the pull request:

```bash
mkdir -p ~/hlcc/bin
install -m 700 /path/to/reviewed/scripts/hlcc-deploy.sh ~/hlcc/bin/hlcc-deploy
sha256sum ~/hlcc/bin/hlcc-deploy          # must equal the hash of scripts/hlcc-deploy.sh in the merged commit
```

Back up `authorized_keys`, then **append** one line (never replace the file); `from=` limits the key to Tailscale addresses:

```bash
cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-$(date +%Y%m%d-%H%M%S)
echo 'command="/home/shikhil/hlcc/bin/hlcc-deploy",restrict,from="100.64.0.0/10" ssh-ed25519 AAAA...hlcc-ci' >> ~/.ssh/authorized_keys
```

To undo it: restore the backup copy, or delete that one line.

### 4. Prove the path before the first deploy

Run the workflow **Deploy check (read-only)** (Actions, run it on `main`). It joins the tailnet, verifies the host key strictly, and runs the server's `check` command, which cannot deploy. Read its output:

- `source address: ... (inside 100.64.0.0/10: yes)` confirms the `from=` range fits the runner. If it says `no`, the connection would have been refused at the key; widen nothing blindly, investigate first.
- `configuration: ok`, `no unfinished deploy marker`, and the memory, load and disk figures.

### 5. Public hostname with sign-in (Cloudflare)

Order matters: protect first, publish second.

1. **Cloudflare Zero Trust, Access, Applications, Add, Self-hosted**: domain `server.kavlien.store`. Add an **Allow** policy for your own email address(es), with the One-time PIN login method. Nobody else gets as far as the login page.
2. **Server env file** (`~/hlcc/hlcc.env`): add `HLCC_TUNNEL_NETWORK=true` and set `HLCC_ALLOWED_ORIGINS=https://server.kavlien.store`. Keep `HLCC_TRUST_PROXY=0` for now.
3. Apply it once by hand (a normal deploy applies it too):
   ```bash
   cd /srv/projects/homelab-control-center
   docker compose --project-name homelab-control-center --env-file ~/hlcc/hlcc.env \
     -f deploy/compose.yaml -f deploy/compose.tunnel.yaml up -d --no-build
   ```
   This attaches only the dashboard to the existing `cloudflare-proxy` network under the name `hlcc-dashboard`. No existing container is touched. The dashboard then shares that network with `cloudflared`, nginx and Nextcloud; it publishes nothing there.
4. **Tunnels, your tunnel, Public Hostname, Add**: `server.kavlien.store`, service `HTTP`, URL `hlcc-dashboard:8787`. (If the tunnel page says it is locally managed rather than remotely managed, stop and ask: the route must then be added in the tunnel's config file, which is a change to the existing deployment.)
5. Sign in at `https://server.kavlien.store`: the Cloudflare PIN first, then the dashboard's own login.
6. Open Settings, **Network identity**. With `HLCC_TRUST_PROXY=0` it shows the tunnel's address as the "client". Choose the smallest hop count whose row shows your real public address (expected: `1`), set `HLCC_TRUST_PROXY=1` in the env file and run step 3 again. Until then every visitor shares one rate-limit bucket.

## Day to day

- **Deploy**: merge to `main`, then approve the `production` deployment when GitHub asks. The job shows the script's progress. A failed deploy shows red, the old version keeps running, and the log names the database backup taken beforehand.
- **Redeploy the same commit**: re-run the workflow; the script reports "already deployed" and exits.
- **Check only**: run **Deploy check (read-only)**, or from a trusted shell `ssh -i <deploy key> shikhil@<server> check`.
- **Logs**: `~/hlcc/deploy.log` on the server. Releases are kept in `/srv/projects/homelab-control-center/releases/<commit>`; the script never deletes them.
- **Revoke CI access**: remove the one line from `authorized_keys`, or delete the `DEPLOY_SSH_KEY` secret.
- **Changing the deploy script**: edit `scripts/hlcc-deploy.sh`, review, merge, then reinstall it on the server (step 3) and compare the hash. Merges never do this for you, by design.
- **Rollback by hand**: `docker tag homelab-control-center:previous homelab-control-center:local` (and the same for `homelab-control-center-docker-proxy`), then the `up -d --no-build` command above.

## After an interrupted deployment

If a deploy is interrupted by a power loss, a kill, or the server restarting, the file `/srv/projects/homelab-control-center/.deploy-in-progress` stays behind (it records the commit, tree, start time, previous commit and backup path). `.deployed-sha` still names the last version that was **verified**. While the marker exists, `deploy` refuses with exit code 78 and `check` reports it. To recover:

1. Read the marker and the end of `~/hlcc/deploy.log`.
2. Look at the real state: `docker compose --project-name homelab-control-center ps`, `docker images | grep homelab-control-center`, and `curl -s 127.0.0.1:8787/api/v1/health`.
3. Decide which version should be running. If both services are healthy on the version you want, nothing else is needed. If not, either run the manual rollback above, or restore the pre-deploy backup named in the marker (backup-and-recovery.md) with the services stopped.
4. Delete the marker (`rm /srv/projects/homelab-control-center/.deploy-in-progress`) only after the live state is what you intend. Then re-run the workflow.

## What a failed deploy looks like

| Message                                      | Meaning                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `configuration problems`                     | a path or the env file failed validation (labels only, never values); nothing was changed (exit 2) |
| `REFUSING: an earlier deploy did not finish` | the marker exists; reconcile it as described above (exit 78)                                       |
| `invalid release archive: ...`               | the upload failed archive validation; nothing was extracted or changed                             |
| `tree mismatch`                              | the upload differs from what CI built; nothing was changed                                         |
| `server busy` or `of memory available`       | the server was too loaded to build safely; re-run the workflow later (exit 75)                     |
| `backup failed its integrity check`          | nothing was built or restarted                                                                     |
| `ROLLED BACK to ...`                         | the new release failed its health or security checks; the previous version is running again        |
| `ROLLBACK DID NOT COMPLETE`                  | the marker is kept; follow "After an interrupted deployment"                                       |
