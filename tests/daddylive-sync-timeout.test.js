/**
 * Regression test for the DaddyLive sync-fetch timeout baseline.
 *
 * History this pins down: commit f15846b (2026-09-27, "prioritize dlive.sx domain
 * and tighten schedule fetch timeouts") lowered these three fetches from
 * 12000/12000/15000 to a flat 6000 in the same commit that reordered the mirror
 * domains. The reorder was right; the timeout cut was not.
 *
 * Why 6000 broke production: this is the app's heaviest fetch (a full homepage
 * scrape plus a ~700-entry schedule JSON, across two mirrors), and every other
 * provider sits at 8000-20000ms. At 6000 DaddyLive was the ONLY provider tuned
 * to fail under load, so it alone disappeared from the catalog while every other
 * source stayed present.
 *
 * These tests assert the restored baseline and the load-scaling behaviour. They
 * are pure unit tests - no network.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src', 'providers', 'DaddyLiveProvider.js');
const source = fs.readFileSync(SRC, 'utf8');

/** Load resolveSyncTimeoutMs in isolation with a controllable os.loadavg + env. */
function loadHelper({ env = {}, load = 0, loadThrows = false } = {}) {
  const start = source.indexOf('function resolveSyncTimeoutMs()');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error('resolveSyncTimeoutMs not found');

  const body = source.slice(start, end + 2);
  const sandbox = {
    os: {
      loadavg: () => {
        if (loadThrows) throw new Error('loadavg unavailable');
        return [load, load, load];
      },
    },
    process: { env },
    Math,
    Number,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(body + '; this.__fn = resolveSyncTimeoutMs;', sandbox);
  return sandbox.__fn;
}

describe('DaddyLive sync timeout baseline', () => {
  test('idle box uses the restored 12000ms baseline (not the 6000 regression)', () => {
    const fn = loadHelper({ env: {}, load: 0 });
    expect(fn()).toBe(12000);
  });

  test('never returns below 12000, so an idle box is never worse than pre-f15846b', () => {
    for (const load of [0, 0.5, 1, 2, 4, 8]) {
      expect(loadHelper({ env: {}, load })()).toBeGreaterThanOrEqual(12000);
    }
  });

  test('adds headroom as load rises', () => {
    const idle = loadHelper({ env: {}, load: 0 })();
    const busy = loadHelper({ env: {}, load: 4 })();
    expect(busy).toBeGreaterThan(idle);
    expect(busy).toBe(12000 + 4 * 2000);
  });

  test('clamps to the 25000ms ceiling under extreme load', () => {
    expect(loadHelper({ env: {}, load: 100 })()).toBe(25000);
  });

  test('honours SYNC_TIMEOUT_BASE_MS', () => {
    expect(loadHelper({ env: { SYNC_TIMEOUT_BASE_MS: '15000' }, load: 0 })()).toBe(15000);
  });

  test('honours SYNC_TIMEOUT_MAX_MS', () => {
    expect(loadHelper({ env: { SYNC_TIMEOUT_MAX_MS: '13000' }, load: 9 })()).toBe(13000);
  });

  test('DADDYLIVE_SYNC_TIMEOUT_MS overrides everything', () => {
    expect(loadHelper({ env: { DADDYLIVE_SYNC_TIMEOUT_MS: '9999' }, load: 9 })()).toBe(9999);
  });

  test('survives a loadavg that throws / is unavailable', () => {
    // Must fall back to the baseline rather than NaN or a crash.
    expect(loadHelper({ env: {}, loadThrows: true })()).toBe(12000);
  });
});

describe('the three sync fetches use the helper, and resolve-path ones do not', () => {
  test('exactly 3 call sites', () => {
    const hits = (source.match(/AbortSignal\.timeout\(resolveSyncTimeoutMs\(\)\)/g) || []).length;
    expect(hits).toBe(3);
  });

  test('resolve-path fetches keep their literal 6000 (bounded by handleStream)', () => {
    const hits = (source.match(/AbortSignal\.timeout\(6000\)/g) || []).length;
    expect(hits).toBe(4);
  });

  test('no sync-path fetch was left at the flat 6000 regression value', () => {
    // The three sync fetches sit in the constructor's fetchSchedule/fetchChannels
    // closures; assert none of them still carries a hardcoded 6000.
    const ctorStart = source.indexOf('constructor(opts = {})');
    const ctorEnd = source.indexOf('clearCache(sourceId)');
    const ctor = source.slice(ctorStart, ctorEnd);
    expect(ctor).not.toMatch(/AbortSignal\.timeout\(6000\)/);
    expect((ctor.match(/AbortSignal\.timeout\(resolveSyncTimeoutMs\(\)\)/g) || []).length).toBe(3);
  });
});

describe('os is required for the load lookup', () => {
  test("requires 'os' exactly once", () => {
    expect((source.match(/require\('os'\)/g) || []).length).toBe(1);
  });
});
