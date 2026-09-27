#!/usr/bin/env bash
#
# status.sh - plain-English health check for the Nuvio Live Sports addon.
#
# Run this on the VPS any time you want to know what's happening:
#
#   cd /root/nuvio-live-sports
#   bash scripts/status.sh
#
# It answers four questions in plain words, no JSON to read:
#   1. Is the app alive and fast?
#   2. Do DaddyLive streams actually work right now?
#   3. Is the server under memory pressure (the thing that broke it)?
#   4. Are workers stable, or silently restarting?
#
# Run it twice a few minutes apart: the worker section compares against the
# previous run, so only the second run can say "restarts are climbing".
#
# Colour is disabled automatically when the output is piped or captured.
# Exit: 0 = all good, 1 = something needs attention.
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" 2>/dev/null || true

PORT_CFG="${PORT:-}"
if [ -z "$PORT_CFG" ] && [ -f .env ]; then
  PORT_CFG="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
PORT_CFG="${PORT_CFG:-7000}"
BASE="http://127.0.0.1:${PORT_CFG}"

PROBLEMS=0

# Colour only on a real terminal, so piping to a file stays readable.
if [ -t 1 ]; then
  C_OK=$'\033[1;32m'; C_BAD=$'\033[1;31m'; C_WARN=$'\033[1;33m'; C_HDR=$'\033[1;36m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_BAD=''; C_WARN=''; C_HDR=''; C_OFF=''
fi
ok()   { printf '  %sOK%s    %s\n'   "$C_OK"   "$C_OFF" "$*"; }
bad()  { printf '  %sBAD%s   %s\n'   "$C_BAD"  "$C_OFF" "$*"; PROBLEMS=$((PROBLEMS+1)); }
warn() { printf '  %sWARN%s  %s\n'   "$C_WARN" "$C_OFF" "$*"; }
line() { printf '\n%s%s%s\n' "$C_HDR" "$*" "$C_OFF"; }

echo ""
echo "======================================================="
echo "  NUVIO HEALTH CHECK     $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================================="

# ------------------------------------------------- 1. alive and fast
line "1. Is the app alive and fast?"
# Read status AND time together: a fast response that is not 200 (or 000 =
# could not connect) is NOT healthy, so timing alone must not decide.
RESP="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 "${BASE}/manifest.json" 2>/dev/null || echo '000 99')"
CODE="${RESP%% *}"; T="${RESP##* }"
[ -n "$CODE" ] || CODE=000
[ -n "$T" ] || T=99

if [ "$CODE" != "200" ]; then
  if [ "$CODE" = "000" ]; then
    bad "app is NOT responding on port ${PORT_CFG} - is pm2 running?  (try: pm2 status)"
  else
    bad "manifest returned HTTP ${CODE} (expected 200)"
  fi
elif awk -v t="$T" 'BEGIN{exit !(t<3)}'; then
  ok "manifest responded 200 in ${T}s"
elif awk -v t="$T" 'BEGIN{exit !(t<8)}'; then
  warn "manifest is OK but slow: ${T}s (want under 1s; usually means still warming up)"
else
  bad "manifest very slow: ${T}s - users are waiting"
fi

