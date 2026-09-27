/**
 * scripts/sweep_team_logos.js
 *
 * Comprehensive multi-sport harvester that builds a high-density, production-ready
 * team crest database stored in src/data/team_logos_seed.json.
 *
 * Sweeps:
 * 1. ESPN public API across 40+ sports leagues worldwide (MLB, NBA, WNBA, NHL, NFL,
 *    NCAA, 25+ global soccer leagues, Rugby, and FIFA national teams).
 * 2. Pre-existing curated seeds and local runtime caches.
 * 3. Normalizes all team names, aliases, and abbreviations.
 */

const fs = require('fs');
const path = require('path');
const { safeFetch } = require('../src/impitClient');

function normalizeKey(name) {
  if (!name) return '';
  return String(name)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{1F3F4}]/gu, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const ESPN_LEAGUES = [
  // Baseball
  'baseball/mlb',

  // Basketball
  'basketball/nba',
  'basketball/wnba',
  'basketball/mens-college-basketball',
  'basketball/womens-college-basketball',

  // Ice Hockey
  'hockey/nhl',

  // American Football
  'football/nfl',
  'football/college-football',

  // Soccer - England
  'soccer/eng.1', // Premier League
  'soccer/eng.2', // Championship
  'soccer/eng.3', // League One
  'soccer/eng.4', // League Two
  'soccer/eng.w.1', // WSL

  // Soccer - Spain
  'soccer/esp.1', // La Liga
  'soccer/esp.2', // La Liga 2
  'soccer/esp.w.1', // Liga F

  // Soccer - Italy
  'soccer/ita.1', // Serie A
  'soccer/ita.2', // Serie B
  'soccer/ita.w.1', // Serie A Women

  // Soccer - Germany
  'soccer/ger.1', // Bundesliga
  'soccer/ger.2', // 2. Bundesliga
  'soccer/ger.w.1', // Frauen-Bundesliga

  // Soccer - France
  'soccer/fra.1', // Ligue 1
  'soccer/fra.2', // Ligue 2
  'soccer/fra.w.1', // Premiere Ligue

  // Soccer - Portugal & Netherlands
  'soccer/por.1', // Liga Portugal
  'soccer/por.2', // Liga Portugal 2
  'soccer/ned.1', // Eredivisie
  'soccer/ned.2', // Eerste Divisie

  // Soccer - Scotland, Turkey, Belgium
  'soccer/sco.1',
  'soccer/tur.1',
  'soccer/bel.1',

  // Soccer - Americas
  'soccer/bra.1', // Serie A
  'soccer/bra.2', // Serie B
  'soccer/arg.1', // Primera
  'soccer/mex.1', // Liga MX
  'soccer/usa.1', // MLS
  'soccer/usa.nwsl', // NWSL

  // Soccer - International & Tournaments
  'soccer/uefa.champions',
  'soccer/uefa.europa',
  'soccer/fifa.world',
  'soccer/fifa.worldq.conmebol',
  'soccer/fifa.worldq.uefa',
  'soccer/fifa.worldq.concacaf',
  'soccer/fifa.worldq.afc',
  'soccer/fifa.worldq.caf',

  // Rugby
  'rugby/six_nations',
  'rugby/premiership_rugby',
  'rugby/top_14',
  'rugby/united_rugby_championship',
  'rugby/super_rugby'
];

async function fetchEspnLeague(leaguePath) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/teams?limit=500`;
  try {
    const res = await safeFetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res || !res.ok) return [];
    const text = typeof res.text === 'string' ? res.text : await res.text();
    const data = JSON.parse(text);
    return data.sports?.[0]?.leagues?.[0]?.teams || [];
  } catch (err) {
    return [];
  }
}

async function runSweep() {
  console.log('==> Starting Comprehensive Sports Team Logo Sweep...');
  const resultMap = new Map();

  // 1. Ingest existing seed and cache first as base
  const seedPaths = [
    path.join(__dirname, '..', 'src', 'data', 'team_logos_seed.json'),
    path.join(__dirname, '..', 'data', 'team_logos_cache.json')
  ];

  for (const p of seedPaths) {
    if (fs.existsSync(p)) {
      try {
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const [k, v] of Object.entries(json)) {
          if (k && v && typeof v === 'string') {
            resultMap.set(normalizeKey(k), v);
          }
        }
      } catch (_) {}
    }
  }
  console.log(`Base pre-existing badges loaded: ${resultMap.size}`);

  // 2. Sweep ESPN Leagues
  console.log(`Fetching from ${ESPN_LEAGUES.length} ESPN league categories...`);
  let espnHarvested = 0;

  for (const league of ESPN_LEAGUES) {
    const teams = await fetchEspnLeague(league);
    for (const item of teams) {
      const tm = item.team || item;
      if (!tm) continue;

      // Extract official 500x500 logo
      let logoUrl = null;
      if (Array.isArray(tm.logos) && tm.logos.length > 0) {
        const defaultLogo = tm.logos.find(l => l.rel && l.rel.includes('default')) || tm.logos[0];
        logoUrl = defaultLogo.href;
      }
      if (!logoUrl) continue;

      // Index by all known variants
      const namesToIndex = [
        tm.displayName,
        tm.name,
        tm.nickname,
        tm.shortDisplayName,
        tm.abbreviation
      ].filter(Boolean);

      for (const name of namesToIndex) {
        const key = normalizeKey(name);
        if (key && key.length > 1) {
          resultMap.set(key, logoUrl);
          espnHarvested++;
        }
      }
    }
  }
  console.log(`Harvested ${espnHarvested} name variants from ESPN!`);

  // 3. Output to src/data/team_logos_seed.json
  const targetFile = path.join(__dirname, '..', 'src', 'data', 'team_logos_seed.json');
  const sortedObj = {};
  const sortedKeys = Array.from(resultMap.keys()).sort();
  for (const k of sortedKeys) {
    sortedObj[k] = resultMap.get(k);
  }

  fs.writeFileSync(targetFile, JSON.stringify(sortedObj, null, 2), 'utf8');
  console.log(`==> Sweep completed successfully! Total unique badges in seed: ${sortedKeys.length}`);
  console.log(`Saved to: ${targetFile}`);
}

runSweep().catch(console.error);
