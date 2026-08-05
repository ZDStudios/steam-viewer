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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import process from 'node:process';
import { WebSocket } from 'ws';

import { findSteamRoot, listInstalledGames } from './steamfs.js';
import { CODECS, ensureFfmpeg, ScreenStream } from './stream.js';

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
/** Built-in ffmpeg screen streaming. */
const STREAM_ENABLED = options.stream !== 'false';
const FFMPEG_PATH = options.ffmpeg || null;
const STREAM_FPS = Number(options['stream-fps'] || 60);
const STREAM_BITRATE = options['stream-bitrate'] || '12M';
const STREAM_HEIGHT = Number(options['stream-height'] || 1080);
const STREAM_INPUT = options['stream-input'] || null;
const ALLOW_FFMPEG_INSTALL = options['no-ffmpeg-install'] !== 'true';
const STREAM_DISPLAY = options['stream-display'] || null;

const WEB_STREAM_PORT = Number(options['web-stream-port'] || 8080);
const WEB_STREAM_URL = options['web-stream-url'] || process.env.STEAM_VIEWER_WEB_STREAM || null;

/**
 * TLS.
 *
 * Node ships its own CA bundle and ignores the operating system's, so on a PC
 * where antivirus or a corporate proxy inspects HTTPS the re-signed
 * certificate is trusted by Windows but not by Node — which surfaces as
 * "self-signed certificate in certificate chain" against a perfectly valid
 * Render URL.
 *
 * `--use-system-ca` (Node 22.15+) makes Node read the OS trust store, which
 * fixes it properly. The agent re-execs itself with that flag on the first
 * certificate failure rather than making the user work it out.
 */
const EXTRA_CA = options.ca || process.env.NODE_EXTRA_CA_CERTS || null;
const INSECURE = options.insecure === 'true';
const SYSTEM_CA_RETRIED = process.env.STEAM_VIEWER_SYSTEM_CA === '1';

const CERT_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);

const isCertError = (error) =>
  Boolean(error) && (CERT_ERRORS.has(error.code) || /self-signed certificate|unable to verify|certificate chain/i.test(error.message || ''));

/** Does this Node build understand --use-system-ca? */
function supportsSystemCa() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 15);
}

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
  --stream=false         Disable built-in screen streaming
  --ffmpeg <path>        ffmpeg binary, if it is not on PATH
  --stream-fps <n>       Capture frame rate (default 60, minimum 30)
  --stream-bitrate <r>   Video bitrate, e.g. 20M (default 12M)
  --stream-height <n>    Scale down to this height (default 1080)
  --stream-display <s>   Capture source override (gdigrab/x11grab/avfoundation)
  --no-ffmpeg-install    Never download ffmpeg; use only what is already here
  --ca <path>            Extra CA certificate to trust (PEM). Needed when
                         antivirus or a corporate proxy inspects HTTPS.
  --insecure             Skip certificate verification entirely. Last resort.
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
    available: sunshine || webStream.available || Boolean(ffmpeg),
    mode: ffmpeg ? 'built-in' : webStream.available ? 'web' : sunshine ? 'moonlight' : null,
    host,
    sunshine,
    webStream,
    builtIn: {
      available: Boolean(ffmpeg),
      running: Boolean(screen?.running),
      ffmpeg: ffmpeg?.version || null,
      codecs: Object.keys(CODECS),
      reason: ffmpeg
        ? null
        : STREAM_ENABLED
          ? 'ffmpeg could not be found or installed on this PC'
          : 'disabled with --stream=false',
    },
    // Moonlight registers this scheme when the native client is installed.
    moonlightUrl: sunshine && host ? `moonlight://${host}` : null,
    sunshineWebUi: webui && host ? `https://${host}:47990` : null,
    note: ffmpeg
      ? 'Built-in streaming is ready — press Watch to see this PC in the browser.'
      : webStream.available
        ? 'moonlight-web-stream detected — the stream can play in the browser.'
        : sunshine
          ? 'Sunshine detected. Use the native Moonlight client, or install ffmpeg for built-in streaming.'
          : 'Install ffmpeg for built-in streaming. Launching games remotely works either way.',
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
 * Screen streaming
 * ------------------------------------------------------------------ */

