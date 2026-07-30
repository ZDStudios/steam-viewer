/**
 * Thin, defensive client for Steam's public (key-less) endpoints, plus the
 * optional key-only Web API calls used by the Library view.
 *
 * Every response shape below is treated as untrusted: Steam silently changes
 * fields, returns `{ success: false }`, or answers with an empty body when it
 * is rate limiting. Normalising here means the browser only ever sees one
 * stable shape.
 */
import { TtlCache } from './cache.js';
import { Limiter, mapPool } from './limiter.js';

const STORE = 'https://store.steampowered.com';
const COMMUNITY = 'https://steamcommunity.com';
const WEBAPI = 'https://api.steampowered.com';
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const STEAMDB = 'https://steamdb.info';

const USER_AGENT =
  process.env.STEAM_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();
export const hasApiKey = () => STEAM_API_KEY.length > 0;

export const cache = new TtlCache({ maxEntries: 4000 });
const limiter = new Limiter({
  concurrency: Number(process.env.STEAM_CONCURRENCY || 4),
  minGapMs: Number(process.env.STEAM_MIN_GAP_MS || 80),
});

export const TTL = {
  home: 5 * 60_000,
  featured: 5 * 60_000,
  search: 10 * 60_000,
  app: 30 * 60_000,
  lite: 60 * 60_000,
  reviews: 5 * 60_000,
  players: 60_000,
  mostPlayed: 3 * 60_000,
  genre: 15 * 60_000,
  news: 15 * 60_000,
  profile: 3 * 60_000,
  browse: 15 * 60_000,
  developer: 30 * 60_000,
  users: 10 * 60_000,
  steamdb: 30 * 60_000,
  calculator: 60 * 60_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Steam hands out plain-http URLs on hosts that are either dead (the old
 * Akamai names) or CORS-hostile. Everything is normalised onto the Cloudflare
 * hosts, which are https, still served and the ones the live store uses.
 */
const HOST_REWRITES = [
  [/^steamcdn-a\.akamaihd\.net$/i, 'cdn.cloudflare.steamstatic.com'],
  [/^cdn\.akamai\.steamstatic\.com$/i, 'cdn.cloudflare.steamstatic.com'],
  [/^media\.steampowered\.com$/i, 'cdn.cloudflare.steamstatic.com'],
  [/^steamstore-a\.akamaihd\.net$/i, 'shared.cloudflare.steamstatic.com'],
  [/^steamcommunity-a\.akamaihd\.net$/i, 'community.cloudflare.steamstatic.com'],
  [/^avatars\.akamai\.steamstatic\.com$/i, 'avatars.cloudflare.steamstatic.com'],
  [/^video\.akamai\.steamstatic\.com$/i, 'video.cloudflare.steamstatic.com'],
];

export function secureUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
  } catch {
    return trimmed.replace(/^http:\/\//i, 'https://');
  }

  parsed.protocol = 'https:';
  for (const [pattern, replacement] of HOST_REWRITES) {
    if (pattern.test(parsed.hostname)) {
      parsed.hostname = replacement;
      break;
    }
  }
  // Trailers live on their own host; the generic CDN name 404s for them.
  if (/^\/store_trailers\//i.test(parsed.pathname) && /^(cdn|shared)\.cloudflare\.steamstatic\.com$/i.test(parsed.hostname)) {
    parsed.hostname = 'video.cloudflare.steamstatic.com';
  }
  return parsed.toString();
}

export class SteamError extends Error {
  constructor(message, { status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'SteamError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * GET a document from Steam through the shared limiter, retrying on the
 * transient failures Steam is fond of (429, 5xx, empty body).
 */
async function fetchText(url, { timeoutMs = 12_000, retries = 2, headers = {}, accept = 'application/json, text/javascript, */*; q=0.01', allowEmpty = false } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await limiter.run(async () => {
        const response = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: accept,
            'Accept-Language': 'en-US,en;q=0.9',
            // Steam localises (and sometimes age-gates) by cookie.
            Cookie: 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1',
            ...headers,
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 429) {
          throw new SteamError('Steam is rate limiting this server', { status: 429, retryable: true });
        }
        if (response.status >= 500) {
          throw new SteamError(`Steam responded ${response.status}`, { status: 502, retryable: true });
        }
        if (!response.ok) {
          throw new SteamError(`Steam responded ${response.status}`, { status: response.status });
        }

        const text = await response.text();
        if (!allowEmpty && !text.trim()) {
          throw new SteamError('Steam returned an empty body', { status: 502, retryable: true });
        }
        return text;
      });
    } catch (error) {
      lastError = error instanceof SteamError ? error : new SteamError(error.message || 'Request failed', { retryable: true });
      const isLast = attempt === retries;
      if (isLast || !lastError.retryable) break;
      await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }

  throw lastError;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new SteamError('Steam returned a non-JSON body', { status: 502, retryable: true });
  }
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
};

/* ------------------------------------------------------------------ *
 * Normalisers — one card shape for the whole UI
 * ------------------------------------------------------------------ */

export const images = (appid) => ({
  header: `${CDN}/${appid}/header.jpg`,
  capsule: `${CDN}/${appid}/capsule_616x353.jpg`,
  portrait: `${CDN}/${appid}/library_600x900.jpg`,
  hero: `${CDN}/${appid}/library_hero.jpg`,
  logo: `${CDN}/${appid}/logo.png`,
});

/**
 * Steam quotes money in minor units (cents) for every currency, including the
 * zero-decimal ones — dividing by 100 and letting Intl pick the precision is
 * correct across the board.
 */
function normalizePrice({ isFree = false, currency = null, initial = null, final = null, discountPercent = 0, finalFormatted = null, initialFormatted = null } = {}) {
  if (isFree) return { isFree: true, currency, discountPercent: 0 };
  if (final === null || final === undefined) return null;
  return {
    isFree: false,
    currency: currency || 'USD',
    initial: initial ?? final,
    final,
    discountPercent: discountPercent || 0,
    initialFormatted,
    finalFormatted,
  };
}

