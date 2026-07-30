# Steam Viewer

An online Steam games viewer: a static site on **GitHub Pages** talking over a **WebSocket** to a small
**Render** relay that pulls live data from Steam's public store endpoints.

Search the whole catalogue, browse by genre, open any developer's back catalogue, and open any game for
trailers, screenshots, the full store description, tags, system requirements, achievements, DLC, news, reviews,
SteamDB stats and a live player count — all styled to feel like Steam.

**No sign-in anywhere.** Look up any public Steam profile and its whole library by name, keep a wishlist in
your own browser, and — with the companion in [`host/`](host/) — list, launch and stream the games installed on
your own PC.

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
| `STEAM_API_KEY` | **Optional.** Profiles and libraries work without it, through steamcommunity.com's key-less endpoints. Setting one adds Steam levels and two-week recents. Get one at <https://steamcommunity.com/dev/apikey>. |
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

The parsers that read Steam's HTML and XML documents are covered by fixtures, which need no network:

```bash
cd server && npm test
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
| `browse` | `genre`, `filter`, `developer`, `publisher`, `specials`, `maxprice`, `term`, `cc`, `l`, `limit` | A ranked slice of the catalogue, straight off the store's own search backend |
| `developer` | `name`, `role` (`developer`/`publisher`), `cc`, `l` | A studio's whole catalogue, plus who they work with |
| `news` | `appid`, `count` | Announcements for an app |
| `users` | `text`, `page`, `limit` | Find people by display name — the index behind `steamcommunity.com/search/users` |
| `profile` | `id` (SteamID64, vanity name, profile URL, or a `…/search/users/#text=` link) | Player summary + owned games. **No API key needed.** |
| `steamdb` | `appid`, `cc` | SteamDB concurrent-player stats, falling back to Steam's charts service |
| `calculator` | `id`, `cc`, `sample` | SteamDB's account-value figure, falling back to a sum of live store prices |
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

## Where the data comes from

Nothing here needs a Steam login, and only one thing needs a key.

| Feature | Source | Key? |
| --- | --- | --- |
| Store, search, genres, developer pages | `store.steampowered.com` store + search endpoints | no |
| Player counts, most-played chart | `ISteamChartsService`, `ISteamUserStats` | no |
| Profiles, owned libraries, playtimes | `steamcommunity.com/…?xml=1` and `/games?tab=all&xml=1` | no |
| Finding people by name | `steamcommunity.com/search/SearchCommunityAjax` | no |
| Steam level, two-week recents | `IPlayerService` | yes |
| SteamDB stats and calculator | attempted against steamdb.info, computed from Steam if refused | no |
| Wishlist | your browser's `localStorage` | n/a |
| Installed games, launching, streaming | the companion in [`host/`](host/), on your own PC | n/a |

**Genres.** The old `getappsingenre` endpoint has been dead for years and answers with an empty
document, which is why every genre page came up blank. Genres, developer pages and the price/tag
filters now go through the search backend the live store itself uses, which returns rendered HTML
with each result's appid in `data-ds-appid`.

**Duplicates.** Steam's front page ships the same title in several editorial slots — a large capsule
*and* a "featured win" entry for one racing game, the hardware promo at two sizes. The relay collapses
them before the browser sees them: by appid, then by a normalised name (so "Deluxe Edition" and
"(GOTY)" fold into the base title), with one `seen` set walking every section in display order so a
title kept upstairs never reappears further down. Hardware and store promos are dropped from game
grids entirely. The live most-played chart is exempt — a chart with holes in it is not a chart.

**SteamDB** publishes no API and sits behind Cloudflare, so it is attempted with a short timeout and,
when refused (the normal outcome from a datacentre IP), the same figures are derived from Steam's own
key-less endpoints instead. Every panel says which of the two you are looking at and links to the real
SteamDB page.

## Wishlist without an account

The heart on any capsule saves it to `localStorage` in your own browser. It never reaches the relay.
[`#/wishlist`](#) totals it up, sorts by price or discount, refreshes prices from the relay on demand,
and exports/imports a JSON file so it survives clearing site data. It is not your Steam wishlist —
the game page links out to Steam for that.

## Remote play

[`host/steam-viewer-host.mjs`](host/) is a dependency-free Node script you run on the PC your games
are on. It reads Steam's own app manifests, launches titles through `steam://rungameid/…`, and reports
whether Sunshine (for Moonlight) or Steam Remote Play is available so the page can hand off to it.

It listens on `127.0.0.1` only and refuses everything until a browser has traded the pairing code it
prints for a token. See [`host/README.md`](host/README.md).

Browsers may talk to `127.0.0.1` from an https page — Chrome, Edge and Firefox all allow it. Safari
does not, so use one of the others for that one feature.

## Notes

- **Untrusted HTML.** Store descriptions, requirements and news bodies are author-written HTML. They are rendered
  through an allow-list sanitiser (`assets/js/sanitize.js`) that rebuilds the DOM from scratch and drops scripts,
  inline handlers, `javascript:` URLs and unknown tags.
- **Dead CDN hosts.** Steam still hands out `akamaihd.net` and `cdn.akamai.steamstatic.com` URLs that no longer
  resolve, over plain HTTP at that. Both the relay and the client-side sanitiser rewrite them onto the
  Cloudflare hosts the live store uses — which is what makes images and animated GIFs inside store descriptions
  and news posts appear at all. Trailers are additionally routed to `video.cloudflare.steamstatic.com`.
- **Trailers.** Every rendition Steam lists is passed to the browser as a `<source>`, best first, and the player
  falls down the list on error — Steam's `max` rendition simply does not exist for a lot of older trailers. The
  video element carries no `crossorigin` attribute, which was the other reason nothing played: it makes the
  browser demand CORS headers that Steam's video CDN does not send.
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
assets/js/components.js     cards, price blocks, carousel, media player, lightbox, wishlist button
assets/js/wishlist.js       the browser-local wishlist
assets/js/host.js           client for the PC companion (pairing, library, launch)
assets/js/views.js          home / search / game / genre / developer / library / wishlist / remote / about
assets/js/app.js            router, header wiring, settings
server/src/index.js         HTTP + WebSocket server, live pushes
server/src/actions.js       the action registry (the only way to reach Steam)
server/src/steam.js         Steam client and response normalisers
server/src/cache.js         TTL cache with in-flight de-duplication
server/src/limiter.js       outbound concurrency/rate limiting
server/scripts/smoke.js     end-to-end check against a running relay
server/scripts/parse-tests.js  offline fixture tests for the HTML/XML parsers
host/steam-viewer-host.mjs  the PC companion: local library, launch, streaming handoff
render.yaml                 Render Blueprint
```

---

Unofficial project, not affiliated with or endorsed by Valve Corporation. Game artwork, trailers and text belong
to their respective owners.
