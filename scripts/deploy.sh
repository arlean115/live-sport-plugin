#!/usr/bin/env bash
#
# deploy.sh - safe, quiet-window deploy for Nuvio Live Sports Plugin.
#
# What it does, in order:
#   1. Records health + the DaddyLive match count so the outcome is comparable.
#   2. Pulls main (fast-forward only - never creates a merge commit).
#   3. Builds into dist/ and ABORTS before touching PM2 if the build fails.
#      This is the important part: a failed build must never reach reload,
#      or you ship a broken addon while people are watching.
#   4. Reloads with `pm2 reload` (rolling, zero-downtime in cluster mode).
#      Never `pm2 restart` - that drops every live connection.
#   5. Waits for /health to answer, then reports the result.
#
# It does NOT restart the resolver or the reverse proxy, and it does not touch
# .env or the crontab.
#
# USAGE
#   cd /root/nuvio-live-sports
#   bash scripts/deploy.sh              # pull, build, reload, verify
#   bash scripts/deploy.sh --no-pull    # build + reload without git pull
#   bash scripts/deploy.sh --check      # health + dlv count only, changes nothing
#
# Env: PM2_NAME (default nuvio-sports), PORT (else .env, else 7000).
# Exit: 0 ok | 1 build/pull/health failure | 2 bad usage
#
set -euo pipefail

# ---- locate the repo -------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -f package.json ] || [ ! -d src ]; then
  echo "ERROR: $REPO_DIR does not look like the addon repo."
  exit 2
fi

PM2_NAME="${PM2_NAME:-nuvio-sports}"
DO_PULL=1
CHECK_ONLY=0

usage() {
  cat <<'EOF'
deploy.sh - safe, quiet-window deploy for the Nuvio Live Sports addon

Usage:
  bash scripts/deploy.sh            pull main, build, pm2 reload, health check
  bash scripts/deploy.sh --no-pull  build + reload only (skip git)
  bash scripts/deploy.sh --check    print branch/health/dlv count, change nothing

The build runs BEFORE pm2 is touched: a failed build aborts the deploy rather
than shipping a broken addon. The reload uses `pm2 reload` (rolling), never
`pm2 restart`. Neither .env nor the crontab is modified.

Env: PM2_NAME (default nuvio-sports), PORT (else .env, else 7000).
Exit: 0 ok | 1 build/pull/health failure | 2 bad usage
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    --check)   CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown flag: $arg"; usage; exit 2 ;;
  esac
done

# ---- resolve the app port (env, else .env, else 7000) ----------------------
APP_PORT="${PORT:-}"
if [ -z "$APP_PORT" ] && [ -f .env ]; then
  APP_PORT="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
APP_PORT="${APP_PORT:-7000}"
BASE="http://127.0.0.1:${APP_PORT}"

log()  { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*"; exit 1; }

# Resolve node once. A minimal PATH (some shells, cron-adjacent contexts) may not
# carry it, and the dlv counter below shells out to node.
NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] || NODE_BIN=/usr/bin/node

# Count DaddyLive matches the running app can see, so the deploy prints
# something meaningful rather than just "OK".
dlv_count() {
  curl -s --max-time 25 "${BASE}/api/matches" 2>/dev/null \
    | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const m=JSON.parse(d);process.stdout.write(String(m.filter(x=>String((x&&x.id)||'').includes('dlv')).length))}catch(_){process.stdout.write('?')}})" \
    2>/dev/null || echo "?"
}

health_ok() {
  curl -sf --max-time 10 "${BASE}/health" >/dev/null 2>&1
}

pm2_mode() {
  if command -v pm2 >/dev/null 2>&1; then
    pm2 jlist 2>/dev/null | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d).find(x=>x.name==='${PM2_NAME}');process.stdout.write(a?('mode='+((a.pm2_env&&a.pm2_env.exec_mode)||'?')+' status='+((a.pm2_env&&a.pm2_env.status)||'?')):'not found')}catch(_){process.stdout.write('?')}})" 2>/dev/null || echo "?"
  else
    echo "pm2 not on PATH"
  fi
}

