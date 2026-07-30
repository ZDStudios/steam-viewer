/**
 * A wishlist that lives entirely in the browser.
 *
 * Steam's own wishlist needs an account, and this site never asks anyone to
 * log in, so this is the stand-in: the same add / prioritise / remove
 * behaviour, persisted to `localStorage` under the visitor's own browser.
 * Nothing leaves the machine, and the relay never sees it.
 *
 * It is a genuine wishlist in every respect except that it is not *your Steam
 * wishlist* — the game page links out to Steam for that.
 */

const KEY = 'steam-viewer:wishlist';
const VERSION = 1;
const MAX = 500;

/** Only the fields a card needs; anything else would just go stale. */
function toEntry(item, extra = {}) {
  return {
    appid: Number(item.appid),
    name: item.name || `App ${item.appid}`,
    header: item.header || null,
    capsule: item.capsule || null,
    portrait: item.portrait || null,
    price: item.price || null,
    platforms: item.platforms || null,
    releaseDate: item.releaseDate || null,
    comingSoon: Boolean(item.comingSoon),
    genres: (item.genres || []).slice(0, 3),
    addedAt: Date.now(),
    ...extra,
  };
}

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || raw.version !== VERSION || !Array.isArray(raw.items)) return [];
    return raw.items.filter((item) => Number.isFinite(Number(item?.appid)));
  } catch {
    // Corrupt or unreadable (private mode, quota games) — start clean rather
    // than taking the whole page down with it.
    return [];
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: VERSION, items: items.slice(0, MAX) }));
    return true;
  } catch {
    return false;
  }
}

class Wishlist {
  constructor() {
    this.items = read();
    this.listeners = new Set();

    // A second tab is the same wishlist; keep them in step.
    window.addEventListener('storage', (event) => {
      if (event.key !== KEY) return;
      this.items = read();
      this.#emit('sync');
    });
  }

  on(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  #emit(reason, appid = null) {
    for (const handler of this.listeners) {
      try {
        handler({ reason, appid, items: this.items, count: this.items.length });
      } catch (error) {
        console.error('[wishlist] listener threw', error);
      }
    }
  }

  get count() {
    return this.items.length;
  }

  all() {
    return [...this.items];
  }

  has(appid) {
    const id = Number(appid);
    return this.items.some((item) => item.appid === id);
  }

  get(appid) {
    const id = Number(appid);
    return this.items.find((item) => item.appid === id) || null;
  }

  add(item) {
    const id = Number(item?.appid);
    if (!Number.isFinite(id)) return false;
    if (this.has(id)) {
      // Re-adding refreshes the cached card instead of duplicating it.
      this.items = this.items.map((entry) => (entry.appid === id ? { ...toEntry(item), addedAt: entry.addedAt } : entry));
    } else {
      if (this.items.length >= MAX) return false;
      this.items = [toEntry(item), ...this.items];
    }
    write(this.items);
    this.#emit('add', id);
    return true;
  }

  remove(appid) {
    const id = Number(appid);
    const before = this.items.length;
    this.items = this.items.filter((item) => item.appid !== id);
    if (this.items.length === before) return false;
    write(this.items);
    this.#emit('remove', id);
    return true;
  }

  /** @returns {boolean} whether the game is on the list afterwards. */
  toggle(item) {
    const id = Number(item?.appid);
    if (this.has(id)) {
      this.remove(id);
      return false;
    }
    return this.add(item);
  }

  /** Drag-free reordering: nudge one entry up or down the list. */
  move(appid, delta) {
    const id = Number(appid);
    const from = this.items.findIndex((item) => item.appid === id);
    if (from < 0) return false;
    const to = Math.min(Math.max(from + delta, 0), this.items.length - 1);
    if (to === from) return false;

    const next = [...this.items];
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry);
    this.items = next;
    write(this.items);
    this.#emit('move', id);
    return true;
  }

  clear() {
    this.items = [];
    write(this.items);
    this.#emit('clear');
  }

  /** Refresh cached prices from freshly fetched cards. */
  merge(cards = []) {
    if (!cards.length) return;
    const byId = new Map(cards.map((card) => [Number(card.appid), card]));
    let changed = false;

    this.items = this.items.map((entry) => {
      const card = byId.get(entry.appid);
      if (!card) return entry;
      changed = true;
      return { ...entry, ...toEntry(card, { addedAt: entry.addedAt }) };
    });

    if (changed) {
      write(this.items);
      this.#emit('refresh');
    }
  }

  /** The whole list as a file, so it survives a cleared browser. */
  export() {
    return JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), items: this.items }, null, 2);
  }

  import(json, { replace = false } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const incoming = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(incoming)) throw new Error('That file does not contain a wishlist.');

    const cleaned = incoming.filter((item) => Number.isFinite(Number(item?.appid))).map((item) => toEntry(item, { addedAt: item.addedAt || Date.now() }));
    if (cleaned.length === 0) throw new Error('That wishlist is empty.');

    const seen = new Set();
    this.items = [...(replace ? [] : this.items), ...cleaned].filter((item) => {
      if (seen.has(item.appid)) return false;
      seen.add(item.appid);
      return true;
    });

    write(this.items);
    this.#emit('import');
    return cleaned.length;
  }

  /** Totals for the wishlist page header. */
  totals() {
    let total = 0;
    let discounted = 0;
    let free = 0;
    let currency = null;
    let priced = 0;

    for (const item of this.items) {
      if (!item.price) continue;
      if (item.price.isFree) {
        free += 1;
        continue;
      }
      if (typeof item.price.final !== 'number') continue;
      total += item.price.final;
      priced += 1;
      currency = currency || item.price.currency || 'USD';
      if (item.price.discountPercent > 0) discounted += 1;
    }

    return { total, currency: currency || 'USD', priced, discounted, free, count: this.items.length };
  }
}

export const wishlist = new Wishlist();
