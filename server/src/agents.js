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
  // 4001 tells the displaced agent it was replaced, so it exits instead of
  // reconnecting — two agents sharing a code would otherwise evict each other
  // forever and neither would be usable.
  const existing = agents.get(key);
  if (existing && existing.socket !== socket) {
    try {
      existing.socket.close(4001, 'replaced by another agent using the same pairing code');
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
    // Browser sockets watching this PC's screen, plus the fMP4 header so a
    // late joiner can start decoding immediately.
    viewers: new Set(),
    streamInit: null,
  };

  // A reconnecting agent keeps its audience.
  if (existing) {
    entry.viewers = existing.viewers;
    for (const viewer of entry.viewers) {
      try {
        viewer.send(JSON.stringify({ event: 'stream', data: { state: 'agent-reconnected', code: key } }));
      } catch {
        /* viewer gone */
      }
    }
  }

  agents.set(key, entry);
  bySocket.set(socket, entry);
  return entry;
}

export function unregister(socket) {
  const entry = bySocket.get(socket);
  if (!entry) return;
  bySocket.delete(socket);
  if (agents.get(entry.code) === entry) agents.delete(entry.code);

  entry.streamInit = null;
  for (const viewer of entry.viewers) {
    try {
      viewer.send(JSON.stringify({ event: 'stream', data: { state: 'ended', reason: 'the agent disconnected' } }));
    } catch {
      /* viewer gone */
    }
  }
  entry.viewers.clear();
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

/* ------------------------------------------------------------------ *
 * Screen streaming
 * ------------------------------------------------------------------ */

const KIND_INIT = 1;

/**
 * A binary frame from an agent: byte 0 says whether this is the fMP4 header
 * or a media fragment. The header is cached so viewers who arrive mid-stream
 * get it before any fragment.
 */
export function pushStream(socket, data) {
  const entry = bySocket.get(socket);
  if (!entry) return;
  entry.lastSeen = Date.now();
  if (!data || data.length < 2) return;

  if (data[0] === KIND_INIT) entry.streamInit = Buffer.from(data);

  for (const viewer of entry.viewers) {
    if (viewer.readyState !== viewer.OPEN) {
      entry.viewers.delete(viewer);
      continue;
    }
    // Drop fragments for a viewer that cannot keep up rather than buffering
    // the stream into memory.
    if (viewer.bufferedAmount > 8 * 1024 * 1024) continue;
    try {
      viewer.send(data, { binary: true });
    } catch {
      entry.viewers.delete(viewer);
    }
  }
}

/** Attach a browser socket to an agent's stream. */
export function addViewer(code, viewer) {
  const entry = find(code);
  entry.viewers.add(viewer);
  viewersBySocket.set(viewer, entry);

  if (entry.streamInit && viewer.readyState === viewer.OPEN) {
    try {
      viewer.send(entry.streamInit, { binary: true });
    } catch {
      /* viewer gone */
    }
  }

  return { code: entry.code, viewers: entry.viewers.size, hasHeader: Boolean(entry.streamInit) };
}

const viewersBySocket = new WeakMap();

export function removeViewer(viewer) {
  const entry = viewersBySocket.get(viewer);
  if (!entry) return;
  entry.viewers.delete(viewer);
  viewersBySocket.delete(viewer);

  // Nobody is watching any more, so the PC should not still be encoding. The
  // browser normally stops the stream itself, but a closed laptop lid or a
  // killed tab never gets the chance — without this the encoder runs until the
  // agent is restarted, burning CPU on someone else's machine.
  if (entry.viewers.size === 0 && entry.socket.readyState === entry.socket.OPEN) {
    entry.streamInit = null;
    try {
      entry.socket.send(JSON.stringify({ id: makeCode(12), op: 'stream.stop', params: {} }));
    } catch {
      /* the agent is going away anyway */
    }
  }
}

export function viewerCount(code) {
  try {
    return find(code).viewers.size;
  } catch {
    return 0;
  }
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