/** Cards coming out of `featuredcategories` / `featured`. */
export function normalizeStoreItem(item) {
  if (!item || item.id === undefined || item.id === null) return null;
  const appid = Number(item.id);
  if (!Number.isFinite(appid)) return null;

  return {
    appid,
    name: item.name || `App ${appid}`,
    type: item.type === 0 || item.type === undefined ? 'game' : String(item.type),
    header: secureUrl(item.header_image || item.large_capsule_image || item.small_capsule_image) || images(appid).header,
    capsule: secureUrl(item.large_capsule_image) || images(appid).capsule,
    portrait: images(appid).portrait,
    price: normalizePrice({
      isFree: item.final_price === 0 && !item.discounted,
      currency: item.currency,
      initial: item.original_price ?? item.final_price,
      final: item.final_price,
      discountPercent: item.discount_percent || 0,
    }),
    platforms: {
      windows: Boolean(item.windows_available),
      mac: Boolean(item.mac_available),
      linux: Boolean(item.linux_available),
    },
    discounted: Boolean(item.discounted),
    controllerSupport: item.controller_support || null,
  };
}

/** Cards coming out of `storesearch`. */
export function normalizeSearchItem(item) {
  if (!item || !item.id) return null;
  const appid = Number(item.id);
  if (!Number.isFinite(appid)) return null;

  const price = item.price
    ? normalizePrice({
        currency: item.price.currency,
        initial: item.price.initial,
        final: item.price.final,
        discountPercent: item.price.discount_percent || 0,
      })
    : normalizePrice({ isFree: true });

  return {
    appid,
    name: item.name || `App ${appid}`,
    type: item.type || 'app',
    header: secureUrl(item.tiny_image) || images(appid).header,
    capsule: images(appid).capsule,
    portrait: images(appid).portrait,
    price,
    metacritic: item.metascore ? Number(String(item.metascore).replace(/\D/g, '')) || null : null,
    platforms: {
      windows: Boolean(item.platforms?.windows),
      mac: Boolean(item.platforms?.mac),
      linux: Boolean(item.platforms?.linux),
    },
    hasVideo: Boolean(item.streamingvideo),
    controllerSupport: item.controller_support || null,
  };
}

/** The compact projection of a full `appdetails` payload used by grids/rails. */
export function toLite(data) {
  if (!data) return null;
  const appid = Number(data.steam_appid);
  if (!Number.isFinite(appid)) return null;

  return {
    appid,
    name: data.name || `App ${appid}`,
    type: data.type || 'game',
    header: secureUrl(data.header_image) || images(appid).header,
    capsule: secureUrl(data.capsule_image) || images(appid).capsule,
    portrait: images(appid).portrait,
    shortDescription: data.short_description || '',
    price: data.is_free
      ? normalizePrice({ isFree: true })
      : normalizePrice({
          currency: data.price_overview?.currency,
          initial: data.price_overview?.initial,
          final: data.price_overview?.final,
          discountPercent: data.price_overview?.discount_percent || 0,
          initialFormatted: data.price_overview?.initial_formatted || null,
          finalFormatted: data.price_overview?.final_formatted || null,
        }),
    platforms: {
      windows: Boolean(data.platforms?.windows),
      mac: Boolean(data.platforms?.mac),
      linux: Boolean(data.platforms?.linux),
    },
    genres: (data.genres || []).map((g) => g.description).filter(Boolean),
    categories: (data.categories || []).map((c) => c.description).filter(Boolean),
    developers: data.developers || [],
    publishers: data.publishers || [],
    releaseDate: data.release_date?.date || null,
    comingSoon: Boolean(data.release_date?.coming_soon),
    metacritic: data.metacritic?.score ?? null,
    recommendations: data.recommendations?.total ?? null,
    hasVideo: Array.isArray(data.movies) && data.movies.length > 0,
    // Small, cheap rendition used for the hover preview on a card.
    preview: previewClip(data.movies?.[0]),
  };
}

/** The lightest trailer rendition, for silent hover previews on cards. */
function previewClip(movie) {
  if (!movie) return null;
  const src = secureUrl(movie.webm?.['480'] || movie.mp4?.['480'] || movie.webm?.max || movie.mp4?.max);
  if (!src) return null;
  return { src, type: /\.webm/i.test(src) ? 'video/webm' : 'video/mp4', poster: secureUrl(movie.thumbnail) };
}

/** The full game page payload. */
export function toFull(data) {
  const lite = toLite(data);
  if (!lite) return null;

  return {
    ...lite,
    requiredAge: Number(data.required_age) || 0,
    isFree: Boolean(data.is_free),
    website: secureUrl(data.website),
    detailedDescription: data.detailed_description || '',
    aboutTheGame: data.about_the_game || '',
    supportedLanguages: data.supported_languages || '',
    background: secureUrl(data.background_raw || data.background),
    legalNotice: data.legal_notice || '',
    dlc: Array.isArray(data.dlc) ? data.dlc.slice(0, 40).map(Number).filter(Number.isFinite) : [],
    metacriticUrl: secureUrl(data.metacritic?.url) || null,
    requirements: {
      windows: cleanRequirements(data.pc_requirements),
      mac: cleanRequirements(data.mac_requirements),
      linux: cleanRequirements(data.linux_requirements),
    },
    achievements: {
      total: data.achievements?.total || 0,
      highlighted: (data.achievements?.highlighted || []).slice(0, 12).map((a) => ({
        name: a.name,
        icon: secureUrl(a.path),
      })),
    },
    screenshots: (data.screenshots || []).map((shot) => ({
      id: shot.id,
      thumb: secureUrl(shot.path_thumbnail),
      full: secureUrl(shot.path_full),
    })),
    movies: (data.movies || []).map(normalizeMovie).filter(Boolean),
    supportInfo: {
      url: secureUrl(data.support_info?.url),
      email: data.support_info?.email || null,
    },
    contentDescriptors: data.content_descriptors?.notes || null,
    storeUrl: `${STORE}/app/${lite.appid}/`,
  };
}

/**
 * A trailer entry, as a ladder rather than a single URL.
 *
 * Which encodings actually exist varies by how old the trailer is: pre-2015
 * entries frequently have no `max` rendition at all, and a fair number of the
 * mp4s 404 while the webm beside them plays. Handing the browser every
 * candidate — best first — lets it fall down the list on `error` instead of
 * showing a dead player, which is why trailers looked broken before.
 */
