'use strict';

const express = require('express');
const path = require('path');
const { addonBuilder } = require('stremio-addon-sdk');
const getRouter = require('stremio-addon-sdk/src/getRouter');
const { getCatalog, getChannelById, getStream } = require('./scraper');

const manifest = {
  id: 'org.custom.seirsanduk',
  version: '1.0.0',
  name: 'BG Live TV',
  description: 'Live Bulgarian TV channels',
  logo: 'http://__host__/images/logo.png',
  types: ['tv'],
  catalogs: [
    { type: 'tv', id: 'bg_tv', name: 'BG Live TV' }
  ],
  resources: ['catalog', 'meta', 'stream'],
  idPrefixes: ['seir_'],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id }) => {
  if (type !== 'tv' || id !== 'bg_tv') return { metas: [] };
  try {
    const metas = await getCatalog();
    return { metas };
  } catch (err) {
    console.error('Catalog error:', err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('seir_')) return { meta: null };
  try {
    const channel = await getChannelById(id);
    if (!channel) return { meta: null };
    return {
      meta: {
        id: channel.id,
        type: 'tv',
        name: channel.name,
        poster: channel.poster,
        posterShape: 'square',
        background: channel.background,
        logo: channel.logo,
        description: `Watch ${channel.name} live.`,
      },
    };
  } catch (err) {
    console.error('Meta error:', err.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('seir_')) return { streams: [] };
  const channelId = id.slice('seir_'.length);
  try {
    const url = await getStream(channelId);
    if (!url) return { streams: [] };
    return {
      streams: [
        {
          title: 'Live Stream',
          url,
          behaviorHints: {
            notWebReady: false,
            headers: {
              'Referer': 'https://www.seirsanduk.online/',
            },
          },
        },
      ],
    };
  } catch (err) {
    console.error('Stream error:', err.message);
    return { streams: [] };
  }
});

const addonInterface = builder.getInterface();
const addonRouter = getRouter(addonInterface);

const app = express();

// Rewrite __host__ placeholder in JSON responses to the actual request host.
// The SDK uses res.end() directly, so we intercept there.
// This lets image URLs work correctly from any device (localhost, LAN IP, domain).
app.use((req, res, next) => {
  const host = req.headers.host || `localhost:${process.env.PORT || 7000}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const origin = `${proto}://${host}`;
  const _end = res.end.bind(res);
  res.end = (data, encoding, callback) => {
    const ct = res.getHeader('Content-Type') || '';
    if (ct.includes('application/json') && typeof data === 'string' && data.includes('__host__')) {
      data = data.replaceAll('http://__host__', origin);
    }
    _end(data, encoding, callback);
  };
  next();
});

// Landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static assets (images, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Addon routes (/manifest.json, /catalog/…, /meta/…, /stream/…)
app.use(addonRouter);

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`Addon running at http://localhost:${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
});
