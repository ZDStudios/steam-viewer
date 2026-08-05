/**
 * Browsing built on Steam's own store-search backend.
 *
 * `/api/getappsingenre` is undocumented and frequently answers with an empty
 * `tabs` object, which is why genre pages came back blank. `/search/results`
 * is the endpoint the real storefront uses for every filtered listing, so it
 * powers genres, tags, developers, publishers and sorted browsing here.
 *
 * It returns rendered HTML rather than JSON, so we pull out the appids Steam
 * stamps on each row (`data-ds-appid`) and hydrate them through the normal
 * cached `appdetails` path — no HTML ever reaches the browser.
 */
import { getAppsLite, fetchText, SteamError, STORE } from './steam.js';

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
};

/** Steam's own sort keys, exposed so the UI can offer the same choices. */
export const SORTS = {
  relevance: '_ASC',
  topsellers: '_ASC',
  released: 'Released_DESC',
  name: 'Name_ASC',
  priceLow: 'Price_ASC',
  priceHigh: 'Price_DESC',
  reviews: 'Reviews_DESC',
};

/**
 * Run a store-search query and return the appids in Steam's own ordering.
 *
 * A row can carry several ids (`data-ds-appid="620,400"`) when it is a bundle;
 * the first id is the headline product, which is the one worth linking to.
 */
export async function searchStoreIds({ filters = {}, cc = 'us', l = 'english', start = 0, count = 50 } = {}) {
  const url = `${STORE}/search/results/?${qs({
    ...filters,
    start,
    count: Math.min(Math.max(count, 1), 100),
    dynamic_data: '',
    sort_by: filters.sort_by || SORTS.topsellers,
    // 998 = "Games", which keeps soundtracks, videos and hardware out.
    category1: filters.category1 ?? 998,
    supportedlang: l,
    infinite: 1,
    json: 1,
    cc,
    l,
  })}`;

  let raw;
  try {
    raw = JSON.parse(await fetchText(url));
  } catch (error) {
    throw new SteamError(`Steam store search failed: ${error.message}`, { status: 502, retryable: true });
  }

  const html = String(raw?.results_html || '');
  const ids = [];
  const seen = new Set();

  for (const match of html.matchAll(/data-ds-appid="([\d,]+)"/g)) {
    const appid = Number(match[1].split(',')[0]);
    if (!Number.isFinite(appid) || appid <= 0 || seen.has(appid)) continue;
    seen.add(appid);
    ids.push(appid);
  }

  return { ids, total: Number(raw?.total_count) || ids.length };
}

/** Resolve a store-search query all the way to renderable cards. */
export async function browse({ filters = {}, cc = 'us', l = 'english', start = 0, count = 24 } = {}) {
  const { ids, total } = await searchStoreIds({ filters, cc, l, start, count: Math.min(count, 50) });
  if (ids.length === 0) return { items: [], total, start };

  const items = await getAppsLite({ appids: ids.slice(0, 30), cc, l });

  // getAppsLite drops apps without a store page and resolves in parallel, so
  // restore Steam's ranking before handing the list over.
  const order = new Map(ids.map((id, index) => [id, index]));
  items.sort((a, b) => (order.get(a.appid) ?? 999) - (order.get(b.appid) ?? 999));

  return { items, total, start };
}

export const GENRES = [
  'Action',
  'Adventure',
  'Casual',
  'Indie',
  'Massively Multiplayer',
  'Racing',
  'RPG',
  'Simulation',
  'Sports',
  'Strategy',
  'Free To Play',
  'Early Access',
];

/**
 * Steam's own store tag ids for the genres above.
 *
 * `?genre=Action` is not a filter the search backend enforces — it accepts the
 * parameter, ignores it, and answers with the unfiltered top sellers. That is
 * why every genre page showed the same games: the request looked successful.
 * `?tags=<id>` is the filter the storefront itself uses and the only one that
 * actually narrows the results.
 */
const TAG_IDS = {
  action: 19,
  adventure: 21,
  casual: 597,
  indie: 492,
  'massively multiplayer': 128,
  racing: 699,
  rpg: 122,
  'role-playing': 122,
  simulation: 599,
  sports: 701,
  strategy: 9,
  'free to play': 113,
  'early access': 493,
  puzzle: 1664,
  horror: 1667,
  shooter: 1774,
  platformer: 1625,
  survival: 1662,
  roguelike: 1716,
  'open world': 1695,
  multiplayer: 3859,
  'co-op': 1685,
  anime: 4085,
  'city builder': 7332,
  'visual novel': 3799,
  fighting: 1743,
  metroidvania: 1628,
  'point & click': 1698,
  sandbox: 3810,
  'turn-based': 1677,
};

const normalizeGenre = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * How the same genre can be asked for, best first.
 *
 * Each is tried until one comes back with results that genuinely belong to the
 * genre — see `looksLikeGenre` — so a filter Steam quietly drops cannot pass
 * itself off as a working page.
 */