function normalizeMovie(movie) {
  if (!movie) return null;

  const sources = [];
  const push = (url, type, quality) => {
    const src = secureUrl(url);
    if (src && !sources.some((entry) => entry.src === src)) sources.push({ src, type, quality });
  };

  push(movie.webm?.max, 'video/webm', 'max');
  push(movie.mp4?.max, 'video/mp4', 'max');
  push(movie.webm?.['480'], 'video/webm', '480');
  push(movie.mp4?.['480'], 'video/mp4', '480');

  if (sources.length === 0) return null;

  return {
    id: movie.id,
    name: movie.name || 'Trailer',
    thumb: secureUrl(movie.thumbnail),
    highlight: Boolean(movie.highlight),
    sources,
    // Kept for older clients / anything that just wants one URL.
    mp4: sources.find((entry) => entry.type === 'video/mp4')?.src || null,
    webm: sources.find((entry) => entry.type === 'video/webm')?.src || null,
  };
}

/** `pc_requirements` is `{minimum, recommended}` — or `[]` when unsupported. */
function cleanRequirements(requirements) {
  if (!requirements || Array.isArray(requirements)) return null;
  const minimum = requirements.minimum || null;
  const recommended = requirements.recommended || null;
  if (!minimum && !recommended) return null;
  return { minimum, recommended };
}

/* ------------------------------------------------------------------ *
 * De-duplication
 *
 * Steam's own front page happily ships the same title several times — a
 * large capsule *and* a "featured win" entry for the same racing game, a
 * hardware ad in two different sizes — because each of those is a separate
 * editorial slot. Merged into one list they just read as duplicates, so the
 * relay collapses them before the browser ever sees them.
 * ------------------------------------------------------------------ */

/** "Forza Horizon 5: Premium Edition (2024)" → "forza horizon 5" */
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/[™®©]/g, ' ')
    .replace(/\b(?:the\s+)?(?:goty|game of the year|complete|definitive|deluxe|ultimate|premium|gold|standard|enhanced|remastered|legendary|anniversary)\b/g, ' ')
    .replace(/\b(?:edition|bundle|pack|collection)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Hardware and store promos are not games and should not sit in a game grid. */
const HARDWARE_NAME = /^\s*(?:valve\s+)?steam\s*(?:machine|deck|link|controller|frame|vr|index|os|hardware|box)\b/i;
const HARDWARE_TYPES = new Set(['hardware', 'advertising', 'mod', 'series', 'video']);

export function isHardwareOrAd(item) {
  if (!item) return true;
  if (HARDWARE_TYPES.has(String(item.type || '').toLowerCase())) return true;
  return HARDWARE_NAME.test(item.name || '');
}

/**
 * Collapse a list to one card per title.
 *
 * @param {Array} items
 * @param {{seen?:Set<string>, dropHardware?:boolean}} options `seen` is shared
 *   across calls so a title kept in an earlier section is dropped from later
 *   ones; the richer of two duplicates (one that carries a price/blurb) wins.
 */
export function dedupeItems(items = [], { seen = new Set(), dropHardware = true } = {}) {
  const out = [];
  const positions = new Map();

  for (const item of items) {
    if (!item || !Number.isFinite(Number(item.appid))) continue;
    if (dropHardware && isHardwareOrAd(item)) continue;

    const byId = `id:${item.appid}`;
    const byName = nameKey(item.name) ? `name:${nameKey(item.name)}` : null;

    // Already kept by an earlier section — drop it entirely.
    if (seen.has(byId) || (byName && seen.has(byName))) {
      const at = positions.get(byId) ?? (byName ? positions.get(byName) : undefined);
      if (at !== undefined) out[at] = richer(out[at], item);
      continue;
    }

    positions.set(byId, out.length);
    if (byName) positions.set(byName, out.length);
    seen.add(byId);
    if (byName) seen.add(byName);
    out.push(item);
  }

  return out;
}

/** Prefer the copy that actually carries data the UI can render. */
function richer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const score = (item) =>
    (item.price ? 2 : 0) + (item.shortDescription ? 2 : 0) + (item.genres?.length ? 1 : 0) + (item.header ? 1 : 0);
  return score(b) > score(a) ? { ...b, ...stripEmpty(a) } : { ...a, ...stripEmpty(b) };
}

