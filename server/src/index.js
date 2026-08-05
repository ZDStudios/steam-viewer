/**
 * Steam Viewer relay.
 *
 * Speaks two transports over one port:
 *   • WebSocket  ws(s)://host/ws   — request/response envelopes + live pushes
 *   • REST       GET  /api/:action — same actions, used as an automatic fallback
 *
 * Designed for Render's free web service tier: single process, no database,
 * everything cached in memory.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';

import { ACTIONS, BUILD, FEATURES, runAction } from './actions.js';
import * as agents from './agents.js';
import { cache, hasApiKey, internals, SteamError, USER_AGENT } from './steam.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const STARTED_AT = Date.now();

/** Comma separated list, or empty/"*" for "any origin". */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const originAllowed = (origin) => {
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*')) return true;
  if (!origin) return true; // curl, native clients, same-origin
  return ALLOWED_ORIGINS.includes(origin);
};

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '32kb' }));
app.use(
  cors({
    origin(origin, callback) {
      callback(null, originAllowed(origin));
    },
  }),
);

/** Coarse per-IP throttle so one browser cannot drain the Steam budget. */
const buckets = new Map();
const REST_LIMIT = Number(process.env.REST_LIMIT_PER_MIN || 180);

function throttle(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    if (buckets.size > 5000) buckets.clear();
    return next();
  }

  bucket.count += 1;
  if (bucket.count > REST_LIMIT) {
    res.status(429).json({ ok: false, error: { message: 'Too many requests, slow down.', status: 429 } });
    return undefined;
  }
  return next();
}

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    clients: wss ? wss.clients.size : 0,
    cache: cache.stats(),
    steam: internals.limiter.stats(),
    apiKey: hasApiKey(),
    build: BUILD,
    features: FEATURES,
    ...agents.stats(),
  });
});

