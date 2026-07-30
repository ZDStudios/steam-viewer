/**
 * A wishlist that lives in this browser.
 *
 * Steam's real wishlist needs a signed-in session, which a static page cannot
 * have. This stores the same idea in `localStorage`: add, ignore, reorder,
 * export. It also seeds the "Since you wishlisted…" rows on the home page, so
 * the store starts recommending things once a few titles are saved.
 */

const KEYS = {
  wishlist: 'steam-viewer:wishlist',
  ignored: 'steam-viewer:ignored',
};

const listeners = new Set();

function read(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value.slice(0, 500)));
  } catch {
    // Quota exceeded or storage disabled — the UI still works for this session.
  }
  emit();
}

function emit() {
  const snapshot = { wishlist: all(), ignored: ignoredIds() };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error('[wishlist] listener threw', error);
    }
  }
}

/** Keep multiple tabs in sync. */
window.addEventListener('storage', (event) => {
  if (event.key === KEYS.wishlist || event.key === KEYS.ignored) emit();
});

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------------ *
 * Wishlist
 * ------------------------------------------------------------------ */

export const all = () => read(KEYS.wishlist);
export const ids = () => all().map((entry) => entry.appid);
export const count = () => all().length;
export const has = (appid) => ids().includes(Number(appid));

/** Store just enough to render a card without another round trip. */
export function add(game) {
  const appid = Number(game?.appid);
  if (!Number.isFinite(appid)) return false;

  const current = all();
  if (current.some((entry) => entry.appid === appid)) return false;

  current.unshift({
    appid,
    name: game.name || `App ${appid}`,
    header: game.header || null,
    capsule: game.capsule || null,
    portrait: game.portrait || null,
    price: game.price || null,
    platforms: game.platforms || null,
    genres: game.genres || [],
    releaseDate: game.releaseDate || null,
    addedAt: Date.now(),
  });

  write(KEYS.wishlist, current);
  unignore(appid);
  return true;
}

export function remove(appid) {
  const id = Number(appid);
  const next = all().filter((entry) => entry.appid !== id);
  write(KEYS.wishlist, next);
  return true;
}

export function toggle(game) {
  if (has(game?.appid)) {
    remove(game.appid);
    return false;
  }
  add(game);
  return true;
}

export function clear() {
  write(KEYS.wishlist, []);
}

/**
 * The few appids used to seed recommendations — most recently added first,
 * since that is what the visitor is currently interested in.
 */
export const seeds = (limit = 3) => ids().slice(0, limit);

/* ------------------------------------------------------------------ *
 * Ignored ("not interested")
 * ------------------------------------------------------------------ */

export const ignoredIds = () => read(KEYS.ignored).map(Number).filter(Number.isFinite);
export const isIgnored = (appid) => ignoredIds().includes(Number(appid));

export function ignore(appid) {
  const id = Number(appid);
  if (!Number.isFinite(id)) return false;
  const current = ignoredIds();
  if (current.includes(id)) return false;
  write(KEYS.ignored, [id, ...current]);
  remove(id);
  return true;
}

export function unignore(appid) {
  const id = Number(appid);
  write(KEYS.ignored, ignoredIds().filter((entry) => entry !== id));
  return true;
}

/** Drop anything the visitor has said they are not interested in. */
export const filterIgnored = (items = []) => {
  const hidden = new Set(ignoredIds());
  return items.filter((item) => !hidden.has(Number(item?.appid)));
};

/* ------------------------------------------------------------------ *
 * Portability
 * ------------------------------------------------------------------ */

export function exportJson() {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), wishlist: all(), ignored: ignoredIds() }, null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.wishlist)) throw new Error('That file is not a Steam Viewer wishlist export.');

  const cleaned = parsed.wishlist
    .filter((entry) => Number.isFinite(Number(entry?.appid)))
    .map((entry) => ({ ...entry, appid: Number(entry.appid) }));

  write(KEYS.wishlist, cleaned);
  if (Array.isArray(parsed.ignored)) write(KEYS.ignored, parsed.ignored.map(Number).filter(Number.isFinite));
  return cleaned.length;
}
