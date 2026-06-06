'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.seirsanduk.online';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};
const DEST_DIR = path.join(__dirname, '..', 'public', 'images', 'tvlogo');

async function downloadImages() {
  fs.mkdirSync(DEST_DIR, { recursive: true });

  console.log('Fetching channel list…');
  const resp = await axios.get(BASE_URL + '/', { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(resp.data);

  const srcs = new Set();
  $('a img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.startsWith('images/tvlogo/')) srcs.add(src);
  });

  console.log(`Found ${srcs.size} images. Downloading…`);
  let downloaded = 0;
  let skipped = 0;

  for (const src of srcs) {
    const filename = path.basename(src);
    const dest = path.join(DEST_DIR, filename);

    if (fs.existsSync(dest)) {
      skipped++;
      continue;
    }

    try {
      const img = await axios.get(`${BASE_URL}/${src}`, {
        headers: HEADERS,
        responseType: 'arraybuffer',
        timeout: 10000,
      });
      fs.writeFileSync(dest, img.data);
      downloaded++;
      process.stdout.write(`  ✓ ${filename}\n`);
    } catch (err) {
      console.warn(`  ✗ ${filename}: ${err.message}`);
    }
  }

  console.log(`Done. ${downloaded} downloaded, ${skipped} already present.`);
}

downloadImages().catch(err => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
