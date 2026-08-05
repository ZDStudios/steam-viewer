/** Small DOM + formatting helpers shared by every view. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Escape a value for interpolation into an HTML template string. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for use inside a `url("...")` or an attribute holding a URL. */
export function escAttr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

export function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const numberFormat = new Intl.NumberFormat(undefined);

export const formatNumber = (value) => (typeof value === 'number' ? numberFormat.format(value) : '—');

const currencyCache = new Map();

/** Steam quotes money in minor units for every currency, so always /100. */
export function formatMoney(minorUnits, currency = 'USD') {
  if (typeof minorUnits !== 'number' || Number.isNaN(minorUnits)) return '';
  const code = (currency || 'USD').toUpperCase();

  let formatter = currencyCache.get(code);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: code });
    } catch {
      formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
    }
    currencyCache.set(code, formatter);
  }
  return formatter.format(minorUnits / 100);
}

/** Minutes of playtime → "12.4 hrs" / "48 min", the way Steam shows it. */
export function formatPlaytime(minutes) {
  if (!minutes) return '0 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours >= 100 ? Math.round(hours) : hours.toFixed(1)} hrs`;
}

export function formatDate(unixSeconds) {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function relativeTime(unixSeconds) {
  if (!unixSeconds) return '';
  const seconds = Math.floor(Date.now() / 1000) - unixSeconds;
  const units = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** Strip Steam's BBCode-ish markup down to a plain sentence. */
export function plainText(html, limit = 260) {
  const text = String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Media proxy
 * ------------------------------------------------------------------ */

let mediaProxyBase = '';

/**
 * Point the asset fallbacks at a relay that can re-serve Steam media.
 *
 * Only enabled once the relay has confirmed it serves `/media`. An older relay
 * answers that route with 404, and routing images to it would turn a slow
 * image into a permanently broken one.
 */
export function setMediaProxy(baseUrl, { enabled = false } = {}) {
  const next = enabled ? String(baseUrl || '').replace(/\/+$/, '') : '';
  if (next !== mediaProxyBase) resetProxyLearning();
  mediaProxyBase = next;
}

export const hasMediaProxy = () => Boolean(mediaProxyBase);

/** Rewrite a Steam asset URL to go through the relay instead. */
export function proxied(url) {
  if (!mediaProxyBase || !url) return null;
  if (url.startsWith(mediaProxyBase)) return null; // already proxied
  return `${mediaProxyBase}/media?url=${encodeURIComponent(url)}`;
}

/** How long an image may take before we give up on Steam's CDN. */
export const SLOW_IMAGE_MS = 3000;

/** Hosts Steam serves store and community art from. */
const STEAM_ASSET_HOST =
  /(^|\.)(steamstatic\.com|steamcommunity\.com|steampowered\.com|steamusercontent\.com|akamaihd\.net|valvesoftware\.com)$/i;

function isSteamAsset(url) {
  try {
    return STEAM_ASSET_HOST.test(new URL(url, window.location.href).hostname);
  } catch {
    return false;
  }
}

/**
 * How many images the relay has had to rescue.
 *
 * On a network where Steam's CDN is simply unreachable — some ISPs, some
 * countries, a lot of school and office networks — *every* image costs a
 * three-second wait before it is retried. After a few rescues we stop
 * pretending the CDN might work and route new images through the relay
 * immediately, which turns a page that trickles in over a minute into one that
 * loads at once.
 */
let rescues = 0;
const RESCUES_BEFORE_PROXY_FIRST = 4;

export const proxyFirst = () => Boolean(mediaProxyBase) && rescues >= RESCUES_BEFORE_PROXY_FIRST;

/** Reset the learned routing — used when the relay changes. */
export function resetProxyLearning() {
  rescues = 0;
}

/** Send this image through the relay, remembering where it came from. */
function routeViaRelay(img, url) {
  const viaRelay = proxied(url);
  if (!viaRelay) return false;
  if (!img.dataset.originalSrc) img.dataset.originalSrc = url;
  img.dataset.proxied = '1';
  img.src = viaRelay;
  return true;
}

/** Move an image on to the next candidate URL in its fallback chain. */
function advanceImage(img) {
  const remaining = (img.dataset.fallback || '').split('|').filter(Boolean);
  const candidate = remaining.shift();
  img.dataset.fallback = remaining.join('|');

  if (candidate) {
    // Once the CDN has proved unreachable, do not spend another three seconds
    // finding that out again for every alternate host.
    if (proxyFirst() && isSteamAsset(candidate)) {
      const viaRelay = proxied(candidate);
      if (viaRelay) {
        img.dataset.originalSrc = candidate;
        img.dataset.proxied = '1';
        img.src = viaRelay;
        return;
      }
    }
    watchImage(img, candidate);
    img.src = candidate;
    return;
  }

  // Last resort: pull it through the relay, which often has a better route to
  // Steam than the visitor does.
  if (!img.dataset.proxied && routeViaRelay(img, img.dataset.originalSrc || img.currentSrc || img.src)) {
    rescues += 1;
    return;
  }

  // If the relay could not serve it either, go back to the URL Steam gave us
  // and let the browser keep trying — a slow image must never end up worse
  // off than if it had never been re-routed.
  if (img.dataset.proxied === '1' && img.dataset.originalSrc) {
    img.dataset.proxied = 'reverted';
    img.src = img.dataset.originalSrc;
    return;
  }

  img.removeAttribute('src');
  img.classList.add('is-missing');
  img.parentElement?.classList.add('has-missing-image');
}

/**
 * Give a URL `SLOW_IMAGE_MS` to produce pixels; after that, re-request it
 * through the relay. Steam's CDNs are quick from some networks and unusable
 * from others, and a stalled request never fires `error`, so a timer is the
 * only signal there is.
 */
function watchImage(img, url) {
  clearTimeout(Number(img.dataset.slowTimer) || 0);
  if (!mediaProxyBase || img.dataset.proxied || !isSteamAsset(url)) return;

  const timer = setTimeout(() => {
    if (img.complete && img.naturalWidth > 0) return;
    if (routeViaRelay(img, url)) rescues += 1;
  }, SLOW_IMAGE_MS);

  img.dataset.slowTimer = String(timer);
  img.addEventListener('load', () => clearTimeout(timer), { once: true });
}

/**
 * Start the slow-image clock only once the browser has actually begun
 * fetching.
 *
 * Cards are lazy-loaded, so an image far below the fold has not been requested
 * at all — starting its timer at render time would route the whole page
 * through the relay three seconds later for no reason. An IntersectionObserver
 * is the only way to know the difference.
 */
const pendingWatch = new WeakMap();
const viewportWatcher =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            viewportWatcher.unobserve(entry.target);
            const url = pendingWatch.get(entry.target);
            pendingWatch.delete(entry.target);
            if (url && !entry.target.complete) watchImage(entry.target, url);
          }
        },
        // Match the browser's own lazy-loading margin closely enough that the
        // timer starts when the request does.
        { rootMargin: '200px' },
      );

