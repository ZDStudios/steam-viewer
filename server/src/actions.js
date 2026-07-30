/**
 * The action registry. Both transports (WebSocket messages and `GET /api/:action`)
 * funnel through `runAction`, so they can never drift apart.
 *
 * Only the actions listed here can reach Steam — the relay is deliberately not
 * a general purpose HTTP proxy.
 */
import * as steam from './steam.js';
import { cache, SteamError, TTL } from './steam.js';

const str = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);
const clampCc = (value) => (/^[a-z]{2}$/i.test(str(value)) ? str(value).toLowerCase() : 'us');
const clampLang = (value) => (/^[a-z_]{2,20}$/i.test(str(value)) ? str(value).toLowerCase() : 'english');
const appid = (value) => {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0 || id > 100_000_000) throw new SteamError('Invalid appid', { status: 400 });
  return Math.trunc(id);
};

/**
 * Each action declares its own cache key + TTL so the WebSocket and REST paths
 * share one warm cache.
 */
export const ACTIONS = {
  ping: {
    ttl: 0,
    key: () => 'ping',
    run: async () => ({ pong: true, at: Date.now() }),
  },

  /** Everything the home page needs, in one round trip. */
  home: {
    ttl: TTL.home,
    key: (p) => `home:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: async (p) => {
      const cc = clampCc(p.cc);
      const l = clampLang(p.l);

      const [featured, categories, mostPlayed] = await Promise.all([
        steam.getFeatured({ cc, l }).catch(() => []),
        steam.getFeaturedCategories({ cc, l }).catch(() => ({ specials: [], topSellers: [], newReleases: [], comingSoon: [] })),
        steam.getMostPlayed({ cc, l, limit: 12 }).catch(() => []),
      ]);

      if (featured.length === 0 && categories.topSellers.length === 0 && mostPlayed.length === 0) {
        throw new SteamError('Steam did not return any store data right now', { status: 502, retryable: true });
      }

      // The carousel wants a blurb, which `featured` does not include. Lite
      // details are cached per app for an hour, so this is cheap after the
      // first load.
      const hero = featured.slice(0, 8);
      const enrichment = await steam.getAppsLite({ appids: hero.map((item) => item.appid), cc, l }).catch(() => []);
      const byId = new Map(enrichment.map((item) => [item.appid, item]));

      /*
       * One `seen` set walks every section in display order, so a title that
       * has already appeared upstairs never shows up again further down the
       * page. The carousel claims first, then the merchandising rows.
       * `mostPlayed` is deliberately exempt: it is a chart, and a chart with
       * holes punched in it is not a chart.
       */
      const seen = new Set();
      const featuredCards = steam.dedupeItems(
        hero.map((item) => {
          const extra = byId.get(item.appid);
          return extra ? { ...item, ...extra, price: item.price || extra.price } : item;
        }),
        { seen },
      );

      const specials = steam.dedupeItems(categories.specials, { seen });
      const topSellers = steam.dedupeItems(categories.topSellers, { seen });
      const newReleases = steam.dedupeItems(categories.newReleases, { seen });
      const comingSoon = steam.dedupeItems(categories.comingSoon, { seen });

      // Extra front-page shelves, each cheap because they reuse the lite cache.
      const [freeToPlay, underTen] = await Promise.all([
        steam.searchStore({ cc, l, limit: 8, genre: 'Free to Play', filter: 'topsellers' }).catch(() => []),
        steam.searchStore({ cc, l, limit: 8, maxprice: 10, specials: true }).catch(() => []),
      ]);

      return {
        cc,
        l,
        featured: featuredCards,
        specials,
        topSellers,
        newReleases,
        comingSoon,
        mostPlayed: steam.dedupeItems(mostPlayed, { seen: new Set() }),
        freeToPlay: steam.dedupeItems(freeToPlay, { seen }),
        underTen: steam.dedupeItems(underTen, { seen }),
        genres: steam.GENRES,
      };
    },
  },

  featured: {
    ttl: TTL.featured,
    key: (p) => `featured:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: (p) => steam.getFeatured({ cc: clampCc(p.cc), l: clampLang(p.l) }),
  },

  search: {
    ttl: TTL.search,
    key: (p) => `search:${str(p.term).toLowerCase()}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: (p) => {
      const term = str(p.term).slice(0, 120);
      if (!term) return { total: 0, items: [], term: '' };
      return steam.search({ term, cc: clampCc(p.cc), l: clampLang(p.l), limit: Math.min(Number(p.limit) || 40, 60) });
    },
  },

  /** Full game page: store details + first page of reviews + recent news. */
  app: {
    ttl: TTL.app,
    key: (p) => `app:${appid(p.appid)}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: async (p) => {
      const id = appid(p.appid);
      const cc = clampCc(p.cc);
      const l = clampLang(p.l);

      const details = await steam.getAppDetails({ appid: id, cc, l });
      const game = steam.toFull(details);

      const [reviews, news] = await Promise.all([
        steam.getReviews({ appid: id, filter: 'all', numPerPage: 10 }).catch(() => null),
        steam.getNews({ appid: id, count: 5 }).catch(() => []),
      ]);

      return { game, reviews, news };
    },
  },

  apps: {
    ttl: TTL.lite,
    key: (p) => `apps:${(p.appids || []).slice(0, 30).join(',')}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: (p) =>
      steam.getAppsLite({
        appids: Array.isArray(p.appids) ? p.appids : String(p.appids || '').split(','),
        cc: clampCc(p.cc),
        l: clampLang(p.l),
      }),
  },

  reviews: {
    ttl: TTL.reviews,
    key: (p) => `reviews:${appid(p.appid)}:${str(p.filter, 'all')}:${str(p.language, 'all')}:${str(p.reviewType, 'all')}:${str(p.cursor, '*')}`,
    run: (p) =>
      steam.getReviews({
        appid: appid(p.appid),
        filter: ['all', 'recent', 'updated'].includes(str(p.filter)) ? str(p.filter) : 'all',
        language: str(p.language, 'all') || 'all',
        reviewType: ['all', 'positive', 'negative'].includes(str(p.reviewType)) ? str(p.reviewType) : 'all',
        cursor: str(p.cursor, '*') || '*',
        numPerPage: Math.min(Number(p.numPerPage) || 20, 50),
      }),
  },

  players: {
    ttl: TTL.players,
    key: (p) => `players:${appid(p.appid)}`,
    run: (p) => steam.getPlayerCount({ appid: appid(p.appid) }),
  },

  mostplayed: {
    ttl: TTL.mostPlayed,
    key: (p) => `mostplayed:${clampCc(p.cc)}:${clampLang(p.l)}:${Math.min(Number(p.limit) || 12, 25)}`,
    run: (p) => steam.getMostPlayed({ cc: clampCc(p.cc), l: clampLang(p.l), limit: Math.min(Number(p.limit) || 12, 25) }),
  },

  genres: {
    ttl: 24 * 60 * 60_000,
    key: () => 'genres',
    run: async () => ({ genres: steam.GENRES }),
  },

  genre: {
    ttl: TTL.genre,
    key: (p) => `genre:${str(p.genre).toLowerCase()}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: (p) => steam.getGenre({ genre: str(p.genre), cc: clampCc(p.cc), l: clampLang(p.l) }),
  },

  news: {
    ttl: TTL.news,
    key: (p) => `news:${appid(p.appid)}:${Math.min(Number(p.count) || 8, 20)}`,
    run: (p) => steam.getNews({ appid: appid(p.appid), count: Math.min(Number(p.count) || 8, 20) }),
  },

  /**
   * A ranked slice of the catalogue. This is the store's own search backend,
   * so it is the one place genre / developer / price filters actually work.
   */
  browse: {
    ttl: TTL.browse,
    key: (p) =>
      `browse:${str(p.genre).toLowerCase()}:${str(p.filter)}:${str(p.developer).toLowerCase()}:${str(p.publisher).toLowerCase()}:${
        p.specials ? 1 : 0
      }:${Number(p.maxprice) || 0}:${str(p.term).toLowerCase()}:${clampCc(p.cc)}:${clampLang(p.l)}:${Math.min(Number(p.limit) || 24, 30)}`,
    run: (p) =>
      steam.searchStore({
        cc: clampCc(p.cc),
        l: clampLang(p.l),
        term: str(p.term).slice(0, 120) || undefined,
        genre: str(p.genre) ? steam.canonicalGenre(str(p.genre)) : undefined,
        developer: str(p.developer) || undefined,
        publisher: str(p.publisher) || undefined,
        filter: str(p.filter) || undefined,
        specials: p.specials === true || p.specials === 'true' || p.specials === '1',
        maxprice: Number(p.maxprice) > 0 ? Math.trunc(Number(p.maxprice)) : undefined,
        limit: Math.min(Math.max(Number(p.limit) || 24, 1), 30),
      }),
  },

  /** A developer or publisher page. */
  developer: {
    ttl: TTL.developer,
    key: (p) => `dev:${str(p.role, 'developer')}:${str(p.name).toLowerCase()}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: (p) =>
      steam.getStudio({
        name: str(p.name).slice(0, 120),
        role: str(p.role) === 'publisher' ? 'publisher' : 'developer',
        cc: clampCc(p.cc),
        l: clampLang(p.l),
      }),
  },

  /**
   * Find people by name — the index behind steamcommunity.com/search/users.
   * No key, no login: anonymous visitors can look anybody up.
   */
  users: {
    ttl: TTL.users,
    key: (p) => `users:${str(p.text).toLowerCase()}:${Math.max(1, Number(p.page) || 1)}`,
    run: (p) => {
      const text = str(p.text).slice(0, 80);
      if (!text) return [];
      return steam.searchUsers({ text, page: Math.max(1, Number(p.page) || 1), limit: Math.min(Number(p.limit) || 20, 30) });
    },
  },

  /** Profile + owned library. Works with or without STEAM_API_KEY. */
  profile: {
    ttl: TTL.profile,
    key: (p) => `profile:${str(p.id).toLowerCase()}:${clampCc(p.cc)}`,
    run: (p) => steam.getProfile({ id: str(p.id), cc: clampCc(p.cc), l: clampLang(p.l) }),
  },

  /** SteamDB stats for one app, with a Steam-sourced fallback. */
  steamdb: {
    ttl: TTL.steamdb,
    key: (p) => `steamdb:${appid(p.appid)}:${clampCc(p.cc)}`,
    run: (p) => steam.getSteamDbApp({ appid: appid(p.appid), cc: clampCc(p.cc) }),
  },

  /** SteamDB's calculator figure for a profile, or ours if it will not answer. */
  calculator: {
    ttl: TTL.calculator,
    key: (p) => `calc:${str(p.id).toLowerCase()}:${clampCc(p.cc)}`,
    run: (p) =>
      steam.getCalculator({
        id: str(p.id),
        cc: clampCc(p.cc),
        l: clampLang(p.l),
        sample: Math.min(Number(p.sample) || 100, 120),
      }),
  },

  capabilities: {
    ttl: 0,
    key: () => 'capabilities',
    run: async () => ({
      actions: Object.keys(ACTIONS),
      // Profiles no longer need a key — this now means "richer profile data".
      library: true,
      apiKey: steam.hasApiKey(),
      genres: steam.GENRES,
    }),
  },
};

export async function runAction(name, params = {}) {
  const action = ACTIONS[name];
  if (!action) throw new SteamError(`Unknown action “${name}”`, { status: 400 });

  const safeParams = params && typeof params === 'object' ? params : {};
  const key = `${name}|${action.key(safeParams)}`;

  if (!action.ttl) {
    return { data: await action.run(safeParams), cached: false };
  }

  const { value, cached } = await cache.wrap(key, action.ttl, () => action.run(safeParams));
  return { data: value, cached };
}
