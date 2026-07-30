#!/usr/bin/env node
/**
 * Steam Viewer Host — the companion that runs on the PC your Steam library
 * is installed on.
 *
 * A web page cannot read a local Steam install, start a game, or open a
 * stream. Browsers forbid all three, and no amount of clever web code changes
 * that. This program is the part that is allowed to: it runs on your machine,
 * reads Steam's own app manifests, launches titles through the `steam://`
 * protocol handler, and reports whether a streaming host is available so the
 * page can hand off to Moonlight or to Steam Remote Play.
 *
 *   node steam-viewer-host.mjs
 *
 * No dependencies — Node 18 or newer is all it needs.
 *
 * Safety, because this is a program that starts other programs:
 *   • it listens on 127.0.0.1 only, so nothing off this machine can reach it;
 *   • it refuses every request until a browser has exchanged the pairing code
 *     printed below for a token, so a random site cannot drive your games;
 *   • the only thing it will ever launch is `steam://rungameid/<number>`,
 *     with the number checked against the games actually installed here;
 *   • nothing is ever sent anywhere — it answers the local browser and that
 *     is the entire extent of its network activity.
 *
 * Flags:
 *   --port <n>     listen on a different port (default 8777)
 *   --token <s>    use a fixed token and skip pairing (for kiosk setups)
 *   --allow-lan    also listen on the LAN, for playing from another device
 *                  on your own network. Off by default, and it still requires
 *                  pairing.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const PORT = Number(flag('port', process.env.STEAM_VIEWER_HOST_PORT || 8777));
const BIND = has('allow-lan') ? '0.0.0.0' : '127.0.0.1';

/** Six characters, unambiguous ones only — this gets read off a screen. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE =
  flag('code') ||
  Array.from(randomBytes(6), (byte) => ALPHABET[byte % ALPHABET.length]).join('');

let token = flag('token', process.env.STEAM_VIEWER_HOST_TOKEN || '');
const pairedTokens = new Set(token ? [token] : []);

/* ------------------------------------------------------------------ *
 * Steam on disk
 * ------------------------------------------------------------------ */

/** Where Steam puts itself, per platform. */
function steamRoots() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'win32') {
    const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(path.join(programFiles86, 'Steam'), path.join(programFiles, 'Steam'), 'C:\\Steam');
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Steam'));
  } else {
    candidates.push(
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    );
  }

  if (process.env.STEAM_PATH) candidates.unshift(process.env.STEAM_PATH);
  return candidates.filter((dir) => safeStat(dir)?.isDirectory());
}

const safeStat = (target) => {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
};

const safeRead = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Valve's KeyValues text format, flattened.
 *
 * Every file this reads is `"key" "value"` pairs inside `"section" { … }`
 * blocks, so a full parser is overkill: pulling out the pairs and the block
 * names is all any of the callers below actually want.
 */
function parseVdf(text) {
  const root = {};
  const stack = [root];
  const lines = String(text || '').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    if (trimmed === '{') continue;
    if (trimmed === '}') {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const pair = trimmed.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/);
    if (pair) {
      stack[stack.length - 1][unescapeVdf(pair[1])] = unescapeVdf(pair[2]);
      continue;
    }

    const section = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (section) {
      const key = unescapeVdf(section[1]);
      const child = {};
      stack[stack.length - 1][key] = child;
      stack.push(child);
    }
  }

  return root;
}

const unescapeVdf = (value) => value.replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');

/** Every steamapps folder Steam knows about, across all drives. */
function libraryFolders() {
  const folders = new Set();

  for (const root of steamRoots()) {
    const steamapps = path.join(root, 'steamapps');
    if (safeStat(steamapps)?.isDirectory()) folders.add(steamapps);

    const vdf = safeRead(path.join(steamapps, 'libraryfolders.vdf'));
    if (!vdf) continue;

    // Two formats have shipped over the years: `"1" "D:\\Games"` and a block
    // per library with a nested `"path"` key. Both appear as flat pairs once
    // parsed, so pick up either.
    const parsed = parseVdf(vdf);
    const walk = (node) => {
      for (const [key, value] of Object.entries(node || {})) {
        if (typeof value === 'string') {
          if (key === 'path' || /^\d+$/.test(key)) {
            const candidate = path.join(value, 'steamapps');
            if (safeStat(candidate)?.isDirectory()) folders.add(candidate);
          }
        } else if (value && typeof value === 'object') {
          walk(value);
        }
      }
    };
    walk(parsed);
  }

  return [...folders];
}

