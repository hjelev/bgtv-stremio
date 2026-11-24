'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.seirsanduk.online';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': BASE_URL + '/',
};
const LOCAL_IMG_DIR = path.join(__dirname, 'public', 'images', 'tvlogo');
// Placeholder hostname rewritten per-request by middleware in index.js
const LOCAL_IMG_BASE = 'http://__host__/images/tvlogo';

// High-res channel tiles committed to the repo, named by channelKey
const TILE_DIR = path.join(__dirname, 'public', 'images', 'channels');
const TILE_BASE = 'http://__host__/images/channels';

// Site slug without the hd-/-hd decoration: hd-btv-hd -> btv
function channelKey(slug) {
  return slug.replace(/^hd-/, '').replace(/-hd$/, '');
}

function imageUrl(slug, src) {
  const tile = path.basename(`${channelKey(slug)}.png`);
  if (fs.existsSync(path.join(TILE_DIR, tile))) {
    return `${TILE_BASE}/${tile}`;
  }
  if (!src) return null;
  const filename = path.basename(src);
  if (fs.existsSync(path.join(LOCAL_IMG_DIR, filename))) {
    return `${LOCAL_IMG_BASE}/${filename}`;
  }
  return src.startsWith('http') ? src : `${BASE_URL}/${src.replace(/^\//, '')}`;
}

let catalogCache = null;

// Channel links look like https://www.seirsanduk.online/<slug>-online
// (older site layout: //www.seirsanduk.online/?id=<slug>&pass=&hash=)
function channelSlug(href) {
  const match = href.match(/[?&]id=([^&]+)/) || href.match(/(?:^|\/)([^/?#]+)-online\/?(?:[?#]|$)/);
  return match ? match[1] : null;
}

async function getCatalog() {
  if (catalogCache) return catalogCache;

  const resp = await axios.get(BASE_URL + '/', { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(resp.data);
  const channels = [];
  const seen = new Set();

  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const img = $(el).find('img');
    if (!img.length) return;

    const channelId = channelSlug(href);
    const name = $(el).text().trim();
    const thumb = img.attr('src') || '';

    if (!channelId || channelId === 'index.php' || seen.has(channelId)) return;
    seen.add(channelId);

    const poster = imageUrl(channelId, thumb);
    channels.push({
      id: 'bgtv_' + channelId,
      type: 'tv',
      name: name || channelId,
      poster,
      posterShape: 'square',
      background: poster,
      logo: poster,
    });
  });

  if (!channels.length) {
    // Likely a site layout change; don't cache so we recover as soon as possible
    console.error('Catalog: no channels found on', BASE_URL);
    return channels;
  }

  catalogCache = channels;
  // Expire cache after 1 hour so new channels are picked up
  setTimeout(() => { catalogCache = null; }, 60 * 60 * 1000);

  return channels;
}

async function getChannelById(id) {
  const channels = await getCatalog();
  return channels.find(c => c.id === id) || null;
}

async function getStream(channelId) {
  // channelId is the part after "bgtv_"
  const url = `${BASE_URL}/?id=${channelId}`;
  const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const html = resp.data;

  // Extract m3u8 from jwplayer file:"..." or any quoted m3u8 URL
  const match = html.match(/file:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
  if (match) return match[1];

  // Fallback: any m3u8 URL in the page
  const fallback = html.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
  if (fallback) return fallback[1];

  return null;
}

module.exports = { channelKey, getCatalog, getChannelById, getStream };
