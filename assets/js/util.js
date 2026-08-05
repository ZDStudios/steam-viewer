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

/**
 * The same for video, but longer.
 *
 * A trailer legitimately takes longer to produce its first frame than a JPEG
 * takes to decode, and giving up too early would restart a download that was
 * about to work.
 */
export const SLOW_VIDEO_MS = 7000;

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

/*
 * Images and video have exactly the same problem — Steam's CDN is fast from
 * some networks, glacial from others and blocked outright on a few — so they
 * get exactly the same treatment. Only three things differ between the two
 * element types, so those are looked up rather than duplicated.
 */
const IS_VIDEO = (node) => node.tagName === 'VIDEO';
/** Has this element actually produced something? */
const hasArrived = (node) => (IS_VIDEO(node) ? node.readyState >= 1 : node.complete && node.naturalWidth > 0);
/** The event that says so. */
const arrivalEvent = (node) => (IS_VIDEO(node) ? 'loadedmetadata' : 'load');
/**
 * How long to wait before treating a request as dead.
 *
 * Once the relay is out of the picture the only remaining explanation is a
 * slow-but-live connection, and the right response to slow is patience, not
 * more requests — so the budget doubles rather than churning through every
 * host on a connection that would have delivered given a moment.
 */
const stallMs = (node) => (IS_VIDEO(node) ? SLOW_VIDEO_MS : SLOW_IMAGE_MS) * (node.dataset.relayTried ? 2 : 1);

/**
 * How many assets the relay has had to rescue.
 *
 * On a network where Steam's CDN is simply unreachable — some ISPs, some
 * countries, a lot of school and office networks — *every* asset costs a
 * three-second wait before it is retried. After a few rescues we stop
 * pretending the CDN might work and route new ones through the relay
 * immediately, which turns a page that trickles in over a minute into one that
 * loads at once. Images and video share the counter deliberately: a network
 * that cannot reach Steam's image hosts cannot reach its video hosts either,
 * and a trailer should not have to rediscover that on its own.
 */
let rescues = 0;
const RESCUES_BEFORE_PROXY_FIRST = 4;

export const proxyFirst = () => Boolean(mediaProxyBase) && rescues >= RESCUES_BEFORE_PROXY_FIRST;

/** Reset the learned routing — used when the relay changes. */
export function resetProxyLearning() {
  rescues = 0;
}

/**
 * Point an element at a URL.
 *
 * A `<video>` needs `load()` to pick up a new `src`, and it must not lose its
 * place in the world: one that was playing carries on playing, so switching
 * CDN host mid-trailer is invisible rather than a stop.
 */
function setSource(node, url) {
  if (!IS_VIDEO(node)) {
    node.src = url;
    return;
  }
  const wasPlaying = !node.paused && !node.ended;
  node.src = url;
  node.load();
  if (wasPlaying) {
    node.play().catch(() => {
      /* autoplay rules — the controls are right there */
    });
  }
}

/** Send this asset through the relay, remembering where it came from. */
function routeViaRelay(node, url) {
  const viaRelay = proxied(url);
  if (!viaRelay) return false;
  if (!node.dataset.originalSrc) node.dataset.originalSrc = url;
  node.dataset.proxied = '1';
  setSource(node, viaRelay);
  return true;
}

/** Move an element on to the next candidate URL in its fallback chain. */
function advanceMedia(node) {
  // Getting here while pointed at the relay means the relay could not serve
  // this either. Record that and go back to being "direct", because
  // `proxied` describes the *current* source — leaving it set was what
  // silently disabled every later stall timer, so one failed relay attempt
  // dropped the element back to error-only walking and it hung on the next
  // unresponsive host indefinitely.
  if (node.dataset.proxied === '1') {
    node.dataset.relayTried = '1';
    delete node.dataset.proxied;
  }

  const remaining = (node.dataset.fallback || '').split('|').filter(Boolean);
  const candidate = remaining.shift();
  node.dataset.fallback = remaining.join('|');

  if (candidate) {
    // Once the CDN has proved unreachable, do not spend another few seconds
    // finding that out again for every alternate host.
    if (!node.dataset.relayTried && proxyFirst() && isSteamAsset(candidate)) {
      const viaRelay = proxied(candidate);
      if (viaRelay) {
        node.dataset.originalSrc = candidate;
        node.dataset.proxied = '1';
        setSource(node, viaRelay);
        watchMedia(node, viaRelay);
        return;
      }
    }
    watchMedia(node, candidate);
    setSource(node, candidate);
    return;
  }

  // Last resort: pull it through the relay, which often has a better route to
  // Steam than the visitor does.
  if (!node.dataset.relayTried && routeViaRelay(node, node.dataset.originalSrc || node.currentSrc || node.src)) {
    rescues += 1;
    return;
  }

  // If the relay could not serve it either, go back to the URL Steam gave us
  // and let the browser keep trying — a slow asset must never end up worse off
  // than if it had never been re-routed.
  if (node.dataset.relayTried && node.dataset.originalSrc && node.dataset.reverted !== '1') {
    node.dataset.reverted = '1';
    setSource(node, node.dataset.originalSrc);
    return;
  }

  // Every host and the relay have all been tried. Say so out loud so a caller
  // that can offer something better than a blank box gets the chance.
  node.dispatchEvent(new CustomEvent('media-exhausted', { bubbles: false }));
  node.removeAttribute('src');
  node.classList.add('is-missing');
  node.parentElement?.classList.add('has-missing-image');
}

