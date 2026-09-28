#!/usr/bin/env bash
#
# status.sh - plain-English health check for the Nuvio Live Sports addon.
#
# Run this on the VPS any time you want to know what's happening:
#
#   cd /root/nuvio-live-sports
#   bash scripts/status.sh
#
# Four questions, answered in words rather than JSON:
#   1. Are the workers running, how much memory do they hold, and are they
#      restarting for a reason?
#   2. Is the app responding on loopback?
#   3. Do DaddyLive streams actually resolve right now?
#   4. Is the server under memory pressure?  (this is what broke it)
#
# MEASUREMENT NOTES (both learned from real false alarms):
#   * Timing is taken on LOOPBACK, never the public hostname. Going out to
#     nuviosports.xyz includes Cloudflare and a cold TLS handshake, which once
#     produced a bogus "18s - users are waiting" on an app that answered in
#     0.58s. A health check must measure the app, not the path.
#   * Only nuvio-sports processes are counted. `pm2 jlist` also lists MODULES
#     (pm2-logrotate), and counting those made a 2-worker cluster report 3.
#   * A restart is not automatically "dying". PM2 recycles a worker that crosses
#     max_memory_restart, which is healthy behaviour. The script therefore
#     reports memory against the cap and says which is happening.
#
# Run it twice a few minutes apart: the restart check compares against the
# previous run, so only a second run can say whether the count is climbing.
#
# Colour is disabled automatically when output is piped.
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
APP_NAME="${PM2_NAME:-nuvio-sports}"

PROBLEMS=0
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
echo "  loopback port ${PORT_CFG}   app ${APP_NAME}"
echo "======================================================="

# ------------------------------------------------- 1. workers
line "1. Are the workers running, and restarting?"
if command -v pm2 >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  STATE_FILE="/tmp/nuvio-status-prev"
  # One JSON object per process; MODULES are excluded by matching pm2_env.name.
  SNAP="$(pm2 jlist 2>/dev/null | NUVIO_APP_NAME="$APP_NAME" node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  let a=[];try{a=JSON.parse(d)}catch(_){}
  const wants=process.env.NUVIO_APP_NAME;
  const app=a.filter(p=>p&&p.pm2_env&&p.pm2_env.name===wants);
  const mods=a.filter(p=>p&&p.pm2_env&&p.pm2_env.pmx_module);
  const row=p=>{
    const mem=Math.round(((p.monit&&p.monit.memory)||0)/1048576);
    const cap=Math.round(((p.pm2_env&&p.pm2_env.max_memory_restart)||0)/1048576);
    return {id:(p.pm2_env&&p.pm2_env.pm_id),mem,cap,rs:(p.pm2_env&&p.pm2_env.restart_time)||0};
  };
  const r=app.map(row);
  process.stdout.write(JSON.stringify({
    workers:r.length,
    total:r.reduce((s,x)=>s+x.rs,0),
    rows:r,
    modules:mods.map(m=>m.pm2_env.name),
    instances:(app[0]&&app[0].pm2_env&&app[0].pm2_env.instances)||null
  }));
});" 2>/dev/null)"

  W=$(echo "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).workers)}catch(_){console.log('?')}})")
  TOT=$(echo "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).total)}catch(_){console.log('?')}})")
  MODS=$(echo "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const m=JSON.parse(d).modules;console.log(m.length?m.join(','):'none')}catch(_){console.log('?')}})")
  INST=$(echo "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(String(JSON.parse(d).instances))}catch(_){console.log('?')}})")
  echo "$SNAP" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{
    const s=JSON.parse(d);
    s.rows.forEach(r=>{
      const pct = r.cap ? Math.round(r.mem/r.cap*100) : 0;
      const flag = (r.cap && r.mem >= r.cap*0.9) ? '  <-- at memory cap (PM2 recycles)' : '';
      console.log('  worker '+r.id+': '+r.mem+'MB / '+r.cap+'MB cap ('+pct+'%), restarts='+r.rs+flag);
    });
  }catch(_){}
});"

  echo "  workers in pm2 : ${W}   (configured instances: ${INST})"
  echo "  restart totals : ${TOT}"
  echo "  pm2 modules    : ${MODS}   (modules are not app workers)"

  AT_CAP=$(echo "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d);console.log(s.rows.some(r=>r.cap&&r.mem>=r.cap*0.9)?'yes':'no')}catch(_){console.log('?')}})")
  if [ "$W" = "0" ] || [ "$W" = "?" ]; then
    bad "no ${APP_NAME} workers are running - is pm2 started? (pm2 status)"
  elif [ "$INST" != "?" ] && [ "$INST" != "null" ] && [ "$W" != "$INST" ]; then
    warn "running ${W} worker(s) but configured for ${INST} - drift? (pm2 jlist | grep instances)"
  else
    ok "${W} workers running, matching the configured instance count"
  fi

  if [ "$AT_CAP" = "yes" ]; then
    warn "a worker is at its memory cap, so PM2 will recycle it soon - that is the"
    warn "restart count rising. Raise --max-memory-restart or reduce per-worker load."
  fi

  if [ -f "$STATE_FILE" ]; then
    PREV="$(cat "$STATE_FILE" 2>/dev/null || echo '?')"
    case "$PREV" in ''|*[!0-9]*) PREV='?' ;; esac
    if [ "$TOT" != '?' ] && [ "$PREV" != '?' ] && [ "$TOT" -gt "$PREV" ] 2>/dev/null; then
      if [ "$AT_CAP" = "yes" ]; then
        warn "restarts rose (${PREV} -> ${TOT}), explained by the memory cap above - not a crash"
      else
        bad "restarts rose (${PREV} -> ${TOT}) with no memory-cap cause - investigate"
      fi
    else
      ok "restarts unchanged since last check (${PREV})"
    fi
  else
    echo "  (first run - run again in a few minutes to see whether restarts climb)"
  fi
  echo "$TOT" > "$STATE_FILE" 2>/dev/null || true
