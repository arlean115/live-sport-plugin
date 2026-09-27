#!/usr/bin/env node
/**
 * prewarm-cron.js - VPS-side cache warming for DaddyLive (and any) sources.
 *
 * WHY THIS EXISTS
 * ---------------
 * Streams are minted lazily by `handleStream()` (src/streams.js) and stored in
 * `StreamResolveCache` (src/services/StreamResolveCache.js), which is an
 * IN-MEMORY, PER-WORKER Map (key `${source}:${matchId}:${sourceId}`, TTL 60s..10min).
 * Nothing is persisted to disk.
 *
 * The app's own prewarm tick (src/services/CronService.js -> prewarmPopular) has
 * two deliberate limits that leave DaddyLive cold:
 *   - it EXCLUDES `category === 'networks'`, i.e. every DaddyLive 24/7 channel;
 *   - it is capped at PREWARM_MAX_MATCHES (default 12) live fixtures per tick.
 * It also runs on ONE worker only (src/index.js: `if (workerOffset === 0)`), and
 * under PM2 cluster each worker keeps its own cache - so a warm entry exists only
 * in the worker that minted it.
 *
 * This script simply calls the public stream endpoint for the targets you care
 * about, which is EXACTLY the warm action: it drives
 * resolveCache.getOrCreate -> mintVerifiedSources -> provider.resolveStream +
 * verifyStreams, populating the cache of whichever worker answers.
 *
 * Because PM2 spreads connections across workers, a single request warms only
 * one worker: use `--repeat` >= your worker count (`pm2 ls`).
 *
 * LOOPBACK ONLY
 * -------------
 * `GET /api/matches` is gated by isLocalDirectRequest() (src/services/localRequest.js):
 * it answers 403 `loopback_only` unless the caller is a DIRECT local hit with NO
 * forwarding headers (x-forwarded-for / forwarded / x-real-ip / cf-connecting-ip)
 * and a loopback/RFC1918 peer. So the default base URL is `http://127.0.0.1:<PORT>`
 * and you should NOT point this at the public host - it will 403, and it would
 * also route the warm traffic through Cloudflare for no reason.
 *
 * EXIT CODES
 * ----------
 *   0  usable run: at least one target produced a real (non-fallback) stream, OR
 *      no targets were selected at all (nothing to do is not a failure).
 *   1  total failure: the match list could not be read, or every target failed.
 *      Kept coarse on purpose so a cron partial-success run does not mail you.
 *   2  bad usage (unknown flag / unparseable value).
 *
 * ADDITIVE: this file changes no runtime behaviour. It is not required by the app.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const USAGE = `
Usage: node scripts/prewarm-cron.js [options]

  --base <url>         Base URL to hit. Default: $PREWARM_BASE_URL, else
                       http://127.0.0.1:<PORT>. Keep it on loopback.
  --all                Include every match, not just live/upcoming ones.
  --networks           Only DaddyLive 24/7 network rows (dlv_ch_*).
  --fixtures           Only DaddyLive fixture rows (dlv_*), not dlv_ch_*.
  --repeat <n>         Requests per target (default 4). Set >= PM2 worker count.
  --concurrency <n>    Targets in flight at once (default 2, hard cap 4).
  --delay-ms <n>       Delay between repeat requests per target (default 250).
  --timeout-ms <n>     Per-request timeout (default 20000).
  --source <name>      Only warm matches having this source (default daddylive).
  --dry-run            List targets + URLs, then stop. Still reads the match list.
  --offline            With --dry-run, make no network calls at all.
  -h, --help           Show this help.
`.trim();

function parseArgs(argv) {
  const opts = {
    base: null,
    all: false,
    networks: false,
    fixtures: false,
    repeat: 4,
    concurrency: 2,
    delayMs: 250,
    timeoutMs: 20000,
    source: 'daddylive',
    dryRun: false,
    offline: false,
    help: false,
  };

  const intOf = (flag, raw, limits) => {
    const n = Number(raw);
    const max = limits.max;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < limits.min || (max != null && n > max)) {
      console.error(`[prewarm] invalid value for ${flag}: ${raw}`);
      process.exit(2);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`[prewarm] ${a} requires a value`);
        process.exit(2);
      }
      return v;
    };

    switch (a) {
      case '--base': opts.base = next(); break;
      case '--all': opts.all = true; break;
      case '--networks': opts.networks = true; break;
      case '--fixtures': opts.fixtures = true; break;
      case '--repeat': opts.repeat = intOf('--repeat', next(), { min: 1, max: 50 }); break;
      case '--concurrency': opts.concurrency = intOf('--concurrency', next(), { min: 1, max: 4 }); break;
      case '--delay-ms': opts.delayMs = intOf('--delay-ms', next(), { min: 0, max: 10000 }); break;
      case '--timeout-ms': opts.timeoutMs = intOf('--timeout-ms', next(), { min: 1000, max: 120000 }); break;
      case '--source': opts.source = String(next()).trim(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--offline': opts.offline = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        console.error(`[prewarm] unknown flag: ${a}`);
        console.error(USAGE);
        process.exit(2);
    }
  }

  if (opts.networks && opts.fixtures) {
    console.error('[prewarm] --networks and --fixtures are mutually exclusive');
    process.exit(2);
  }
  // Hard cap enforced here so the guarantee cannot be bypassed downstream.
  if (opts.concurrency > 4) opts.concurrency = 4;
  return opts;
}

// ---------------------------------------------------------------------------
// Base URL resolution (loopback by default; never the public host implicitly)
// ---------------------------------------------------------------------------

/** Read PORT from the process env, else the repo's .env, else the dev default. */
function resolvePort() {
  if (process.env.PORT) return String(process.env.PORT).trim();
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*PORT\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch (_) { /* .env optional */ }
  return '7000';
}