function stripEmpty(item) {
  const out = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Store endpoints
 * ------------------------------------------------------------------ */

export async function getFeaturedCategories({ cc = 'us', l = 'english' } = {}) {
  const raw = await fetchJson(`${STORE}/api/featuredcategories/?${qs({ cc, l })}`);
  const pick = (key) => dedupeItems((raw?.[key]?.items || []).map(normalizeStoreItem).filter(Boolean));

  return {
    specials: pick('specials'),
    topSellers: pick('top_sellers'),
    newReleases: pick('new_releases'),
    comingSoon: pick('coming_soon'),
  };
}

export async function getFeatured({ cc = 'us', l = 'english' } = {}) {
  const raw = await fetchJson(`${STORE}/api/featured/?${qs({ cc, l })}`);
  const capsules = (raw?.large_capsules || []).map(normalizeStoreItem).filter(Boolean);
  const windows = (raw?.featured_win || []).map(normalizeStoreItem).filter(Boolean);

  // `large_capsules` and `featured_win` overlap heavily, and both carry the
  // hardware promos — one merged, de-duplicated, games-only list instead.
  return dedupeItems([...capsules, ...windows]);
}

/* ------------------------------------------------------------------ *
 * Store search (the endpoint the live store itself uses)
 *
 * `getappsingenre` — what the genre pages used to call — has been dead for
 * years and answers with an empty document, which is why every genre page
 * came up blank. The search backend behind store.steampowered.com/search is
 * still very much alive; it answers with a JSON envelope wrapping a chunk of
 * rendered HTML, and each result carries its appid in `data-ds-appid`.
 * ------------------------------------------------------------------ */

const SEARCH_FILTERS = new Set(['topsellers', 'popularnew', 'comingsoon', 'globaltopsellers', 'popularcomingsoon']);

/**
 * @returns {Promise<number[]>} appids, in the order Steam ranked them.
 */
export async function searchAppIds({
  cc = 'us',
  l = 'english',
  term = '',
  genre = null,
  tags = null,
  developer = null,
  publisher = null,
  filter = null,
  specials = false,
  maxprice = null,
  category1 = null,
  count = 50,
  start = 0,
} = {}) {
  const url = `${STORE}/search/results/?${qs({
    query: '',
    term: term || undefined,
    genre: genre || undefined,
    tags: tags || undefined,
    developer: developer || undefined,
    publisher: publisher || undefined,
    filter: filter && SEARCH_FILTERS.has(filter) ? filter : undefined,
    specials: specials ? 1 : undefined,
    maxprice: maxprice || undefined,
    category1: category1 || undefined,
    cc,
    l,
    start: Math.max(0, Number(start) || 0),
    count: Math.min(Math.max(Number(count) || 50, 1), 100),
    infinite: 1,
    json: 1,
    ignore_preferences: 1,
  })}`;

  let raw;
  try {
    raw = await fetchJson(url);
  } catch {
    return [];
  }

  const html = typeof raw?.results_html === 'string' ? raw.results_html : '';
  const ids = [];
  const seen = new Set();

  for (const match of html.matchAll(/data-ds-appid="([\d,]+)"/g)) {
    // Bundles list every member app; the first one is the headline title.
    const id = Number(String(match[1]).split(',')[0]);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/** Search → appids → full cards, de-duplicated. */
export async function searchStore(options = {}) {
  const { cc = 'us', l = 'english', limit = 24 } = options;
  const ids = await searchAppIds({ ...options, count: Math.min(Math.max(limit * 2, 20), 100) });
  if (ids.length === 0) return [];

  const cards = await getAppsLite({ appids: ids.slice(0, 30), cc, l });
  const order = new Map(ids.map((id, index) => [id, index]));
  return dedupeItems(cards.sort((a, b) => (order.get(a.appid) ?? 999) - (order.get(b.appid) ?? 999))).slice(0, limit);
}

export async function search({ term, cc = 'us', l = 'english', limit = 40 } = {}) {
  const query = String(term || '').trim();
  if (!query) return { total: 0, items: [] };

  const raw = await fetchJson(`${STORE}/api/storesearch/?${qs({ term: query, cc, l })}`);
  const items = (raw?.items || []).map(normalizeSearchItem).filter(Boolean).slice(0, limit);
  return { total: raw?.total ?? items.length, items, term: query };
}

export async function getAppDetails({ appid, cc = 'us', l = 'english' } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) throw new SteamError('Invalid appid', { status: 400 });

  const raw = await fetchJson(`${STORE}/api/appdetails?${qs({ appids: id, cc, l })}`);
  const entry = raw?.[String(id)];
  if (!entry || entry.success !== true || !entry.data) {
    throw new SteamError(`Steam has no store page for app ${id}`, { status: 404 });
  }
  return entry.data;
}

/** Resolve a batch of appids into lite cards, cached individually. */
export async function getAppsLite({ appids = [], cc = 'us', l = 'english' } = {}) {
  const ids = [...new Set(appids.map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 30);

  const resolved = await mapPool(ids, 3, async (id) => {
    const { value } = await cache.wrap(`lite:${id}:${cc}:${l}`, TTL.lite, async () => {
      try {
        return toLite(await getAppDetails({ appid: id, cc, l }));
      } catch {
        return null;
      }
    });
    return value;
  });

  return resolved.filter(Boolean);
}

export async function getReviews({ appid, filter = 'all', language = 'all', reviewType = 'all', purchaseType = 'all', cursor = '*', numPerPage = 20 } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) throw new SteamError('Invalid appid', { status: 400 });

  const url = `${STORE}/appreviews/${id}?${qs({
    json: 1,
    filter,
    language,
    review_type: reviewType,
    purchase_type: purchaseType,
    num_per_page: Math.min(Math.max(Number(numPerPage) || 20, 1), 100),
    cursor,
  })}`;

  const raw = await fetchJson(url);
  if (!raw || raw.success !== 1) throw new SteamError('Steam returned no reviews', { status: 502, retryable: true });

  const summary = raw.query_summary || {};
  return {
    appid: id,
    cursor: raw.cursor || null,
    summary: {
      reviewScore: summary.review_score ?? null,
      reviewScoreDesc: summary.review_score_desc || null,
      totalPositive: summary.total_positive ?? null,
      totalNegative: summary.total_negative ?? null,
      totalReviews: summary.total_reviews ?? null,
    },
    reviews: (raw.reviews || []).map((review) => ({
      id: review.recommendationid,
      votedUp: Boolean(review.voted_up),
      text: review.review || '',
      created: review.timestamp_created || null,
      updated: review.timestamp_updated || null,
      votesUp: review.votes_up || 0,
      votesFunny: review.votes_funny || 0,
      commentCount: review.comment_count || 0,
      earlyAccess: Boolean(review.written_during_early_access),
      steamPurchase: Boolean(review.steam_purchase),
      receivedForFree: Boolean(review.received_for_free),
      author: {
        steamid: review.author?.steamid || null,
        gamesOwned: review.author?.num_games_owned ?? null,
        reviewsWritten: review.author?.num_reviews ?? null,
        playtimeForever: review.author?.playtime_forever ?? 0,
        playtimeAtReview: review.author?.playtime_at_review ?? 0,
      },
    })),
  };
}

export async function getPlayerCount({ appid } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) throw new SteamError('Invalid appid', { status: 400 });

  const raw = await fetchJson(`${WEBAPI}/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?${qs({ appid: id })}`);
  const count = raw?.response?.result === 1 ? raw.response.player_count : null;
  return { appid: id, players: typeof count === 'number' ? count : null, at: Date.now() };
}

export async function getMostPlayed({ cc = 'us', l = 'english', limit = 12 } = {}) {
  const raw = await fetchJson(`${WEBAPI}/ISteamChartsService/GetMostPlayedGames/v1/`);
  const ranks = (raw?.response?.ranks || []).slice(0, Math.min(limit, 25));
  if (ranks.length === 0) return [];

  const lite = await getAppsLite({ appids: ranks.map((r) => r.appid), cc, l });
  const byId = new Map(lite.map((item) => [item.appid, item]));

  return ranks
    .map((rank) => {
      const card = byId.get(Number(rank.appid));
      if (!card) return null;
      return {
        ...card,
        rank: rank.rank,
        concurrent: rank.concurrent_in_game ?? null,
        peak: rank.peak_in_game ?? null,
      };
    })
    .filter(Boolean);
}

export async function getNews({ appid, count = 8 } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) throw new SteamError('Invalid appid', { status: 400 });

  const raw = await fetchJson(
    `${WEBAPI}/ISteamNews/GetNewsForApp/v2/?${qs({ appid: id, count: Math.min(Number(count) || 8, 20), maxlength: 900, format: 'json' })}`,
  );

  return (raw?.appnews?.newsitems || []).map((item) => ({
    id: item.gid,
    title: item.title,
    url: secureUrl(item.url),
    author: item.author || null,
    contents: item.contents || '',
    feedLabel: item.feedlabel || null,
    date: item.date || null,
    appid: item.appid || id,
  }));
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
  'Free to Play',
  'Early Access',
];

