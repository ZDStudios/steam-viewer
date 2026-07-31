#!/usr/bin/env node
/**
 * Steam Viewer Agent — runs on your gaming PC and lets the website see and
 * launch the games you actually have installed.
 *
 *   node src/index.js --relay https://your-service.onrender.com
 *
 * It makes an *outbound* WebSocket to the relay, so no port forwarding and no
 * inbound firewall rule are needed. It never receives your Steam password: it
 * reads the local library files and hands launch requests to the Steam client
 * through `steam://` URLs, exactly as a desktop shortcut would.
 *
 * The pairing code printed at startup is the only credential. Anyone who has
 * it can list and launch your installed games, so treat it like a password —
 * it changes every time the agent restarts unless you pin one with --code.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import process from 'node:process';
import { WebSocket } from 'ws';

import { findSteamRoot, listInstalledGames } from './steamfs.js';

const VERSION = '1.0.0';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=');
    const value = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : 'true');
    options[flag] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const RELAY = String(options.relay || process.env.STEAM_VIEWER_RELAY || '').replace(/\/+$/, '');
const STEAM_ROOT_OVERRIDE = options['steam-root'] || process.env.STEAM_ROOT || null;
const ALLOW_LAUNCH = options['no-launch'] !== 'true';
const REFRESH_MS = Number(options['refresh-seconds'] || 300) * 1000;

/**
 * moonlight-web-stream (github.com/MrCreativ3001/moonlight-web-stream) is a
 * browser Moonlight client: a Rust web server that forwards a Sunshine stream
 * to a browser over WebRTC. If it is running on this PC we hand the site its
 * address so the stream can be watched in the page.
 */
const WEB_STREAM_PORT = Number(options['web-stream-port'] || 8080);
const WEB_STREAM_URL = options['web-stream-url'] || process.env.STEAM_VIEWER_WEB_STREAM || null;

const randomCode = (length = 8) =>
  [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');

const CODE = String(options.code || process.env.STEAM_VIEWER_CODE || randomCode()).toUpperCase();

if (!RELAY) {
  console.error(`
Steam Viewer Agent ${VERSION}

  Missing relay URL.

  node src/index.js --relay https://your-service.onrender.com

Options
  --relay <url>          Relay to connect to (required)
  --code <CODE>          Pin the pairing code instead of generating one
  --steam-root <path>    Steam install directory, if auto-detection misses it
  --no-launch            Read-only: report games but refuse launch requests
  --refresh-seconds <n>  How often to rescan the library (default 300)
  --web-stream-port <n>  Port moonlight-web-stream listens on (default 8080)
  --web-stream-url <url> Its address, if it runs on another machine or behind
                         a reverse proxy (skips auto-detection)
`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Local machine facts
 * ------------------------------------------------------------------ */

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** Is something listening on this local port? */
function portOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

/** Does the port speak TLS? Decides whether a browser page can embed it. */
function tlsHandshake(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' },
      () => {
        socket.destroy();
        resolve(true);
      },
    );
    socket.setTimeout(timeoutMs);
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.on('timeout', fail);
    socket.on('error', fail);
  });
}

/** Look for a moonlight-web-stream server on this PC. */
async function probeWebStream() {
  if (WEB_STREAM_URL) {
    let secure = false;
    try {
      secure = new URL(WEB_STREAM_URL).protocol === 'https:';
    } catch {
      /* leave it to the browser to complain about a malformed URL */
    }
    return { available: true, url: WEB_STREAM_URL, secure, embeddable: secure, source: 'configured' };
  }

  if (!(await portOpen(WEB_STREAM_PORT))) {
    return { available: false, port: WEB_STREAM_PORT, source: 'not detected' };
  }

  const secure = await tlsHandshake(WEB_STREAM_PORT);
  const host = lanAddress();
  const scheme = secure ? 'https' : 'http';

  return {
    available: true,
    port: WEB_STREAM_PORT,
    secure,
    // A page served over https can only embed another https origin, so a
    // plain-http instance has to be opened in its own tab instead.
    embeddable: secure,
    url: host ? `${scheme}://${host}:${WEB_STREAM_PORT}` : null,
    localUrl: `${scheme}://localhost:${WEB_STREAM_PORT}`,
    source: 'detected',
  };
}

/**
 * Streaming status.
 *
 * The browser cannot decode NVIDIA GameStream or Steam's Remote Play protocol,
 * so this does not stream video into the page. What it can do is detect a
 * Sunshine host and hand the visitor a `moonlight://` URL, which opens the
 * native Moonlight client already pointed at this PC.
 */
async function streamingStatus() {
  const host = lanAddress();
  // Sunshine: 47989 is the GameStream control port, 47990 its web UI.
  const [control, webui, webStream] = await Promise.all([portOpen(47989), portOpen(47990), probeWebStream()]);
  const sunshine = control || webui;

  return {
    // Streaming is possible if either path is there; the browser one is what
    // actually plays inside the page.
    available: sunshine || webStream.available,
    mode: webStream.available ? 'web' : sunshine ? 'moonlight' : null,
    host,
    sunshine,
    webStream,
    // Moonlight registers this scheme when the native client is installed.
    moonlightUrl: sunshine && host ? `moonlight://${host}` : null,
    sunshineWebUi: webui && host ? `https://${host}:47990` : null,
    note: webStream.available
      ? 'moonlight-web-stream detected — the stream can play in the browser.'
      : sunshine
        ? 'Sunshine detected. Install moonlight-web-stream to watch in the browser, or use the native Moonlight client.'
        : 'No Sunshine host detected on this PC. Launching games remotely works either way.',
    downloads: {
      sunshine: 'https://app.lizardbyte.dev/Sunshine/',
      moonlight: 'https://moonlight-stream.org/',
      webStream: 'https://github.com/MrCreativ3001/moonlight-web-stream',
    },
  };
}

