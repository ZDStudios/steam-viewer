/** Boot, header wiring and the hash router. */
import * as account from './account.js?v=2026-08-05.2';
import { normalizeBase, Relay } from './client.js?v=2026-08-05.2';
import { toast } from './components.js?v=2026-08-05.2';
import { $, $$, attachImageFallbacks, debounce, esc, escAttr, formatMoney, REGIONS, scrollToTop, setMediaProxy } from './util.js?v=2026-08-05.2';
import * as wishlist from './wishlist.js?v=2026-08-05.2';
import {
  aboutView,
  appView,
  browseView,
  creatorView,
  diagnosticsView,
  genreView,
  homeView,
  libraryView,
  playView,
  searchView,
  usersView,
  watchView,
  wishlistView,
} from './views.js?v=2026-08-05.2';

const CONFIG = window.STEAM_VIEWER_CONFIG || {};
const LS = {
  server: 'steam-viewer:server',
  region: 'steam-viewer:region',
};

const FALLBACK_GENRES = [
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

/* ------------------------------------------------------------------ *
 * Shared context handed to every view
 * ------------------------------------------------------------------ */

const relay = new Relay(resolveServerUrl());

const ctx = {
  relay,
  region: localStorage.getItem(LS.region) || CONFIG.defaultCountry || 'us',
  language: CONFIG.defaultLanguage || 'english',
  setTitle(title) {
    document.title = title;
  },
  navigate(hash) {
    window.location.hash = hash;
  },
};

function resolveServerUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get('server');
  if (fromQuery) {
    const normalized = normalizeBase(fromQuery);
    if (normalized) {
      localStorage.setItem(LS.server, normalized);
      return normalized;
    }
  }
  return normalizeBase(localStorage.getItem(LS.server) || CONFIG.serverUrl || '');
}

/* ------------------------------------------------------------------ *
 * Header: connection pill, region, settings, genres
 * ------------------------------------------------------------------ */

const connPill = $('#conn-pill');
const footServer = $('#foot-server');

const CONN_LABELS = {
  idle: ['conn--connecting', 'Starting…'],
  connecting: ['conn--connecting', 'Connecting…'],
  online: ['conn--online', 'Live'],
  rest: ['conn--rest', 'HTTP mode'],
  offline: ['conn--offline', 'Offline'],
};

relay.on('state', ({ state, detail, baseUrl }) => {
  const [className, label] = CONN_LABELS[state] || CONN_LABELS.offline;
  connPill.className = `conn ${className}`;
  $('.conn__label', connPill).textContent = label;
  connPill.title = detail ? `${label} — ${detail}` : label;
  footServer.textContent = baseUrl ? `relay: ${baseUrl} · page ${CLIENT_BUILD}` : 'relay: not configured';
});

relay.on('hello', (capabilities) => {
  populateGenres(capabilities?.genres || FALLBACK_GENRES);
  // Only route assets through a relay that actually serves /media.
  setMediaProxy(relay.baseUrl, { enabled: (capabilities?.features || []).includes('media-proxy') });
});

connPill.addEventListener('click', () => openSettings());

/* Wishlist counter in the primary nav */
const wishCount = $('#wish-count');
function paintWishCount() {
  const total = wishlist.count();
  wishCount.textContent = String(total);
  wishCount.hidden = total === 0;
}
paintWishCount();
wishlist.onChange(paintWishCount);

/* Region selector */
const regionSelect = $('#region-select');
regionSelect.innerHTML = REGIONS.map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
regionSelect.value = ctx.region;
regionSelect.addEventListener('change', () => {
  ctx.region = regionSelect.value;
  localStorage.setItem(LS.region, ctx.region);
  toast(`Store region set to ${regionSelect.selectedOptions[0].textContent}`, 'ok', 3000);
  route(true);
});

/* Genre dropdown */
const genreDropdown = $('#genre-dropdown');
const genreToggle = $('.dropdown__toggle', genreDropdown);
const genreMenu = $('.dropdown__menu', genreDropdown);

