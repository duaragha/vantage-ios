#!/usr/bin/env bash
#
# Build and deploy Vantage to the Windows gaming PC through Docker's remote
# SSH context. This script deliberately has no local-Docker fallback.

set -Eeuo pipefail

readonly DOCKER_CONTEXT='gamingpc'
readonly EXPECTED_DOCKER_ENDPOINT='ssh://docker-pc'
readonly TAILSCALE_HOST='raghavsgamingpc'
readonly DASHBOARD_URL='https://raghavsgamingpc.tail4d6220.ts.net:3500'

DRY_RUN=0
RUN_GATES=1

usage() {
  cat <<'EOF'
Usage: ./infra/deploy-docker-to-pc.sh [--dry-run] [--skip-gates]

  --dry-run     Validate local configuration and print the release sequence.
                It does not contact Docker or change the PC.
  --skip-gates  Skip pnpm install/test/typecheck/lint/audit/build. Use only
                when those exact sources have already passed the full gates.

The target is permanently locked to Docker context "gamingpc"
(ssh://docker-pc). There is no option to deploy Vantage locally.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) DRY_RUN=1 ;;
    --skip-gates) RUN_GATES=0 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

readonly ENV_FILE="$REPO_ROOT/.env"
readonly COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"
readonly -a DOCKER=(docker --context "$DOCKER_CONTEXT")
readonly -a COMPOSE=(
  docker --context "$DOCKER_CONTEXT" compose
  --env-file "$ENV_FILE"
  -f "$COMPOSE_FILE"
)

log() {
  printf '\n==> %s\n' "$*"
}

print_command() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

env_key_is_set() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      value = substr($0, index($0, "=") + 1)
      sub(/\r$/, "", value)
      if (length(value) > 0) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$ENV_FILE"
}

env_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "=" {
      value = substr($0, index($0, "=") + 1)
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

wait_for_healthy_container() {
  local container="$1"
  local timeout_seconds="$2"
  local started_at status
  started_at="$(date +%s)"

  while true; do
    status="$("${DOCKER[@]}" inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$container" 2>/dev/null || true)"
    case "$status" in
      healthy | running)
        printf '  %s: %s\n' "$container" "$status"
        return 0
        ;;
      unhealthy | exited | dead)
        "${COMPOSE[@]}" logs --tail 100 --no-color >&2 || true
        die "$container entered state: $status"
        ;;
    esac

    if (( $(date +%s) - started_at >= timeout_seconds )); then
      "${COMPOSE[@]}" logs --tail 100 --no-color >&2 || true
      die "$container did not become healthy within ${timeout_seconds}s (last state: ${status:-missing})"
    fi
    sleep 3
  done
}

assert_non_root_container() {
  local container="$1"
  local configured_user
  configured_user="$("${DOCKER[@]}" inspect --format '{{.Config.User}}' "$container")"
  case "$configured_user" in
    '' | 0 | root | 0:* | root:*) die "$container is configured to run as root" ;;
  esac
  printf '  %s user: %s\n' "$container" "$configured_user"
}

assert_image_has_no_private_files() {
  local image="$1"
  "${DOCKER[@]}" run --rm --entrypoint sh "$image" -lc \
    "if for root in /app /repo; do
       [ -d \"\$root\" ] || continue
       find \"\$root\" -type f \
         \( -name '.env' -o \( -name '.env.*' ! -name '.env.example' \) \
            -o -name '*.dump' -o -name '*.key' -o -name '*.crt' \) \
         -print -quit
     done | grep -q .; then
       echo 'private file found in an application source tree' >&2
       exit 1
     fi"
  printf '  %s: no env, dump, key, or certificate files under /app or /repo\n' "$image"
}

log 'validating local release configuration'
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing"
[[ -f "$COMPOSE_FILE" ]] || die "$COMPOSE_FILE is missing"

for command in awk curl date docker pg_restore pnpm sha256sum stat tailscale; do
  require_command "$command"
done

env_mode="$(stat -c %a "$ENV_FILE")"
[[ "$env_mode" == '600' || "$env_mode" == '400' ]] ||
  die ".env permissions are $env_mode; run chmod 600 .env before deploying"

required_env_keys=(
  POSTGRES_USER
  POSTGRES_PASSWORD
  POSTGRES_DB
  DATABASE_URL
  SESSION_SECRET
  ADMIN_PASSWORD_HASH_B64
  WORKER_SECRET
  ANTHROPIC_API_KEY
  FINNHUB_API_KEY
  TIINGO_API_KEY
  FRED_API_KEY
  ALPACA_KEY_ID
  ALPACA_SECRET_KEY
  EDGAR_USER_AGENT
  DASHBOARD_BASE_URL
  TZ
)
for key in "${required_env_keys[@]}"; do
  env_key_is_set "$key" || die "$key is missing or empty in .env"
  value="$(env_value "$key")"
  case "$value" in
    change_me* | your_* | sk-ant-your-*) die "$key still contains an example placeholder" ;;
  esac
done

[[ "$(env_value DASHBOARD_BASE_URL)" == "$DASHBOARD_URL" ]] ||
  die "DASHBOARD_BASE_URL must be $DASHBOARD_URL for the PC deployment"
[[ "$(env_value TZ)" == 'America/Toronto' ]] ||
  die 'TZ must be America/Toronto for scheduler and market-date correctness'