function genreStrategies(name) {
  const key = normalizeGenre(name);
  const tag = TAG_IDS[key];
  const strategies = [];

  if (tag) strategies.push({ key: 'tag', base: { tags: tag }, verify: true });
  // Free-to-play is a price, not a genre. Steam does enforce `maxprice`, and
  // the result cannot be checked against the genres field, so it is trusted.
  if (key === 'free to play') strategies.push({ key: 'price', base: { maxprice: 'free' }, verify: false });
  strategies.push({ key: 'genre', base: { genre: name }, verify: true });
  // Last resort: a plain text search. Loose, but a page of roughly-right games
  // beats an error message.
  strategies.push({ key: 'term', base: { term: name }, verify: true });

  return strategies;
}

/**
 * Does this result set actually belong to the genre?
 *
 * Steam tags every store page with its genres, so the answer is in the data we
 * already hydrated. A filter that was ignored returns the global top sellers,
 * which overlap a requested genre by a few titles at most.
 */
function looksLikeGenre(items, name) {
  if (items.length === 0) return false;
  const wanted = normalizeGenre(name);
  const hits = items.filter((item) =>
    (item.genres || []).some((genre) => {
      const found = normalizeGenre(genre);
      return found === wanted || found.includes(wanted) || wanted.includes(found);
    }),
  ).length;
  return hits / items.length >= 0.4;
}

/** Genre landing page: a few differently-sorted rows, like Steam's own. */
export async function getGenre({ genre, cc = 'us', l = 'english' } = {}) {
  const name = String(genre || '').trim();
  if (!name) throw new SteamError('Missing genre', { status: 400 });

  const rows = [
    { key: 'topsellers', label: 'Top Sellers', sort: SORTS.topsellers },
    { key: 'newreleases', label: 'New & Trending', sort: SORTS.released },
    { key: 'toprated', label: 'Top Rated', sort: SORTS.reviews },
    { key: 'specials', label: 'Specials', sort: SORTS.topsellers, extra: { specials: 1 } },
  ];

  // Find a filter that works before spending four requests on one that does
  // not. The headline row doubles as the probe, so nothing is wasted.
  let chosen = null;
  let headline = [];
  const attempts = [];

  for (const strategy of genreStrategies(name)) {
    let items = [];
    try {
      ({ items } = await browse({ filters: { ...strategy.base, sort_by: SORTS.topsellers }, cc, l, count: 12 }));
    } catch {
      continue;
    }
    if (items.length === 0) continue;

    if (strategy.verify === false || looksLikeGenre(items, name)) {
      chosen = strategy;
      headline = items;
      break;
    }
    attempts.push({ strategy, items });
  }

  if (!chosen && attempts.length) {
    // Nothing could be verified — a genre Steam does not tag, or a tag id this
    // relay does not know. A text search is at least *about* the word that was
    // asked for, so it beats the unfiltered top sellers that an ignored filter
    // hands back. Either way the page is told the listing is unverified rather
    // than being allowed to present it as a real genre.
    const best = attempts.find((attempt) => attempt.strategy.key === 'term') || attempts[0];
    chosen = { ...best.strategy, key: 'unverified' };
    headline = best.items;
  }

  if (!chosen) throw new SteamError(`Steam returned no titles for “${name}”`, { status: 404 });

  const sections = [{ key: rows[0].key, label: rows[0].label, items: headline }];

  for (const row of rows.slice(1)) {
    try {
      const { items } = await browse({
        filters: { ...chosen.base, ...(row.extra || {}), sort_by: row.sort },
        cc,
        l,
        count: 12,
      });
      if (items.length) sections.push({ key: row.key, label: row.label, items });
    } catch {
      // One empty row should not take the whole page down.
    }
  }

  return { genre: name, matchedBy: chosen.key, sections };
}

/** Developer / publisher landing page. */
export async function getCreator({ name, role = 'developer', cc = 'us', l = 'english', start = 0 } = {}) {
  const creator = String(name || '').trim();
  if (!creator) throw new SteamError('Missing developer name', { status: 400 });
  const field = role === 'publisher' ? 'publisher' : 'developer';

  const [popular, recent] = await Promise.all([
    browse({ filters: { [field]: creator, sort_by: SORTS.topsellers }, cc, l, start, count: 24 }).catch(() => ({ items: [], total: 0 })),
    browse({ filters: { [field]: creator, sort_by: SORTS.released }, cc, l, count: 12 }).catch(() => ({ items: [] })),
  ]);

  if (popular.items.length === 0 && recent.items.length === 0) {
    throw new SteamError(`Steam has no titles listed for “${creator}”`, { status: 404 });
  }

  // Everything the creator has shipped, used for the header stat line.
  const seen = new Set();
  const catalogue = [...popular.items, ...recent.items].filter((item) => {
    if (seen.has(item.appid)) return false;
    seen.add(item.appid);
    return true;
  });

  return {
    name: creator,
    role: field,
    total: popular.total,
    catalogue,
    sections: [
      { key: 'popular', label: 'Most Popular', items: popular.items },
      { key: 'recent', label: 'Latest Releases', items: recent.items },
    ].filter((section) => section.items.length > 0),
  };
}
