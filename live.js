'use strict';

// Stable HLS playlists for Stremio.
//
// Upstream stream URLs carry a token (?e=<expiry>&hash=<sig>) that dies after
// about 2 hours, after which the CDN answers 404 and playback stops. Players
// keep polling the playlist URL they were given, so we give them one of ours
// and fetch the upstream playlist with a fresh token on every poll. Only the
// playlist text passes through here; segments are absolute CDN links.

const axios = require('axios');
const scraper = require('./scraper');

const HEADERS = {
  'User-Agent': scraper.HEADERS['User-Agent'],
  'Referer': scraper.HEADERS['Referer'],
};
const PLAYLIST_TIMEOUT = 5000;
// Renew tokens this long before they expire
const RENEW_MARGIN = 10 * 60 * 1000;
// Assumed lifetime of URLs without an expiry param
const DEFAULT_TTL = 30 * 60 * 1000;
// Don't scrape a channel page more often than this (the site throttles with 503)
const SCRAPE_COOLDOWN = 10 * 1000;
const SCRAPE_RETRY_DELAYS = [500, 1500];
// While upstream is down, repeat the last playlist for up to this long
const STALE_MAX_AGE = 2 * 60 * 1000;
// Segments a player gets to continue with after the upstream numbering restarts
const RESUME_SEGMENTS = 3;
// A live playlist without a new segment for this long is considered frozen
const STALL_AFTER = 20 * 1000;
// A last segment older than this means the host has stopped updating
const FRESH_SEGMENT_AGE = 45 * 1000;
const FAILOVER_COOLDOWN = 15 * 1000;

// The CDN hosts mirror each other: same paths, same tokens. The site picks one
// at random and it is sometimes dead or frozen. Hosts seen on the site are added.
const hosts = new Set(['cdn11.glebul.com', 'mx86.glebul.com', 'cdn5.glebul.com']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// channelId -> { url, pageUrl, expires, scrapedAt, scraping, failoverAt, variants }
const sources = new Map();
// "channelId/variant" -> { lastGood, lastGoodAt, pending, seq, lastKey, changedAt }
const playlists = new Map();

function expiryOf(url) {
  const e = Number(url.searchParams.get('e'));
  return e > 0 ? e * 1000 : Date.now() + DEFAULT_TTL;
}

async function scrapeUrl(channelId) {
  for (let attempt = 0; ; attempt++) {
    try {
      const url = await scraper.getStream(channelId);
      return url ? new URL(url) : null;
    } catch (err) {
      if (attempt >= SCRAPE_RETRY_DELAYS.length) throw err;
      await sleep(SCRAPE_RETRY_DELAYS[attempt]);
    }
  }
}

// Scrape the channel page for a fresh token. The host we are on is kept, the
// URL as given by the site is available as pageUrl. Concurrent callers share
// one request.
function renew(channelId) {
  const source = sources.get(channelId) ||
    { url: null, pageUrl: null, expires: 0, scrapedAt: 0, scraping: null, failoverAt: 0, variants: null };
  sources.set(channelId, source);
  if (source.scraping) return source.scraping;
  if (Date.now() - source.scrapedAt < SCRAPE_COOLDOWN) return Promise.resolve(source);

  source.scrapedAt = Date.now();
  source.scraping = (async () => {
    try {
      const fresh = await scrapeUrl(channelId);
      if (fresh) {
        hosts.add(fresh.host);
        source.pageUrl = fresh;
        source.expires = expiryOf(fresh);
        const url = new URL(source.url || fresh);
        url.search = fresh.search;
        source.url = url;
      }
    } catch (err) {
      console.error(`Live ${channelId}: could not renew stream URL:`, err.message);
      borrowToken(source);
    } finally {
      source.scraping = null;
    }
    return source;
  })();
  return source.scraping;
}

// Tokens are not tied to a channel, so when the site won't answer for this
// one, use the freshest token any other channel has.
function borrowToken(source) {
  if (!source.url) return;
  for (const other of sources.values()) {
    if (other.expires <= source.expires) continue;
    const url = new URL(source.url);
    url.search = other.url.search;
    source.url = url;
    source.expires = other.expires;
  }
}

// Current upstream source for a channel, or null if it has none
async function getSource(channelId) {
  const source = sources.get(channelId);
  if (!source || !source.url) {
    if (!await scraper.getChannelById('bgtv_' + channelId)) return null;
    const fresh = await renew(channelId);
    return fresh.url ? fresh : null;
  }
  const left = source.expires - Date.now();
  if (left <= 0) await renew(channelId);
  else if (left < RENEW_MARGIN) renew(channelId);
  return source;
}

async function fetchText(url) {
  const resp = await axios.get(url.href, { headers: HEADERS, timeout: PLAYLIST_TIMEOUT, responseType: 'text' });
  if (typeof resp.data !== 'string' || !resp.data.startsWith('#EXTM3U')) {
    throw new Error('not a playlist');
  }
  return { text: resp.data, url };
}

// Variants are addressed by their position in the master playlist; null if
// there is no such variant
async function fetchUpstream(source, variant, base = source.url) {
  if (variant === null) return fetchText(base);
  if (!source.variants) {
    const master = await fetchText(base);
    source.variants = isMaster(master.text) ? variantPaths(master.text) : [];
  }
  const path = source.variants[variant];
  if (!path) return null;
  const url = new URL(path, base);
  url.search = base.search;
  return fetchText(url);
}

function variantPaths(text) {
  return text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split('?')[0]);
}