/** Installed games, read out of Steam's own `appmanifest_*.acf` files. */
function installedGames() {
  const games = new Map();

  for (const folder of libraryFolders()) {
    let entries = [];
    try {
      entries = fs.readdirSync(folder);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!/^appmanifest_(\d+)\.acf$/i.test(entry)) continue;

      const manifest = parseVdf(safeRead(path.join(folder, entry)));
      const state = manifest.AppState || {};
      const appid = Number(state.appid || entry.match(/(\d+)/)[1]);
      if (!Number.isFinite(appid) || appid <= 0 || games.has(appid)) continue;

      // 4 is "fully installed"; anything else is mid-download or broken.
      const fullyInstalled = (Number(state.StateFlags) & 4) === 4;

      games.set(appid, {
        appid,
        name: state.name || `App ${appid}`,
        installDir: state.installdir ? path.join(folder, 'common', state.installdir) : null,
        sizeOnDisk: Number(state.SizeOnDisk) || 0,
        lastUpdated: Number(state.LastUpdated) || null,
        lastPlayed: Number(state.LastPlayed) || null,
        installed: fullyInstalled,
        buildId: state.buildid || null,
        library: folder,
      });
    }
  }

  return [...games.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ *
 * Launching
 * ------------------------------------------------------------------ */

/** Hand a `steam://` URL to the OS, without ever going through a shell. */
function openUrl(url) {
  return new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];

    execFile(command, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

/** Is something listening on this port locally? */
function portOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Addresses another device on the network could reach this PC on. */
function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/**
 * Sunshine — the open-source host Moonlight connects to — listens on 47989
 * (control) and 47990 (its web UI). Steam's own Remote Play needs no probing:
 * if Steam is running, it is available.
 */
async function streamTargets() {
  const [sunshineControl, sunshineWeb, steamRemote] = await Promise.all([portOpen(47989), portOpen(47990), portOpen(27036)]);
  const addresses = localAddresses();

  return {
    hostname: os.hostname(),
    addresses,
    moonlight: {
      available: sunshineControl || sunshineWeb,
      host: addresses[0] || '127.0.0.1',
      port: 47989,
      webUi: sunshineWeb ? 'https://127.0.0.1:47990' : null,
      install: 'https://github.com/LizardByte/Sunshine/releases',
    },
    steamRemotePlay: {
      available: steamRemote,
      note: steamRemote
        ? 'Steam is running, so Remote Play works from the Steam Link app on any device signed into the same account.'
        : 'Steam does not appear to be running on this PC.',
      install: 'https://store.steampowered.com/remoteplay',
    },
  };
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

/** Constant-time compare, so a token cannot be guessed a character at a time. */
function tokenMatches(candidate) {
  if (!candidate) return false;
  const given = createHash('sha256').update(String(candidate)).digest();
  for (const known of pairedTokens) {
    const expected = createHash('sha256').update(known).digest();
    if (timingSafeEqual(given, expected)) return true;
  }
  return false;
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  /*
   * The page that talks to this agent is served from GitHub Pages, so its
   * origin is not this machine — CORS has to be open. That is safe only
   * because the pairing token is what actually authorises anything; the
   * headers below let the browser ask, they do not let it in.
   */
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  // Chrome's Private Network Access preflight: a public page reaching a
  // loopback server must be told, explicitly, that it is welcome.
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const authorised = () => tokenMatches(url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

  try {
    switch (url.pathname) {
      /* Unauthenticated: just enough for a browser to know we are here. */
      case '/steamviewer/ping':
        json(res, 200, {
          agent: 'steam-viewer-host',
          version: VERSION,
          hostname: os.hostname(),
          platform: process.platform,
          requiresPairing: true,
          paired: pairedTokens.size > 0,
        });
        return;

      case '/steamviewer/pair': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'POST only' });
        const body = await readBody(req);
        const given = String(body.code || '').trim().toUpperCase();

        if (given !== PAIRING_CODE) {
          console.log(`[host] rejected a pairing attempt with code "${given}"`);
          return json(res, 403, { ok: false, message: 'That pairing code is not right.' });
        }

        const issued = randomBytes(24).toString('hex');
        pairedTokens.add(issued);
        token = issued;
        console.log('[host] a browser paired successfully');
        return json(res, 200, { ok: true, token: issued, hostname: os.hostname() });
      }

      case '/steamviewer/library': {
        if (!authorised()) return json(res, 401, { ok: false, error: 'unpaired', message: 'Pair this browser first.' });
        const games = installedGames();
        const folders = libraryFolders();
        console.log(`[host] library requested — ${games.length} games across ${folders.length} folders`);
        return json(res, 200, {
          ok: true,
          hostname: os.hostname(),
          platform: process.platform,
          libraryFolders: folders,
          games,
        });
      }

      case '/steamviewer/stream': {
        if (!authorised()) return json(res, 401, { ok: false, error: 'unpaired', message: 'Pair this browser first.' });
        return json(res, 200, { ok: true, ...(await streamTargets()) });
      }

      case '/steamviewer/launch': {
        if (!authorised()) return json(res, 401, { ok: false, error: 'unpaired', message: 'Pair this browser first.' });
        if (req.method !== 'POST') return json(res, 405, { ok: false, message: 'POST only' });

        const body = await readBody(req);
        const appid = Number(body.appid);
        if (!Number.isInteger(appid) || appid <= 0 || appid > 100_000_000) {
          return json(res, 400, { ok: false, message: 'That is not a valid appid.' });
        }

        // Only ever launch something Steam says is installed here.
        const game = installedGames().find((entry) => entry.appid === appid);
        if (!game) {
          return json(res, 404, { ok: false, message: `App ${appid} is not installed on ${os.hostname()}.` });
        }

        const launchUrl = `steam://rungameid/${appid}`;
        console.log(`[host] launching ${game.name} (${appid})`);
        await openUrl(launchUrl);

        const payload = { ok: true, appid, name: game.name, message: `Launching ${game.name} on ${os.hostname()}…` };

        if (body.mode === 'stream') {
          const targets = await streamTargets();
          if (targets.moonlight.available) {
            payload.streamUrl = `moonlight://${targets.moonlight.host}:${targets.moonlight.port}`;
            payload.message = `${game.name} is starting — handing the stream to Moonlight.`;
          } else {
            payload.message = `${game.name} is starting. No Sunshine host here, so connect with the Steam Link app for Remote Play.`;
          }
          payload.targets = targets;
        }

        return json(res, 200, payload);
      }

      case '/steamviewer/stop': {
        if (!authorised()) return json(res, 401, { ok: false, error: 'unpaired', message: 'Pair this browser first.' });
        // Steam exposes no "stop this game" URL, and killing someone's game
        // process from a web page is not a thing this should be doing.
        return json(res, 200, {
          ok: true,
          message: 'Steam has no remote-stop command — close the game on the PC, or through the Steam overlay.',
        });
      }

      default:
        return json(res, 404, { ok: false, message: 'No such endpoint.' });
    }
  } catch (error) {
    console.error('[host] request failed:', error.message);
    json(res, 500, { ok: false, message: error.message || 'Something went wrong.' });
  }
});