function watchWhenVisible(img, url) {
  if (!viewportWatcher || img.loading !== 'lazy') {
    watchImage(img, url);
    return;
  }
  pendingWatch.set(img, url);
  viewportWatcher.observe(img);
}

/**
 * Keep every Steam image on the page working.
 *
 * Three things can go wrong and each has a different answer:
 *   • the asset moved between CDN hosts — walk `data-fallback`;
 *   • the CDN 404s outright — same, then the relay;
 *   • the CDN is slow or blocked from this network — the relay, on a timer,
 *     because a stalled request never reports an error.
 *
 * Images without a fallback chain (avatars, screenshots, community art) get
 * the relay treatment too: they are the ones with no alternate host to try, so
 * the relay is their only route.
 */
export function attachImageFallbacks(root = document) {
  for (const img of $$('img', root)) {
    if (img.dataset.fallbackBound) continue;

    const src = img.getAttribute('src');
    const chained = img.hasAttribute('data-fallback');
    // Anything not from Steam and without a chain is somebody else's problem.
    if (!chained && !(src && isSteamAsset(src))) continue;

    img.dataset.fallbackBound = '1';
    if (src) img.dataset.originalSrc = src;

    img.addEventListener('error', () => advanceImage(img));

    if (!src) {
      advanceImage(img);
    } else if (img.complete && img.naturalWidth === 0) {
      // The browser starts loading as soon as innerHTML is assigned, which is
      // before this listener exists, so a failure may already have happened.
      advanceImage(img);
    } else if (proxyFirst() && isSteamAsset(src)) {
      routeViaRelay(img, src);
    } else if (!img.complete) {
      watchWhenVisible(img, src);
    }
  }
}

