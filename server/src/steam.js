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

export const STORE = 'https://store.steampowered.com';
export const WEBAPI = 'https://api.steampowered.com';
export const COMMUNITY = 'https://steamcommunity.com';
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';

export const USER_AGENT =
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
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Steam still hands out plain-http asset URLs; GitHub Pages is https-only. */
export function secureUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url.replace(/^http:\/\//i, 'https://');
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
 * GET a JSON document from Steam through the shared limiter, retrying on the
 * transient failures Steam is fond of (429, 5xx, empty body).
 */
async function fetchJson(url, { timeoutMs = 12_000, retries = 2, headers = {} } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await limiter.run(async () => {
        const response = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/javascript, */*; q=0.01',
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
        if (!text.trim()) {
          throw new SteamError('Steam returned an empty body', { status: 502, retryable: true });
        }
        try {
          return JSON.parse(text);
        } catch {
          throw new SteamError('Steam returned a non-JSON body', { status: 502, retryable: true });
        }
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

/**
 * Fetch a non-JSON document (search HTML, community XML) through the same
 * limiter and retry policy.
 */
export async function fetchText(url, { timeoutMs = 15_000, retries = 1, headers = {} } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await limiter.run(async () => {
        const response = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            Cookie: 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1',
            ...headers,
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.status === 429) throw new SteamError('Steam is rate limiting this server', { status: 429, retryable: true });
        if (response.status >= 500) throw new SteamError(`Steam responded ${response.status}`, { status: 502, retryable: true });
        if (!response.ok) throw new SteamError(`Steam responded ${response.status}`, { status: response.status });

        const text = await response.text();
        if (!text.trim()) throw new SteamError('Steam returned an empty body', { status: 502, retryable: true });
        return text;
      });
    } catch (error) {
      lastError = error instanceof SteamError ? error : new SteamError(error.message || 'Request failed', { retryable: true });
      if (attempt === retries || !lastError.retryable) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  throw lastError;
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
  };
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
    movies: (data.movies || []).map((movie) => ({
      id: movie.id,
      name: movie.name,
      thumb: secureUrl(movie.thumbnail),
      highlight: Boolean(movie.highlight),
      mp4: secureUrl(movie.mp4?.max || movie.mp4?.['480']),
      mp4Low: secureUrl(movie.mp4?.['480']),
      webm: secureUrl(movie.webm?.max || movie.webm?.['480']),
    })),
    supportInfo: {
      url: secureUrl(data.support_info?.url),
      email: data.support_info?.email || null,
    },
    contentDescriptors: data.content_descriptors?.notes || null,
    storeUrl: `${STORE}/app/${lite.appid}/`,
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
 * Store endpoints
 * ------------------------------------------------------------------ */

/**
 * Steam's merchandising rows repeat the same product under several appids —
 * regional Steam Machine listings, one iRacing entry per season pass, the same
 * game as both a base app and an edition. Collapse on appid *and* on a
 * normalised name so the storefront does not show the same box three times.
 */
export function dedupeCards(items = [], { seenIds, seenNames } = {}) {
  const ids = seenIds || new Set();
  const names = seenNames || new Set();

  const normalizeName = (name) =>
    String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[™®©]/g, '')
      // Drop edition/bundle suffixes so "X" and "X - Deluxe Edition" collapse.
      .replace(/\s*[-–—:|]\s*(deluxe|ultimate|premium|gold|complete|definitive|goty|game of the year|standard|digital|collector'?s?|anniversary|remastered|enhanced)\b.*$/i, '')
      .replace(/\s*\((?:pc|steam|windows)\)\s*$/i, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();

  return items.filter((item) => {
    if (!item || !Number.isFinite(item.appid)) return false;
    const key = normalizeName(item.name);
    if (ids.has(item.appid) || (key && names.has(key))) return false;
    ids.add(item.appid);
    if (key) names.add(key);
    return true;
  });
}

export async function getFeaturedCategories({ cc = 'us', l = 'english' } = {}) {
  const raw = await fetchJson(`${STORE}/api/featuredcategories/?${qs({ cc, l })}`);
  const pick = (key) => dedupeCards((raw?.[key]?.items || []).map(normalizeStoreItem).filter(Boolean));

  return {
    specials: pick('specials'),
    topSellers: pick('top_sellers'),
    newReleases: pick('new_releases'),
    comingSoon: pick('coming_soon'),
  };
}

/**
 * Prices for many apps in one request. `appdetails` only accepts a comma
 * separated `appids` list when a `filters` value narrows the payload, which is
 * what makes a whole-library valuation affordable.
 */
export async function getPricesBulk({ appids = [], cc = 'us' } = {}) {
  const ids = [...new Set(appids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const chunks = [];
  for (let index = 0; index < ids.length; index += 50) chunks.push(ids.slice(index, index + 50));

  const prices = new Map();
  const results = await mapPool(chunks, 2, async (chunk) => {
    const raw = await fetchJson(`${STORE}/api/appdetails?${qs({ appids: chunk.join(','), filters: 'price_overview', cc })}`);
    return raw || {};
  });

  for (const result of results) {
    for (const [appid, entry] of Object.entries(result || {})) {
      if (!entry || entry.success !== true) continue;
      const overview = entry.data?.price_overview;
      if (!overview) {
        prices.set(Number(appid), { free: true, final: 0, currency: null });
        continue;
      }
      prices.set(Number(appid), {
        free: false,
        final: overview.final ?? 0,
        initial: overview.initial ?? overview.final ?? 0,
        currency: overview.currency || null,
        discountPercent: overview.discount_percent || 0,
      });
    }
  }

  return prices;
}

export async function getFeatured({ cc = 'us', l = 'english' } = {}) {
  const raw = await fetchJson(`${STORE}/api/featured/?${qs({ cc, l })}`);
  const capsules = (raw?.large_capsules || []).map(normalizeStoreItem).filter(Boolean);
  const windows = (raw?.featured_win || []).map(normalizeStoreItem).filter(Boolean);
  // De-duplicate while preserving the editorial order Steam ships.
  return dedupeCards([...capsules, ...windows]);
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

/**
 * Lite card plus the handful of screenshots and the trailer the discovery rows
 * need. Shares the per-app cache with `getAppsLite`, so a card the visitor has
 * already seen costs nothing.
 */
export async function getAppCards({ appids = [], cc = 'us', l = 'english', shots = 4 } = {}) {
  const ids = [...new Set(appids.map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 12);

  const resolved = await mapPool(ids, 3, async (id) => {
    const { value } = await cache.wrap(`card:${id}:${cc}:${l}`, TTL.lite, async () => {
      try {
        const data = await getAppDetails({ appid: id, cc, l });
        const lite = toLite(data);
        if (!lite) return null;
        const movie = (data.movies || [])[0];
        return {
          ...lite,
          screenshots: (data.screenshots || []).slice(0, shots).map((shot) => ({
            thumb: secureUrl(shot.path_thumbnail),
            full: secureUrl(shot.path_full),
          })),
          preview: movie
            ? { webm: secureUrl(movie.webm?.['480'] || movie.webm?.max), mp4: secureUrl(movie.mp4?.['480'] || movie.mp4?.max), thumb: secureUrl(movie.thumbnail) }
            : null,
        };
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

export async function getGenre({ genre, cc = 'us', l = 'english' } = {}) {
  const name = String(genre || '').trim();
  if (!name) throw new SteamError('Missing genre', { status: 400 });

  let raw = null;
  try {
    raw = await fetchJson(`${STORE}/api/getappsingenre/?${qs({ genre: name, cc, l })}`);
  } catch {
    raw = null;
  }

  const tabs = raw?.tabs || {};
  const tabIds = (key) =>
    (tabs?.[key]?.items || [])
      .map((item) => Number(item?.id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, 12);

  const wanted = [
    { key: 'topsellers', label: 'Top Sellers' },
    { key: 'newreleases', label: 'New Releases' },
    { key: 'comingsoon', label: 'Coming Soon' },
    { key: 'specials', label: 'Specials' },
  ];

  const sections = [];
  for (const tab of wanted) {
    const ids = tabIds(tab.key);
    if (ids.length === 0) continue;
    sections.push({ key: tab.key, label: tab.label, items: await getAppsLite({ appids: ids, cc, l }) });
  }

  // `getappsingenre` is undocumented and occasionally returns nothing at all;
  // a plain store search for the genre name still gives the user something.
  if (sections.length === 0) {
    const fallback = await search({ term: name, cc, l, limit: 24 });
    sections.push({ key: 'search', label: `Matching “${name}”`, items: fallback.items });
  }

  return { genre: raw?.name || name, sections };
}

/* ------------------------------------------------------------------ *
 * Key-only endpoints (Library view)
 * ------------------------------------------------------------------ */

const STEAMID64 = /^\d{17}$/;

export async function resolveSteamId(input) {
  if (!hasApiKey()) throw new SteamError('This server has no STEAM_API_KEY configured', { status: 501 });

  let candidate = String(input || '').trim();
  if (!candidate) throw new SteamError('Missing Steam profile', { status: 400 });

  // Accept full profile URLs as well as bare ids / vanity names.
  const urlMatch = candidate.match(/steamcommunity\.com\/(?:profiles|id)\/([^/?#]+)/i);
  if (urlMatch) candidate = decodeURIComponent(urlMatch[1]);
  candidate = candidate.replace(/^@/, '');

  if (STEAMID64.test(candidate)) return candidate;

  const raw = await fetchJson(`${WEBAPI}/ISteamUser/ResolveVanityURL/v1/?${qs({ key: STEAM_API_KEY, vanityurl: candidate })}`);
  if (raw?.response?.success !== 1 || !raw.response.steamid) {
    throw new SteamError(`No Steam profile matches “${candidate}”`, { status: 404 });
  }
  return raw.response.steamid;
}

export async function getProfile({ id, cc = 'us', l = 'english' } = {}) {
  const steamid = await resolveSteamId(id);

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
    throw new SteamError('That Steam profile is private or does not exist', { status: 404 });
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