function populateGenres(genres) {
  genreMenu.innerHTML = genres
    .map((genre) => `<a href="#/genre/${encodeURIComponent(genre)}" role="menuitem">${esc(genre)}</a>`)
    .join('');
}
populateGenres(FALLBACK_GENRES);

const closeGenres = () => {
  if (genreMenu.hidden) return;
  genreMenu.hidden = true;
  genreToggle.setAttribute('aria-expanded', 'false');
};

/**
 * Put the menu under its button.
 *
 * The menu is `position: fixed` because the nav strip it lives in scrolls
 * horizontally, and a scroll container clips absolutely-positioned children —
 * which is what made this button look like it did nothing at all. Fixed
 * positioning escapes the clip but means the coordinates have to be worked out
 * here, against the viewport.
 */
const placeGenres = () => {
  const button = genreToggle.getBoundingClientRect();
  genreMenu.style.top = `${Math.round(button.bottom + 4)}px`;
  // Keep it on screen when the button is near the right-hand edge.
  const width = genreMenu.offsetWidth || 210;
  const left = Math.min(button.left, Math.max(8, window.innerWidth - width - 8));
  genreMenu.style.left = `${Math.round(left)}px`;
};

const openGenres = () => {
  genreMenu.hidden = false;
  placeGenres();
  genreToggle.setAttribute('aria-expanded', 'true');
};

genreToggle.addEventListener('click', () => {
  if (genreMenu.hidden) openGenres();
  else closeGenres();
});

// Anchored to the viewport, so anything that moves the button moves the menu.
window.addEventListener('scroll', () => (genreMenu.hidden ? undefined : placeGenres()), { passive: true });
window.addEventListener('resize', () => (genreMenu.hidden ? undefined : placeGenres()));
$('.storenav__links')?.addEventListener('scroll', () => (genreMenu.hidden ? undefined : placeGenres()), { passive: true });

document.addEventListener('click', (event) => {
  if (!genreDropdown.contains(event.target) && !genreMenu.contains(event.target)) closeGenres();
});
// Picking a genre has to close the menu: the click is inside the dropdown, so
// the handler above deliberately leaves it open, and it would otherwise sit
// over the page it just navigated to.
genreMenu.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeGenres();
});
genreDropdown.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeGenres();
    genreToggle.focus();
  }
});

/* ------------------------------------------------------------------ *
 * Settings modal
 * ------------------------------------------------------------------ */

const settingsModal = $('#settings-modal');
const serverInput = $('#server-input');
const settingsStatus = $('#settings-status');

function openSettings(message = '') {
  serverInput.value = relay.baseUrl || '';
  settingsStatus.textContent = message;
  settingsStatus.className = `modal__note${message ? ' is-error' : ''}`;
  settingsModal.hidden = false;
  serverInput.focus();
  serverInput.select();
}

function closeSettings() {
  settingsModal.hidden = true;
}

$('#settings-btn').addEventListener('click', () => openSettings());
$('#settings-cancel').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) closeSettings();
});

$('#settings-save').addEventListener('click', async () => {
  const normalized = normalizeBase(serverInput.value);
  if (!normalized) {
    settingsStatus.textContent = 'That does not look like a URL.';
    settingsStatus.className = 'modal__note is-error';
    return;
  }

  settingsStatus.textContent = 'Contacting the relay (a sleeping Render service can take up to a minute)…';
  settingsStatus.className = 'modal__note';

  localStorage.setItem(LS.server, normalized);
  relay.setBaseUrl(normalized);

  const awake = await relay.warm();
  if (awake) {
    settingsStatus.textContent = 'Connected.';
    settingsStatus.className = 'modal__note is-ok';
    setTimeout(() => {
      closeSettings();
      route(true);
    }, 500);
  } else {
    settingsStatus.textContent = 'No answer yet. Double-check the URL — the page will keep retrying in the background.';
    settingsStatus.className = 'modal__note is-error';
  }
});

/* ------------------------------------------------------------------ *
 * Search box + live suggestions
 * ------------------------------------------------------------------ */

const searchForm = $('#searchbox');
const searchInput = $('#search-input');
const suggestBox = $('#suggest');
let suggestIndex = -1;
let suggestItems = [];