/** Steam's own genre spelling, so `?genre=` matches whatever the user clicked. */
const GENRE_ALIASES = new Map([
  ['rpg', 'RPG'],
  ['role playing', 'RPG'],
  ['role-playing', 'RPG'],
  ['mmo', 'Massively Multiplayer'],
  ['massively multiplayer', 'Massively Multiplayer'],
  ['f2p', 'Free to Play'],
  ['free to play', 'Free to Play'],
  ['free-to-play', 'Free to Play'],
  ['early access', 'Early Access'],
]);

export function canonicalGenre(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const alias = GENRE_ALIASES.get(raw.toLowerCase());
  if (alias) return alias;
  const known = GENRES.find((genre) => genre.toLowerCase() === raw.toLowerCase());
  return known || raw;
}

export async function getGenre({ genre, cc = 'us', l = 'english' } = {}) {
  const name = canonicalGenre(genre);
  if (!name) throw new SteamError('Missing genre', { status: 400 });

  const wanted = [
    { key: 'topsellers', label: 'Top Sellers', query: { filter: 'topsellers' } },
    { key: 'newreleases', label: 'New & Trending', query: { filter: 'popularnew' } },
    { key: 'specials', label: 'Specials', query: { specials: true } },
    { key: 'comingsoon', label: 'Coming Soon', query: { filter: 'comingsoon' } },
  ];

  const seen = new Set();
  const sections = [];

  // Sequential on purpose: four parallel searches plus their appdetails
  // lookups is exactly the burst that gets the relay's IP rate limited.
  for (const tab of wanted) {
    const items = await searchStore({ genre: name, cc, l, limit: 12, ...tab.query }).catch(() => []);
    const fresh = dedupeItems(items, { seen });
    if (fresh.length) sections.push({ key: tab.key, label: tab.label, items: fresh });
  }

  // Last resort — a plain term search still beats an empty page.
  if (sections.length === 0) {
    const fallback = await search({ term: name, cc, l, limit: 24 });
    if (fallback.items.length) sections.push({ key: 'search', label: `Matching “${name}”`, items: dedupeItems(fallback.items) });
  }

  return { genre: name, sections };
}

/**
 * A developer or publisher page: everything Steam lists under that studio.
 *
 * The search backend accepts `developer=`/`publisher=` but is picky about the
 * exact string, so a name that returns nothing falls back to a term search
 * filtered against the credits on each app.
 */
export async function getStudio({ name, role = 'developer', cc = 'us', l = 'english' } = {}) {
  const studio = String(name || '').trim();
  if (!studio) throw new SteamError('Missing developer name', { status: 400 });
  const field = role === 'publisher' ? 'publisher' : 'developer';

  let items = await searchStore({ [field]: studio, cc, l, limit: 30, filter: 'topsellers' }).catch(() => []);
  let matched = true;

  if (items.length === 0) {
    matched = false;
    const loose = await search({ term: studio, cc, l, limit: 30 }).catch(() => ({ items: [] }));
    const detailed = await getAppsLite({ appids: loose.items.map((item) => item.appid).slice(0, 24), cc, l }).catch(() => []);
    const needle = studio.toLowerCase();
    const credited = detailed.filter((item) =>
      [...(item.developers || []), ...(item.publishers || [])].some((credit) => credit.toLowerCase().includes(needle)),
    );
    items = dedupeItems(credited.length ? credited : detailed);
  }

  const games = dedupeItems(items);
  const byPopularity = [...games].sort((a, b) => (b.recommendations || 0) - (a.recommendations || 0));

  return {
    name: studio,
    role: field,
    exact: matched,
    count: games.length,
    games,
    highlights: byPopularity.slice(0, 5),
    // Every credit that appears on the returned games, so the page can offer
    // "also published by…" style links.
    related: [
      ...new Set(
        games
          .flatMap((item) => (field === 'developer' ? item.publishers || [] : item.developers || []))
          .filter((credit) => credit && credit.toLowerCase() !== studio.toLowerCase()),
      ),
    ].slice(0, 12),
    storeUrl: `${STORE}/search/?${qs({ [field]: studio })}`,
  };
}

/* ------------------------------------------------------------------ *
 * Community endpoints — profiles and libraries without an API key
 *
 * Every steamcommunity.com profile page answers with a machine-readable XML
 * document when asked with `?xml=1`, and `/games?tab=all&xml=1` lists the
 * whole owned library with playtimes. Neither needs a key, a login or a
 * session — they are the same documents Steam has served since 2010 — so the
 * Library and profile views work for anonymous visitors. When the operator
 * *has* set STEAM_API_KEY the Web API is used instead, because it also
 * carries the Steam level and the two-week recents.
 * ------------------------------------------------------------------ */

const STEAMID64 = /^\d{17}$/;
/** SteamID64 = this + the 32-bit account id shown as `data-miniprofile`. */
const STEAMID64_BASE = 76561197960265728n;

/** Minimal XML field reader — these documents are flat and CDATA-wrapped. */
function xmlField(xml, tag) {
  const match = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i').exec(xml || '');
  return match ? match[1].trim() : null;
}