const isMaster = text => text.includes('#EXT-X-STREAM-INF');

// Link to the newest segment of a media playlist
function lastSegment({ text, url }) {
  const line = text.split(/\r?\n/).reverse().find(l => l && !l.startsWith('#'));
  return line ? new URL(line, url) : null;
}

async function isFresh(upstream) {
  if (isMaster(upstream.text)) return true;
  const segment = lastSegment(upstream);
  if (!segment) return false;
  try {
    const { headers } = await axios.head(segment.href, { headers: HEADERS, timeout: PLAYLIST_TIMEOUT });
    const age = Date.parse(headers.date) - Date.parse(headers['last-modified']);
    return !(age > FRESH_SEGMENT_AGE);
  } catch {
    return false;
  }
}

// Move the channel to another CDN host that has a live playlist for it.
// Returns that playlist, or null if no other host is any better.
async function failover(channelId, source, variant) {
  if (Date.now() - source.failoverAt < FAILOVER_COOLDOWN) return null;
  source.failoverAt = Date.now();
  const from = source.url.host;
  const attempts = [...hosts].filter(host => host !== from).map(async host => {
    const base = new URL(source.url);
    base.host = host;
    const upstream = await fetchUpstream(source, variant, base);
    if (!upstream || !await isFresh(upstream)) throw new Error('not live');
    return { base, upstream };
  });
  try {
    const { base, upstream } = await Promise.any(attempts);
    base.search = source.url.search;
    source.url = base;
    console.log(`Live ${channelId}: moved from ${from} to ${base.host}`);
    return upstream;
  } catch {
    return null;
  }
}

function absoluteUris(line, base) {
  return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${new URL(uri, base).href}"`);
}

function rewriteMaster(text, base, source) {
  source.variants = variantPaths(text);
  let n = 0;
  return text.split(/\r?\n/).map(line => {
    if (!line) return line;
    return line.startsWith('#') ? absoluteUris(line, base) : `v${n++}.m3u8`;
  }).join('\n');
}

