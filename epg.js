'use strict';

const axios = require('axios');

// XMLTV guides from open-epg.com. bulgaria2 has the widest coverage and the
// cleanest titles; bulgaria1 fills in channels it lacks (e.g. AXN).
const SOURCES = {
  2: 'https://www.open-epg.com/files/bulgaria2.xml',
  1: 'https://www.open-epg.com/files/bulgaria1.xml',
};
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

// Site slug (without the hd-/-hd decoration) -> channel id in [bulgaria2, bulgaria1]
const CHANNELS = {
  '24-kitchen': ['24 Kitchen HD.bg', '24kitchen.bg'],
  '78-tv': ['7/8 TV HD.bg'],
  'axn': [null, 'AXN.bg'],
  'axn-black': [null, 'AXN Black.bg'],
  'axn-white': [null, 'AXN White.bg'],
  'bloomberg-tv': ['Bloomberg BG.bg', 'Bloomberg TV Bulgaria.bg'],
  'bnt-1': ['БНТ 1 HD.bg', 'БНТ1.bg'],
  'bnt-2': ['БНТ 2 HD.bg', 'БНТ2.bg'],
  'bnt-3': ['БНТ 3 HD.bg', 'БНТ HD.bg'],
  'bnt-4': ['БНТ 4 HD.bg', 'БНТ Свят.bg'],
  'btv': ['bTV HD.bg', 'bTV.bg'],
  'btv-action': ['bTV Action HD.bg', 'bTV Action.bg'],
  'btv-cinema': ['bTV Cinema HD.bg', 'bTV Cinema.bg'],
  'btv-comedy': ['bTV Comedy HD.bg', 'bTV Comedy.bg'],
  'btv-story': ['bTV Story HD.bg', 'bTV Story.bg'],
  'bulgaria-on-air': ['BulgariaOnAir HD.bg', 'България он еър.bg'],
  'cartoon-network': ['Cartoon Network.bg', 'Cartoon Network.bg'],
  'city-tv': ['City TV HD.bg'],
  'code-fashion-tv': ['Code Fashion TV.bg'],
  'diema': ['Diema HD.bg', 'Диема.bg'],
  'diema-family': ['Diema Family HD.bg', 'Диема Фемили.bg'],
  'diema-sport': ['Diema Sport HD.bg', 'Diema Sport HD.bg'],
  'diema-sport-2': ['Diema Sport 2 HD.bg', 'Diema Sport 2 HD.bg'],
  'diema-sport-3': ['Diema Sport 3 HD.bg', 'Diema Sport 3.bg'],
  'discovery-channel': ['Discovery HD.bg', 'Discovery Channel.bg'],
  'disney-channel': ['Disney.bg', 'Disney Channel.bg'],
  'dstv': ['DSTV HD.bg'],
  'e-kids': ['E-Kids.bg', 'EKids.bg'],
  'epic-drama': ['Epic Drama HD.bg', 'Epic Drama.bg'],
  'euronews-bulgaria': ['Euronews BG HD.bg'],
  'eurosport-1': ['Eurosport 1 HD.bg', 'Eurosport.bg'],
  'eurosport-2': ['Eurosport 2 HD.bg', 'Eurosport 2.bg'],
  'evrokom': ['Евроком HD.bg', 'Евроком НКТВ.bg'],
  'folklor-tv': ['Folklor.bg'],
  'food-network': ['Food Network HD.bg', 'Food Network HD.bg'],
  'id-xtra': ['ID HD.bg', 'Investigation Discovery.bg'],
  'kanal-3': ['Kanal 3 HD.bg'],
  'kino-nova': ['Kino Nova HD.bg', 'KinoNova.bg'],
  'max-one': ['MAX One HD.bg'],
  'max-sport-1': ['MAX Sport 1 HD.bg', 'MAX Sport 1.bg'],
  'max-sport-2': ['MAX Sport 2 HD.bg', 'MAX Sport 2.bg'],
  'max-sport-3': ['MAX Sport 3 HD.bg', 'MAX Sport 3.bg'],
  'max-sport-4': ['MAX Sport 4 HD.bg', 'MAX Sport 4.bg'],
  'nat-geo': ['Nat Geo HD.bg', 'National Geographic Channel.bg'],
  'nat-geo-wild': ['NG Wild HD.bg', 'Nat Geo Wild.bg'],
  'nick-jr': ['Nick Junior.bg', 'Nick Jr..bg'],
  'nickelodeon': ['Nickelodeon.bg', 'Nickelodeon.bg'],
  'nicktoons': ['Nicktoons.bg'],
  'nova-news': ['Nova News HD.bg', 'NOVANEWS.bg'],
  'nova-sport': ['Nova Sport HD.bg', 'Нова Спорт.bg'],
  'nova-tv': ['NOVA HD.bg', 'Нова телевизия.bg'],
  'planeta': ['Планета HD.bg', 'Планета HD.bg'],
  'planeta-folk': ['Планета Фолк HD.bg', 'Планета Фолк.bg'],
  'ring-bg': ['Ring HD.bg', 'RING.bg'],
  'rodina-tv': ['Rodina TV.bg'],
  'skat': ['СКАТ.bg', 'СКАТ.bg'],
  'star-channel': ['STAR Channel HD.bg', 'StarChannel.bg'],
  'star-crime': ['STAR Crime HD.bg', 'StarCrime.bg'],
  'star-life': ['STAR Life HD.bg', 'StarLife.bg'],
  'the-voice': ['The Voice HD.bg', 'The Voice.bg'],
  'tiankov-tv': ['Тянков Фолк.bg'],
  'tlc': ['TLC HD.bg', 'TLC Balkans.bg'],
  'travel-channel': ['Travel Channel HD.bg', 'Travel Channel.bg'],
  'travel-tv': ['Travel TV.bg'],
  'tv-1': ['TV 1 HD.bg', 'TV1.bg'],
  'viasat-explore': ['ViasatExplore HD.bg', 'Viasat Explorer.bg'],
  'vtk': ['VTK.bg'],
};

