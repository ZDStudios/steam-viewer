/**
 * Transport to the Render relay.
 *
 * WebSocket is the primary channel — it gives us live player-count and
 * most-played pushes. If the socket cannot be established (corporate proxy,
 * blocked upgrade, sleeping free-tier container) the same actions are issued
 * over `GET /api/:action` instead, so the site degrades instead of breaking.
 */
import { uid } from './util.js?v=2026-07-31.4';

const STATES = ['idle', 'connecting', 'online', 'rest', 'offline'];

export class Relay {
  constructor(baseUrl = '') {
    this.baseUrl = normalizeBase(baseUrl);
    this.socket = null;
    this.state = 'idle';
    this.pending = new Map();
    this.listeners = new Map();
    this.subscriptions = new Set();
    this.attempts = 0;
    this.reconnectTimer = null;
    this.capabilities = null;
    this.everConnected = false;
    this.closedByUs = false;
  }

  /* --------------------------------------------------------------- *
   * Events
   * --------------------------------------------------------------- */

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[relay] listener for "${event}" threw`, error);
      }
    }
  }

  setState(state, detail = '') {
    if (!STATES.includes(state) || (this.state === state && !detail)) return;
    this.state = state;
    this.emit('state', { state, detail, baseUrl: this.baseUrl });
  }

  /* --------------------------------------------------------------- *
   * Connection
   * --------------------------------------------------------------- */

  get configured() {
    return Boolean(this.baseUrl);
  }

  setBaseUrl(url) {
    const next = normalizeBase(url);
    if (next === this.baseUrl) return;
    this.baseUrl = next;
    this.everConnected = false;
    this.attempts = 0;
    this.disconnect();
    if (next) this.connect();
  }

  connect() {
    if (!this.baseUrl) {
      this.setState('offline', 'No relay server configured');
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(this.reconnectTimer);
    this.closedByUs = false;
    this.setState(this.everConnected ? 'connecting' : 'connecting', this.attempts > 0 ? `Reconnecting (attempt ${this.attempts + 1})` : 'Waking the relay…');

    let socket;
    try {
      socket = new WebSocket(websocketUrl(this.baseUrl));
      // Screen-stream fragments arrive as binary frames on this same socket.
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      this.#scheduleReconnect(error?.message || 'WebSocket unavailable');
      return;
    }

    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.everConnected = true;
      this.setState('online', 'Live over WebSocket');
      for (const appid of this.subscriptions) this.#raw({ id: uid(), action: 'subscribe', params: { appid } });
    });

    socket.addEventListener('message', (event) => this.#onMessage(event));

    socket.addEventListener('close', (event) => {
      this.socket = null;
      if (this.closedByUs) return;
      this.#scheduleReconnect(event.reason || `socket closed (${event.code})`);
    });

    socket.addEventListener('error', () => {
      // `close` always follows; the reconnect is scheduled there.
    });
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.closedByUs = true;
    if (this.socket) {
      try {
        this.socket.close(1000, 'client navigating away');
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
  }

  #scheduleReconnect(reason) {
    this.attempts += 1;

    // Fall back to plain HTTP once the socket has clearly failed a few times.
    if (this.attempts >= 3 && this.baseUrl) {
      this.setState('rest', `WebSocket unavailable (${reason}) — using HTTP fallback`);
    } else {
      this.setState('offline', reason);
    }

    const delay = Math.min(1000 * 2 ** (this.attempts - 1), 20_000) + Math.random() * 600;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #raw(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  #onMessage(event) {
    // Binary is always screen-stream payload; JSON is everything else.
    if (typeof event.data !== 'string') {
      this.emit('stream-chunk', event.data);
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.event) {
      if (message.event === 'hello') {
        this.capabilities = message.data || null;
        this.emit('hello', message.data);
      }
      this.emit(message.event, message.data);
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.ok) entry.resolve({ data: message.data, cached: Boolean(message.cached) });
    else entry.reject(new RelayError(message.error?.message || 'Request failed', message.error?.status || 500));
  }

  /* --------------------------------------------------------------- *
   * Requests
   * --------------------------------------------------------------- */

  /**
   * Issue an action. Resolves with the action payload (unwrapped), rejects
   * with a RelayError.
   */
  async request(action, params = {}, { timeoutMs } = {}) {
    if (!this.baseUrl) throw new RelayError('No relay server configured yet.', 0);

    // Render free instances sleep; the very first call has to absorb the boot.
    const timeout = timeoutMs ?? (this.everConnected ? 30_000 : 75_000);

    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.#requestOverSocket(action, params, timeout);
    }
    return this.#requestOverHttp(action, params, timeout);
  }

  #requestOverSocket(action, params, timeout) {
    const id = uid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError(`“${action}” timed out after ${Math.round(timeout / 1000)}s`, 504));
      }, timeout);

      this.pending.set(id, {
        timer,
        resolve: ({ data }) => resolve(data),
        reject,
      });

      if (!this.#raw({ id, action, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#requestOverHttp(action, params, timeout).then(resolve, reject);
      }
    });
  }

  async #requestOverHttp(action, params, timeout) {
    const url = new URL(`${this.baseUrl}/api/${encodeURIComponent(action)}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }

    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeout), mode: 'cors' });
    } catch (error) {
      const message =
        error?.name === 'TimeoutError'
          ? `“${action}” timed out — the relay may still be waking up.`
          : `Could not reach the relay at ${this.baseUrl}`;
      throw new RelayError(message, 0);
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      throw new RelayError('The relay returned a response this page could not read.', response.status);
    }

    if (!response.ok || body?.ok === false) {
      throw new RelayError(body?.error?.message || `Relay responded ${response.status}`, body?.error?.status || response.status);
    }

    this.everConnected = true;
    if (this.state !== 'online') this.setState('rest', 'Connected over HTTP');
    return body.data;
  }

  /** Ask the relay to push player-count updates for a game. */
  subscribe(appid) {
    const id = Number(appid);
    if (!Number.isFinite(id)) return;
    this.subscriptions.add(id);
    this.#raw({ id: uid(), action: 'subscribe', params: { appid: id } });
  }

  unsubscribe(appid) {
    const id = Number(appid);
    this.subscriptions.delete(id);
    this.#raw({ id: uid(), action: 'unsubscribe', params: { appid: id } });
  }

  unsubscribeAll() {
    for (const id of [...this.subscriptions]) this.unsubscribe(id);
  }

  /**
   * Resolve once the WebSocket is actually open.
   *
   * Most actions work equally well over the HTTP fallback, but the screen
   * stream does not: fragments only arrive as binary frames on the socket, so
   * `stream.watch` issued over HTTP subscribes a connection that will never
   * deliver anything. A page opened cold — a shared watch link, say — has to
   * wait for the socket rather than race it.
   */
  whenOnline(timeoutMs = 25_000) {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    if (!this.baseUrl) return Promise.resolve(false);

    this.connect();

    return new Promise((resolve) => {
      let off = null;
      let timer = null;
      const settle = (ok) => {
        clearTimeout(timer);
        off?.();
        resolve(ok);
      };
      timer = setTimeout(() => settle(false), timeoutMs);
      off = this.on('state', ({ state }) => {
        if (state === 'online') settle(true);
      });
    });
  }

  /** Wake a sleeping Render container without blocking the UI. */
  async warm() {
    if (!this.baseUrl) return false;
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(75_000), mode: 'cors' });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export class RelayError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

export function normalizeBase(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    parsed.hash = '';
    parsed.search = '';
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function websocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  return url.toString();
}