app.get('/', (req, res) => {
  const wsUrl = `${req.secure || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`;
  res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Steam Viewer relay</title>
<style>
  body{background:#1b2838;color:#c7d5e0;font:15px/1.6 "Segoe UI",Arial,sans-serif;margin:0;padding:48px 24px}
  main{max-width:640px;margin:0 auto}
  h1{color:#66c0f4;font-weight:300;letter-spacing:.5px}
  code{background:#16202d;color:#a4d007;padding:2px 6px;border-radius:3px}
  a{color:#66c0f4}
  ul{padding-left:20px}
</style>
<main>
  <h1>Steam Viewer relay is running</h1>
  <p>Point the web client at <code>${req.protocol === 'https' ? 'https' : req.get('x-forwarded-proto') || 'http'}://${req.get('host')}</code></p>
  <p>WebSocket endpoint: <code>${wsUrl}</code></p>
  <ul>
    <li><a href="/healthz">/healthz</a></li>
    <li><a href="/api/capabilities">/api/capabilities</a></li>
    <li><a href="/api/search?term=portal">/api/search?term=portal</a></li>
    <li><a href="/api/app?appid=620">/api/app?appid=620</a></li>
    <li><code>/media?url=&lt;steam asset&gt;</code> — asset proxy for slow CDNs</li>
  </ul>
  <p>Build: <code>${BUILD}</code></p>
  <p>Steam API key: ${hasApiKey() ? 'set (richer profiles)' : 'not set (profiles still work via community XML)'}</p>
</main>`);
});

async function handleRest(req, res) {
  const name = req.params.action;
  const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };

  if (params.appids && typeof params.appids === 'string') {
    params.appids = params.appids.split(',');
  }

  try {
    const { data, cached } = await runAction(name, params);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ ok: true, action: name, cached, ts: Date.now(), data });
  } catch (error) {
    const status = error instanceof SteamError ? error.status : 500;
    res.status(status).json({
      ok: false,
      action: name,
      error: { message: error.message || 'Request failed', status },
    });
  }
}

/* ------------------------------------------------------------------ *
 * Media proxy
 * ------------------------------------------------------------------ */

/**
 * Steam's CDNs are fast from some networks and glacial from others, and a few
 * ISPs throttle or block them outright. `GET /media?url=…` re-serves a Steam
 * asset through the relay, which the page falls back to when an image has not
 * arrived within a few seconds.
 *
 * It is not an open proxy: only Steam's own asset hosts are reachable, and
 * only image and video responses are passed back.
 */
const MEDIA_HOSTS = [
  /(^|\.)steamstatic\.com$/i,
  /(^|\.)akamaihd\.net$/i,
  /(^|\.)steampowered\.com$/i,
  /(^|\.)steamcommunity\.com$/i,
  /(^|\.)steamusercontent\.com$/i,
  /(^|\.)valvesoftware\.com$/i,
];

const MEDIA_TYPES = /^(image|video|audio)\//i;
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES || 64 * 1024 * 1024);

function allowedMediaUrl(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!MEDIA_HOSTS.some((pattern) => pattern.test(url.hostname))) return null;
  url.protocol = 'https:';
  return url.toString();
}

const mediaBuckets = new Map();
const MEDIA_LIMIT = Number(process.env.MEDIA_LIMIT_PER_MIN || 900);

function mediaThrottle(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const bucket = mediaBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    mediaBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    if (mediaBuckets.size > 5000) mediaBuckets.clear();
    return next();
  }
  bucket.count += 1;
  if (bucket.count > MEDIA_LIMIT) {
    res.status(429).end();
    return undefined;
  }
  return next();
}

app.get('/media', mediaThrottle, async (req, res) => {
  const target = allowedMediaUrl(req.query.url);
  if (!target) {
    res.status(400).json({ ok: false, error: { message: 'That URL is not a Steam asset', status: 400 } });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        // Forwarded so the browser can still seek within a video.
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    res.status(504).json({ ok: false, error: { message: `Upstream fetch failed: ${error.message}`, status: 504 } });
    return;
  }

  const type = upstream.headers.get('content-type') || '';
  if (!MEDIA_TYPES.test(type)) {
    upstream.body?.cancel?.().catch(() => {});
    res.status(415).json({ ok: false, error: { message: 'Upstream did not return media', status: 415 } });
    return;
  }

  const length = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(length) && length > MEDIA_MAX_BYTES) {
    upstream.body?.cancel?.().catch(() => {});
    res.status(413).json({ ok: false, error: { message: 'Asset too large to proxy', status: 413 } });
    return;
  }

  res.status(upstream.status);
  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  // Steam assets are immutable per URL, so let browsers keep them.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // Client navigated away mid-download; nothing to report.
    res.destroy();
  }
});

app.get('/api/:action', throttle, handleRest);
app.post('/api/:action', throttle, handleRest);

app.use((req, res) => res.status(404).json({ ok: false, error: { message: 'Not found', status: 404 } }));

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */

const server = http.createServer(app);

/**
 * Two WebSocket endpoints share one port: `/ws` for browsers, `/agent` for the
 * companion agent on a visitor's PC (its payload cap is larger because it
 * uploads a whole installed-games list on connect).
 *
 * Both use `noServer` and are routed by hand below. Attaching two `path`-bound
 * WebSocketServers to the same http server does not work: each one aborts the
 * other's upgrades with a 400 before the right handler ever sees them.
 */
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  } catch {
    socket.destroy();
    return;
  }

  const target = pathname === '/ws' ? wss : pathname === '/agent' ? agentWss : null;
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

agentWss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw, isBinary) => {
    // Binary from an agent is always screen-stream payload.
    if (isBinary) {
      agents.pushStream(socket, raw);
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      if (message.type === 'register') {
        const entry = agents.register({ socket, code: message.code, info: message.info, games: message.games });
        socket.send(JSON.stringify({ type: 'registered', code: entry.code, at: Date.now() }));
        console.log(`[steam-viewer] agent ${entry.code} paired from ${entry.info.host} (${entry.games.length} games)`);
        return;
      }
      if (message.type === 'games') {
        agents.updateGames(socket, message.games);
        return;
      }
      if (message.id) {
        agents.resolveReply(socket, message);
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', error: { message: error.message } }));
    }
  });

  const drop = () => agents.unregister(socket);
  socket.on('close', drop);
  socket.on('error', drop);
});

const WS_WINDOW_MS = 10_000;
const WS_MAX_MESSAGES = Number(process.env.WS_LIMIT_PER_WINDOW || 60);

function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* the socket is going away; the close handler cleans up */
  }
}

wss.on('connection', (socket, req) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    send(socket, { event: 'error', data: { message: 'Origin not allowed' } });
    socket.close(1008, 'origin not allowed');
    return;
  }

  socket.isAlive = true;
  socket.subscriptions = new Set();
  socket.window = { count: 0, resetAt: Date.now() + WS_WINDOW_MS };

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  send(socket, {
    event: 'hello',
    ts: Date.now(),
    data: {
      server: 'steam-viewer-relay',
      version: 1,
      actions: Object.keys(ACTIONS),
      library: true,
      apiKey: hasApiKey(),
      build: BUILD,
      features: FEATURES,
      liveIntervalMs: LIVE_INTERVAL_MS,
    },
  });

  socket.on('message', async (raw) => {
    const now = Date.now();
    if (now > socket.window.resetAt) socket.window = { count: 0, resetAt: now + WS_WINDOW_MS };
    socket.window.count += 1;
    if (socket.window.count > WS_MAX_MESSAGES) {
      send(socket, { event: 'error', data: { message: 'Too many requests, slow down.' } });
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { event: 'error', data: { message: 'Malformed JSON' } });
      return;
    }

    const id = typeof message?.id === 'string' ? message.id.slice(0, 64) : null;
    const action = typeof message?.action === 'string' ? message.action : null;
    const params = message?.params && typeof message.params === 'object' ? message.params : {};

    if (!action) {
      send(socket, { id, ok: false, error: { message: 'Missing action', status: 400 } });
      return;
    }

    // Watching an agent's screen is connection state, not a Steam call.
    if (action === 'stream.watch' || action === 'stream.leave') {
      try {
        if (action === 'stream.leave') {
          agents.removeViewer(socket);
          send(socket, { id, ok: true, action, data: { watching: false } });
        } else {
          const info = agents.addViewer(String(params.code || ''), socket);
          send(socket, { id, ok: true, action, data: { watching: true, ...info } });
        }
      } catch (error) {
        send(socket, { id, ok: false, action, error: { message: error.message, status: error.status || 500 } });
      }
      return;
    }

    // Subscriptions are connection state, not Steam calls.
    if (action === 'subscribe' || action === 'unsubscribe') {
      const id64 = Number(params.appid);
      if (Number.isFinite(id64) && id64 > 0) {
        if (action === 'subscribe') {
          if (socket.subscriptions.size < 25) socket.subscriptions.add(id64);
        } else {
          socket.subscriptions.delete(id64);
        }
      }
      send(socket, { id, ok: true, action, ts: Date.now(), data: { subscriptions: [...socket.subscriptions] } });
      return;
    }

    try {
      const { data, cached } = await runAction(action, params);
      send(socket, { id, ok: true, action, cached, ts: Date.now(), data });
    } catch (error) {
      const status = error instanceof SteamError ? error.status : 500;
      send(socket, { id, ok: false, action, error: { message: error.message || 'Request failed', status } });
    }
  });

  const cleanup = () => {
    socket.subscriptions?.clear();
    agents.removeViewer(socket);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

/** Drop half-open sockets — Render's proxy will not always close them for us. */
const heartbeat = setInterval(() => {
  for (const pool of [wss.clients, agentWss.clients]) {
    for (const socket of pool) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }
}, 30_000);

/* ------------------------------------------------------------------ *
 * Live pushes
 * ------------------------------------------------------------------ */

const LIVE_INTERVAL_MS = Number(process.env.LIVE_INTERVAL_MS || 120_000);
const PLAYERS_INTERVAL_MS = Number(process.env.PLAYERS_INTERVAL_MS || 60_000);

const liveTicker = setInterval(async () => {
  if (wss.clients.size === 0) return;
  try {
    const { data } = await runAction('mostplayed', { limit: 10 });
    const payload = { event: 'live', ts: Date.now(), data: { mostPlayed: data } };
    for (const socket of wss.clients) send(socket, payload);
  } catch {
    /* a failed tick is not worth telling the browser about */
  }
}, LIVE_INTERVAL_MS);

const playersTicker = setInterval(async () => {
  const watched = new Set();
  for (const socket of wss.clients) {
    for (const id of socket.subscriptions || []) watched.add(id);
  }
  if (watched.size === 0) return;

  for (const id of [...watched].slice(0, 25)) {
    try {
      const { data } = await runAction('players', { appid: id });
      for (const socket of wss.clients) {
        if (socket.subscriptions?.has(id)) send(socket, { event: 'players', ts: Date.now(), data });
      }
    } catch {
      /* skip this app for this tick */
    }
  }
}, PLAYERS_INTERVAL_MS);

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

server.listen(PORT, HOST, () => {
  console.log(`[steam-viewer] listening on http://${HOST}:${PORT}`);
  console.log(`[steam-viewer] websocket path /ws · library ${hasApiKey() ? 'enabled' : 'disabled'}`);
  if (ALLOWED_ORIGINS.length > 0) console.log(`[steam-viewer] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

function shutdown(signal) {
  console.log(`[steam-viewer] ${signal} received, shutting down`);
  clearInterval(heartbeat);
  clearInterval(liveTicker);
  clearInterval(playersTicker);
  for (const socket of wss.clients) socket.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[steam-viewer] unhandled rejection:', reason));