/**
 * Steam has shuffled its trailer CDN between Akamai, Cloudflare and Fastly,
 * and `appdetails` still hands out URLs on hosts that no longer answer.
 *
 * The relay probes these and puts a working one first, but this runs client
 * side too so trailers still play when the page is talking to an older relay
 * that never sent a `sources` list.
 */
export const VIDEO_HOSTS = [
  'video.cloudflare.steamstatic.com',
  'video.fastly.steamstatic.com',
  'video.akamai.steamstatic.com',
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
];

export function videoCandidates(url) {
  if (!url) return [];
  const secure = String(url).replace(/^http:\/\//i, 'https://');

  let parsed;
  try {
    parsed = new URL(secure);
  } catch {
    return [secure];
  }

  // Keep whatever host we were given first; it is right more often than not.
  const hosts = [parsed.host, ...VIDEO_HOSTS.filter((host) => host !== parsed.host)];
  return hosts.map((host) => {
    const candidate = new URL(secure);
    candidate.host = host;
    return candidate.toString();
  });
}

/** Expand a movie record from any relay version into an ordered source list. */
export function movieSources(movie) {
  if (!movie) return [];

  // A current relay sends `sources` already probed and ordered.
  const provided = Array.isArray(movie.sources) ? movie.sources : [];

  // An older relay sent one URL per encoding, unprobed.
  const legacy = [movie.mp4, movie.mp4Low, movie.webm, movie.webmLow].filter(Boolean);

  const expanded = [...provided, ...legacy].flatMap(videoCandidates);
  const direct = expanded.filter((url, index, all) => url && all.indexOf(url) === index);

  // If every CDN host is unreachable from here, the relay usually still has a
  // route to Steam — so it is appended as the final source rather than the
  // player giving up.
  const viaRelay = direct.slice(0, 2).map(proxied).filter(Boolean);
  return [...direct, ...viaRelay];
}

export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

export const REGIONS = [
  ['us', 'United States (USD)'],
  ['gb', 'United Kingdom (GBP)'],
  ['de', 'Germany (EUR)'],
  ['fr', 'France (EUR)'],
  ['nl', 'Netherlands (EUR)'],
  ['pl', 'Poland (PLN)'],
  ['ca', 'Canada (CAD)'],
  ['au', 'Australia (AUD)'],
  ['nz', 'New Zealand (NZD)'],
  ['br', 'Brazil (BRL)'],
  ['mx', 'Mexico (MXN)'],
  ['ar', 'Argentina (USD)'],
  ['jp', 'Japan (JPY)'],
  ['kr', 'South Korea (KRW)'],
  ['cn', 'China (CNY)'],
  ['in', 'India (INR)'],
  ['ru', 'Russia (RUB)'],
  ['tr', 'Türkiye (USD)'],
  ['za', 'South Africa (ZAR)'],
  ['se', 'Sweden (SEK)'],
  ['no', 'Norway (NOK)'],
  ['ch', 'Switzerland (CHF)'],
];
