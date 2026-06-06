# BG Live TV (SeirSanduk) — Stremio Addon

A Stremio addon that scrapes live Bulgarian TV channels from [seirsanduk.online](https://www.seirsanduk.online/) and serves them as a `tv` catalog with playable HLS streams.

## Features

- 65 Bulgarian live TV channels (BTV, BNT, Nova, sports, kids, news, etc.)
- Channel logos and thumbnails
- Fresh HLS `.m3u8` stream URL fetched on every play request
- No account or subscription required

---

## Docker Compose (recommended)

```bash
docker compose up -d --build
```

The addon is now running at `http://localhost:7000`.

```bash
docker compose down        # stop and remove the container
docker compose logs -f     # follow logs
```

---

## Docker (standalone)

### Build the image

```bash
docker build -t stremio-seirsanduk .
```

### Run the container

```bash
docker run -d --name stremio-seirsanduk -p 7000:7000 --restart unless-stopped stremio-seirsanduk
```

The addon is now running at `http://localhost:7000`.

### Stop / remove

```bash
docker stop stremio-seirsanduk
docker rm stremio-seirsanduk
```

---

## Manual (Node.js)

### Requirements

- [Node.js](https://nodejs.org/) v18+ (install via [nvm](https://github.com/nvm-sh/nvm) if not available)

### Install & run

```bash
git clone <repo-url>
cd stremio-plugin
npm install
npm run download-images   # downloads all 65 channel logos locally
npm start
```

---

## Installing in Stremio

Open `http://localhost:7000` in a browser — the landing page shows the exact manifest URL for your host and has a one-click install button.

Or manually: open the Stremio app → **Addons → Community Addons → Install from URL** and enter:

```
http://localhost:7000/manifest.json
```

To install on a TV or another device on the same network, replace `localhost` with the host machine's local IP address (e.g. `http://192.168.1.x:7000/manifest.json`).

---

## Project Structure

```
├── Dockerfile
├── docker-compose.yml
├── index.js               # Stremio addon server (manifest, catalog, meta, stream handlers)
├── scraper.js             # Web scraping logic (channel list + stream URL extraction)
├── scripts/
│   └── download-images.js # Downloads all channel logos to public/images/tvlogo/
├── public/
│   ├── index.html         # Landing page served at http://<host>:7000/
│   └── images/tvlogo/     # Locally hosted channel logos (65 PNG files)
└── package.json
```

### How it works

1. **Catalog handler** — fetches the seirsanduk.online homepage and uses `cheerio` to extract channel names, logos, and slugs from `?id=<slug>` links. Results are cached for 1 hour.
2. **Meta handler** — returns channel name, poster, and logo when Stremio requests the detail page for a channel.
3. **Stream handler** — fetches the channel's page and extracts the `.m3u8` URL from the embedded JWPlayer `file:"..."` script via regex. The URL is time-limited so it is fetched fresh on every play request.

## Tech Stack

| Package | Purpose |
|---|---|
| `stremio-addon-sdk` | Addon manifest, handlers, HTTP server |
| `axios` | HTTP requests to the target site |
| `cheerio` | HTML parsing for channel list |

## Addon Manifest

| Field | Value |
|---|---|
| ID | `org.custom.seirsanduk` |
| Type | `tv` |
| Catalog ID | `bg_tv` |
| ID prefix | `seir_` |
| Port | `7000` |