server.on('connection', (socket) => {
  // Belt and braces: even bound to 0.0.0.0 with --allow-lan, refuse anything
  // that is not a private address.
  const remote = socket.remoteAddress || '';
  const isLocal = /^(::1|::ffff:127\.|127\.)/.test(remote);
  const isPrivate = /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remote);
  if (!isLocal && !(has('allow-lan') && isPrivate)) {
    console.log(`[host] refused a connection from ${remote}`);
    socket.destroy();
  }
});

server.listen(PORT, BIND, () => {
  const games = installedGames();
  const folders = libraryFolders();

  console.log('');
  console.log('  Steam Viewer Host');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  listening   http://${BIND}:${PORT}`);
  console.log(`  machine     ${os.hostname()} (${process.platform})`);
  console.log(`  steam       ${folders.length ? `${folders.length} library folder(s), ${games.length} installed game(s)` : 'no Steam install found'}`);
  console.log('');
  if (pairedTokens.size && flag('token')) {
    console.log('  paired      using the token given on the command line');
  } else {
    console.log(`  PAIRING CODE:  ${PAIRING_CODE}`);
    console.log('');
    console.log('  Open Steam Viewer on this PC, go to Remote Play, and enter that code.');
  }
  console.log('');
  if (!folders.length) {
    console.log('  No Steam install was found. Set STEAM_PATH to point at it, e.g.');
    console.log('    STEAM_PATH="D:\\Steam" node steam-viewer-host.mjs');
    console.log('');
  }
  console.log('  Ctrl-C to stop.');
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — is the host already running?`);
    console.error(`  Try:  node steam-viewer-host.mjs --port ${PORT + 1}\n`);
    process.exit(1);
  }
  throw error;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[host] stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