const closeSuggest = () => {
  suggestBox.hidden = true;
  suggestIndex = -1;
};

const runSuggest = debounce(async (term) => {
  if (term.length < 2 || !relay.configured) {
    closeSuggest();
    return;
  }

  suggestBox.hidden = false;
  suggestBox.innerHTML = '<div class="suggest__empty">Searching…</div>';

  try {
    const result = await ctx.relay.request('search', { term, cc: ctx.region, l: ctx.language, limit: 8 }, { timeoutMs: 20_000 });
    suggestItems = (result.items || []).slice(0, 8);

    if (suggestItems.length === 0) {
      suggestBox.innerHTML = `<div class="suggest__empty">No store results for “${esc(term)}”.</div>`;
      return;
    }

    suggestBox.innerHTML = suggestItems
      .map((item, index) => {
        const price = item.price?.isFree
          ? 'Free'
          : item.price?.final !== undefined
            ? formatMoney(item.price.final, item.price.currency)
            : '';
        return `<div class="suggest__row" data-index="${index}" data-appid="${item.appid}">
            <img src="${escAttr(item.header)}" alt="" loading="lazy" />
            <span class="suggest__name">${esc(item.name)}</span>
            <span class="suggest__price">${esc(price)}</span>
          </div>`;
      })
      .join('');
    attachImageFallbacks(suggestBox);
  } catch (error) {
    suggestBox.innerHTML = `<div class="suggest__empty">${esc(error.message)}</div>`;
  }
}, 280);

searchInput.addEventListener('input', () => runSuggest(searchInput.value.trim()));
searchInput.addEventListener('focus', () => {
  if (suggestItems.length && searchInput.value.trim().length >= 2) suggestBox.hidden = false;
});

searchInput.addEventListener('keydown', (event) => {
  if (suggestBox.hidden) return;
  const rows = $$('.suggest__row', suggestBox);
  if (!rows.length) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    suggestIndex = (suggestIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((row, index) => row.classList.toggle('is-active', index === suggestIndex));
    rows[suggestIndex].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && suggestIndex >= 0) {
    event.preventDefault();
    const appid = rows[suggestIndex].dataset.appid;
    closeSuggest();
    searchInput.blur();
    window.location.hash = `#/app/${appid}`;
  } else if (event.key === 'Escape') {
    closeSuggest();
  }
});

suggestBox.addEventListener('click', (event) => {
  const row = event.target.closest('.suggest__row');
  if (!row) return;
  closeSuggest();
  window.location.hash = `#/app/${row.dataset.appid}`;
});

document.addEventListener('click', (event) => {
  if (!searchForm.contains(event.target)) closeSuggest();
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const term = searchInput.value.trim();
  closeSuggest();
  searchInput.blur();
  if (term) window.location.hash = `#/search/${encodeURIComponent(term)}`;
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const main = $('#main');
let cleanup = null;
let routeToken = 0;

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, ...rest] = raw.split('/');
  return { path: path || '', arg: rest.join('/') };
}

function markActiveNav(path) {
  const map = {
    '': 'home',
    search: 'home',
    app: 'home',
    genre: 'home',
    developer: 'home',
    publisher: 'home',
    browse: 'charts',
    library: 'library',
    users: 'library',
    wishlist: 'wishlist',
    play: 'play',
    watch: 'play',
    about: 'about',
  };
  const active = path === 'browse' && parseHash().arg !== 'mostplayed' ? 'home' : map[path] || 'home';
  $$('.topbar__nav a').forEach((link) => link.classList.toggle('is-active', link.dataset.nav === active));

  const sub = path === '' ? 'home' : path === 'browse' ? parseHash().arg : '';
  $$('.storenav__links a').forEach((link) => link.classList.toggle('is-active', link.dataset.sub === sub));
}

