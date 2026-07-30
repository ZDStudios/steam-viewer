# Steam Viewer

An online Steam games viewer: a static site on **GitHub Pages** talking over a **WebSocket** to a small
**Render** relay that pulls live data from Steam's public store endpoints.

Search the whole catalogue, browse top sellers / new releases / specials / the live most-played chart, and open
any game for trailers, screenshots, the full store description, tags, system requirements, achievements, DLC,
news, reviews and a live player count — all styled to feel like Steam.

```
┌────────────────────────┐   wss://…/ws (fallback: GET /api/…)   ┌────────────────────────┐   https   ┌───────────┐
│  GitHub Pages (static) │ ────────────────────────────────────► │  Render relay (Node)   │ ────────► │   Steam   │
│  index.html + assets/  │ ◄──────────────────────────────────── │  cache · rate limiter  │ ◄──────── │  public   │
└────────────────────────┘        live pushes: players,          └────────────────────────┘  endpoints└───────────┘
                                  most-played chart
```

The browser never talks to Steam directly — Steam sends no CORS headers, so a relay is required. The relay holds
no secrets unless you opt into the Library feature.

---

## 1. Deploy the relay to Render

**Blueprint (easiest).** In Render: **New ▸ Blueprint**, pick this repository, apply. `render.yaml` creates a free
web service from `server/` with WebSockets and a health check already configured.

**Or create it by hand.** New ▸ Web Service, connect this repo, then:

| Setting | Value |
| --- | --- |
| Root directory | `server` |
| Runtime | Node |
| Build command | `npm install --omit=dev` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `STEAM_API_KEY` | Enables the **Library** view (owned games for a public profile). Get one at <https://steamcommunity.com/dev/apikey>. Everything else works without it. |
| `ALLOWED_ORIGINS` | Comma-separated allow-list, e.g. `https://<your-user>.github.io`. Unset means any origin. |

When it is live, open the service URL — you should get a status page listing the WebSocket endpoint.

> Free Render instances sleep after ~15 minutes idle. The first request afterwards takes up to a minute; the site
> shows a "waking the relay" state and retries on its own.

## 2. Point the site at your relay

Edit [`assets/js/config.js`](assets/js/config.js):

```js
window.STEAM_VIEWER_CONFIG = {
  serverUrl: "https://your-service.onrender.com",
  ...
};
```

Two runtime overrides also work and need no rebuild:

- `?server=https://your-service.onrender.com` in the address bar
- the **gear icon** in the header — saved to `localStorage`

## 3. Turn on GitHub Pages

**Settings ▸ Pages ▸ Source: GitHub Actions.** The workflow in
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes `index.html` + `assets/` on every push.

(Serving from a branch works too — pick the branch and `/ (root)`. `.nojekyll` is already present.)

---

## Running it locally

```bash
# relay
cd server
npm install
npm start                      # http://127.0.0.1:8080  ·  ws://127.0.0.1:8080/ws

# site (any static server, from the repo root)
python3 -m http.server 8098
```

Then open `http://127.0.0.1:8098/?server=http://127.0.0.1:8080`.

Check the relay end to end — HTTP surface plus a WebSocket round trip:

```bash
cd server && npm run smoke                          # defaults to 127.0.0.1:8080
BASE=https://your-service.onrender.com npm run smoke
```

---

## Protocol

Send an envelope, get one back. Every action also exists as `GET /api/<action>` with the same parameters as a
query string, which is what the page falls back to when the socket cannot connect.

```jsonc
// browser → relay
{ "id": "c3f1…", "action": "search", "params": { "term": "portal", "cc": "us" } }

// relay → browser
{ "id": "c3f1…", "ok": true, "action": "search", "cached": false, "ts": 1730000000, "data": { "items": [ … ] } }

// relay → browser, unsolicited
{ "event": "players", "data": { "appid": 620, "players": 12345 } }
```

| Action | Parameters | Returns |
| --- | --- | --- |
| `home` | `cc`, `l` | Featured carousel, specials, top sellers, new releases, coming soon, most played |
| `search` | `term`, `cc`, `l`, `limit` | Store search results |
| `app` | `appid`, `cc`, `l` | Full game page: details, media, first page of reviews, recent news |
| `apps` | `appids` (max 30), `cc`, `l` | Compact cards for a batch of appids |
| `reviews` | `appid`, `filter`, `reviewType`, `language`, `cursor` | Paged reviews plus the score summary |
| `players` | `appid` | Current concurrent players |
| `mostplayed` | `cc`, `l`, `limit` | Live most-played chart, enriched with store data |
| `genre` | `genre`, `cc`, `l` | Genre landing page sections |
| `news` | `appid`, `count` | Announcements for an app |
| `profile` | `id` (SteamID64, vanity name or profile URL) | Player summary + owned games — needs `STEAM_API_KEY` |
| `genres`, `capabilities`, `ping` | — | Metadata |
| `subscribe` / `unsubscribe` | `appid` | Start/stop live player-count pushes (WebSocket only) |

Pushed events: `hello` on connect, `players` every 60s for subscribed apps, `live` (most-played) every 2 minutes.

## How the relay stays inside Steam's limits

Steam rate-limits `appdetails` at roughly 200 requests per 5 minutes per IP, and every visitor shares the relay's
single outbound IP. So the relay:

- caches every response in memory with a per-action TTL (60s for player counts, 5 min for the home page, 30 min
  for a game page, 1 hour for compact cards);
- de-duplicates identical in-flight requests, so ten simultaneous visitors on one game cause one Steam call;
- funnels all outbound traffic through a limiter (4 concurrent, ≥80 ms apart) and retries 429/5xx with backoff;
- throttles callers too — 180 requests/min per IP over HTTP, 60 messages/10s per socket.

## Notes

- **Untrusted HTML.** Store descriptions, requirements and news bodies are author-written HTML. They are rendered
  through an allow-list sanitiser (`assets/js/sanitize.js`) that rebuilds the DOM from scratch and drops scripts,
  inline handlers, `javascript:` URLs and unknown tags.
- **Mixed content.** Steam still serves some asset URLs over plain HTTP; the relay rewrites them to HTTPS so
  nothing is blocked on Pages.
- **Prices** come back in minor units for every currency (including zero-decimal ones) and are formatted with
  `Intl.NumberFormat` for the region you pick in the header.
- **Fonts.** Steam's Motiva Sans is Valve-licensed, so the system font stack stands in — the same fallback Steam
  itself uses.

## Repository layout

```
index.html                  the whole client shell
assets/css/steam.css        Steam-flavoured styling
assets/js/config.js         relay URL + defaults (edit this)
assets/js/client.js         WebSocket transport, reconnect, HTTP fallback
assets/js/sanitize.js       allow-list HTML sanitiser
assets/js/components.js     cards, price blocks, carousel, media player, lightbox
assets/js/views.js          home / search / game / genre / browse / library / about
assets/js/app.js            router, header wiring, settings
server/src/index.js         HTTP + WebSocket server, live pushes
server/src/actions.js       the action registry (the only way to reach Steam)
server/src/steam.js         Steam client and response normalisers
server/src/cache.js         TTL cache with in-flight de-duplication
server/src/limiter.js       outbound concurrency/rate limiting
server/scripts/smoke.js     end-to-end check against a running relay
render.yaml                 Render Blueprint
```

---

Unofficial project, not affiliated with or endorsed by Valve Corporation. Game artwork, trailers and text belong
to their respective owners.
