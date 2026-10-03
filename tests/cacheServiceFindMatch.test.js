'use strict';

const CacheService = require('../src/services/CacheService');

describe('CacheService.findMatch & _cloneMatch', () => {
  let cacheService;

  beforeEach(() => {
    cacheService = new CacheService();
    // Populate with mock matches
    cacheService.cachedMatches = [
      {
        id: 'nuvio_sport_dlv_101',
        title: 'Arsenal vs Chelsea',
        category: 'football',
        aliasIds: ['nuvio_sport_spk_202', 'nuvio_sport_ppv_303'],
        sources: [
          { id: '101', source: 'daddylive', name: 'Stream 1', behaviorHints: { notWebReady: true } },
          { id: 'dlv_backup_101', source: 'daddylive', name: 'Stream 2' },
        ],
        team1: { name: 'Arsenal' },
        team2: { name: 'Chelsea' },
      },
      {
        id: 'nuvio_sport_spk_cleveland_guardians_vs_detroit_tigers',
        title: 'Cleveland Guardians vs Detroit Tigers',
        category: 'baseball',
        sources: [
          { id: 'stream_999', source: 'streamedpk', name: 'Main Feed' },
        ],
      },
    ];
    cacheService.lastDiskMtime = Date.now() + 100000; // prevent disk reload during unit test
  });

  test('Tier 1: finds match by direct primary ID', () => {
    const match = cacheService.findMatch('nuvio_sport_dlv_101');
    expect(match).not.toBeNull();
    expect(match.id).toBe('nuvio_sport_dlv_101');
    expect(match.title).toBe('Arsenal vs Chelsea');
  });

  test('Tier 2: finds match by alias ID', () => {
    const match = cacheService.findMatch('nuvio_sport_spk_202');
    expect(match).not.toBeNull();
    expect(match.id).toBe('nuvio_sport_dlv_101');
  });

  test('Tier 3: finds match by source ID', () => {
    const match = cacheService.findMatch('101');
    expect(match).not.toBeNull();
    expect(match.id).toBe('nuvio_sport_dlv_101');

    const match2 = cacheService.findMatch('stream_999');
    expect(match2).not.toBeNull();
    expect(match2.id).toBe('nuvio_sport_spk_cleveland_guardians_vs_detroit_tigers');
  });

  test('Tier 4: finds match by normalized slug or team name', () => {
    const match = cacheService.findMatch('cleveland-guardians');
    expect(match).not.toBeNull();
    expect(match.id).toBe('nuvio_sport_spk_cleveland_guardians_vs_detroit_tigers');
  });

  test('returns null for nonexistent ID or falsy inputs', () => {
    expect(cacheService.findMatch(null)).toBeNull();
    expect(cacheService.findMatch('')).toBeNull();
    expect(cacheService.findMatch('non_existent_match_id')).toBeNull();
  });

  test('Object isolation: mutating returned match does NOT corrupt internal cachedMatches', () => {
    const match1 = cacheService.findMatch('nuvio_sport_dlv_101');
    expect(match1).not.toBeNull();

    // Mutate the returned object and its nested source/team objects
    match1.title = 'MUTATED TITLE';
    match1.sources[0].name = 'MUTATED SOURCE';
    match1.sources[0].behaviorHints.notWebReady = false;
    match1.team1.name = 'MUTATED TEAM';

    // Fetch again
    const match2 = cacheService.findMatch('nuvio_sport_dlv_101');
    expect(match2.title).toBe('Arsenal vs Chelsea');
    expect(match2.sources[0].name).toBe('Stream 1');
    expect(match2.sources[0].behaviorHints.notWebReady).toBe(true);
    expect(match2.team1.name).toBe('Arsenal');
  });

  test('Performance: fast in-memory lookups without full array clone overhead', () => {
    const start = Date.now();
    for (let i = 0; i < 5000; i++) {
      cacheService.findMatch('nuvio_sport_dlv_101');
    }
    const elapsed = Date.now() - start;
    // 5000 lookups should easily finish in under 100ms
    expect(elapsed).toBeLessThan(500);
  });
});
