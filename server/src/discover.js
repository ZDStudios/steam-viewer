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

/** Genre landing page: a few differently-sorted rows, like Steam's own. */
export async function getGenre({ genre, cc = 'us', l = 'english' } = {}) {
  const name = String(genre || '').trim();
  if (!name) throw new SteamError('Missing genre', { status: 400 });

  const base = name.toLowerCase() === 'free to play' ? { maxprice: 'free' } : { genre: name };
  const rows = [
    { key: 'topsellers', label: 'Top Sellers', filters: { ...base, sort_by: SORTS.topsellers } },
    { key: 'newreleases', label: 'New & Trending', filters: { ...base, sort_by: SORTS.released } },
    { key: 'toprated', label: 'Top Rated', filters: { ...base, sort_by: SORTS.reviews } },
    { key: 'specials', label: 'Specials', filters: { ...base, specials: 1, sort_by: SORTS.topsellers } },
  ];

  const sections = [];
  for (const row of rows) {
    try {
      const { items } = await browse({ filters: row.filters, cc, l, count: 12 });
      if (items.length) sections.push({ key: row.key, label: row.label, items });
    } catch {
      // One empty row should not take the whole page down.
    }
  }

  if (sections.length === 0) {
    throw new SteamError(`Steam returned no titles for “${name}”`, { status: 404 });
  }

  return { genre: name, sections };
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