function resolveBase(opts) {
  const raw = opts.base || process.env.PREWARM_BASE_URL || `http://127.0.0.1:${resolvePort()}`;
  return String(raw).replace(/\/+$/, '');
}

/** Warn (but do not block) when the base is not loopback: /api/matches will 403. */
function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * Live/replay helpers from the app itself when importable, so the "is this live"
 * decision stays identical to the catalog's. Requiring src/catalog pulls in the
 * full DI container, which is heavy but harmless in a short-lived cron process;
 * if anything about that import fails we fall back to a conservative local clock
 * check rather than dying.
 */
function loadCatalogHelpers() {
  try {
    const catalog = require('../src/catalog');
    if (typeof catalog.isMatchLive === 'function' && typeof catalog.isReplayMatch === 'function') {
      return {
        source: 'src/catalog',
        isMatchLive: catalog.isMatchLive,
        isReplayMatch: catalog.isReplayMatch,
      };
    }
  } catch (_) { /* fall through */ }
  return null;
}

function localFallbackHelpers() {
  // Mirrors the intent of catalog.getEventDurationMs without importing it: a
  // generous per-category window, and a default that keeps unknown sports.
  const DURATIONS_MS = {
    cricket: 8 * 3600e3,
    mma: 6 * 3600e3,
    golf: 6 * 3600e3,
    motorsport: 4 * 3600e3,
    american_football: 4 * 3600e3,
    tennis: 4 * 3600e3,
    darts: 4 * 3600e3,
    hockey: 3 * 3600e3,
    basketball: 3 * 3600e3,
    baseball: 3.5 * 3600e3,
    football: 2.5 * 3600e3,
    rugby: 2.5 * 3600e3,
  };
  const kickoffOf = (m) => {
    if (!m || !m.date) return 0;
    const n = Number(m.date);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(String(m.date));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return {
    source: 'local-fallback',
    isMatchLive(m) {
      if (!m) return false;
      if (m.category === 'networks') return true;
      if (['finished', 'ended', 'postponed', 'cancelled'].includes(m.status)) return false;
      const k = kickoffOf(m);
      if (k === 0) return true;
      const now = Date.now();
      if (now < k) return false;
      return now <= k + (DURATIONS_MS[m.category] || 24 * 3600e3);
    },
    isReplayMatch(m) {
      if (!m) return false;
      if (m.category === 'networks') return false;
      if (['postponed', 'cancelled'].includes(m.status)) return false;
      const srcs = Array.isArray(m.sources) ? m.sources : [];
      const REPLAY_SOURCES = new Set(['replayzone', 'livetv']);
      if (srcs.length && !srcs.some((s) => REPLAY_SOURCES.has(s && s.source))) return false;
      const k = kickoffOf(m);
      if (k === 0) return ['finished', 'ended'].includes(m.status);
      return Date.now() > k + (DURATIONS_MS[m.category] || 24 * 3600e3);
    },
  };
}

function selectTargets(matches, opts, helpers) {
  const selected = [];

  for (const m of matches) {
    if (!m || !m.id || !Array.isArray(m.sources) || m.sources.length === 0) continue;
    if (!m.sources.some((s) => s && s.source === opts.source)) continue;

    const id = String(m.id);
    const isNetwork = id.startsWith('dlv_ch_');
    if (opts.networks && !isNetwork) continue;
    if (opts.fixtures && isNetwork) continue;

    if (!opts.all && !isNetwork) {
      // Fixtures: warm only when live (skip replays and not-yet-started events).
      let replay = false;
      try { replay = helpers.isReplayMatch(m); } catch (_) { replay = false; }
      if (replay) continue;
      let live = false;
      try { live = helpers.isMatchLive(m); } catch (_) { live = false; }
      if (!live) continue;
    }

    selected.push(m);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const UA = 'nuvio-prewarm-cron/1.0 (+loopback)';

async function getJson(url, timeoutMs) {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { /* leave null */ }
  return { status: res.status, body, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A DaddyLive stream is "really warmed" when a minted manifest URL came back. */
function classify(streams) {
  const list = Array.isArray(streams) ? streams : [];
  const manifest = list.find((s) => s && typeof s.url === 'string' && s.url.includes('/api/manifest?'));
  const fallbackOnly = list.length > 0 && !manifest;
  return {
    count: list.length,
    warmed: !!manifest,
    fallbackOnly,
    sample: manifest ? manifest.url.slice(0, 120) : String((list[0] && (list[0].url || list[0].externalUrl)) || '').slice(0, 120),
  };
}

async function warmTarget(base, match, opts, stats) {
  const metaId = 'nuvio_sport_' + match.id;
  const url = `${base}/stream/tv/${encodeURIComponent(metaId)}.json`;
  let best = { count: 0, warmed: false, fallbackOnly: false, sample: '' };
  let lastErr = null;

  for (let i = 0; i < opts.repeat; i++) {
    if (i > 0 && opts.delayMs > 0) await sleep(opts.delayMs);
    try {
      const r = await getJson(url, opts.timeoutMs);
      if (r.status !== 200 || !r.body) {
        lastErr = `HTTP ${r.status}`;
        continue;
      }
      const c = classify(r.body.streams || []);
      // A real mint is the thing we want; fallback-only is "not warmed".
      if (c.warmed) { best = c; break; }
      if (c.count >= best.count) best = c;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }

  const state = best.warmed ? 'warmed' : (best.fallbackOnly ? 'fallback-only' : 'failed');
  if (best.warmed) stats.warmed++;
  else if (best.fallbackOnly) stats.fallbackOnly++;
  else stats.failed++;

  const detail = state === 'warmed'
    ? `manifest: ${best.sample}`
    : (lastErr ? `last error: ${lastErr}` : (best.sample ? `sample: ${best.sample}` : 'no streams returned'));

  console.log(`[prewarm] ${state.padEnd(13)} ${match.id} (${best.count} stream(s)) - ${match.title || ''}`);
  if (state !== 'warmed') console.log(`[prewarm]               ${detail}`);

  return { id: match.id, state, count: best.count };
}

/** Run tasks with a fixed worker pool so the VPS never stampedes upstream. */
async function runPool(items, size, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, size) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const base = resolveBase(opts);
  const started = Date.now();

  console.log('[prewarm] ================================================');
  console.log(`[prewarm] base       : ${base}`);
  console.log(`[prewarm] source     : ${opts.source}`);
  console.log(`[prewarm] scope      : ${opts.all ? 'all' : 'live/upcoming'}${opts.networks ? ' +networks-only' : ''}${opts.fixtures ? ' +fixtures-only' : ''}`);
  console.log(`[prewarm] repeat     : ${opts.repeat}x per target (set >= PM2 worker count)`);
  console.log(`[prewarm] concurrency: ${opts.concurrency}`);
  console.log(`[prewarm] mode       : ${opts.offline ? 'offline dry-run' : (opts.dryRun ? 'dry-run' : 'live')}`);
  console.log('[prewarm] ================================================');

  if (!isLoopback(base)) {
    console.warn('[prewarm] WARNING: base is not loopback. /api/matches is loopback-only and will answer 403,');
    console.warn('[prewarm]          and warm traffic would traverse the public edge. Use http://127.0.0.1:<PORT>.');
  }

  // Offline dry-run: prove the no-network path without touching the app.
  if (opts.dryRun && opts.offline) {
    console.log('[prewarm] --offline: skipping the match-list fetch and all warming.');
    console.log(`[prewarm] would GET ${base}/api/matches, then GET ${base}/stream/tv/nuvio_sport_<id>.json x${opts.repeat} for each selected target.`);
    console.log('[prewarm] OK (offline dry-run complete).');
    process.exit(0);
  }

  const matchesUrl = `${base}/api/matches`;
  let matches;
  try {
    const r = await getJson(matchesUrl, opts.timeoutMs);
    if (r.status !== 200) {
      console.error(`[prewarm] FATAL: GET ${matchesUrl} -> HTTP ${r.status}`);
      if (r.body && r.body.reason) console.error(`[prewarm] reason: ${r.body.reason}`);
      if (r.status === 403) {
        console.error('[prewarm] /api/matches is loopback-only. Run this on the VPS host against 127.0.0.1, not via Cloudflare/Caddy.');
      }
      process.exit(1);
    }
    if (!Array.isArray(r.body)) {
      console.error(`[prewarm] FATAL: GET ${matchesUrl} did not return a JSON array (got ${typeof r.body}).`);
      process.exit(1);
    }
    matches = r.body;
  } catch (e) {
    console.error(`[prewarm] FATAL: could not reach ${matchesUrl} - ${e && e.message ? e.message : e}`);
    console.error('[prewarm] Is the app running on that port? Check `pm2 ls` and PORT in .env.');
    process.exit(1);
  }

  console.log(`[prewarm] match list: ${matches.length} match(es)`);

  let helpers;
  try {
    helpers = loadCatalogHelpers() || localFallbackHelpers();
  } catch (_) {
    helpers = localFallbackHelpers();
  }
  console.log(`[prewarm] live-check: ${helpers.source}`);

  const targets = selectTargets(matches, opts, helpers);
  console.log(`[prewarm] selected  : ${targets.length} target(s)`);

  if (targets.length === 0) {
    console.log('[prewarm] Nothing to warm (no matching targets). Exit 0.');
    process.exit(0);
  }

  if (opts.dryRun) {
    for (const m of targets) {
      const srcs = (m.sources || []).filter((s) => s && s.source === opts.source).length;
      console.log(`[prewarm] would warm ${m.id}  (${srcs} ${opts.source} source(s))  ${m.category || ''}  ${m.title || ''}`);
      console.log(`[prewarm]   GET ${base}/stream/tv/nuvio_sport_${encodeURIComponent(m.id)}.json`);
    }
    console.log(`[prewarm] dry-run complete: ${targets.length} target(s), ${targets.length * opts.repeat} request(s) would be sent.`);
    process.exit(0);
  }

  const stats = { warmed: 0, fallbackOnly: 0, failed: 0 };
  await runPool(targets, opts.concurrency, (m) => warmTarget(base, m, opts, stats));

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('[prewarm] ------------------------------------------------');
  console.log(`[prewarm] targets: ${targets.length}  warmed: ${stats.warmed}  fallback-only: ${stats.fallbackOnly}  failed: ${stats.failed}   (${secs}s)`);
  if (stats.fallbackOnly > 0) {
    console.log('[prewarm] note: "fallback-only" means the provider served the web-player link');
    console.log('[prewarm]       instead of a minted manifest - that target is NOT warm.');
  }
  console.log('[prewarm] ------------------------------------------------');

  // Total failure only. Nothing-to-do already exited 0 above; partial success is 0.
  if (stats.warmed === 0 && stats.fallbackOnly === 0 && stats.failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error('[prewarm] FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
