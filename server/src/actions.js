/**
 * The action registry. Both transports (WebSocket messages and `GET /api/:action`)
 * funnel through `runAction`, so they can never drift apart.
 *
 * Only the actions listed here can reach Steam — the relay is deliberately not
 * a general purpose HTTP proxy.
 */
import * as steam from './steam.js';
import * as discover from './discover.js';
import * as community from './community.js';
import * as stats from './stats.js';
import * as agents from './agents.js';
import { cache, SteamError, TTL } from './steam.js';

/**
 * Bumped whenever the relay gains a capability the page can depend on. The
 * diagnostics view compares this against what it expects, so "the relay is
 * deploying from the wrong branch" is distinguishable from "the feature is
 * broken" — they look identical from the browser otherwise.
 */
export const BUILD = '2026-08-05.1';

export const FEATURES = [
  'trailer-probe', // movies carry a probed `sources` list
  'genre-search', // genres via /search/results rather than getappsingenre
  'creator-pages', // developer / publisher catalogues
  'discovery-rows', // home-page recommendation rows
  'profile-rich', // recent activity, achievements, friends
  'profile-keyless', // profiles without STEAM_API_KEY
  'calculator', // account value
  'steamspy', // ownership estimates
  'remote-play', // paired agents
  'dedupe', // collapsed duplicate storefront rows
  'media-proxy', // GET /media re-serves Steam assets
  'agent-stream', // built-in screen streaming through the relay
  'genre-tags', // genres resolved by store tag id, and verified
  'steam-openid', // /auth/steam — sign in through Steam
];

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

      return {
        cc,
        l,
        featured: hero.map((item) => {
          const extra = byId.get(item.appid);
          return extra ? { ...item, shortDescription: extra.shortDescription, genres: extra.genres, price: item.price || extra.price } : item;
        }),
        ...categories,
        mostPlayed,
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

      // Verify trailer URLs here rather than letting the browser discover a
      // dead CDN host mid-playback. Cached with the rest of the page.
      game.movies = await steam.resolveMovies(game.movies).catch(() => game.movies);

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
    run: async () => ({ genres: discover.GENRES }),
  },

  genre: {
    ttl: TTL.genre,
    key: (p) => `genre:${str(p.genre).toLowerCase()}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: (p) => discover.getGenre({ genre: str(p.genre), cc: clampCc(p.cc), l: clampLang(p.l) }),
  },

  /** Arbitrary store-search browsing: sorts, specials, price ceilings, tags. */
  browse: {
    ttl: TTL.genre,
    key: (p) => `browse:${JSON.stringify(p.filters || {})}:${clampCc(p.cc)}:${clampLang(p.l)}:${Number(p.start) || 0}`,
    run: (p) =>
      discover.browse({
        filters: p.filters && typeof p.filters === 'object' ? p.filters : {},
        cc: clampCc(p.cc),
        l: clampLang(p.l),
        start: Math.min(Math.max(Number(p.start) || 0, 0), 500),
        count: Math.min(Number(p.count) || 24, 30),
      }),
  },

  /** Developer or publisher page. */
  creator: {
    ttl: TTL.genre,
    key: (p) => `creator:${str(p.role, 'developer')}:${str(p.name).toLowerCase()}:${clampCc(p.cc)}:${Number(p.start) || 0}`,
    run: (p) =>
      discover.getCreator({
        name: str(p.name),
        role: str(p.role) === 'publisher' ? 'publisher' : 'developer',
        cc: clampCc(p.cc),
        l: clampLang(p.l),
        start: Math.min(Math.max(Number(p.start) || 0, 0), 200),
      }),
  },

  /**
   * Discovery-queue style rows. `seeds` are appids the visitor has wishlisted,
   * so the row can say "Since you wishlisted X" the way the store does.
   */
  discovery: {
    ttl: TTL.home,
    key: (p) => `discovery:${(Array.isArray(p.seeds) ? p.seeds : String(p.seeds || '').split(',')).slice(0, 3).join(',')}:${clampCc(p.cc)}:${clampLang(p.l)}`,
    run: async (p) => {
      const cc = clampCc(p.cc);
      const l = clampLang(p.l);
      const seeds = (Array.isArray(p.seeds) ? p.seeds : String(p.seeds || '').split(','))
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 3);

      const rows = [];
      const used = new Set(seeds);

      // One row per wishlisted game, recommending something from its genre.
      for (const seed of seeds) {
        try {
          const [seedCard] = await steam.getAppsLite({ appids: [seed], cc, l });
          const genre = seedCard?.genres?.[0];
          if (!seedCard || !genre) continue;

          // `{ genre }` is a filter Steam accepts and ignores, so this used to
          // recommend the global top sellers no matter what was wishlisted.
          const { items } = await discover.browse({
            filters: { ...discover.genreFilter(genre), sort_by: discover.SORTS.topsellers },
            cc,
            l,
            count: 12,
          });
          const pick = items.find((item) => !used.has(item.appid));
          if (!pick) continue;
          used.add(pick.appid);

          const [card] = await steam.getAppCards({ appids: [pick.appid], cc, l });
          if (card) rows.push({ reason: 'Since you wishlisted', because: seedCard.name, becauseAppid: seedCard.appid, item: card });
        } catch {
          // A row that cannot be built is simply not shown.
        }
      }

      // Top up with editorial picks so the section is never empty.
      if (rows.length < 3) {
        const home = await steam.getFeaturedCategories({ cc, l }).catch(() => ({ topSellers: [], newReleases: [] }));
        const pool = steam
          .dedupeCards([...(home.topSellers || []), ...(home.newReleases || [])])
          .filter((item) => !used.has(item.appid))
          .slice(0, 3 - rows.length + 2);

        const cards = await steam.getAppCards({ appids: pool.map((item) => item.appid), cc, l });
        for (const card of cards) {
          if (rows.length >= 3 || used.has(card.appid)) continue;
          used.add(card.appid);
          rows.push({ reason: 'Recommended', because: card.genres?.[0] || 'popular on Steam', item: card });
        }
      }

      if (rows.length === 0) throw new SteamError('Steam returned nothing to recommend right now', { status: 502, retryable: true });
      return { rows };
    },
  },

  news: {
    ttl: TTL.news,
    key: (p) => `news:${appid(p.appid)}:${Math.min(Number(p.count) || 8, 20)}`,
    run: (p) => steam.getNews({ appid: appid(p.appid), count: Math.min(Number(p.count) || 8, 20) }),
  },

  /**
   * Everything the real Steam profile page shows: identity, level, recent
   * activity with achievement progress, the full library, and the friends
   * list with live status.
   *
   * Uses the Web API when a key is configured and the public community
   * documents otherwise, so looking someone up never requires the visitor —
   * or the relay — to be signed in.
   */
  profile: {
    ttl: TTL.profile,
    key: (p) => `profile:${str(p.id).toLowerCase()}:${clampCc(p.cc)}`,
    run: async (p) => {
      const id = str(p.id);
      const cc = clampCc(p.cc);
      const l = clampLang(p.l);

      // Community XML is the source of identity either way: it is the only
      // place the summary, real name and "hours past 2 weeks" line live.
      const community$ = community.getCommunityProfile(id);
      const api$ = steam.hasApiKey() ? steam.getProfile({ id, cc, l }).catch(() => null) : Promise.resolve(null);
      const [profile, api] = await Promise.all([community$, api$.catch(() => null)]);

      const steamid = profile.steamid;

      const library = api?.games?.length
        ? { games: api.games }
        : await community.getCommunityGames(steamid).catch((error) => ({ games: [], error: error.message }));

      // Recent activity: the API's two-week list is authoritative, the XML's
      // "most played" block is the key-less stand-in.
      const recent = (api?.recent?.length ? api.recent : profile.mostPlayed).slice(0, 6);

      const friends$ = steam.hasApiKey()
        ? steam.getFriends({ steamid }).then((result) => (result.available ? result : community.getCommunityFriends(steamid)))
        : community.getCommunityFriends(steamid);

      // Achievement bars for the recent games, in parallel with the friends.
      const achievements$ = Promise.all(
        recent.slice(0, 4).map(async (game) => {
          const viaApi = steam.hasApiKey() ? await steam.getPlayerAchievements({ steamid, appid: game.appid }).catch(() => null) : null;
          const result = viaApi || (await community.getCommunityAchievements(steamid, game.appid).catch(() => null));
          return [game.appid, result];
        }),
      );

      const [friends, achievementPairs] = await Promise.all([
        friends$.catch(() => ({ friends: [], total: 0, available: false })),
        achievements$.catch(() => []),
      ]);

      const achievements = new Map(achievementPairs.filter(([, value]) => value));
      const games = library.games || [];

      return {
        steamid,
        profile: {
          name: profile.name,
          realname: profile.realname,
          summary: profile.summary,
          headline: profile.headline,
          avatar: profile.avatar,
          profileUrl: profile.profileUrl,
          customUrl: profile.customUrl,
          country: profile.location,
          memberSince: profile.memberSince,
          createdAt: api?.profile?.createdAt || null,
          onlineState: profile.onlineState,
          stateMessage: profile.stateMessage,
          playingName: profile.playingName || api?.profile?.playingName || null,
          playingAppId: profile.playingAppId || api?.profile?.playingAppId || null,
          visible: profile.isPublic,
          vacBanned: profile.vacBanned,
          limitedAccount: profile.limitedAccount,
        },
        level: api?.level ?? null,
        hours2Weeks: profile.hours2Weeks ?? null,
        gameCount: api?.gameCount ?? games.length,
        groupCount: profile.groupCount || 0,
        games,
        recent: recent.map((game) => ({ ...game, achievements: achievements.get(game.appid) || null })),
        friends: friends.friends || [],
        friendCount: friends.total || 0,
        friendsAvailable: Boolean(friends.available),
        libraryError: library.error || null,
        inventoryUrl: `https://steamcommunity.com/profiles/${steamid}/inventory/`,
        badgesUrl: `https://steamcommunity.com/profiles/${steamid}/badges/`,
        cc,
        l,
        source: api ? 'webapi+community' : 'community',
      };
    },
  },

  /** Find public profiles by name — steamcommunity.com/search/users. */
  usersearch: {
    ttl: TTL.profile,
    key: (p) => `usersearch:${str(p.text).toLowerCase()}:${Number(p.page) || 1}`,
    run: (p) => community.searchUsers({ text: str(p.text), page: Number(p.page) || 1 }),
  },

  /** Ownership / playtime estimates plus SteamDB deep links. */
  steamspy: {
    ttl: 6 * 60 * 60_000,
    key: (p) => `steamspy:${appid(p.appid)}`,
    run: (p) => stats.getSteamSpy({ appid: appid(p.appid) }),
  },

  /** Account-value calculator over a profile's library. */
  calculator: {
    ttl: TTL.profile,
    key: (p) => `calculator:${str(p.id).toLowerCase()}:${clampCc(p.cc)}`,
    run: async (p) => {
      const cc = clampCc(p.cc);
      const { data } = await runAction('profile', { id: str(p.id), cc, l: clampLang(p.l) });
      const summary = await stats.calculateLibrary({ games: data.games, cc });
      return {
        ...summary,
        steamid: data.steamid,
        name: data.profile?.name || data.steamid,
        steamdb: stats.steamdbCalculatorUrl(data.steamid),
      };
    },
  },

  /**
   * Talk to a paired Steam Viewer Agent running on the visitor's own PC.
   * Never cached — it is live device state.
   */
  agent: {
    ttl: 0,
    key: (p) => `agent:${str(p.code)}:${str(p.op)}`,
    run: async (p) => {
      const code = str(p.code).toUpperCase();
      const op = str(p.op, 'status');
      if (!code) throw new SteamError('Enter the pairing code shown by the agent', { status: 400 });

      switch (op) {
        case 'status':
          return agents.status(code);
        case 'games':
          return agents.games(code);
        case 'refresh':
          return agents.request(code, 'refresh', {});
        case 'launch':
          return agents.request(code, 'launch', { appid: appid(p.appid) });
        case 'stop':
          return agents.request(code, 'stop', { appid: p.appid ? appid(p.appid) : null });
        case 'stream':
          return agents.request(code, 'stream', { appid: p.appid ? appid(p.appid) : null });
        case 'stream.start':
          return agents.request(code, 'stream.start', {
            fps: Number(p.fps) || undefined,
            bitrate: str(p.bitrate) || undefined,
            height: Number(p.height) || undefined,
            codec: str(p.codec) || undefined,
          });
        case 'stream.stop':
          return agents.request(code, 'stream.stop', {});
        default:
          throw new SteamError(`Unknown agent operation “${op}”`, { status: 400 });
      }
    },
  },

  capabilities: {
    ttl: 0,
    key: () => 'capabilities',
    run: async () => ({
      actions: Object.keys(ACTIONS),
      // Profiles work either way now; the key only upgrades the data.
      library: true,
      apiKey: steam.hasApiKey(),
      genres: discover.GENRES,
      remotePlay: true,
      build: BUILD,
      /**
       * Named capabilities the page can test for. A relay deploying from a
       * stale branch answers without these, which is what the diagnostics
       * page checks — a mismatched relay looks exactly like a broken feature
       * otherwise.
       */
      features: FEATURES,
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
