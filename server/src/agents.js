/**
 * Registry for Steam Viewer Agents — the small program a visitor installs on
 * their gaming PC (see `agent/`). The agent holds an outbound WebSocket to
 * this relay, which means the PC never needs an open port or a public address.
 *
 * The browser addresses an agent by its pairing code; the relay forwards the
 * operation down the agent's socket and returns whatever it answers. The relay
 * never stores credentials — the pairing code is the whole handshake, so it is
 * treated as a secret and rotates whenever the agent restarts.
 */
import { SteamError } from './steam.js';

const agents = new Map(); // code -> entry
const bySocket = new WeakMap();

const REQUEST_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 20_000);

/** Unambiguous alphabet: no O/0, I/1, so codes survive being read aloud. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

export function register({ socket, code, info = {}, games = [] }) {
  const key = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(key)) throw new SteamError('Invalid pairing code', { status: 400 });

  // A reconnecting agent replaces its previous socket rather than stacking up.
  const existing = agents.get(key);
  if (existing && existing.socket !== socket) {
    try {
      existing.socket.close(1000, 'replaced by a newer agent connection');
    } catch {
      /* already gone */
    }
  }

  const entry = {
    code: key,
    socket,
    info: {
      host: String(info.host || 'unknown').slice(0, 64),
      platform: String(info.platform || '').slice(0, 32),
      agentVersion: String(info.agentVersion || '').slice(0, 16),
      streaming: info.streaming && typeof info.streaming === 'object' ? info.streaming : { available: false },
    },
    games: Array.isArray(games) ? games.slice(0, 2000) : [],
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    pending: new Map(),
  };

  agents.set(key, entry);
  bySocket.set(socket, entry);
  return entry;
}

export function unregister(socket) {
  const entry = bySocket.get(socket);
  if (!entry) return;
  bySocket.delete(socket);
  if (agents.get(entry.code) === entry) agents.delete(entry.code);
  for (const pending of entry.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new SteamError('The agent disconnected', { status: 503 }));
  }
  entry.pending.clear();
}

export function updateGames(socket, games) {
  const entry = bySocket.get(socket);
  if (!entry) return;
  entry.games = Array.isArray(games) ? games.slice(0, 2000) : [];
  entry.lastSeen = Date.now();
}

/** Route a reply frame from an agent back to whoever asked for it. */
export function resolveReply(socket, message) {
  const entry = bySocket.get(socket);
  if (!entry) return;
  entry.lastSeen = Date.now();

  const pending = entry.pending.get(message?.id);
  if (!pending) return;
  entry.pending.delete(message.id);
  clearTimeout(pending.timer);

  if (message.ok) pending.resolve(message.data ?? null);
  else pending.reject(new SteamError(message.error?.message || 'The agent refused that request', { status: message.error?.status || 502 }));
}

function find(code) {
  const entry = agents.get(String(code || '').toUpperCase());
  if (!entry) throw new SteamError('No agent is paired with that code. Start Steam Viewer Agent on your PC and check the code.', { status: 404 });
  if (entry.socket.readyState !== entry.socket.OPEN) {
    agents.delete(entry.code);
    throw new SteamError('That agent is no longer connected', { status: 503 });
  }
  return entry;
}

export function status(code) {
  const entry = find(code);
  return {
    code: entry.code,
    online: true,
    host: entry.info.host,
    platform: entry.info.platform,
    agentVersion: entry.info.agentVersion,
    streaming: entry.info.streaming,
    games: entry.games.length,
    connectedAt: entry.connectedAt,
    lastSeen: entry.lastSeen,
  };
}

export function games(code) {
  const entry = find(code);
  return { code: entry.code, host: entry.info.host, streaming: entry.info.streaming, games: entry.games };
}

/** Ask the agent to do something and wait for its answer. */
export function request(code, op, params = {}) {
  const entry = find(code);

  return new Promise((resolve, reject) => {
    const id = makeCode(12);
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new SteamError(`The agent did not answer “${op}” in time`, { status: 504 }));
    }, REQUEST_TIMEOUT_MS);

    entry.pending.set(id, { resolve, reject, timer });

    try {
      entry.socket.send(JSON.stringify({ id, op, params }));
    } catch (error) {
      entry.pending.delete(id);
      clearTimeout(timer);
      reject(new SteamError(`Could not reach the agent: ${error.message}`, { status: 503 }));
    }
  });
}

export const stats = () => ({ agents: agents.size });
