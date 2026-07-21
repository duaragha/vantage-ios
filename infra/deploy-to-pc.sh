#!/usr/bin/env bash
#
# deploy-to-pc.sh — LEGACY pm2 deploy script. The primary deploy path is
# now docker compose (see infra/docker-compose.yml + docs/DEPLOY_WINDOWS.md).
# This script remains as a fallback for hosts without Docker.
#
# Ships the vantage build from the laptop to the gaming PC
# (Windows 11 + OpenSSH server). Steps:
#   1. Build locally (pnpm -r build)
#   2. Rsync built artifacts + package manifests + migrations to remote
#   3. SSH to remote, install prod deps, run `prisma migrate deploy`,
#      and `pm2 reload infra/ecosystem.config.cjs --update-env`
#
# Usage:
#   ./infra/deploy-to-pc.sh               # real deploy
#   ./infra/deploy-to-pc.sh --dry-run     # print what would happen, run nothing
#
# Config (override via env):
#   PC_SSH_TARGET   user@host for SSH/rsync (e.g. raghav@raghav-pc.local)
#   PC_DEPLOY_PATH  absolute path on the PC where the repo lives
#                   (default /c/Users/raghav/vantage — Git-Bash / MSYS
#                    path syntax, works with OpenSSH on Windows)
#
# First-time setup:
#   - Enable OpenSSH Server on Windows (Settings → Apps → Optional features).
#   - Generate an SSH key on the laptop, copy the public key to
#     %USERPROFILE%\.ssh\authorized_keys on the PC.
#   - Verify: `ssh $PC_SSH_TARGET echo ok` before running this script.
#   - Clone the repo once on the PC so initial `.env` + Postgres are in place.
#   - `pnpm install` on the PC once so node_modules is populated.
#   - `pm2 start infra/ecosystem.config.cjs` once so PM2 remembers the apps.

set -euo pipefail

# --- Config -------------------------------------------------------------------
PC_SSH_TARGET="${PC_SSH_TARGET:-raghav@raghav-pc.local}"
PC_DEPLOY_PATH="${PC_DEPLOY_PATH:-/c/Users/raghav/vantage}"
PLACEHOLDER_TARGET_RE='^raghav@raghav-pc\.local$'

# --- Flags --------------------------------------------------------------------
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# --- Pre-flight ---------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "$PC_SSH_TARGET" =~ $PLACEHOLDER_TARGET_RE ]]; then
  cat >&2 <<'EOF'
================================================================================
PC_SSH_TARGET is still the placeholder (raghav@raghav-pc.local).

Before using this script:
  1. Make sure your gaming PC has OpenSSH Server running and reachable.
  2. Set PC_SSH_TARGET in your shell (or pass inline):
       export PC_SSH_TARGET=raghav@<your-pc-hostname-or-tailnet>
     Examples:
       raghav@raghav-pc.local           (mDNS on the LAN)
       raghav@raghav-pc.tailnet.ts.net  (Tailscale)
       raghav@192.168.1.42              (fixed LAN IP)
  3. Optionally override the target path:
       export PC_DEPLOY_PATH=/c/Users/raghav/vantage
  4. Verify connectivity: ssh "$PC_SSH_TARGET" echo ok
================================================================================
EOF
  if [ "$DRY_RUN" -eq 0 ]; then
    exit 1
  else
    echo "(continuing dry-run with placeholder target)" >&2
  fi
fi

echo "==> Target:    $PC_SSH_TARGET:$PC_DEPLOY_PATH"
echo "==> Dry-run:   $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)"

# --- 1. Build locally ---------------------------------------------------------
echo "==> [1/3] Building locally"
run pnpm install --frozen-lockfile
run pnpm -r build

# --- 2. Rsync to remote -------------------------------------------------------
echo "==> [2/3] Rsyncing to $PC_SSH_TARGET:$PC_DEPLOY_PATH"

# Include list — we ship everything by default and exclude dev-only noise.
# Critical shipped items:
#   - package manifests + lockfile + workspace + tsconfig (for pnpm install)
#   - dist/ + .next/ + generated/ outputs (pre-built code)
#   - Prisma schema + migrations (for `prisma migrate deploy`)
#   - infra/ (ecosystem, env-preload, cloudflared, scripts)
#   - docs/ + README.md
#
# Exclude list — never ship secrets, dev junk, or machine-specific binaries:
#   .env*          (keys stay on the PC)
#   node_modules/  (pnpm install on the PC resolves via the lockfile)
#   .git/, *.log, logs/, .next/cache/, .turbo/, .tsbuildinfo, coverage/
#   cloudflared/*.json  (tunnel credentials are per-machine)
RSYNC_ARGS=(
  -avz --delete-after
  --exclude '.git/'
  --exclude 'node_modules/'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '*.log'
  --exclude 'logs/'
  --exclude '.next/cache/'
  --exclude '.turbo/'
  --exclude '.cache/'
  --exclude '.DS_Store'
  --exclude 'Thumbs.db'
  --exclude '*.tsbuildinfo'
  --exclude 'coverage/'
  --exclude 'infra/cloudflared/*.json'
)

run rsync "${RSYNC_ARGS[@]}" "$REPO_ROOT/" "$PC_SSH_TARGET:$PC_DEPLOY_PATH/"

# --- 3. Remote install + migrate + reload -------------------------------------
echo "==> [3/3] Remote install / migrate / pm2 reload"

REMOTE_SCRIPT=$(cat <<REMOTE
set -euo pipefail
cd "$PC_DEPLOY_PATH"

echo "  -> pnpm install --prod"
pnpm install --prod --frozen-lockfile

echo "  -> prisma migrate deploy"
pnpm --filter @vantage/db exec prisma migrate deploy

echo "  -> pm2 reload ecosystem.config.cjs"
if pm2 describe vantage-web >/dev/null 2>&1; then
  pm2 reload infra/ecosystem.config.cjs --update-env
else
  pm2 start infra/ecosystem.config.cjs
fi
pm2 save

echo "  -> health checks"
for i in 1 2 3 4 5; do
  if curl -sf http://localhost:3001/health >/dev/null; then
    echo "     worker /health OK"
    break
  fi
  sleep 2
done
curl -sf http://localhost:3000/api/health >/dev/null && echo "     web /api/health OK"
REMOTE
)

if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] ssh %q <<REMOTE\n' "$PC_SSH_TARGET"
  printf '%s\n' "$REMOTE_SCRIPT"
  printf 'REMOTE\n'
else
  ssh "$PC_SSH_TARGET" bash -s <<<"$REMOTE_SCRIPT"
fi

echo "==> Deploy complete"