/**
 * Give a URL its stall budget to produce something, then do something else.
 *
 * This is the part a plain `error` listener cannot do: a request that hangs
 * never fails, it just never finishes, so a timer is the only signal there is.
 * It is why a blocked CDN used to leave a trailer spinning forever on a black
 * frame with a list of working alternates sitting untouched beside it.
 *
 * The relay gets first refusal, because it usually has a route this network
 * does not. Once it has been tried and failed, a stall instead moves to the
 * next host — the point is that *every* dead end has a time limit, not just
 * the ones polite enough to report an error.
 */
function watchMedia(node, url) {
  clearTimeout(Number(node.dataset.slowTimer) || 0);

  const canRelay = Boolean(mediaProxyBase) && !node.dataset.relayTried && !node.dataset.proxied && isSteamAsset(url);
  const canAdvance = Boolean(node.dataset.fallback) || (Boolean(mediaProxyBase) && !node.dataset.relayTried);
  if (!canRelay && !canAdvance) return;

  const timer = setTimeout(() => {
    if (hasArrived(node)) return;
    if (canRelay && routeViaRelay(node, url)) {
      rescues += 1;
      // The relay can hang too; it does not get an unlimited turn either.
      watchMedia(node, proxied(url) || url);
      return;
    }
    advanceMedia(node);
  }, stallMs(node));

  node.dataset.slowTimer = String(timer);
  node.addEventListener(arrivalEvent(node), () => clearTimeout(timer), { once: true });
}

/**
 * Start the stall clock only once the browser has actually begun fetching.
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
            if (url && !hasArrived(entry.target)) watchMedia(entry.target, url);
          }
        },
        // Match the browser's own lazy-loading margin closely enough that the
        // timer starts when the request does.
        { rootMargin: '200px' },
      );

function watchWhenVisible(node, url) {
  if (!viewportWatcher || node.loading !== 'lazy') {
    watchMedia(node, url);
    return;
  }
  pendingWatch.set(node, url);
  viewportWatcher.observe(node);
}

/**
 * Keep every Steam image *and* every Steam video on the page working.
 *
 * Three things can go wrong and each has a different answer:
 *   • the asset moved between CDN hosts — walk `data-fallback`;
 *   • the CDN 404s outright — same, then the relay;
 *   • the CDN is slow or blocked from this network — the relay, on a timer,
 *     because a stalled request never reports an error.
 *
 * Assets without a fallback chain (avatars, screenshots, community art) get
 * the relay treatment too: they are the ones with no alternate host to try, so
 * the relay is their only route.
 */
export function attachMediaFallbacks(root = document) {
  for (const node of $$('img, video', root)) {
    if (node.dataset.fallbackBound) continue;

    const src = node.getAttribute('src');
    const chained = node.hasAttribute('data-fallback');
    // Anything not from Steam and without a chain is somebody else's problem.
    // A <video> with no src at all is a MediaSource player — leave it alone.
    if (!chained && !(src && isSteamAsset(src))) continue;

    node.dataset.fallbackBound = '1';
    if (src) node.dataset.originalSrc = src;

    node.addEventListener('error', () => advanceMedia(node));

    if (!src) {
      advanceMedia(node);
    } else if (!IS_VIDEO(node) && node.complete && node.naturalWidth === 0) {
      // The browser starts loading as soon as innerHTML is assigned, which is
      // before this listener exists, so a failure may already have happened.
      advanceMedia(node);
    } else if (proxyFirst() && isSteamAsset(src)) {
      if (routeViaRelay(node, src)) watchMedia(node, proxied(src) || src);
    } else if (!hasArrived(node)) {
      watchWhenVisible(node, src);
    }
  }
}

/** Kept as the name every view already calls; video is covered too now. */
export const attachImageFallbacks = attachMediaFallbacks;

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

  // No relay URLs appended here any more: `attachMediaFallbacks` walks this
  // list and falls through to the relay itself once it runs out, on a stall as
  // well as on an error, which is the case a hand-appended source could never
  // cover — a hung request never fails, so the player just spun forever.
  return expanded.filter((url, index, all) => url && all.indexOf(url) === index);
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
