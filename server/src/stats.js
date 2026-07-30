/**
 * The SteamDB-style numbers: ownership estimates, playtime medians, peak
 * players, and an account-value calculator.
 *
 * SteamDB itself sits behind bot protection and its terms do not allow
 * scraping, so nothing here reads steamdb.info. Instead the same figures are
 * assembled from sources that are meant to be called programmatically —
 * SteamSpy's public API and Steam's own charts and pricing — and every panel
 * links out to the matching SteamDB page so the real thing is one click away.
 */
import { getPricesBulk, SteamError, fetchText } from './steam.js';
import { Limiter } from './limiter.js';

const STEAMSPY = 'https://steamspy.com/api.php';

// SteamSpy asks for no more than one request per second.
const spyLimiter = new Limiter({ concurrency: 1, minGapMs: 1100 });

export const steamdbLinks = (appid) => ({
  app: `https://steamdb.info/app/${appid}/`,
  charts: `https://steamdb.info/app/${appid}/charts/`,
  depots: `https://steamdb.info/app/${appid}/depots/`,
  history: `https://steamdb.info/app/${appid}/price/`,
});

export const steamdbCalculatorUrl = (steamid) => `https://steamdb.info/calculator/${steamid}/`;

/** Ownership + playtime estimates for one app. */
export async function getSteamSpy({ appid } = {}) {
  const id = Number(appid);
  if (!Number.isFinite(id) || id <= 0) throw new SteamError('Invalid appid', { status: 400 });

  let raw;
  try {
    raw = JSON.parse(await spyLimiter.run(() => fetchText(`${STEAMSPY}?request=appdetails&appid=${id}`, { retries: 0 })));
  } catch {
    throw new SteamError('SteamSpy did not answer', { status: 502, retryable: true });
  }
  if (!raw || !raw.appid) throw new SteamError('SteamSpy has no data for this app', { status: 404 });

  const positive = Number(raw.positive) || 0;
  const negative = Number(raw.negative) || 0;
  const total = positive + negative;

  // SteamSpy quotes tags as {tag: votes}; the top few are the useful ones.
  const tags = Object.entries(raw.tags && typeof raw.tags === 'object' ? raw.tags : {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 12)
    .map(([name, votes]) => ({ name, votes: Number(votes) || 0 }));

  return {
    appid: id,
    name: raw.name || null,
    developer: raw.developer || null,
    publisher: raw.publisher || null,
    owners: raw.owners || null,
    ccu: Number(raw.ccu) || null,
    positive,
    negative,
    reviewTotal: total,
    positivePercent: total ? Math.round((positive / total) * 100) : null,
    averagePlaytimeForever: Number(raw.average_forever) || 0,
    averagePlaytime2Weeks: Number(raw.average_2weeks) || 0,
    medianPlaytimeForever: Number(raw.median_forever) || 0,
    medianPlaytime2Weeks: Number(raw.median_2weeks) || 0,
    tags,
    steamdb: steamdbLinks(id),
    source: 'steamspy',
  };
}

/**
 * Account value, the way SteamDB's calculator presents it: what the library
 * would cost at today's prices, plus how much of it has actually been played.
 *
 * Prices come from Steam's own bulk `appdetails?filters=price_overview` call,
 * so the figure is in the visitor's chosen store currency.
 */
export async function calculateLibrary({ games = [], cc = 'us' } = {}) {
  const owned = (games || []).filter((game) => Number.isFinite(Number(game?.appid)));
  if (owned.length === 0) {
    throw new SteamError('That library has no games to value', { status: 400 });
  }

  // Cap the valuation so one enormous library cannot monopolise the relay.
  const MAX = 1200;
  const considered = owned.slice(0, MAX);
  const prices = await getPricesBulk({ appids: considered.map((game) => Number(game.appid)), cc });

  let currency = null;
  let totalMinor = 0;
  let currentMinor = 0;
  let priced = 0;
  let free = 0;
  let unknown = 0;
  let playedMinutes = 0;
  let neverPlayed = 0;

  for (const game of considered) {
    const minutes = Number(game.playtimeForever) || 0;
    playedMinutes += minutes;
    if (minutes === 0) neverPlayed += 1;

    const price = prices.get(Number(game.appid));
    if (!price) {
      unknown += 1;
      continue;
    }
    if (price.free) {
      free += 1;
      continue;
    }
    currency = currency || price.currency;
    totalMinor += price.initial ?? price.final ?? 0;
    currentMinor += price.final ?? 0;
    priced += 1;
  }

  const hours = playedMinutes / 60;

  return {
    cc,
    currency: currency || 'USD',
    gamesConsidered: considered.length,
    gamesTotal: owned.length,
    truncated: owned.length > MAX,
    priced,
    free,
    unknown,
    // Minor units, matching every other price in the API.
    valueAtFullPrice: totalMinor,
    valueAtCurrentPrice: currentMinor,
    savingsIfBoughtNow: Math.max(0, totalMinor - currentMinor),
    playtimeMinutes: playedMinutes,
    playtimeHours: Math.round(hours * 10) / 10,
    neverPlayed,
    playedPercent: considered.length ? Math.round(((considered.length - neverPlayed) / considered.length) * 100) : 0,
    // What each played hour has cost, the stat the calculator is known for.
    costPerHourMinor: hours > 0 ? Math.round(totalMinor / hours) : null,
    source: 'steam-prices',
  };
}
