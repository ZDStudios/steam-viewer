/**
 * Client for the Steam Viewer Host — the small companion program in `host/`
 * that the visitor installs on the PC their Steam library lives on.
 *
 * The website cannot read a local Steam install, launch a game or stream a
 * desktop; a browser is not allowed to do any of those things, and no amount
 * of web code changes that. What it *can* do is talk to a program running on
 * the same machine, so the split is:
 *
 *   this page  ──http──►  127.0.0.1:8777 (host agent)  ──►  Steam / Sunshine
 *
 * The agent is the piece with the permissions: it reads the local Steam
 * library folders, launches titles through `steam://rungameid/…`, and reports
 * whether a streaming host (Sunshine, for Moonlight) or Steam's own Remote
 * Play is available so the page can hand off to it.
 *
 * Pairing: the agent prints a code on startup, and refuses every request
 * until that code is exchanged for a token. Without it, any website the
 * visitor opened could drive their games.
 */

const DEFAULT_PORTS = [8777, 8778, 8779];
const LS_BASE = 'steam-viewer:host-url';
const LS_TOKEN = 'steam-viewer:host-token';

export class HostError extends Error {
  constructor(message, { needsPairing = false, offline = false } = {}) {
    super(message);
    this.name = 'HostError';
    this.needsPairing = needsPairing;
    this.offline = offline;
  }
}

class HostAgent {
  constructor() {
    this.baseUrl = localStorage.getItem(LS_BASE) || '';
    this.token = localStorage.getItem(LS_TOKEN) || '';
    this.info = null;
    this.listeners = new Set();
    this.state = 'unknown';
  }

  on(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  #emit() {
    for (const handler of this.listeners) {
      try {
        handler({ state: this.state, info: this.info, baseUrl: this.baseUrl, paired: this.paired });
      } catch (error) {
        console.error('[host] listener threw', error);
      }
    }
  }

  #setState(state) {
    this.state = state;
    this.#emit();
  }

  get paired() {
    return Boolean(this.token);
  }

  get connected() {
    return this.state === 'ready';
  }

  async #call(path, { method = 'GET', body = null, timeoutMs = 8000, auth = true } = {}) {
    if (!this.baseUrl) throw new HostError('No host agent found on this machine.', { offline: true });

    const url = new URL(path, this.baseUrl);
    if (auth && this.token) url.searchParams.set('token', this.token);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        mode: 'cors',
      });
    } catch {
      this.#setState('offline');
      throw new HostError('The Steam Viewer Host is not answering. Is it running on this PC?', { offline: true });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new HostError('The host agent sent something this page could not read.');
    }

    if (response.status === 401 || payload?.error === 'unpaired') {
      this.token = '';
      localStorage.removeItem(LS_TOKEN);
      this.#setState('unpaired');
      throw new HostError('This browser is not paired with the host agent yet.', { needsPairing: true });
    }
    if (!response.ok || payload?.ok === false) {
      throw new HostError(payload?.message || `The host agent answered ${response.status}.`);
    }

    return payload;
  }

  /**
   * Look for an agent on the usual ports.
   *
   * Requests to `127.0.0.1` from an https page are allowed — browsers treat
   * loopback as a trustworthy origin — but Safari is stricter than Chrome and
   * Firefox here, which is why a failure to find one is reported plainly
   * rather than retried forever.
   */
  async discover({ ports = DEFAULT_PORTS } = {}) {
    this.#setState('searching');

    const candidates = [this.baseUrl, ...ports.map((port) => `http://127.0.0.1:${port}`)].filter(
      (url, index, all) => url && all.indexOf(url) === index,
    );

    for (const candidate of candidates) {
      try {
        const response = await fetch(new URL('/steamviewer/ping', candidate), {
          signal: AbortSignal.timeout(2500),
          mode: 'cors',
        });
        if (!response.ok) continue;

        const info = await response.json();
        if (info?.agent !== 'steam-viewer-host') continue;

        this.baseUrl = candidate;
        this.info = info;
        localStorage.setItem(LS_BASE, candidate);
        this.#setState(this.token ? 'ready' : 'unpaired');
        return info;
      } catch {
        /* nothing listening there — try the next port */
      }
    }

    this.info = null;
    this.#setState('offline');
    return null;
  }

  async pair(code) {
    const cleaned = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!cleaned) throw new HostError('Enter the pairing code the host agent printed.');

    const payload = await this.#call('/steamviewer/pair', { method: 'POST', body: { code: cleaned }, auth: false });
    if (!payload?.token) throw new HostError('The host agent did not hand back a token.');

    this.token = payload.token;
    localStorage.setItem(LS_TOKEN, payload.token);
    this.#setState('ready');
    return payload;
  }

  unpair() {
    this.token = '';
    localStorage.removeItem(LS_TOKEN);
    this.#setState('unpaired');
  }

  forget() {
    this.unpair();
    this.baseUrl = '';
    this.info = null;
    localStorage.removeItem(LS_BASE);
    this.#setState('unknown');
  }

  /** Everything installed on the PC, read out of Steam's app manifests. */
  async library() {
    const payload = await this.#call('/steamviewer/library');
    this.#setState('ready');
    return payload;
  }

  /** Streaming targets the agent found: Sunshine/Moonlight, Steam Remote Play. */
  async streamTargets() {
    return this.#call('/steamviewer/stream');
  }

  /**
   * Start a game on the PC.
   * @param {number} appid
   * @param {'local'|'stream'} mode `stream` also returns the launch URL for
   *   whichever streaming client the agent found.
   */
  async launch(appid, mode = 'local') {
    return this.#call('/steamviewer/launch', { method: 'POST', body: { appid: Number(appid), mode }, timeoutMs: 15_000 });
  }

  async stop(appid) {
    return this.#call('/steamviewer/stop', { method: 'POST', body: { appid: Number(appid) } });
  }
}

export const host = new HostAgent();

/**
 * Moonlight registers a `moonlight://` protocol handler when installed, so a
 * plain link hands the stream off to the native client. Nothing here can tell
 * whether that handler exists — the browser will simply do nothing if it does
 * not — so the UI always offers the install link beside it.
 */
export function moonlightUrl({ address, port = 47989, appid = null } = {}) {
  if (!address) return null;
  const base = `moonlight://${address}:${port}`;
  return appid ? `${base}?app=${encodeURIComponent(appid)}` : base;
}

/** Steam's own Remote Play, which needs no third-party streaming host. */
export function steamLinkUrl(appid) {
  return appid ? `steam://rungameid/${Number(appid)}` : 'steam://open/games';
}