let ffmpeg = null;
let screen = null;

/**
 * Frames are sent as binary with a one-byte kind marker, so the relay can
 * cache the header and replay it to anyone who joins mid-stream.
 *   0x01 = fMP4 init segment   0x02 = media fragment
 */
const KIND_INIT = 1;
const KIND_MEDIA = 2;

function sendFrame(kind, chunk) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const framed = Buffer.allocUnsafe(chunk.length + 1);
  framed[0] = kind;
  chunk.copy(framed, 1);
  try {
    socket.send(framed, { binary: true });
  } catch {
    /* the socket is going away; the close handler cleans up */
  }
}

function startScreenStream(params = {}) {
  if (!ffmpeg) {
    throw new Error(
      'ffmpeg was not found on this PC. Install it and make sure `ffmpeg` runs from a terminal, or pass --ffmpeg <path>.',
    );
  }
  if (screen?.running) return { ok: true, alreadyRunning: true, ffmpeg: ffmpeg.version };

  const codec = CODECS[params.codec] ? params.codec : 'h264';

  screen = new ScreenStream({
    ffmpegPath: ffmpeg.path,
    codec,
    fps: params.fps || STREAM_FPS,
    bitrate: params.bitrate || STREAM_BITRATE,
    height: params.height || STREAM_HEIGHT,
    display: STREAM_DISPLAY,
    input: STREAM_INPUT,
    onChunk: (chunk, isInit) => sendFrame(isInit ? KIND_INIT : KIND_MEDIA, chunk),
    onExit: (error) => {
      if (error) console.error(`[agent] stream stopped: ${error.message}`);
      screen = null;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stream-state', running: false, error: error ? error.message : null }));
      }
    },
  });

  screen.start();
  console.log(`[agent] screen stream started (${codec})`);
  return { ok: true, ffmpeg: ffmpeg.version, fps: params.fps || STREAM_FPS, codec, mime: screen.mime };
}