async function route(force = false) {
  const { path, arg } = parseHash();
  const token = ++routeToken;

  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (error) {
      console.error('[router] cleanup failed', error);
    }
    cleanup = null;
  }

  markActiveNav(path);
  scrollToTop();

  if (!relay.configured) {
    main.innerHTML = welcomeHtml();
    $('#welcome-configure')?.addEventListener('click', () => openSettings());
    return;
  }

  let result;
  try {
    switch (path) {
      case '':
      case 'home':
        result = await homeView(main, ctx);
        break;
      case 'search':
        result = await searchView(main, ctx, decodeURIComponent(arg || ''));
        break;
      case 'app':
        result = await appView(main, ctx, arg);
        break;
      case 'genre':
        result = await genreView(main, ctx, arg);
        break;
      case 'browse':
        result = await browseView(main, ctx, arg);
        break;
      case 'library':
        result = await libraryView(main, ctx, arg);
        break;
      case 'users':
        result = await usersView(main, ctx, arg);
        break;
      case 'wishlist':
        result = wishlistView(main, ctx);
        break;
      case 'play':
        result = await playView(main, ctx);
        break;
      case 'watch':
        result = await watchView(main, ctx, arg);
        break;
      case 'developer':
        result = await creatorView(main, ctx, 'developer', arg);
        break;
      case 'publisher':
        result = await creatorView(main, ctx, 'publisher', arg);
        break;
      case 'about':
        result = aboutView(main, ctx);
        break;
      case 'diagnostics':
        result = await diagnosticsView(main, ctx);
        break;
      default:
        main.innerHTML = '<div class="empty"><h2>Page not found</h2><p><a href="#/">Back to the store</a></p></div>';
    }
  } catch (error) {
    console.error('[router] view failed', error);
    main.innerHTML = `<div class="empty"><h2>Something broke rendering this page</h2><p>${esc(error.message)}</p></div>`;
  }

  // A newer navigation started while this one was awaiting data.
  if (token !== routeToken) {
    if (typeof result === 'function') result();
    return;
  }
  cleanup = typeof result === 'function' ? result : null;
  void force;
}

function welcomeHtml() {
  return `<div class="empty">
    <h2>Connect your relay to get started</h2>
    <p style="max-width:560px;margin:0 auto">
      This site reads the live Steam catalogue through a small relay you deploy yourself. Deploy the
      <code>server/</code> folder of this repository to Render, then paste the service URL here.
    </p>
    <p style="margin-top:18px">
      <button class="btn btn--green" type="button" id="welcome-configure">Enter relay URL</button>
      <a class="btn btn--ghost" href="#/about">How it works</a>
    </p>
  </div>`;
}

window.addEventListener('hashchange', () => route());

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

/* A sign-in that has just come back from Steam lands here, before routing. */
const signIn = account.consumeRedirect();
if (signIn?.steamid) {
  toast('Signed in through Steam', 'ok', 4000);
  window.location.hash = `#/library/${signIn.steamid}`;
} else if (signIn?.error) {
  toast(signIn.error, 'error', 8000);
}

if (!window.location.hash) window.location.replace(`${window.location.pathname}${window.location.search}#/`);

/** What this copy of the page is; shown in diagnostics and the footer. */
export const CLIENT_BUILD = CONFIG.build || '2026-08-05.2';
window.STEAM_VIEWER_CLIENT_BUILD = CLIENT_BUILD;

async function loadCapabilities() {
  try {
    const caps = await relay.request('capabilities', {}, { timeoutMs: 75_000 });
    relay.capabilities = caps;
    populateGenres(caps?.genres || FALLBACK_GENRES);
    setMediaProxy(relay.baseUrl, { enabled: (caps?.features || []).includes('media-proxy') });
  } catch {
    // Not fatal: the page works, assets just never route through the relay.
  }
}

if (relay.configured) {
  relay.connect();
  loadCapabilities();
  // Render's free tier sleeps; nudge it awake in parallel with the first view.
  relay.warm().then((awake) => {
    if (!awake && relay.state !== 'online') {
      toast('The relay is not answering yet — still retrying.', 'error', 7000);
    }
  });
} else {
  relay.setState('offline', 'No relay server configured');
  setTimeout(() => openSettings(), 400);
}

route();

window.addEventListener('beforeunload', () => relay.disconnect());
