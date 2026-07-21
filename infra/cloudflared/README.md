# Cloudflare Tunnel setup (LEGACY)

NOTE: vantage no longer uses Cloudflare Tunnel — Tailscale handles remote
access. This document is kept for reference in case we ever need a public
URL again. The brand name "equity-agent" appears throughout because it was
written before the rename.

The dashboard runs on `http://localhost:3000` on the gaming PC. To reach it
from anywhere (laptop, phone) without opening router ports, we used to front
it with a Cloudflare Tunnel. All inbound traffic terminates TLS at Cloudflare,
then flows to `cloudflared` over an outbound-only QUIC connection.

---

## 1. Install `cloudflared` on the gaming PC

Option A — winget (recommended):

```powershell
winget install --id Cloudflare.cloudflared
```

Option B — direct download:

1. Grab the latest Windows `.msi` from
   <https://github.com/cloudflare/cloudflared/releases/latest>.
2. Run the installer. It adds `cloudflared` to `PATH`.

Verify:

```powershell
cloudflared --version
```

---

## 2. Pick an authentication path

You have two choices. Pick one and stick with it.

### Path A — your own Cloudflare domain (recommended)

You need a domain whose nameservers point at Cloudflare. Free plan is fine.

```powershell
# Opens a browser. Authorize the zone you want to use.
cloudflared tunnel login

# Creates a tunnel named "equity-agent" and writes credentials to
#   C:\Users\<you>\.cloudflared\<UUID>.json
cloudflared tunnel create equity-agent

# Bind a subdomain to the tunnel. Pick anything — equity.example.com,
# agent.<your-domain>, etc. Cloudflare creates the CNAME automatically.
cloudflared tunnel route dns equity-agent equity.<your-domain>
```

### Path B — no domain, use `trycloudflare.com`

For quick testing. URL rotates per invocation. Skip `config.yml` entirely:

```powershell
cloudflared tunnel --url http://localhost:3000
```

cloudflared prints a `https://<random>.trycloudflare.com` URL. It lasts as
long as `cloudflared` stays running. Good for smoke-testing; not for real
use (no persistent URL, no Access gating).

---

## 3. Wire the config file (Path A only)

Open `infra/cloudflared/config.yml` and replace the placeholders:

| Placeholder              | Where to get it                                       |
| ------------------------ | ----------------------------------------------------- |
| `<TUNNEL_UUID>`          | Printed by `cloudflared tunnel create equity-agent`   |
| `<CREDENTIALS_PATH>`     | `C:\Users\<you>\.cloudflared\<UUID>.json`             |
| `<DASHBOARD_HOSTNAME>`   | The subdomain you passed to `cloudflared tunnel route dns` |

Save. Smoke-test:

```powershell
cloudflared tunnel --config C:\path\to\equity-agent\infra\cloudflared\config.yml run equity-agent
```

Open `https://<DASHBOARD_HOSTNAME>` in a browser — you should hit the
dashboard login page. Ctrl-C when verified.

Also update `DASHBOARD_BASE_URL=https://<DASHBOARD_HOSTNAME>` in `.env` so
Telegram deep-links point at the public URL.

---

## 4. Install as a Windows service (auto-start)

Running the tunnel inside a terminal window is fine for testing. For the
always-on setup:

```powershell
# Install cloudflared as a Windows service that auto-starts on boot.
# Uses the config at C:\Users\<you>\.cloudflared\config.yml by default —
# copy infra/cloudflared/config.yml there OR pass --config in
# Service arguments via the registry (HKLM\SYSTEM\...\cloudflared).
cloudflared service install

# Start it now
net start cloudflared
```

Check status:

```powershell
Get-Service cloudflared
cloudflared tunnel info equity-agent
```

If you edit `config.yml` after install, restart the service:

```powershell
net stop cloudflared
net start cloudflared
```

---

## 5. Guarding the credentials file

`cloudflared tunnel create` writes a JSON file containing a secret that can
operate the tunnel on your behalf. Don't commit it. The repo's `.gitignore`
already ignores `infra/cloudflared/*.json`; the deploy script skips it via
rsync `--exclude`. Keep the canonical copy in
`C:\Users\<you>\.cloudflared\` and back it up with the rest of your
`%USERPROFILE%` dotfiles.

---

## 6. Troubleshooting

**Tunnel connects but 502 Bad Gateway at the hostname** — Next.js isn't
running, or PM2 hasn't reloaded after a deploy. Check
`pm2 status equity-agent-web` on the PC.

**Cookie/session breaks behind the tunnel** — make sure `config.yml` sets
`originRequest.httpHostHeader` to the public hostname (see the template).
iron-session binds the session cookie to the hostname Next.js sees.

**Tunnel drops after laptop sleep / router reboot** — cloudflared
auto-reconnects within ~30s. Verify with `cloudflared tunnel info
equity-agent`. The Phase 13 self-alert fires if the public URL is
unreachable for >5 min.