session_secret="$(env_value SESSION_SECRET)"
worker_secret="$(env_value WORKER_SECRET)"
(( ${#session_secret} >= 32 )) || die 'SESSION_SECRET must be at least 32 characters'
(( ${#worker_secret} >= 24 )) || die 'WORKER_SECRET must be at least 24 characters'
unset session_secret worker_secret value

if ! env_key_is_set TELEGRAM_BOT_TOKEN || ! env_key_is_set TELEGRAM_CHAT_ID; then
  printf 'warning: Telegram is not configured; alerts will remain queued.\n' >&2
fi

if ((DRY_RUN)); then
  log 'dry-run release sequence'
  if ((RUN_GATES)); then
    print_command pnpm install --frozen-lockfile
    print_command pnpm test
    print_command pnpm typecheck
    print_command pnpm lint
    print_command pnpm audit --audit-level high
    print_command pnpm build
    printf '  DATABASE_URL=<from-.env> pnpm --filter @vantage/db exec prisma validate\n'
  fi
  print_command tailscale ping -c 1 "$TAILSCALE_HOST"
  print_command "${DOCKER[@]}" info
  print_command "${COMPOSE[@]}" config --quiet
  print_command "${DOCKER[@]}" volume inspect equity_agent_pgdata
  print_command "${COMPOSE[@]}" up -d postgres
  printf '  [backup] pg_dump in vantage-postgres -> backups/vantage-TIMESTAMP.dump.partial\n'
  print_command "${COMPOSE[@]}" build web worker embedder
  print_command "${COMPOSE[@]}" run --rm --no-deps worker sh -c 'cd node_modules/@vantage/db && ../../.pnpm/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma'
  print_command "${COMPOSE[@]}" up -d --no-deps embedder web worker
  printf '  [verify] container health, non-root users, image contents, migrations, and %s\n' "$DASHBOARD_URL"
  exit 0
fi

if ((RUN_GATES)); then
  log 'running local release gates'
  pnpm install --frozen-lockfile
  pnpm test
  pnpm typecheck
  pnpm lint
  pnpm audit --audit-level high
  pnpm build
  DATABASE_URL="$(env_value DATABASE_URL)" \
    pnpm --filter @vantage/db exec prisma validate
fi

log 'verifying the remote Docker target'
endpoint="$(docker context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}')"
[[ "$endpoint" == "$EXPECTED_DOCKER_ENDPOINT" ]] ||
  die "Docker context $DOCKER_CONTEXT points to $endpoint, expected $EXPECTED_DOCKER_ENDPOINT"
tailscale ping -c 1 "$TAILSCALE_HOST"
"${DOCKER[@]}" info >/dev/null
"${COMPOSE[@]}" config --quiet
"${DOCKER[@]}" volume inspect equity_agent_pgdata >/dev/null
printf '  context: %s (%s)\n' "$DOCKER_CONTEXT" "$endpoint"

log 'starting and checking live Postgres'
"${COMPOSE[@]}" up -d postgres
wait_for_healthy_container vantage-postgres 180

log 'creating a verified pre-migration backup'
umask 077
mkdir -p backups
chmod 700 backups
backup_stamp="$(date +%Y%m%d-%H%M%S)"
backup_path="$REPO_ROOT/backups/vantage-${backup_stamp}.dump"
partial_path="${backup_path}.partial"
trap 'rm -f "${partial_path:-}"' EXIT

if ! "${COMPOSE[@]}" exec -T postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$partial_path"; then
  die 'pg_dump failed; deployment stopped before migration'
fi
[[ -s "$partial_path" ]] || die 'database backup is empty'
pg_restore --list "$partial_path" >/dev/null
mv "$partial_path" "$backup_path"
sha256sum "$backup_path" >"${backup_path}.sha256"
trap - EXIT
printf '  backup: %s (%s bytes)\n' "$backup_path" "$(stat -c %s "$backup_path")"

log 'building remote application images'
"${COMPOSE[@]}" build web worker embedder

log 'applying and verifying database migrations'
# The slim worker image has no pnpm; run the prisma CLI bundled into the
# pruned /app tree (same invocation as the Railway preDeployCommand).
"${COMPOSE[@]}" run --rm --no-deps worker \
  sh -c 'cd node_modules/@vantage/db && ../../.pnpm/node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma'
"${COMPOSE[@]}" run --rm --no-deps worker \
  sh -c 'cd node_modules/@vantage/db && ../../.pnpm/node_modules/.bin/prisma migrate status --schema prisma/schema.prisma'

log 'replacing web, worker and embedder containers'
"${COMPOSE[@]}" up -d --no-deps embedder web worker
wait_for_healthy_container vantage-web 240
wait_for_healthy_container vantage-worker 240
wait_for_healthy_container vantage-embedder 240

log 'checking runtime isolation'
assert_non_root_container vantage-web
assert_non_root_container vantage-worker
assert_non_root_container vantage-embedder
assert_image_has_no_private_files vantage-web:local
assert_image_has_no_private_files vantage-worker:local
assert_image_has_no_private_files vantage-embedder:local

log 'checking the live dashboard'
curl --fail --silent --show-error --retry 10 --retry-delay 3 \
  --retry-all-errors "$DASHBOARD_URL/api/health"
printf '\n'

log 'deployment status'
"${COMPOSE[@]}" ps
"${COMPOSE[@]}" logs --since 10m --no-color web worker
printf '\nrelease complete: %s\n' "$DASHBOARD_URL"
