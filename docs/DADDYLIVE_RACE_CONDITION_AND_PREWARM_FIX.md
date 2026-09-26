# DaddyLive Race Condition and Prewarm Fix

## The Issue
DaddyLive (priority 1) takes 2-4 seconds to return its stream URLs. Some other providers (like DamiTV) are extremely fast, returning in under 1 second.
Because of the concurrency logic in `handleStream`, the API was returning the fast stream immediately upon the soft deadline or even earlier if the fast stream succeeded and nothing else was holding up the queue. 

Furthermore, `CronService` used a `.some()` check to determine if a match was already "warm" in the cache. Since the fast providers resolved quickly, their presence in the cache tricked `CronService` into skipping the match entirely during the prewarm cycle. Thus, DaddyLive was never given the time to resolve in the background and its streams were effectively missing from the API response for live matches.

## The Solution
1. **Source Priorities Updated (`src/streams.js`)**: DaddyLive's priority was elevated to 1 (alongside internal/admin sources), ensuring it's treated as a critical provider.
2. **Priority Waiting (`src/streams.js`)**: We introduced `PRIORITY_WAIT_SOURCES = ['daddylive']` inside the `handleStream` time-boxing logic. Now, if the soft deadline triggers (e.g. at 6s) but a priority source is still `inFlight`, `handleStream` will wait up to the `HARD_DEADLINE_MS` (15s) for the priority source to finish. This ensures we never prematurely cut off DaddyLive streams.
3. **Soft Deadline Config**: `STREAM_SOFT_DEADLINE_MS` default was updated to 6000 (6 seconds) to give the initial fetch a healthy window without excessive blocking.
4. **Prewarmer Strictness (`src/services/CronService.js`)**: The caching check was updated. Instead of `.some()`, if a match contains priority sources, it now checks that they `.every()` exist in the cache. Only then will it skip the prewarm. This guarantees DaddyLive is properly background-fetched.

## Note on Deployment (The Streamed.pk wipeout scare)
When PM2 reloads the application (`pm2 reload nuvio-sports`), the `MatchAggregator.syncMatches()` starts in the background and takes ~40-50 seconds to complete its merge.
During this window, `cacheService` is mostly empty and only the fast providers (like TimStreams) show up in the catalog. 
This behaves like the other providers (Streamed.pk, ReplayZone, etc) have been wiped out, but they are just being re-synced. 
Always wait at least 1 minute after a restart before checking the catalog/streams!
