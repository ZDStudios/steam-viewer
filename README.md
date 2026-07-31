# Steam Viewer

An online Steam games viewer: a static site on **GitHub Pages** talking over a **WebSocket** to a small
**Render** relay that pulls live data from Steam's public store endpoints.

Search the whole catalogue, browse top sellers / new releases / specials / genres / the live most-played chart, and
open any game for trailers, screenshots, the full store description, tags, system requirements, achievements, DLC,
news, reviews, ownership stats and a live player count — all styled to feel like Steam.

It also does the things a signed-in Steam session normally gates:

- **Discovery rows** on the home page — big capsule, screenshot grid, *Visit Product Page / Add to wishlist / Ignore
  / Find More like this* — seeded by a **wishlist kept in your browser**, no Steam account involved.
- **Any public profile, no sign-in** — read through Steam Community's XML, plus a **SteamDB-style account-value
  calculator** computed from Steam's own bulk pricing.
- **Developer and publisher pages**.
- **Remote Play** — pair the companion agent on your gaming PC to list and launch your installed games.

```
┌────────────────────────┐   wss://…/ws (fallback: GET /api/…)   ┌────────────────────────┐   https   ┌───────────┐
│  GitHub Pages (static) │ ────────────────────────────────────► │  Render relay (Node)   │ ────────► │   Steam   │
│  index.html + assets/  │ ◄──────────────────────────────────── │  cache · rate limiter  │ ◄──────── │  public   │
└────────────────────────┘        live pushes: players,          └────────────────────────┘  endpoints└───────────┘
                                  most-played chart
```

The browser never talks to Steam directly — Steam sends no CORS headers, so a relay is required. The relay holds no
secrets: an API key is optional and only upgrades profile data.

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
| `STEAM_API_KEY` | **Optional.** Profiles already work without it via community XML; a key adds Steam level, account age and a clearer private-profile signal. Get one at <https://steamcommunity.com/dev/apikey>. |
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
| `discovery` | `seeds` (wishlisted appids), `cc`, `l` | Discovery-queue rows with screenshots and a reason |
| `browse` | `filters`, `start`, `count` | Arbitrary store-search browsing (sorts, specials, price ceilings) |
| `creator` | `name`, `role` (`developer`/`publisher`) | A studio's catalogue |
| `usersearch` | `text`, `page` | Public profiles matching a name |
| `steamspy` | `appid` | Ownership/playtime estimates plus SteamDB deep links |
| `calculator` | `id`, `cc` | Account value, hours played, cost per hour |
| `agent` | `code`, `op`, `appid` | Talk to a paired PC: `status`, `games`, `refresh`, `launch`, `stream` |
| `search` | `term`, `cc`, `l`, `limit` | Store search results |
| `app` | `appid`, `cc`, `l` | Full game page: details, media, first page of reviews, recent news |
| `apps` | `appids` (max 30), `cc`, `l` | Compact cards for a batch of appids |
| `reviews` | `appid`, `filter`, `reviewType`, `language`, `cursor` | Paged reviews plus the score summary |
| `players` | `appid` | Current concurrent players |
| `mostplayed` | `cc`, `l`, `limit` | Live most-played chart, enriched with store data |
| `genre` | `genre`, `cc`, `l` | Genre landing page sections |
| `news` | `appid`, `count` | Announcements for an app |
| `profile` | `id` (SteamID64, vanity name or profile URL) | Identity, level, recent activity with achievement bars, friends, full library — Web API if a key is set, community XML otherwise |
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

## Remote play

`agent/` is a small Node program you run on your gaming PC. See [agent/README.md](agent/README.md).

```bash
cd agent && npm install
npm start -- --relay https://your-service.onrender.com
```

It prints a pairing code; enter that under **Remote Play** on the site. It reads your installed games from Steam's
`appmanifest_*.acf` files, launches them with `steam://rungameid/<id>`, and dials *out* to the relay so nothing
needs port-forwarding. It never sees your Steam password.

### Watching in the browser (built in)

With **ffmpeg** installed on the gaming PC, the agent streams the screen to the
site by itself — no Sunshine, no second server. It captures the desktop,
encodes to whichever codec the browser reports it can decode (H.264 in
fragmented MP4, or VP8 in WebM for browsers without proprietary codecs), and
pushes fragments down the connection the agent already holds. The page feeds
them into a MediaSource, so there is no plugin and nothing to port-forward.

About a second of latency, and no input forwarding: it is a view of the screen,
which suits watching a game rather than playing one.

### Playing in the browser (Moonlight)