const WANTED = { 2: new Set(), 1: new Set() };
for (const [id2, id1] of Object.values(CHANNELS)) {
  if (id2) WANTED[2].add(id2);
  if (id1) WANTED[1].add(id1);
}

// Per source: channel id -> programmes sorted by start ({ start, stop, title, desc }, times in ms)
const guides = { 2: new Map(), 1: new Map() };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function cleanText(s) {
  // bulgaria1 leaves dangling separators behind ("Вкусна Коледа -")
  return decodeEntities(s || '').replace(/\s+/g, ' ').replace(/\s+-\s*$/, '').trim();
}

// "20261124160000 +0200" -> epoch ms
function parseTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\s*([+-])(\d\d)(\d\d))?/.exec(s || '');
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (m[8] * 60 + +m[9]) * 60000 : 0;
  return utc - offset;
}

// The guides are large (12 MB) but flat, so a regex pass is much cheaper than a DOM
function parseGuide(xml, wanted) {
  const guide = new Map();
  for (const [, attrs, body] of xml.matchAll(/<programme\s([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const attr = name => (new RegExp(`\\b${name}="([^"]*)"`).exec(attrs) || [])[1] || '';
    const tag = name => (new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(body) || [])[1];

    const channel = decodeEntities(attr('channel'));
    if (!wanted.has(channel)) continue;
    const start = parseTime(attr('start'));
    const stop = parseTime(attr('stop'));
    const title = cleanText(tag('title'));
    if (!title || !(stop > start)) continue;

    if (!guide.has(channel)) guide.set(channel, []);
    guide.get(channel).push({ start, stop, title, desc: cleanText(tag('desc')) });
  }
  for (const list of guide.values()) list.sort((a, b) => a.start - b.start);
  return guide;
}

async function refreshSource(key) {
  let delay = REFRESH_MS;
  try {
    const resp = await axios.get(SOURCES[key], { headers: HEADERS, timeout: 60000, responseType: 'text' });
    const guide = parseGuide(resp.data, WANTED[key]);
    if (!guide.size) throw new Error('no programmes found');
    guides[key] = guide;
    console.log(`EPG: loaded ${guide.size} channels from ${SOURCES[key]}`);
  } catch (err) {
    // Keep serving the previous guide and try again soon
    console.error(`EPG error (${SOURCES[key]}):`, err.message);
    delay = RETRY_MS;
  }
  setTimeout(() => refreshSource(key), delay).unref();
}

// Loads the guide and keeps it fresh in the background; requests never wait for it.
function startEpg() {
  return Promise.all(Object.keys(SOURCES).map(refreshSource));
}

// Returns { now, next } for a site channel slug, or null if nothing is known to be on
function getNowNext(slug, at = Date.now()) {
  const key = slug.replace(/^hd-/, '').replace(/-hd$/, '');
  const [id2, id1] = Object.hasOwn(CHANNELS, key) ? CHANNELS[key] : [];
  for (const list of [guides[2].get(id2), guides[1].get(id1)]) {
    if (!list) continue;
    const now = list.findLast(p => p.start <= at && at < p.stop);
    if (now) return { now, next: list.find(p => p.start >= now.stop) || null };
  }
  return null;
}

const timeFormat = new Intl.DateTimeFormat('bg-BG', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Sofia',
});

function formatTime(ms) {
  const { hour, minute } = Object.fromEntries(timeFormat.formatToParts(ms).map(p => [p.type, p.value]));
  return `${hour}:${minute}`;
}

function formatRange(p) {
  return `${formatTime(p.start)}–${formatTime(p.stop)}`;
}

module.exports = { startEpg, getNowNext, formatTime, formatRange, parseGuide, parseTime };