/** Hand a URL to the OS, which is how `steam://` reaches the Steam client. */
function openUrl(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.unref();
    resolve(true);
  });
}

/* ------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------ */

let steamRoot = null;
let installed = [];

async function scanLibrary() {
  steamRoot = await findSteamRoot(STEAM_ROOT_OVERRIDE);
  if (!steamRoot) {
    console.warn('[agent] could not find a Steam installation — pass --steam-root <path>');
    installed = [];
    return installed;
  }

  installed = await listInstalledGames(steamRoot);
  return installed;
}

const asPayload = () =>
  installed.map((game) => ({
    appid: game.appid,
    name: game.name,
    sizeOnDisk: game.sizeOnDisk,
    lastPlayed: game.lastPlayed,
    fullyInstalled: game.fullyInstalled,
  }));

/* ------------------------------------------------------------------ *
 * Relay connection
 * ------------------------------------------------------------------ */

let socket = null;
let attempts = 0;
let refreshTimer = null;

function websocketUrl() {
  const url = new URL(RELAY);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/agent`;
  return url.toString();
}

async function handleOperation(message) {
  const { id, op, params = {} } = message;
  const reply = (ok, payload) =>
    socket?.send(JSON.stringify(ok ? { id, ok: true, data: payload } : { id, ok: false, error: payload }));

  try {
    switch (op) {
      case 'refresh': {
        await scanLibrary();
        socket?.send(JSON.stringify({ type: 'games', games: asPayload() }));
        reply(true, { games: asPayload().length, steamRoot });
        return;
      }

      case 'launch': {
        if (!ALLOW_LAUNCH) {
          reply(false, { message: 'This agent runs in read-only mode (--no-launch).', status: 403 });
          return;
        }
        const appid = Number(params.appid);
        const game = installed.find((entry) => entry.appid === appid);
        if (!game) {
          reply(false, { message: 'That game is not installed on this PC.', status: 404 });
          return;
        }
        await openUrl(`steam://rungameid/${appid}`);
        console.log(`[agent] launch requested: ${game.name} (${appid})`);
        reply(true, { launched: true, appid, name: game.name });
        return;
      }

      case 'stop': {
        // Steam exposes no protocol handler for quitting a running game, and
        // killing the process from here would risk losing a save.
        reply(false, {
          message: 'Steam provides no way to close a running game remotely — quit it on the PC.',
          status: 501,
        });
        return;
      }

      case 'stream': {
        const streaming = await streamingStatus();
        if (params.appid && ALLOW_LAUNCH && streaming.available) {
          const appid = Number(params.appid);
          if (installed.some((entry) => entry.appid === appid)) await openUrl(`steam://rungameid/${appid}`);
        }
        reply(true, streaming);
        return;
      }

      default:
        reply(false, { message: `Unknown operation “${op}”`, status: 400 });
    }
  } catch (error) {
    reply(false, { message: error.message || 'Operation failed', status: 500 });
  }
}

async function connect() {
  const streaming = await streamingStatus();

  socket = new WebSocket(websocketUrl());

  socket.on('open', () => {
    attempts = 0;
    socket.send(
      JSON.stringify({
        type: 'register',
        code: CODE,
        info: { host: os.hostname(), platform: process.platform, agentVersion: VERSION, streaming },
        games: asPayload(),
      }),
    );
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'registered') {
      console.log(`\n  ✔ Paired with ${RELAY}`);
      console.log(`  ✔ ${installed.length} installed games visible`);
      console.log(
    `  ✔ Streaming: ${
      streaming.webStream?.available
        ? `in-browser via moonlight-web-stream (${streaming.webStream.url || streaming.webStream.localUrl})`
        : streaming.sunshine
          ? 'Sunshine detected (native Moonlight only)'
          : 'not available'
    }\n`,
  );
      console.log(`     Pairing code:  ${CODE}\n`);
      console.log('  Enter that code on the site under Remote Play. Keep this window open.\n');
      return;
    }
    if (message.type === 'error') {
      console.error(`[agent] relay error: ${message.error?.message}`);
      return;
    }
    if (message.id && message.op) handleOperation(message);
  });

  socket.on('close', () => {
    attempts += 1;
    const delay = Math.min(2000 * 2 ** (attempts - 1), 30_000);
    console.log(`[agent] disconnected — reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  });

  socket.on('error', (error) => {
    // `close` follows and schedules the retry.
    if (attempts === 0) console.error(`[agent] connection error: ${error.message}`);
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

console.log(`Steam Viewer Agent ${VERSION}`);
console.log(`  relay: ${RELAY}`);

await scanLibrary();
console.log(`  steam: ${steamRoot || 'not found'}`);
console.log(`  games: ${installed.length} installed`);
if (!ALLOW_LAUNCH) console.log('  mode:  read-only (--no-launch)');

await connect();

refreshTimer = setInterval(async () => {
  const before = installed.length;
  await scanLibrary();
  if (installed.length !== before && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'games', games: asPayload() }));
    console.log(`[agent] library changed: ${installed.length} installed games`);
  }
}, Math.max(REFRESH_MS, 60_000));

const shutdown = () => {
  clearInterval(refreshTimer);
  try {
    socket?.close(1000, 'agent shutting down');
  } catch {
    /* already closed */
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