Install [Sunshine](https://app.lizardbyte.dev/Sunshine/) and
[moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) on the gaming PC. The agent detects
the latter on port 8080 and the site grows a **Stream in browser** panel plus a **Play & stream** button on every
installed game — that starts the game and opens the player.

Give moonlight-web-stream a `certificate` in its `server/config.json` to have the player embed *inline* in the page:
an HTTPS page cannot embed a plain-`http` origin, so without one the player opens in its own tab instead (which
works fine, it is just a second window). A native [Moonlight](https://moonlight-stream.org/) client is detected too.

The pairing code is the only credential — anyone holding it can list and launch games on that PC. It is regenerated
on every start unless pinned with `--code`, and `--no-launch` runs the agent read-only.

## Profile pages

A profile shows what the real Steam profile shows: avatar with its status ring, persona and real name, summary,
Recent Activity with hours on record and per-game achievement progress, the Currently Online panel with game and
group counts, the friends list with live status, the full library, and the account-value calculator.

Nobody signs in. Without an API key it is assembled from the public community documents —
`/?xml=1` for identity and most-played, `/games/?tab=all&xml=1` for the library, `/stats/<appid>/?xml=1` for
achievement progress, and the friends page for the sidebar. With `STEAM_API_KEY` set, the Web API supplies Steam
level, a richer friends list and exact two-week playtime instead.

A profile whose game details are private cannot be read either way — that is Steam's setting, not a limitation here.

## Trailers and animated clips

Two things had to be right for game media to play:

- **No `crossorigin` on the player.** Steam's video CDN sends no `Access-Control-Allow-Origin`, so a CORS media
  fetch can never succeed.
- **A CDN host that still answers.** `appdetails` hands out URLs on hosts Valve has retired. The relay expands
  every trailer into candidates across the known hosts (`video.cloudflare`, `video.fastly`, `video.akamai`, …),
  probes them with a one-byte range request, and puts a working one first. Results are cached for six hours.

Store descriptions embed their short looping clips as muted `<video>` — this is what reads as a GIF on the real
store page. The sanitiser allows `<video>`/`<source>` from https origins and re-applies the playback flags itself
(muted, looping, autoplaying, no controls), so the animation shows without the markup being able to add sound or
grab focus.

## Slow or blocked Steam CDNs

Steam's asset hosts are fast from some networks and unusable from others. Any
image that has not produced pixels within **3 seconds** is re-requested through
the relay's `GET /media?url=…` endpoint, which streams the asset back with a
day of cache headers. Trailers append the same route as their final source.

It is not an open proxy: only Steam's own asset hosts pass the allow-list, only
image/video/audio responses are returned, `Range` is forwarded so video seeking
still works, and it has its own per-IP rate limit (`MEDIA_LIMIT_PER_MIN`,
default 900). Size is capped by `MEDIA_MAX_BYTES` (default 64 MB).

On Render's free tier this costs bandwidth, so it only ever engages as a
fallback — a healthy connection to Steam never touches it.

## When something is not showing

Open **[#/diagnostics](#)** from the footer link. It runs from your browser and reports:

- which relay you are talking to, its **build**, and whether it has every feature this page expects;
- the trailer URLs for a chosen app, each one actually loaded in a `<video>` so you can see which CDN hosts answer;
- the Steam image hosts, for comparison.

The most common cause of "trailers/genres/profiles look broken" is a **relay running older code than the page** —
Render deploys from whichever branch its service is configured for, which may not be the branch you are pushing.
The diagnostics page names the missing features and says so explicitly.

## On SteamDB

SteamDB is linked, not scraped: it sits behind bot protection and its terms do not permit automated access. The
equivalent numbers are assembled from sources meant to be called programmatically —
[SteamSpy](https://steamspy.com/api.php) for ownership and playtime estimates, and Steam's own charts and bulk
pricing API for player counts and the account-value calculator. Every stats panel deep-links to the matching SteamDB
page.

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
assets/js/wishlist.js       browser-local wishlist and ignore list
assets/js/views.js          home / search / game / genre / creator / library / wishlist / play / about
assets/js/app.js            router, header wiring, settings
server/src/index.js         HTTP + WebSocket server, live pushes
server/src/actions.js       the action registry (the only way to reach Steam)
server/src/steam.js         Steam client, response normalisers, de-duplication
server/src/discover.js      genre / developer / publisher browsing via store search
server/src/community.js     key-less profile + user search via community XML
server/src/stats.js         SteamSpy estimates and the account-value calculator
server/src/agents.js        registry for paired PCs
server/src/cache.js         TTL cache with in-flight de-duplication
server/src/limiter.js       outbound concurrency/rate limiting
server/scripts/smoke.js     end-to-end check against a running relay
agent/                      the companion program for your gaming PC
render.yaml                 Render Blueprint
```

---

Unofficial project, not affiliated with or endorsed by Valve Corporation. Game artwork, trailers and text belong
to their respective owners.
