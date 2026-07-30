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

/** Swap in a placeholder when a Steam CDN asset 404s (common for old apps). */
export function attachImageFallbacks(root = document) {
  for (const img of $$('img[data-fallback]', root)) {
    if (img.dataset.fallbackBound) continue;
    img.dataset.fallbackBound = '1';
    img.addEventListener(
      'error',
      () => {
        const next = (img.dataset.fallback || '').split('|').filter(Boolean);
        const candidate = next.shift();
        img.dataset.fallback = next.join('|');
        if (candidate) {
          img.src = candidate;
        } else {
          img.removeAttribute('src');
          img.classList.add('is-missing');
          img.parentElement?.classList.add('has-missing-image');
        }
      },
      { once: false },
    );
  }
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
