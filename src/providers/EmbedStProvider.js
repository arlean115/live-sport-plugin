const BaseProvider = require('./BaseProvider');
const StreamEntity = require('../domain/StreamEntity');
const { execFile } = require('child_process');
const path = require('path');

class EmbedStProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'EmbedSt';
    this.embedIndiaProvider = opts.embedIndiaProvider;
  }

  async getMatches() {
    return [];
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    const embedUrl = src.embedUrl || sourceId;
    if (!embedUrl || !embedUrl.startsWith('http')) {
      console.warn(`[${this.name}] Invalid embed URL: ${embedUrl}`);
      return streams;
    }

    let referer = src.referer;
    if (!referer) {
      try {
        referer = new URL(embedUrl).origin + '/';
      } catch (err) {
        referer = 'https://embed.st/';
      }
    }

    // CF Worker edge-scraper removed per user request

    // ─── Tier 0: Iframe redirect detection ───────────────────────────────────
    // Some embed.st pages (e.g. dead channels like rally-tv) swap their native 
    // stream for an <iframe src="https://embedindia.st/..."> fallback.
    // WASM would still extract a token for the dead stream → 404/Not found.
    // We detect this by quickly fetching the embed HTML and checking for iframes
    // pointing at known external providers. If found, skip WASM entirely.
    const IFRAME_FALLBACK_DOMAINS = ['embedindia.st', 'embedindia.com', 'embedsport.xyz', 'sportsembed.su'];
    if (streams.length === 0 && !embedUrl.includes('sportsembed.su')) {
      try {
        const { safeFetch } = require('../impitClient');
        const dispatcher = new (require('undici').Agent)({ keepAliveTimeout: 15000, keepAliveMaxTimeout: 30000, connect: { timeout: 15000 } });
        const htmlRes = await safeFetch(embedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            'Referer': referer,
            'Accept': 'text/html'
          },
          dispatcher,
          bodyTimeout: 6000,
          headersTimeout: 6000
        });
        const html = await htmlRes.text();
        // Match <iframe src="https://embedindia.st/..."> pattern
        const iframeMatch = html.match(/src="(https:\/\/([^/"]+)[^"]+)"/g);
        if (iframeMatch) {
          for (const attr of iframeMatch) {
            const srcMatch = attr.match(/src="(https?:\/\/[^"]+)"/);
            if (!srcMatch) continue;
            const iframeSrc = srcMatch[1];
            try {
              const iframeHost = new URL(iframeSrc).hostname;
              if (IFRAME_FALLBACK_DOMAINS.includes(iframeHost)) {
                console.log(`[${this.name}] Detected iframe redirect -> ${iframeSrc} for ${matchTitle}. Resolving via iframe provider.`);
                const iframeReferer = new URL(iframeSrc).origin + '/';
                
                if (iframeSrc.includes('embedindia') && this.embedIndiaProvider) {
                      const indiaStreams = await this.embedIndiaProvider.resolveStream(iframeSrc, matchCategory, matchTitle, { referer: iframeReferer });
                      if (indiaStreams.length > 0) {
                          indiaStreams.forEach(s => {
                              s.name = this.name;
                              s.title = s.title.replace('EmbedIndia', this.name);
                          });
                          streams.push(...indiaStreams);
                          break;
                      }
                  }
                
                streams.push(new StreamEntity({
                  name: 'EmbedSt',
                  title: `${matchTitle} (Live)`,
                  externalUrl: `/watch?mode=extract&embed=${encodeURIComponent(iframeSrc)}&referer=${encodeURIComponent(iframeReferer)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
                }));
                break; // only use first matching iframe
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        // Non-fatal - if HTML fetch fails just fall through to WASM
        console.warn(`[${this.name}] Iframe detection prefetch failed for ${embedUrl}: ${e.message}`);
      }
    }

    // ─── Tier 1: Native WASM decryption ─────────────────────────────────────
    if (streams.length === 0) {
      try {
        // Parse the user, event, id from the URL: https://embed.st/embed/admin/ppv-celtic-vs-lask-linz/1
        const parts = embedUrl.split('/');
        const user  = parts[parts.length - 3];
        const event = parts[parts.length - 2];
        const id    = parts[parts.length - 1];

        if (user && event && id && !embedUrl.includes('sportsembed.su')) {
          console.log(`[${this.name}] Decrypting native WASM for ${user}/${event}/${id}...`);

          const m3u8Url = await new Promise((resolve) => {
            // Using __dirname ensures it works when bundled by ncc into dist/
            const scriptPath = path.join(__dirname, 'run_wasm_native.js');
            execFile('node', [scriptPath, user, event, id, embedUrl], { timeout: 15000 }, (error, stdout) => {
              if (error) {
                console.error(`[${this.name}] Native WASM execution failed:`, error.message);
                return resolve(null);
              }
              const urlMatch = stdout.match(/https:\/\/[^\s"]+\.m3u8/);
              resolve(urlMatch ? urlMatch[0] : null);
            });
          });

          if (m3u8Url) {
            console.log(`[${this.name}] Natively decrypted M3U8 for ${matchTitle}: ${m3u8Url}`);
            const { BASE_URL } = require('../config');
            const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(new URL(referer).origin)}`;
            streams.push(new StreamEntity({
              name: 'EmbedSt',
              title: `[Direct] ${matchTitle}`,
              url: proxyUrl,
              behaviorHints: { 
                notWebReady: true
              },
              resolution: 'HD'
            }));
          } else {
            console.warn(`[${this.name}] Native decryption failed to extract M3U8 for ${embedUrl}`);
          }
        } else if (embedUrl.includes('sportsembed.su') || embedUrl.includes('watchfooty.st/embed')) {
            console.log(`[${this.name}] Decrypting native WASM for sportsembed...`);
            try {
                const { extractSportsEmbed } = require('./SportsEmbedExtractor');
                const m3u8Url = await extractSportsEmbed(embedUrl);
                if (m3u8Url) {
                    console.log(`[${this.name}] Natively decrypted M3U8 for sportsembed: ${m3u8Url}`);
                    const { BASE_URL } = require('../config');
                    const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent('https://sportsembed.su/')}&origin=${encodeURIComponent('https://sportsembed.su')}`;
                    streams.push(new StreamEntity({
                        name: 'EmbedSt',
                        title: `[Direct] ${matchTitle}`,
                        url: proxyUrl,
                        behaviorHints: { notWebReady: true },
                        resolution: 'HD'
                    }));
                }
            } catch (err) {
                console.warn(`[${this.name}] SportsEmbed Decryptor error: ${err.message}`);
            }
        }
      } catch (err) {
        console.warn(`[${this.name}] Decryptor error for ${embedUrl}: ${err.message}`);
      }
    }



    // ─── Tier 3: Raw embed fallback — always appended ────────────────────────
    streams.push(new StreamEntity({
      name: 'EmbedSt',
      title: `${matchTitle} (Web Player)`,
      externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));

    return streams;
  }
}

module.exports = EmbedStProvider;