# ---- check-only mode -------------------------------------------------------
if [ "$CHECK_ONLY" = "1" ]; then
  log "Check only (no changes)"
  echo "repo      : $REPO_DIR"
  echo "branch    : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  echo "head      : $(git log -1 --oneline 2>/dev/null || echo '?')"
  echo "app port  : $APP_PORT"
  if health_ok; then echo "health    : OK"; else warn "health    : NOT RESPONDING"; fi
  echo "dlv rows  : $(dlv_count)"
  echo "pm2       : $(pm2_mode)"
  exit 0
fi

# ---- pre-flight ------------------------------------------------------------
log "Pre-flight"
command -v node >/dev/null 2>&1 || die "node not found on PATH"
command -v pm2  >/dev/null 2>&1 || die "pm2 not found on PATH"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
if [ "$DO_PULL" = "1" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  die "on branch '$CURRENT_BRANCH', not 'main'. Switch to main first (git checkout main)."
fi

echo "repo   : $REPO_DIR"
echo "port   : $APP_PORT"
echo "pm2    : $PM2_NAME"

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  warn "working tree has uncommitted changes."
  warn "A 'git pull' can overwrite or conflict with them. Continuing in 5s (Ctrl-C to abort)."
  warn "Tip: stash first with 'git stash push -u' if these are yours."
  sleep 5
fi

HEALTH_BEFORE=$(health_ok && echo yes || echo no)
DLV_BEFORE=$(dlv_count)
echo "before : health=$HEALTH_BEFORE dlv=$DLV_BEFORE"

# ---- pull ------------------------------------------------------------------
if [ "$DO_PULL" = "1" ]; then
  log "git pull (fast-forward only)"
  git fetch origin main
  git merge --ff-only origin/main
  echo "head   : $(git log -1 --oneline)"
else
  log "Skipping git pull (--no-pull)"
fi

# ---- build -----------------------------------------------------------------
log "npm run build"
if ! npm run build > /tmp/nuvio-build.log 2>&1; then
  warn "BUILD FAILED - the running app was NOT touched."
  echo "---- last 40 lines of /tmp/nuvio-build.log ----"
  tail -n 40 /tmp/nuvio-build.log
  die "refusing to reload on a failed build"
fi
echo "build   : OK"

[ -s dist/index.js ] || die "dist/index.js is missing or empty after build - not reloading"

# ---- reload ----------------------------------------------------------------
log "pm2 reload $PM2_NAME (rolling / zero-downtime)"
if ! pm2 reload "$PM2_NAME" --update-env; then
  warn "pm2 reload failed. The old process may still be serving."
  die "reload failed - inspect: pm2 logs $PM2_NAME --lines 50"
fi

# ---- wait for health -------------------------------------------------------
log "Waiting for health"
TRIES=0
until health_ok; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -ge 15 ]; then
    warn "Health did not recover within ~30s."
    echo "Rollback: git reset --hard <previous-sha> && npm run build && pm2 reload $PM2_NAME --update-env"
    echo "Logs    : pm2 logs $PM2_NAME --lines 60 --nostream"
    exit 1
  fi
  sleep 2
done
echo "health  : OK"

# ---- summary ---------------------------------------------------------------
DLV_AFTER=$(dlv_count)
log "Deploy complete"
echo "head    : $(git log -1 --oneline)"
echo "health  : ${HEALTH_BEFORE} -> OK"
echo "dlv rows: ${DLV_BEFORE} -> ${DLV_AFTER}"
echo ""
echo "A dlv count much lower than 'before' is usually the match cache mid-resync."
echo "Force a clean one with : node scripts/sync-matches.js"
echo "Check the carry-forward log with:"
echo "  pm2 logs ${PM2_NAME} --lines 40 --nostream | grep -i carried"
