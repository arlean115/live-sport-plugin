/**
 * manifest.js — Stremio / Nuvio Addon Manifest
 *
 * Live sports events and 24/7 sports networks aggregator.
 */

const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: 'community.nuvio.live-sports',
  version: '3.1.3',
  name: '🏆 Nuvio Live Sports',
  description:
    'The ultimate live sports aggregator. Stream live Football, NBA, NFL, NHL, F1, and more. ' +
    'Aggregates high-speed live streams and 24/7 sports TV networks with zero-lag playback.',
  logo: '/logo.png',

  types: ['tv', 'series', 'channel'],
  resources: ['catalog', 'meta', 'stream'],

  catalogs: [
    { type: 'tv', id: 'nuvio_sports_live', name: '🔴 Live Now', extra: [
      { name: 'genre', options: ['Football'], isRequired: false },
      { name: 'search', isRequired: false }
    ] },
    { type: 'tv', id: 'nuvio_sports_networks', name: '📺 24/7 Live TV', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'tv', id: 'nuvio_sports_replays', name: '⏪ Sports Replays', extra: [{ name: 'skip', isRequired: true }] },
    
    // Football Sub-catalogs for Collections
    { type: 'tv', id: 'nuvio_sports_replays_football', name: '⚽ Football Replays', extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_today', name: "📅 Today's Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_yesterday', name: "📅 Yesterday's Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_this_week', name: "📅 This Week's Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_older', name: "📅 Older Replays", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_premier_league', name: "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League", extra: [{ name: 'skip', isRequired: true }] },
    { type: 'tv', id: 'nuvio_sports_replays_football_ucl', name: "⭐ Champions League", extra: [{ name: 'skip', isRequired: true }] },

    
    { type: 'tv', id: 'nuvio_sports_football', name: '⚽ Soccer', extra: [{ name: 'search', isRequired: false }] },
    
    { type: 'tv', id: 'nuvio_sports_upcoming', name: '⏱️ Upcoming', extra: [
      { name: 'genre', options: ['Football'], isRequired: false },
      { name: 'search', isRequired: false }
    ] }
  ],

  config: [
    { key: 'teams', title: 'Favorite Teams (comma separated)', type: 'text' },
    { key: 'sports', title: 'Enabled Sports (comma separated)', type: 'text', default: 'all' },
    { 
      key: 'timezone', 
      title: 'Timezone', 
      type: 'text',
      default: 'UTC'
    },
    // Preferred commentary languages, in order. Names or codes both work
    // ("Spanish, Arabic, Hindi", "es, ar, hi"); English is always ranked first
  // regardless.
    { key: 'languages', title: 'Preferred Languages (comma separated, English always first)', type: 'text' },
    // 'all' (default) lists every replay; 'mainstream' hides niche and
    // lower-division fixtures from the replay catalogs and hubs.
    { key: 'replayFilter', title: 'Replay Catalog (all or mainstream)', type: 'text', default: 'all' }
  ],

  idPrefixes: ['nuvio_sport_'],

  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true
  },

  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..F6aEbE6t6R_hibs0MWTXdw.T0iVZbTb3-Cn9MUDoIic5yovMLCxjssPZHs2meJgSbTBXVegWV0j27ZCkIi60pNbuxEy2tQXHxbVytxthyD4GozD5DCzDnpdUcWQOmhd4IQs37WQxp7-neyrt9aeLP_N.XRyLWSFHcEupa3FTtsh_eA'
  },
};

const builder = new addonBuilder(manifest);

module.exports = { builder, manifest };

