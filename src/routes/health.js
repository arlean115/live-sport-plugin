/**
 * routes/health.js - /health
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();
const container = require('../container');

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

function getMemoryReport() {
  const mem = process.memoryUsage();
  // rss = total process RAM (includes Rust/native heap that V8 GC cannot see)
  // heapUsed = JS objects only
  // external = Node.js Buffer allocations
  // nativeEst = everything rss accounts for that isn't JS heap or buffers
  const nativeEst = mem.rss - mem.heapUsed - mem.external;
  return {
    rss:        mb(mem.rss),
    heapUsed:   mb(mem.heapUsed),
    heapTotal:  mb(mem.heapTotal),
    external:   mb(mem.external),
    nativeEst:  mb(Math.max(0, nativeEst)),
    rssBytes:   mem.rss,
  };
}

// ─── Periodic memory logger ────────────────────────────────────────────────────
// Logs a memory snapshot every 5 minutes so the trend is visible in pm2 logs
// without needing to watch live. Look for [MemWatch] lines to track growth.
const MEM_LOG_INTERVAL_MS = 5 * 60 * 1000;
const _memTimer = setInterval(() => {
  const m = getMemoryReport();
  const warn = m.rssBytes > 700 * 1024 * 1024 ? ' WARNING HIGH' : '';
  console.log(`[MemWatch] RSS=${m.rss}  heapUsed=${m.heapUsed}  nativeEst=${m.nativeEst}${warn}`);
}, MEM_LOG_INTERVAL_MS);
if (_memTimer.unref) _memTimer.unref();

// ─── Health Check ─────────────────────────────────────────────────────────────
router.get('/health', (_, res) => {
  let cache = null;
  try { cache = container.resolve('streamResolveCache').stats(); } catch (_) {}
  let breakers = null;
  let openBreakers = [];
  try {
    const cb = container.resolve('circuitBreaker');
    if (cb && cb.getStatus) breakers = cb.getStatus();
    if (cb && cb.getOpenBreakers) openBreakers = cb.getOpenBreakers();
  } catch (_) {}

  const mem = getMemoryReport();

  res.json({
    status: 'ok',
    service: 'nuvio-live-sports',
    pid: process.pid,
    uptime: Math.floor(process.uptime()) + 's',
    memory: {
      rss:       mem.rss,
      heapUsed:  mem.heapUsed,
      heapTotal: mem.heapTotal,
      external:  mem.external,
      nativeEst: mem.nativeEst,
      warning:   mem.rssBytes > 700 * 1024 * 1024 ? 'HIGH - approaching PM2 restart limit' : 'ok',
    },
    openBreakers,
    breakerCount: breakers ? Object.keys(breakers).length : null,
    streamResolveCache: cache,
  });
});

module.exports = router;

