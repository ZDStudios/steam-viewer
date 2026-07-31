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
  mediaProxyBase = enabled ? String(baseUrl || '').replace(/\/+$/, '') : '';
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

/** Move an image on to the next candidate URL in its fallback chain. */
function advanceImage(img) {
  const remaining = (img.dataset.fallback || '').split('|').filter(Boolean);
  const candidate = remaining.shift();
  img.dataset.fallback = remaining.join('|');

  if (candidate) {
    watchImage(img, candidate);
    img.src = candidate;
    return;
  }

  // Last resort: pull it through the relay, which often has a better route to
  // Steam than the visitor does.
  const viaRelay = img.dataset.proxied ? null : proxied(img.dataset.originalSrc || img.currentSrc || img.src);
  if (viaRelay) {
    img.dataset.proxied = '1';
    img.src = viaRelay;
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
 * from others, and a stalled request never fires `error`.
 */
function watchImage(img, url) {
  clearTimeout(Number(img.dataset.slowTimer) || 0);
  if (!mediaProxyBase || img.dataset.proxied) return;

  const timer = setTimeout(() => {
    if (img.complete && img.naturalWidth > 0) return;
    const viaRelay = proxied(url);
    if (!viaRelay) return;
    img.dataset.proxied = '1';
    img.src = viaRelay;
  }, SLOW_IMAGE_MS);

  img.dataset.slowTimer = String(timer);
  img.addEventListener('load', () => clearTimeout(timer), { once: true });
}

/**
 * Swap in the next CDN candidate when a Steam asset 404s — common for older
 * apps, and for art Valve has moved between hosts — and fall back to the
 * relay for anything slow or blocked.
 */
export function attachImageFallbacks(root = document) {
  for (const img of $$('img[data-fallback]', root)) {
    if (img.dataset.fallbackBound) continue;
    img.dataset.fallbackBound = '1';

    const src = img.getAttribute('src');
    if (src) img.dataset.originalSrc = src;

    img.addEventListener('error', () => advanceImage(img));

    // The browser starts loading as soon as innerHTML is assigned, which is
    // before this listener exists. Anything that already failed (or was given
    // an empty src) has to be caught by hand.
    if (!src) advanceImage(img);
    else if (img.complete && img.naturalWidth === 0) advanceImage(img);
    else if (!img.complete) watchImage(img, src);
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
