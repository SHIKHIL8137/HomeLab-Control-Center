# Host agent: design only

**Status: design only. Nothing here is built, installed or enabled, and nothing on the Ubuntu server has been
changed.** It is written down so the decision can be made with the trade-offs visible.

## Why it might be needed

A container cannot truthfully observe some things about the machine it runs on:

- the Wi-Fi link state and signal (the server was seen losing its Wi-Fi beacon repeatedly before an unclean reboot),
- the **LAN** default gateway (inside a container, the gateway is Docker's bridge, not the router),
- Tailscale state (the daemon's socket is on the host),
- the boot history and clean-versus-unclean shutdown.

The dashboard currently shows these as "Needs host agent" rather than a misleading green.

## Shape of the agent

A small, unprivileged program run by a systemd timer, which writes one JSON status file for the dashboard to read.
It listens on no port and accepts no input.

- Runs as a dedicated user with no shell, no sudo and no Docker access.
- Writes `status.json` atomically (write temp, rename) to a directory the dashboard mounts **read-only**.
- Reads only fixed sources: `/sys/class/net/<iface>/{operstate,carrier}`, `/proc/net/wireless`, the default route,
  `tailscale status --json` (needs the Tailscale operator setting, otherwise skipped), `last -x` or the journal for boots.
- Probes only fixed, configured targets (gateway address, a DNS name), with short timeouts.
- Includes a timestamp and its own version, so the dashboard can mark stale agent data as stale like any other source.

## What the dashboard does with it

Validates the file against a schema, treats anything malformed or old as "unavailable", and never trusts it for
anything but display. The agent cannot be told to do anything by the dashboard.

## Open decisions (need the owner)

1. Is it worth installing a host-side component at all, or is "Needs host agent" acceptable?
2. Which interface name and gateway to monitor (the audit saw a Wi-Fi interface and a LAN address).
3. Whether Tailscale's operator setting may be changed so the agent can read its status without sudo.
4. Where the status file should live, and who may read it.

## Not decided or done

Installation steps, the unit files, and the permissions are deliberately not written yet. They would be a change to
the server and need a separate approval.