else
  warn "pm2 or node not on PATH; skipping worker check"
fi

# ------------------------------------------------- 2. app responding
line "2. Is the app responding on loopback?"
RESP="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 "${BASE}/manifest.json" 2>/dev/null || echo '000 99')"
CODE="${RESP%% *}"; T="${RESP##* }"
[ -n "$CODE" ] || CODE=000
[ -n "$T" ] || T=99

if [ "$CODE" != "200" ]; then
  if [ "$CODE" = "000" ]; then
    bad "no response on 127.0.0.1:${PORT_CFG} - is pm2 running?  (pm2 status)"
  else
    bad "manifest returned HTTP ${CODE} (expected 200)"
  fi
elif awk -v t="$T" 'BEGIN{exit !(t<3)}'; then
  ok "manifest served 200 in ${T}s"
elif awk -v t="$T" 'BEGIN{exit !(t<10)}'; then
  warn "manifest slow: ${T}s on loopback (want under 1s)"
else
  bad "manifest very slow even on loopback: ${T}s"
fi

# ------------------------------------------------- 3. daddylive works
line "3. Do DaddyLive streams actually work?"
DLV_IDS="$(curl -s --max-time 25 "${BASE}/api/matches" 2>/dev/null \
  | grep -o '"id":"dlv[^"]*"' | sed 's/"id":"//;s/"//' | head -40)"

if [ -z "$DLV_IDS" ]; then
  bad "no DaddyLive match in the catalog at all"
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

# ------------------------------------------------- 4. memory
line "4. Is the server under memory pressure?   (this is what broke it)"
if command -v free >/dev/null 2>&1; then
  AVAIL_MB="$(free -m | awk '/^Mem:/{print $7}')"
  USED_PCT="$(free | awk '/^Mem:/{printf "%d", ($3/$2)*100}')"
  SWAP_MB="$(free -m | awk '/^Swap:/{print $3}')"
  [ -n "$AVAIL_MB" ] || AVAIL_MB=0
  if [ "$AVAIL_MB" -lt 300 ]; then
    bad "only ${AVAIL_MB}MB RAM available (${USED_PCT}% used) - this causes worker restarts"
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