// Make segment links absolute and keep the media sequence moving forward even
// if upstream restarts or we moved to another host; players treat a sequence
// that goes backwards as an error or stall.
function rewriteMedia(text, base, prev) {
  const header = [];
  const segments = [];
  let tags = [];
  let first = 0;
  let inSegments = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#EXT-X-ENDLIST')) continue; // live never ends
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      first = Number(line.split(':')[1]) || 0;
    } else if (!line.startsWith('#')) {
      const url = new URL(line, base);
      segments.push({ key: url.pathname, href: url.href, tags });
      tags = [];
    } else if (inSegments || /^#(EXTINF|EXT-X-(DISCONTINUITY$|KEY|MAP|PROGRAM-DATE-TIME|BYTERANGE))/.test(line)) {
      inSegments = true;
      tags.push(absoluteUris(line, base));
    } else {
      header.push(line);
    }
  }
  if (!segments.length) throw new Error('empty playlist');

  let { offset, min, breaks } = prev || { offset: 0, min: 0, breaks: new Set() };
  if (prev) {
    const known = segments.findIndex(s => prev.known.has(s.key));
    if (known >= 0) {
      offset = prev.known.get(segments[known].key) - (first + known);
    } else {
      // Nothing in common with what players have: continue right after it
      const resume = Math.max(0, segments.length - RESUME_SEGMENTS);
      offset = prev.last + 1 - (first + resume);
      min = prev.last + 1;
      breaks = new Set(breaks).add(segments[resume].key);
    }
  }

  segments.forEach((s, i) => { s.seq = first + i + offset; });
  const visible = segments.filter(s => s.seq >= min);
  if (!visible.length) throw new Error('outdated playlist');
  const known = new Map(segments.map(s => [s.key, s.seq]));
  const seq = {
    offset,
    min,
    known,
    breaks: new Set([...breaks].filter(key => known.has(key))),
    last: segments[segments.length - 1].seq,
  };

  const out = [...header, `#EXT-X-MEDIA-SEQUENCE:${visible[0].seq}`];
  for (const s of visible) {
    if (seq.breaks.has(s.key) && !s.tags.includes('#EXT-X-DISCONTINUITY')) out.push('#EXT-X-DISCONTINUITY');
    out.push(...s.tags, s.href);
  }
  return { text: out.join('\n') + '\n', seq };
}

// Fetch upstream, working through renewed token, other hosts, and finally
// whatever URL the site currently has
async function fetchWithRecovery(channelId, source, variant) {
  try {
    return await fetchUpstream(source, variant);
  } catch (err) {
    console.error(`Live ${channelId}: ${source.url.host}: ${err.message}`);
    const status = err.response && err.response.status;
    if (status >= 400 && status < 500) {
      const before = source.url.href;
      await renew(channelId);
      if (source.url.href !== before) {
        try {
          return await fetchUpstream(source, variant);
        } catch { /* not the token then */ }
      }
    }
    const moved = await failover(channelId, source, variant);
    if (moved) return moved;

    await renew(channelId);
    const url = new URL(source.pageUrl);
    url.search = source.url.search;
    if (url.href === source.url.href) throw err;
    const upstream = await fetchUpstream(source, variant, url);
    source.url = url;
    return upstream;
  }
}

// Hosts sometimes keep answering with a playlist that no longer grows.
// With no history yet, look at the age of the newest segment instead.
async function isFrozen(entry, upstream) {
  const key = lastSegment(upstream)?.pathname;
  if (key !== entry.lastKey) {
    const first = !entry.lastKey;
    entry.lastKey = key;
    entry.changedAt = Date.now();
    return first && !await isFresh(upstream);
  }
  return Date.now() - entry.changedAt > STALL_AFTER;
}

async function loadPlaylist(channelId, variant, entry) {
  const source = await getSource(channelId);
  if (!source) return null;

  let upstream = await fetchWithRecovery(channelId, source, variant);
  if (!upstream) return null;
  if (isMaster(upstream.text)) return rewriteMaster(upstream.text, upstream.url, source);

  if (await isFrozen(entry, upstream)) {
    const moved = await failover(channelId, source, variant);
    if (moved) {
      upstream = moved;
      entry.lastKey = lastSegment(moved).pathname;
      entry.changedAt = Date.now();
    }
  }
  const { text, seq } = rewriteMedia(upstream.text, upstream.url, entry.seq);
  entry.seq = seq;
  return text;
}

// Playlist text for a channel, or null if there is no such channel or variant.
// variant is null for the channel's own playlist. Throws if upstream is down.
async function getPlaylist(channelId, variant = null) {
  const key = `${channelId}/${variant}`;
  const entry = playlists.get(key) || {};
  if (entry.pending) return entry.pending;

  playlists.set(key, entry);
  entry.pending = (async () => {
    try {
      const text = await loadPlaylist(channelId, variant, entry);
      if (text) {
        entry.lastGood = text;
        entry.lastGoodAt = Date.now();
      }
      return text;
    } catch (err) {
      if (entry.lastGood && Date.now() - entry.lastGoodAt < STALE_MAX_AGE) return entry.lastGood;
      throw err;
    } finally {
      entry.pending = null;
      // Don't remember names that never resolved to a stream
      if (!entry.lastGood) playlists.delete(key);
    }
  })();
  return entry.pending;
}

module.exports = { getSource, getPlaylist };