# ------------------------------------------------- 2. daddylive actually works
line "2. Do DaddyLive streams actually work?"
DLV_IDS="$(curl -s --max-time 20 "${BASE}/api/matches" 2>/dev/null \
  | grep -o '"id":"dlv[^"]*"' | sed 's/"id":"//;s/"//' | head -40)"

if [ -z "$DLV_IDS" ]; then
  bad "no DaddyLive match found in the catalog at all"
else
  TRIED=0; PLAYED=0
  for id in $(echo "$DLV_IDS" | head -5); do
    TRIED=$((TRIED+1))
    R="$(curl -s --max-time 30 "${BASE}/stream/tv/nuvio_sport_${id}.json" 2>/dev/null)"
    if echo "$R" | grep -q 'api/manifest'; then PLAYED=$((PLAYED+1)); fi
  done
  if [ "$PLAYED" -eq 0 ]; then
    bad "0 of ${TRIED} DaddyLive streams resolved - the provider is failing"
  elif [ "$PLAYED" -lt "$TRIED" ]; then
    warn "${PLAYED} of ${TRIED} DaddyLive streams resolved (partial is normal)"
  else
    ok "${PLAYED} of ${TRIED} DaddyLive streams resolved and playing"
  fi
fi

# ------------------------------------------------- 3. memory
line "3. Is the server under memory pressure?   (this is what broke it)"
if command -v free >/dev/null 2>&1; then
  AVAIL_MB="$(free -m | awk '/^Mem:/{print $7}')"
  USED_PCT="$(free | awk '/^Mem:/{printf "%d", ($3/$2)*100}')"
  SWAP_MB="$(free -m | awk '/^Swap:/{print $3}')"
  [ -n "$AVAIL_MB" ] || AVAIL_MB=0
  if [ "$AVAIL_MB" -lt 300 ]; then
    bad "only ${AVAIL_MB}MB RAM available (${USED_PCT}% used) - this is what causes worker restarts"
  elif [ "$AVAIL_MB" -lt 800 ]; then
    warn "${AVAIL_MB}MB RAM available (${USED_PCT}% used) - getting tight"
  else
    ok "${AVAIL_MB}MB RAM available (${USED_PCT}% used) - healthy"
  fi
  if [ "${SWAP_MB:-0}" -gt 800 ]; then
    warn "swap in use: ${SWAP_MB}MB (some swapping - watch it)"
  fi
else
  warn "free not available; skipping memory check"
fi

# ------------------------------------------------- 4. workers stable?
line "4. Are the workers stable, or silently restarting?"
if command -v pm2 >/dev/null 2>&1; then
  STATE_FILE="/tmp/nuvio-status-prev"
  CUR="$(pm2 jlist 2>/dev/null | grep -o '"pm_id"' | wc -l | tr -d ' ')"
  RESTARTS="$(pm2 jlist 2>/dev/null | grep -o '"restart_time":[0-9]*' | sed 's/.*://' | paste -sd+ - | bc 2>/dev/null)"
  PERW="$(pm2 jlist 2>/dev/null | grep -o '"restart_time":[0-9]*' | sed 's/.*://' | paste -sd' ' -)"
  [ -n "$RESTARTS" ] || RESTARTS='?'
  echo "  workers running : ${CUR}"
  echo "  restarts each   : ${PERW:-unknown}   (left to right = worker order)"
  echo "  restarts total  : ${RESTARTS}   (cumulative since last pm2 delete)"

  if [ -f "$STATE_FILE" ]; then
    PREV="$(cat "$STATE_FILE" 2>/dev/null || echo '?')"
    case "$PREV" in ''|*[!0-9]*) PREV='?' ;; esac
    if [ "$RESTARTS" != '?' ] && [ "$PREV" != '?' ] && [ "$RESTARTS" -gt "$PREV" ] 2>/dev/null; then
      bad "restarts INCREASED since last check (${PREV} -> ${RESTARTS}) - workers are still dying"
    else
      ok "restarts unchanged since last check (${PREV}) - workers are stable"
    fi
  else
    echo "  (first run - run this again in a few minutes to see if restarts climb)"
  fi
  echo "$RESTARTS" > "$STATE_FILE" 2>/dev/null || true
else
  warn "pm2 not on PATH; skipping worker check"
fi

# ------------------------------------------------- summary
echo ""
echo "======================================================="
if [ "$PROBLEMS" -eq 0 ]; then
  printf '  %sVERDICT: everything looks good.%s\n' "$C_OK" "$C_OFF"
else
  printf '  %sVERDICT: %d thing(s) need attention (see BAD above).%s\n' "$C_BAD" "$PROBLEMS" "$C_OFF"
fi
echo "======================================================="
echo ""
if [ "$PROBLEMS" -eq 0 ]; then exit 0; else exit 1; fi