function xmlBlocks(xml, tag) {
  return [...String(xml || '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))].map((match) => match[1]);
}

const decodeEntities = (value) =>
  String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');

/** Accept a SteamID64, a vanity name, or any flavour of profile URL. */
export function parseProfileInput(input) {
  let candidate = String(input || '').trim();
  if (!candidate) throw new SteamError('Missing Steam profile', { status: 400 });

  // …including the URL the community user-search page produces, whose target
  // sits in the fragment: /search/users/#text=zdstudio12345
  const hashText = candidate.match(/[#?&]text=([^&#\s]+)/i);
  if (hashText) candidate = decodeURIComponent(hashText[1]);

  const urlMatch = candidate.match(/steamcommunity\.com\/(profiles|id)\/([^/?#]+)/i);
  if (urlMatch) {
    return urlMatch[1].toLowerCase() === 'profiles'
      ? { kind: 'steamid', value: decodeURIComponent(urlMatch[2]) }
      : { kind: 'vanity', value: decodeURIComponent(urlMatch[2]) };
  }

  candidate = candidate.replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  if (STEAMID64.test(candidate)) return { kind: 'steamid', value: candidate };
  return { kind: 'vanity', value: candidate };
}

/** Resolve to a SteamID64 without an API key, via the community XML document. */
export async function resolveSteamIdKeyless(input) {
  const { kind, value } = parseProfileInput(input);
  if (kind === 'steamid' && STEAMID64.test(value)) return value;

  const xml = await fetchText(`${COMMUNITY}/id/${encodeURIComponent(value)}/?xml=1`, {
    accept: 'text/xml,application/xml,text/html;q=0.9',
  }).catch(() => '');

  const steamid = xmlField(xml, 'steamID64');
  if (steamid && STEAMID64.test(steamid)) return steamid;

  // Not a vanity URL — try the community search, which also matches on the
  // display name people actually know each other by.
  const [first] = await searchUsers({ text: value, limit: 1 }).catch(() => []);
  if (first?.steamid) return first.steamid;

  throw new SteamError(`No Steam profile matches “${value}”`, { status: 404 });
}

/** The profile summary, straight off the community XML document. */
async function getCommunityProfile(steamid) {
  const xml = await fetchText(`${COMMUNITY}/profiles/${steamid}/?xml=1`, {
    accept: 'text/xml,application/xml,text/html;q=0.9',
  });

  if (/<privacyState>/i.test(xml) && /private/i.test(xmlField(xml, 'privacyState') || '')) {
    return { private: true, name: decodeEntities(xmlField(xml, 'steamID')) };
  }

  const state = (xmlField(xml, 'onlineState') || '').toLowerCase();
  return {
    private: false,
    name: decodeEntities(xmlField(xml, 'steamID')) || null,
    realName: decodeEntities(xmlField(xml, 'realname')) || null,
    avatar: secureUrl(xmlField(xml, 'avatarFull') || xmlField(xml, 'avatarMedium')),
    profileUrl: `${COMMUNITY}/profiles/${steamid}`,
    customUrl: xmlField(xml, 'customURL') || null,
    memberSince: xmlField(xml, 'memberSince') || null,
    location: decodeEntities(xmlField(xml, 'location')) || null,
    summary: decodeEntities(xmlField(xml, 'summary')) || null,
    online: state === 'online' || state === 'in-game',
    inGame: state === 'in-game',
    stateMessage: decodeEntities(xmlField(xml, 'stateMessage')) || null,
    playingName: decodeEntities(xmlField(xml, 'inGameInfo')) || null,
    vacBanned: xmlField(xml, 'vacBanned') === '1',
  };
}

/** The owned library, straight off `/games?tab=all&xml=1`. */
async function getCommunityGames(steamid) {
  const xml = await fetchText(`${COMMUNITY}/profiles/${steamid}/games?tab=all&xml=1`, {
    accept: 'text/xml,application/xml,text/html;q=0.9',
  }).catch(() => '');

  const games = [];
  for (const block of xmlBlocks(xml, 'game')) {
    const appid = Number(xmlField(block, 'appID'));
    if (!Number.isFinite(appid) || appid <= 0) continue;

    const hours = Number(String(xmlField(block, 'hoursOnRecord') || '0').replace(/,/g, '')) || 0;
    const recent = Number(String(xmlField(block, 'hoursLast2Weeks') || '0').replace(/,/g, '')) || 0;

    games.push({
      appid,
      name: decodeEntities(xmlField(block, 'name')) || `App ${appid}`,
      header: images(appid).header,
      portrait: images(appid).portrait,
      capsule: images(appid).capsule,
      playtimeForever: Math.round(hours * 60),
      playtime2Weeks: Math.round(recent * 60),
      lastPlayed: null,
    });
  }

  return games.sort((a, b) => b.playtimeForever - a.playtimeForever);
}

/**
 * Search Steam's community for people by name — the same index behind
 * steamcommunity.com/search/users/#text=… , which is why that URL shape is
 * accepted verbatim in the lookup box.
 *
 * The AJAX endpoint wants a `sessionid` that matches its cookie, but does not
 * care what it is for an anonymous search, so one is minted per call.
 */
export async function searchUsers({ text, page = 1, limit = 20 } = {}) {
  const term = String(text || '').trim();
  if (!term) return [];

  const sessionid = Array.from({ length: 24 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const url = `${COMMUNITY}/search/SearchCommunityAjax?${qs({
    text: term,
    filter: 'users',
    sessionid,
    steamid_user: false,
    page: Math.max(1, Number(page) || 1),
  })}`;

  const raw = await fetchJson(url, {
    headers: {
      Cookie: `sessionid=${sessionid}; birthtime=283993201; wants_mature_content=1; Steam_Language=english`,
      Referer: `${COMMUNITY}/search/users/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  }).catch(() => null);

  const html = typeof raw?.html === 'string' ? raw.html : '';
  const results = [];

  for (const row of html.split(/<div\s+class="search_row[^"]*"/i).slice(1)) {
    const account = Number(/data-miniprofile="(\d+)"/i.exec(row)?.[1] || 0);
    const href = /href="(https?:\/\/steamcommunity\.com\/(?:id|profiles)\/[^"?#]+)/i.exec(row)?.[1] || null;
    const name = decodeEntities(/class="searchPersonaName"[^>]*>([\s\S]*?)<\/a>/i.exec(row)?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const avatar = secureUrl(/<img[^>]+src="([^"]+)"/i.exec(row)?.[1] || '');

    if (!account && !href) continue;

    const steamid = account ? String(STEAMID64_BASE + BigInt(account)) : href?.match(/\/profiles\/(\d{17})/)?.[1] || null;
    if (!steamid && !href) continue;

    results.push({
      steamid,
      name: name || 'Steam user',
      avatar,
      profileUrl: href,
      vanity: href?.match(/\/id\/([^/?#]+)/)?.[1] || null,
      location: decodeEntities(/class="search_match_info"[\s\S]*?<div>([\s\S]*?)<\/div>/i.exec(row)?.[1] || '')
        .replace(/<[^>]+>/g, '')
        .trim() || null,
    });

    if (results.length >= limit) break;
  }

  // A bare vanity name that the index does not surface still resolves
  // directly, so a lookup for an exact profile never comes back empty.
  if (results.length === 0 && /^[\w.-]{2,32}$/.test(term)) {
    const xml = await fetchText(`${COMMUNITY}/id/${encodeURIComponent(term)}/?xml=1`, {
      accept: 'text/xml,application/xml,text/html;q=0.9',
    }).catch(() => '');
    const steamid = xmlField(xml, 'steamID64');
    if (steamid && STEAMID64.test(steamid)) {
      results.push({
        steamid,
        name: decodeEntities(xmlField(xml, 'steamID')) || term,
        avatar: secureUrl(xmlField(xml, 'avatarMedium') || xmlField(xml, 'avatarFull')),
        profileUrl: `${COMMUNITY}/id/${encodeURIComponent(term)}`,
        vanity: term,
        location: decodeEntities(xmlField(xml, 'location')) || null,
      });
    }
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * SteamDB
 *
 * SteamDB sits behind Cloudflare and does not publish an API, so nothing
 * here is guaranteed: the fetch is attempted with a short timeout and, when
 * it is refused (which is the normal case from a datacentre IP), the same
 * figures are derived from Steam's own key-less endpoints instead and the
 * payload says so. Deep links to the real pages are always returned.
 * ------------------------------------------------------------------ */

export const steamdbLinks = (appid) => ({
  app: `${STEAMDB}/app/${appid}/`,
  charts: `${STEAMDB}/app/${appid}/charts/`,
  depots: `${STEAMDB}/app/${appid}/depots/`,
  patchnotes: `${STEAMDB}/app/${appid}/patchnotes/`,
  history: `${STEAMDB}/app/${appid}/price/`,
});

const STEAMDB_HEADERS = {
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${STEAMDB}/`,
};

async function trySteamDb(path) {
  try {
    return await fetchText(`${STEAMDB}${path}`, {
      timeoutMs: 6000,
      retries: 0,
      accept: 'text/html,application/xhtml+xml',
      headers: STEAMDB_HEADERS,
    });
  } catch {
    return null;
  }
}

const numberFrom = (value) => {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};

/** Concurrent-player stats for one app: SteamDB if it answers, Steam if not. */
export async function getSteamDbApp({ appid, cc = 'us' } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) throw new SteamError('Invalid appid', { status: 400 });

  const links = steamdbLinks(id);
  const html = await trySteamDb(`/app/${id}/charts/`);

  if (html && /class="app-chart-numbers"|id="chart-app-online"/i.test(html)) {
    const cells = [...html.matchAll(/<li[^>]*>\s*<strong[^>]*>([\d,\s]+)<\/strong>\s*<span[^>]*>([^<]+)<\/span>/gi)];
    const pick = (label) => numberFrom(cells.find(([, , text]) => new RegExp(label, 'i').test(text))?.[1]);
    return {
      appid: id,
      available: true,
      source: 'steamdb',
      current: pick('now|current'),
      peak24h: pick('24-hour|24 hour'),
      peakAllTime: pick('all-time|all time'),
      followers: null,
      links,
      cc,
    };
  }

  // Fallback: Steam's own charts service is key-less and gives the two
  // numbers people actually look SteamDB up for.
  const [live, chart] = await Promise.all([
    getPlayerCount({ appid: id }).catch(() => ({ players: null })),
    fetchJson(`${WEBAPI}/ISteamChartsService/GetGamesByConcurrentPlayers/v1/`).catch(() => null),
  ]);

  const entry = (chart?.response?.ranks || []).find((rank) => Number(rank.appid) === id) || null;

  return {
    appid: id,
    available: false,
    source: 'steam',
    note: 'SteamDB did not answer this server, so these come from Steam’s own charts service.',
    current: live.players ?? null,
    peak24h: entry?.peak_in_game ?? null,
    peakAllTime: null,
    rank: entry?.rank ?? null,
    links,
    cc,
  };
}

/**
 * The SteamDB "calculator" figure for a profile: what the library would cost
 * at today's prices. When SteamDB refuses, the same sum is computed here from
 * live store prices over the most-played slice of the library.
 */
export async function getCalculator({ id, cc = 'us', l = 'english', sample = 100 } = {}) {
  const steamid = await resolveSteamId(id);
  const url = `${STEAMDB}/calculator/${steamid}/?cc=${encodeURIComponent(cc)}`;
  const html = await trySteamDb(`/calculator/${steamid}/?cc=${encodeURIComponent(cc)}`);

  if (html && /calculator|price-container/i.test(html) && !/Just a moment|cf-browser-verification/i.test(html)) {
    const worth = /class="[^"]*number[^"]*"[^>]*>\s*([^<]+?)\s*</i.exec(html)?.[1] || null;
    const games = numberFrom(/(\d[\d,]*)\s*games? (?:owned|in account)/i.exec(html)?.[1]);
    const hours = numberFrom(/(\d[\d,]*)\s*hours? played/i.exec(html)?.[1]);
    if (worth) {
      return { steamid, available: true, source: 'steamdb', worthFormatted: worth.trim(), games, hours, url, cc };
    }
  }

  const profile = await getProfile({ id: steamid, cc, l });
  const owned = profile.games || [];
  const slice = owned.slice(0, Math.min(Math.max(Number(sample) || 100, 1), 120));

  const priced = await getAppsLite({ appids: slice.map((game) => game.appid), cc, l }).catch(() => []);
  const byId = new Map(priced.map((item) => [item.appid, item]));

  let total = 0;
  let currency = 'USD';
  let counted = 0;
  let free = 0;

  for (const game of slice) {
    const card = byId.get(game.appid);
    if (!card?.price) continue;
    if (card.price.isFree) {
      free += 1;
      counted += 1;
      continue;
    }
    if (typeof card.price.initial !== 'number') continue;
    total += card.price.initial;
    currency = card.price.currency || currency;
    counted += 1;
  }

  const minutes = owned.reduce((sum, game) => sum + (game.playtimeForever || 0), 0);

  return {
    steamid,
    available: false,
    source: 'computed',
    note:
      'SteamDB did not answer this server, so this is summed from live Steam store prices ' +
      `across ${counted} of ${owned.length} owned games (highest playtime first).`,
    url,
    cc,
    currency,
    // Minor units, like every other price in this API.
    worth: total,
    sampled: counted,
    freeGames: free,
    games: owned.length,
    hours: Math.round(minutes / 60),
    averageMinutes: owned.length ? Math.round(minutes / owned.length) : 0,
    neverPlayed: owned.filter((game) => !game.playtimeForever).length,
  };
}

/* ------------------------------------------------------------------ *
 * Key-only endpoints (richer profile data when STEAM_API_KEY is set)
 * ------------------------------------------------------------------ */

export async function resolveSteamId(input) {
  const { kind, value } = parseProfileInput(input);
  if (kind === 'steamid' && STEAMID64.test(value)) return value;

  if (hasApiKey()) {
    const raw = await fetchJson(`${WEBAPI}/ISteamUser/ResolveVanityURL/v1/?${qs({ key: STEAM_API_KEY, vanityurl: value })}`).catch(() => null);
    if (raw?.response?.success === 1 && raw.response.steamid) return raw.response.steamid;
  }

  // No key, or the key-only resolver drew a blank on a display name.
  return resolveSteamIdKeyless(value);
}

/**
 * A profile plus its library.
 *
 * With STEAM_API_KEY set this is the Web API, which adds the Steam level and
 * the two-week recents. Without one it is the community XML documents, which
 * need no key and no login — so an anonymous visitor still gets the profile,
 * the full owned-games list and playtimes.
 */
export async function getProfile({ id, cc = 'us', l = 'english' } = {}) {
  const steamid = await resolveSteamId(id);
  return hasApiKey() ? getProfileWithKey({ steamid, cc, l }) : getProfileKeyless({ steamid, cc, l });
}

export async function getProfileKeyless({ steamid, cc = 'us', l = 'english' } = {}) {
  const [profile, games] = await Promise.all([
    getCommunityProfile(steamid).catch(() => null),
    getCommunityGames(steamid).catch(() => []),
  ]);

  if (!profile) {
    throw new SteamError('That Steam profile does not exist, or Steam is not answering right now', { status: 404 });
  }
  if (profile.private && games.length === 0) {
    throw new SteamError(`${profile.name || 'That profile'} has their game details set to private`, { status: 403 });
  }

  return {
    steamid,
    keyless: true,
    profile: {
      name: profile.name,
      avatar: profile.avatar,
      profileUrl: profile.customUrl ? `${COMMUNITY}/id/${profile.customUrl}` : profile.profileUrl,
      visible: !profile.private,
      country: profile.location,
      realName: profile.realName,
      summary: profile.summary,
      memberSince: profile.memberSince,
      state: profile.online ? 1 : 0,
      playingName: profile.inGame ? profile.playingName || profile.stateMessage : null,
      vacBanned: profile.vacBanned,
    },
    level: null,
    gameCount: games.length,
    games,
    // The XML library carries two-week hours, which is all "recent" needs.
    recent: games.filter((game) => game.playtime2Weeks > 0).slice(0, 12),
    cc,
    l,
  };
}

async function getProfileWithKey({ steamid, cc = 'us', l = 'english' } = {}) {
  const [summaryRaw, ownedRaw, recentRaw, levelRaw] = await Promise.all([
    fetchJson(`${WEBAPI}/ISteamUser/GetPlayerSummaries/v2/?${qs({ key: STEAM_API_KEY, steamids: steamid })}`).catch(() => null),
    fetchJson(
      `${WEBAPI}/IPlayerService/GetOwnedGames/v1/?${qs({
        key: STEAM_API_KEY,
        steamid,
        include_appinfo: 1,
        include_played_free_games: 1,
        format: 'json',
      })}`,
    ).catch(() => null),
    fetchJson(`${WEBAPI}/IPlayerService/GetRecentlyPlayedGames/v1/?${qs({ key: STEAM_API_KEY, steamid, count: 12 })}`).catch(() => null),
    fetchJson(`${WEBAPI}/IPlayerService/GetSteamLevel/v1/?${qs({ key: STEAM_API_KEY, steamid })}`).catch(() => null),
  ]);

  const player = summaryRaw?.response?.players?.[0] || null;
  if (!player && !ownedRaw?.response?.games) {
    // The key path can come up empty where the community documents do not
    // (a rate-limited key, a profile the key cannot see) — so try those.
    return getProfileKeyless({ steamid, cc, l });
  }

  const toOwned = (game) => {
    const appid = Number(game.appid);
    return {
      appid,
      name: game.name || `App ${appid}`,
      header: images(appid).header,
      portrait: images(appid).portrait,
      capsule: images(appid).capsule,
      playtimeForever: game.playtime_forever || 0,
      playtime2Weeks: game.playtime_2weeks || 0,
      lastPlayed: game.rtime_last_played || null,
    };
  };

  const games = (ownedRaw?.response?.games || []).map(toOwned).sort((a, b) => b.playtimeForever - a.playtimeForever);

  return {
    steamid,
    profile: player
      ? {
          name: player.personaname,
          avatar: secureUrl(player.avatarfull || player.avatar),
          profileUrl: secureUrl(player.profileurl),
          state: player.personastate ?? null,
          visible: player.communityvisibilitystate === 3,
          lastLogoff: player.lastlogoff || null,
          country: player.loccountrycode || null,
          createdAt: player.timecreated || null,
          playingAppId: player.gameid ? Number(player.gameid) : null,
          playingName: player.gameextrainfo || null,
        }
      : null,
    level: levelRaw?.response?.player_level ?? null,
    gameCount: ownedRaw?.response?.game_count ?? games.length,
    games,
    recent: (recentRaw?.response?.games || []).map(toOwned),
    cc,
    l,
  };
}

export const internals = { fetchJson, limiter };
