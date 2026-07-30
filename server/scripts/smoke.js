#!/usr/bin/env node
/**
 * Smoke test against a running relay.
 *
 *   node src/index.js &            # or: npm start
 *   npm run smoke                  # defaults to http://127.0.0.1:8080
 *   BASE=https://your.onrender.com npm run smoke
 *
 * Checks the HTTP surface, then the WebSocket request/response envelope.
 */
import { WebSocket } from 'ws';

const BASE = (process.env.BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 90_000);

let failures = 0;

const log = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
  const body = await response.json();
  return { status: response.status, body };
}

async function httpChecks() {
  console.log(`\nHTTP  ${BASE}`);

  try {
    const { status, body } = await getJson('/healthz');
    log(status === 200 && body.ok === true, 'GET /healthz', `status ${status}`);
  } catch (error) {
    log(false, 'GET /healthz', error.message);
  }

  try {
    const { body } = await getJson('/api/capabilities');
    log(Array.isArray(body?.data?.actions), 'GET /api/capabilities', `${body?.data?.actions?.length ?? 0} actions`);
  } catch (error) {
    log(false, 'GET /api/capabilities', error.message);
  }

  for (const [label, path, check] of [
    ['search', '/api/search?term=portal', (data) => Array.isArray(data?.items)],
    ['app', '/api/app?appid=620', (data) => data?.game?.name],
    ['players', '/api/players?appid=730', (data) => typeof data?.players === 'number' || data?.players === null],
    ['mostplayed', '/api/mostplayed?limit=5', (data) => Array.isArray(data)],
    ['home', '/api/home', (data) => Array.isArray(data?.topSellers)],
  ]) {
    try {
      const { status, body } = await getJson(path);
      const value = check(body?.data);
      log(status === 200 && Boolean(value), `GET ${path}`, typeof value === 'string' ? value : `status ${status}`);
    } catch (error) {
      log(false, `GET ${path}`, error.message);
    }
  }
}

function websocketChecks() {
  console.log(`\nWebSocket  ${BASE.replace(/^http/, 'ws')}/ws`);

  return new Promise((resolve) => {
    const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
    const seen = { hello: false, pong: false, search: false };
    const done = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve();
    };

    const timer = setTimeout(() => {
      log(false, 'websocket round trip', 'timed out');
      done();
    }, TIMEOUT);

    socket.on('open', () => {
      socket.send(JSON.stringify({ id: 'a', action: 'ping' }));
      socket.send(JSON.stringify({ id: 'b', action: 'search', params: { term: 'half-life' } }));
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.event === 'hello') {
        seen.hello = true;
        log(Array.isArray(message.data?.actions), 'hello frame', `library ${message.data?.library ? 'on' : 'off'}`);
      }
      if (message.id === 'a') {
        seen.pong = true;
        log(message.ok === true, 'ping');
      }
      if (message.id === 'b') {
        seen.search = true;
        log(message.ok === true && Array.isArray(message.data?.items), 'search', `${message.data?.items?.length ?? 0} results`);
      }
      if (seen.hello && seen.pong && seen.search) {
        clearTimeout(timer);
        done();
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      log(false, 'websocket', error.message);
      done();
    });
  });
}

await httpChecks();
await websocketChecks();

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