function stopScreenStream() {
  if (!screen) return { ok: true, alreadyStopped: true };
  screen.stop();
  screen = null;
  console.log('[agent] screen stream stopped');
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Relay connection
 * ------------------------------------------------------------------ */

let socket = null;
let attempts = 0;
let lastError = null;
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

      case 'stream.start': {
        // Watching the screen and starting a game are different permissions,
        // and they have their own switches: `--stream=false` turns streaming
        // off, `--no-launch` stops games being started. Gating streaming on
        // --no-launch meant a read-only agent could not be watched at all,
        // and anyone who wanted to watch had to allow remote launching too.
        if (!STREAM_ENABLED) {
          reply(false, { message: 'Screen streaming is switched off on this agent (--stream=false).', status: 403 });
          return;
        }
        try {
          reply(true, startScreenStream(params));
        } catch (error) {
          reply(false, { message: error.message, status: 501 });
        }
        return;
      }

      case 'stream.stop': {
        reply(true, stopScreenStream());
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

function tlsOptions() {
  const options = {};
  if (INSECURE) options.rejectUnauthorized = false;
  if (EXTRA_CA) {
    try {
      options.ca = fs.readFileSync(EXTRA_CA);
    } catch (error) {
      console.warn(`[agent] could not read --ca ${EXTRA_CA}: ${error.message}`);
    }
  }
  return options;
}

/**
 * Re-launch this process with --use-system-ca so Node trusts the certificates
 * Windows already trusts. Returns false if that is not possible, in which case
 * the caller prints instructions instead.
 */
function retryWithSystemCa() {
  if (SYSTEM_CA_RETRIED || INSECURE || !supportsSystemCa()) return false;

  console.log('\n[agent] certificate rejected — retrying with the system certificate store…\n');

  const result = spawnSync(
    process.execPath,
    ['--use-system-ca', ...process.execArgv.filter((arg) => arg !== '--use-system-ca'), ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, STEAM_VIEWER_SYSTEM_CA: '1' } },
  );

  process.exit(result.status ?? 1);
}

function explainCertFailure(message) {
  console.error(`
[agent] Could not verify the relay's certificate: ${message}

  Node uses its own list of trusted certificate authorities and ignores the
  one Windows keeps, so this usually means antivirus or a company proxy is
  inspecting HTTPS traffic and re-signing it. The relay itself is fine.

  Fixes, best first:

    1. Update Node to 22.15 or newer, then run:
         npm start -- --relay ${RELAY} --use-system-ca
       (this agent tries that automatically when it can)

    2. Export your security software's root certificate and point at it:
         npm start -- --relay ${RELAY} --ca C:\\path\\to\\root.pem
       or set NODE_EXTRA_CA_CERTS to the same file.

    3. Turn off HTTPS/SSL scanning for ${RELAY} in that software.

    4. Last resort, skips verification entirely:
         npm start -- --relay ${RELAY} --insecure
`);
}

async function connect() {
  const streaming = await streamingStatus();

  socket = new WebSocket(websocketUrl(), tlsOptions());

  socket.on('open', () => {
    attempts = 0;
    lastError = null;
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
      streaming.builtIn?.available
        ? 'built in (ffmpeg) — watch straight from the site'
        : streaming.webStream?.available
          ? `moonlight-web-stream (${streaming.webStream.url || streaming.webStream.localUrl})`
          : streaming.sunshine
            ? 'Sunshine detected (native Moonlight only)'
            : `not available — ${streaming.builtIn?.reason || 'no capture backend'}`
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

  socket.on('close', (code, reasonBuffer) => {
    // Another agent took this pairing code. Reconnecting would just evict it
    // straight back, so stop and say so.
    if (code === 4001) {
      console.error(`
[agent] Another agent connected with the pairing code ${CODE}, so this one has stopped.

  Two copies cannot share a code. Close the other one, or start this one with a
  different --code.
`);
      process.exit(1);
    }

    // A certificate failure will not fix itself by reconnecting.
    if (lastError && isCertError(lastError)) {
      if (retryWithSystemCa() === false) {
        explainCertFailure(lastError.message);
        process.exit(1);
      }
      return;
    }

    attempts += 1;
    const delay = Math.min(2000 * 2 ** (attempts - 1), 30_000);
    console.log(`[agent] disconnected — reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  });

  socket.on('error', (error) => {
    lastError = error;
    // `close` follows and decides what to do about it.
    if (attempts === 0 && !isCertError(error)) console.error(`[agent] connection error: ${error.message}`);
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
// Resolve (and if necessary fetch) the encoder before pairing, so the site is
// told the truth about whether streaming is available.
if (STREAM_ENABLED) {
  ffmpeg = await ensureFfmpeg({ explicit: FFMPEG_PATH, allowInstall: ALLOW_FFMPEG_INSTALL });
}
console.log(`  video: ${ffmpeg ? `${ffmpeg.path === 'ffmpeg' ? 'ffmpeg (PATH)' : ffmpeg.path}` : 'no encoder — streaming unavailable'}`);

if (!ALLOW_LAUNCH) console.log('  mode:  read-only (--no-launch)');
if (INSECURE) console.log('  tls:   verification DISABLED (--insecure)');
else if (SYSTEM_CA_RETRIED) console.log('  tls:   using the system certificate store');
else if (EXTRA_CA) console.log(`  tls:   trusting extra CA ${EXTRA_CA}`);

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
  stopScreenStream();
  try {
    socket?.close(1000, 'agent shutting down');
  } catch {
    /* already closed */
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
