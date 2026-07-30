/** Reusable pieces of Steam-flavoured UI: cards, price blocks, media player,
 *  carousel, lightbox and toasts. */
import { $, $$, el, esc, escAttr, formatMoney } from './util.js';
import { wishlist } from './wishlist.js';

/* ------------------------------------------------------------------ *
 * Card registry
 *
 * Cards are rendered as HTML strings, so a click on one has nothing but an
 * appid to go on. Every card that gets rendered leaves its data here, which
 * is what the wishlist button adds when it is pressed.
 * ------------------------------------------------------------------ */

const known = new Map();

export function rememberCards(items = []) {
  for (const item of items) {
    if (item && Number.isFinite(Number(item.appid))) known.set(Number(item.appid), item);
  }
}

export function knownCard(appid) {
  return known.get(Number(appid)) || null;
}

/* ------------------------------------------------------------------ *
 * Atoms
 * ------------------------------------------------------------------ */

const ICON = {
  windows: '<svg viewBox="0 0 24 24" aria-label="Windows"><path fill="currentColor" d="M3 5.6 10.2 4.6v6.7H3Zm0 12.8 7.2 1V12.7H3Zm8.5 1.2L21 21V12.7h-9.5Zm0-15.2v7.9H21V3Z"/></svg>',
  mac: '<svg viewBox="0 0 24 24" aria-label="macOS"><path fill="currentColor" d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.8-3.5.8s-1.8-.8-3-.8c-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 .8 1.1 1.7 2.3 2.9 2.2 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.2 1.2-2.4 1.2-2.5 0 0-2.4-.9-2.4-3.5ZM14.2 5.3c.6-.8 1-1.9.9-3-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.8-.9 2.9 1 0 2-.5 2.7-1.3Z"/></svg>',
  linux: '<svg viewBox="0 0 24 24" aria-label="Linux"><path fill="currentColor" d="M12 2c2.2 0 3.4 1.8 3.4 4.3 0 1.5.4 2.3 1.2 3.5 1.1 1.6 2.6 3.4 2.6 5.7 0 1-.4 1.8-.4 2.6 0 1 .8 1.3.8 2.1 0 1-1.5 1.8-4 1.8-1.9 0-2.9-.6-3.6-.6s-1.7.6-3.6.6c-2.5 0-4-.8-4-1.8 0-.8.8-1.1.8-2.1 0-.8-.4-1.6-.4-2.6 0-2.3 1.5-4.1 2.6-5.7.8-1.2 1.2-2 1.2-3.5C8.6 3.8 9.8 2 12 2Zm-1.7 4.1c-.5 0-.8.5-.8 1.1s.3 1.1.8 1.1.9-.5.9-1.1-.4-1.1-.9-1.1Zm3.4 0c-.5 0-.9.5-.9 1.1s.4 1.1.9 1.1.8-.5.8-1.1-.3-1.1-.8-1.1Z"/></svg>',
};

export function platformsHtml(platforms = {}) {
  const parts = [];
  if (platforms.windows) parts.push(ICON.windows);
  if (platforms.mac) parts.push(ICON.mac);
  if (platforms.linux) parts.push(ICON.linux);
  if (parts.length === 0) return '';
  return `<span class="platforms">${parts.join('')}</span>`;
}

export function priceHtml(price) {
  if (!price) return '<span class="price"><span class="price__now">—</span></span>';

  if (price.isFree) {
    return '<span class="price price--free"><span class="price__now">Free To Play</span></span>';
  }

  const currency = price.currency || 'USD';
  const final = price.finalFormatted || formatMoney(price.final, currency);

  if (price.discountPercent > 0 && price.initial > price.final) {
    const was = price.initialFormatted || formatMoney(price.initial, currency);
    return `<span class="price">
        <span class="price__cut">-${price.discountPercent}%</span>
        <span class="price__stack">
          <span class="price__was">${esc(was)}</span>
          <span class="price__final">${esc(final)}</span>
        </span>
      </span>`;
  }

  if (price.final === 0) {
    return '<span class="price price--free"><span class="price__now">Free</span></span>';
  }

  return `<span class="price"><span class="price__now">${esc(final)}</span></span>`;
}

/** Steam's CDN 404s on a fair number of older capsules — chain the fallbacks. */
function imageChain(item, primary) {
  const appid = item.appid;
  const chain = [
    item.header,
    item.capsule,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
  ].filter((url, index, all) => url && url !== primary && all.indexOf(url) === index);
  return chain.join('|');
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

/** The heart button every card and game page shares. */
export function wishButtonHtml(appid, { size = 'sm', label = false } = {}) {
  const on = wishlist.has(appid);
  return `<button class="wishbtn wishbtn--${esc(size)}${on ? ' is-on' : ''}" type="button" data-wish="${Number(appid)}"
      aria-pressed="${on}" title="${on ? 'On your wishlist' : 'Add to your wishlist'}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.7-9.6-9A5.4 5.4 0 0 1 12 6.6 5.4 5.4 0 0 1 21.6 12c-2.1 4.3-9.6 9-9.6 9Z"/></svg>
    ${label ? `<span>${on ? 'On wishlist' : 'Wishlist'}</span>` : ''}
    <span class="sr-only">${on ? 'Remove from wishlist' : 'Add to wishlist'}</span>
  </button>`;
}

export function cardHtml(item, { rank = null, live = null, wish = true } = {}) {
  if (!item) return '';
  rememberCards([item]);

  const primary = item.header || item.capsule || '';
  const tags = (item.genres || []).slice(0, 3).join(', ');
  const meta = item.releaseDate && !tags ? item.releaseDate : tags;
  const preview = item.preview?.src || null;

  return `<a class="card" href="#/app/${item.appid}" data-appid="${item.appid}">
    <div class="card__shot"${preview ? ` data-preview="${escAttr(preview)}" data-preview-type="${escAttr(item.preview.type || 'video/mp4')}"` : ''}>
      <img src="${escAttr(primary)}" data-fallback="${escAttr(imageChain(item, primary))}"
           alt="${escAttr(item.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      ${rank ? `<span class="card__rank">#${rank}</span>` : ''}
      ${item.hasVideo ? '<span class="card__video">TRAILER</span>' : ''}
      ${wish ? wishButtonHtml(item.appid) : ''}
    </div>
    <div class="card__body">
      <div class="card__name" title="${escAttr(item.name)}">${esc(item.name)}</div>
      <div class="card__meta">
        ${platformsHtml(item.platforms)}
        ${meta ? `<span class="card__tags">${esc(meta)}</span>` : '<span></span>'}
        ${priceHtml(item.price)}
      </div>
      ${live ? `<div class="card__live">${esc(live)}</div>` : ''}
    </div>
  </a>`;
}

export function portraitCardHtml(game, { subtitle = '', badge = '', wish = false, installed = false, action = null } = {}) {
  rememberCards([game]);
  const portrait = game.portrait || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/library_600x900.jpg`;

  return `<a class="pcard${installed ? ' pcard--installed' : ''}" href="#/app/${game.appid}" title="${escAttr(game.name)}" data-appid="${game.appid}">
    <span class="pcard__fallback">${esc(game.name)}</span>
    <img class="pcard__img" src="${escAttr(portrait)}"
         data-fallback="${escAttr([game.capsule, game.header].filter(Boolean).join('|'))}"
         alt="${escAttr(game.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    ${badge ? `<span class="pcard__badge">${esc(badge)}</span>` : ''}
    ${wish ? wishButtonHtml(game.appid) : ''}
    ${action ? `<span class="pcard__action"><button class="btn btn--green btn--sm" type="button" data-play="${game.appid}">${esc(action)}</button></span>` : ''}
    <span class="pcard__foot"><span>${esc(game.name)}</span>${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</span>
  </a>`;
}

/**
 * Wire every wishlist button under `root`.
 *
 * Delegated from one listener so freshly painted grids need no re-binding,
 * and re-rendered in place on change so two copies of the same card (a rail
 * and a grid, say) never disagree.
 */
export function mountWishButtons(root = document) {
  const paint = () => {
    for (const button of $$('[data-wish]', root)) {
      const on = wishlist.has(button.dataset.wish);
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
      button.title = on ? 'On your wishlist' : 'Add to your wishlist';
      const text = $('span:not(.sr-only)', button);
      if (text) text.textContent = on ? 'On wishlist' : 'Wishlist';
      const label = $('.sr-only', button);
      if (label) label.textContent = on ? 'Remove from wishlist' : 'Add to wishlist';
    }
  };

  const onClick = (event) => {
    const button = event.target.closest('[data-wish]');
    if (!button || !root.contains(button)) return;

    // The button sits inside the card's own <a>, so the click has to be
    // stopped here or pressing the heart navigates to the game page.
    event.preventDefault();
    event.stopPropagation();

    const appid = Number(button.dataset.wish);
    const item = knownCard(appid) || { appid, name: button.closest('[data-appid]')?.querySelector('.card__name')?.textContent || `App ${appid}` };
    const added = wishlist.toggle(item);
    paint();
    toast(added ? `${item.name} added to your wishlist` : `${item.name} removed from your wishlist`, added ? 'ok' : 'info', 2600);
  };

  // Capture, so the anchor never sees the click at all.
  root.addEventListener('click', onClick, true);
  const off = wishlist.on(paint);
  paint();

  return () => {
    root.removeEventListener('click', onClick, true);
    off();
  };
}

/**
 * Silent, looping trailer preview on hover — the little clips Steam plays in
 * its own capsules. Muted and `playsinline`, so no autoplay policy blocks it,
 * and skipped entirely when the visitor asked for reduced motion.
 */
export function mountCardPreviews(root = document) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  const playing = new Map();

  const start = (shot) => {
    if (playing.has(shot) || !shot.dataset.preview) return;

    const video = document.createElement('video');
    video.className = 'card__preview';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.disableRemotePlayback = true;
    video.src = shot.dataset.preview;

    // A preview that will not load is not worth a second attempt.
    video.addEventListener('error', () => {
      delete shot.dataset.preview;
      video.remove();
      playing.delete(shot);
    });

    shot.appendChild(video);
    playing.set(shot, video);
    video.play().catch(() => {
      video.remove();
      playing.delete(shot);
    });
  };

  const stop = (shot) => {
    const video = playing.get(shot);
    if (!video) return;
    video.pause();
    video.remove();
    playing.delete(shot);
  };

  const enter = (event) => {
    const shot = event.target.closest?.('.card__shot[data-preview]');
    if (shot) start(shot);
  };
  const leave = (event) => {
    const shot = event.target.closest?.('.card__shot');
    if (shot) stop(shot);
  };

  root.addEventListener('mouseenter', enter, true);
  root.addEventListener('mouseleave', leave, true);
  root.addEventListener('focusin', enter);
  root.addEventListener('focusout', leave);

  return () => {
    root.removeEventListener('mouseenter', enter, true);
    root.removeEventListener('mouseleave', leave, true);
    root.removeEventListener('focusin', enter);
    root.removeEventListener('focusout', leave);
    for (const shot of [...playing.keys()]) stop(shot);
  };
}

export function sectionHtml({ title, note = '', link = null, linkLabel = 'See all', body = '', layout = 'grid' }) {
  return `<section class="section">
    <div class="section__head">
      <h2 class="section__title">${esc(title)}${note ? `<small>${esc(note)}</small>` : ''}</h2>
      ${link ? `<a class="section__link" href="${escAttr(link)}">${esc(linkLabel)} &rsaquo;</a>` : ''}
    </div>
    ${
      // `raw` is for bodies that bring their own container, like railHtml().
      layout === 'raw'
        ? body
        : `<div class="${layout === 'rail' ? 'rail' : layout === 'portrait' ? 'grid grid--portrait' : 'grid'}">${body}</div>`
    }
  </section>`;
}

export function cardsHtml(items = [], options = {}) {
  return items
    .map((item, index) => cardHtml(item, { rank: options.ranked ? index + 1 : null, live: options.live?.(item), wish: options.wish !== false }))
    .join('');
}

/* ------------------------------------------------------------------ *
 * Home-page furniture
 * ------------------------------------------------------------------ */

/** The coloured genre tiles Steam runs down its own front page. */
const CATEGORY_TILES = [
  { label: 'Action', genre: 'Action', tint: '#a4231f' },
  { label: 'Adventure', genre: 'Adventure', tint: '#6b4c9a' },
  { label: 'RPG', genre: 'RPG', tint: '#2b6a9c' },
  { label: 'Strategy', genre: 'Strategy', tint: '#37744e' },
  { label: 'Simulation', genre: 'Simulation', tint: '#8a6a1f' },
  { label: 'Racing', genre: 'Racing', tint: '#b1541c' },
  { label: 'Sports', genre: 'Sports', tint: '#1f6f7a' },
  { label: 'Indie', genre: 'Indie', tint: '#8c3d6b' },
  { label: 'Casual', genre: 'Casual', tint: '#4a6f8a' },
  { label: 'Massively Multiplayer', genre: 'Massively Multiplayer', tint: '#3f5b8c' },
  { label: 'Free to Play', genre: 'Free to Play', tint: '#4c7a1a' },
  { label: 'Early Access', genre: 'Early Access', tint: '#7a5a2a' },
];

export function categoryTilesHtml() {
  return `<div class="cattiles">
    ${CATEGORY_TILES.map(
      (tile) => `<a class="cattile" href="#/genre/${encodeURIComponent(tile.genre)}" style="--tint:${escAttr(tile.tint)}">
        <span class="cattile__label">${esc(tile.label)}</span>
      </a>`,
    ).join('')}
  </div>`;
}

/** A compact horizontal row — the shape Steam uses for "Special Offers". */
export function railHtml(items = [], options = {}) {
  rememberCards(items);
  return `<div class="rail">${items
    .map((item) => {
      const primary = item.header || item.capsule || '';
      const discount = item.price?.discountPercent > 0 ? `<span class="railcard__cut">-${item.price.discountPercent}%</span>` : '';
      return `<a class="railcard" href="#/app/${item.appid}" data-appid="${item.appid}">
        <div class="card__shot"${item.preview?.src ? ` data-preview="${escAttr(item.preview.src)}"` : ''}>
          <img src="${escAttr(primary)}" data-fallback="${escAttr(imageChain(item, primary))}" alt="${escAttr(item.name)}"
               loading="lazy" decoding="async" referrerpolicy="no-referrer" />
          ${discount}
          ${options.wish === false ? '' : wishButtonHtml(item.appid)}
        </div>
        <div class="railcard__name">${esc(item.name)}</div>
        <div class="railcard__price">${priceHtml(item.price)}</div>
      </a>`;
    })
    .join('')}</div>`;
}

/** Developer / publisher credits, linked through to their own page. */
export function studioLinksHtml(names = [], role = 'developer') {
  if (!names?.length) return '';
  return names
    .map((name) => `<a href="#/${role === 'publisher' ? 'publisher' : 'developer'}/${encodeURIComponent(name)}">${esc(name)}</a>`)
    .join(', ');
}

export const skeletonGrid = (count = 8) =>
  `<div class="grid">${Array.from({ length: count }, () => '<div class="skeleton skeleton--card"></div>').join('')}</div>`;

export const skeletonPage = () =>
  `<div class="skeleton skeleton--hero"></div>
   ${skeletonGrid(8)}
   <p class="loading-note">Fetching live data from Steam…</p>`;

/* ------------------------------------------------------------------ *
 * Hero carousel
 * ------------------------------------------------------------------ */

const genreChips = (genres = []) =>
  (genres || [])
    .slice(0, 4)
    .map((genre) => `<span class="chip">${esc(genre)}</span>`)
    .join('');

export function heroHtml(items) {
  if (!items?.length) return '';
  return `<div class="hero" id="hero">
    <button class="hero__arrow hero__arrow--prev" type="button" aria-label="Previous">&#8249;</button>
    <button class="hero__arrow hero__arrow--next" type="button" aria-label="Next">&#8250;</button>
    <div class="hero__frame">
      <a class="hero__media" id="hero-media" href="#/app/${items[0].appid}">
        <img id="hero-img" src="${escAttr(items[0].capsule || items[0].header)}" alt="${escAttr(items[0].name)}" />
      </a>
      <div class="hero__side">
        <a class="hero__title" id="hero-title" href="#/app/${items[0].appid}">${esc(items[0].name)}</a>
        <div class="hero__desc" id="hero-desc">${esc(items[0].shortDescription || '')}</div>
        <div class="hero__tags" id="hero-tags">${genreChips(items[0].genres)}</div>
        <div class="hero__foot">
          <span id="hero-platforms">${platformsHtml(items[0].platforms)}</span>
          <span id="hero-price">${priceHtml(items[0].price)}</span>
        </div>
      </div>
    </div>
    <div class="hero__dots" id="hero-dots">
      ${items.map((_, index) => `<button class="hero__dot${index === 0 ? ' is-active' : ''}" type="button" data-index="${index}" aria-label="Slide ${index + 1}"></button>`).join('')}
    </div>
  </div>`;
}

export function mountHero(root, items, { intervalMs = 6500 } = {}) {
  const hero = $('#hero', root);
  if (!hero || !items?.length) return () => {};

  let index = 0;
  let timer = null;

  const media = $('#hero-media', hero);
  const img = $('#hero-img', hero);
  const title = $('#hero-title', hero);
  const desc = $('#hero-desc', hero);
  const price = $('#hero-price', hero);
  const platforms = $('#hero-platforms', hero);
  const tags = $('#hero-tags', hero);
  const dots = $$('.hero__dot', hero);

  const show = (next) => {
    index = (next + items.length) % items.length;
    const item = items[index];
    media.href = `#/app/${item.appid}`;
    title.href = `#/app/${item.appid}`;
    img.src = item.capsule || item.header;
    img.alt = item.name;
    title.textContent = item.name;
    desc.textContent = item.shortDescription || '';
    tags.innerHTML = genreChips(item.genres);
    price.innerHTML = priceHtml(item.price);
    platforms.innerHTML = platformsHtml(item.platforms);
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === index));
  };

  const start = () => {
    stop();
    if (items.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      timer = setInterval(() => show(index + 1), intervalMs);
    }
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  $('.hero__arrow--prev', hero).addEventListener('click', () => {
    show(index - 1);
    start();
  });
  $('.hero__arrow--next', hero).addEventListener('click', () => {
    show(index + 1);
    start();
  });
  dots.forEach((dot) =>
    dot.addEventListener('click', () => {
      show(Number(dot.dataset.index));
      start();
    }),
  );

  hero.addEventListener('mouseenter', stop);
  hero.addEventListener('mouseleave', start);
  start();

  return stop;
}

/* ------------------------------------------------------------------ *
 * Game media player (screenshots + trailers)
 * ------------------------------------------------------------------ */

export const isAnimated = (url) => /\.(?:gif|webp|apng)(?:[?#]|$)/i.test(String(url || ''));

export function playerHtml(media) {
  if (!media.length) {
    return '<div class="player"><div class="player__stage"><p class="loading-note">No media for this title.</p></div></div>';
  }

  return `<div class="player" id="player">
    <div class="player__stage" id="player-stage"></div>
    <div class="player__strip" id="player-strip">
      ${media
        .map(
          (entry, index) => `<button class="player__thumb${entry.kind === 'video' ? ' player__thumb--video' : ''}${
            entry.animated ? ' player__thumb--gif' : ''
          }${index === 0 ? ' is-active' : ''}"
              type="button" data-index="${index}" aria-label="${escAttr(entry.label || `Media ${index + 1}`)}">
              <img src="${escAttr(entry.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </button>`,
        )
        .join('')}
    </div>
  </div>`;
}

/**
 * The trailer / screenshot player.
 *
 * Trailers used to fail on every title. Two reasons, both fixed here:
 *
 *  1. the element carried `crossorigin="anonymous"`, which makes the browser
 *     insist on CORS headers that Steam's video CDN does not send — so the
 *     media element errored before it ever fetched a byte;
 *  2. only one URL was ever tried, and Steam's `max` rendition simply does
 *     not exist for a great many older trailers.
 *
 * So: no `crossorigin`, and every rendition the relay found is attached as a
 * `<source>`, best first, letting the browser walk down the list itself.
 *
 * @param {Array<{kind:'video'|'image', thumb:string, src?:string,
 *   sources?:Array<{src:string,type:string}>, poster?:string, label?:string,
 *   animated?:boolean}>} media
 */
export function mountPlayer(root, media, { onZoom } = {}) {
  const stage = $('#player-stage', root);
  const strip = $('#player-strip', root);
  if (!stage || !media.length) return;

  let current = 0;

  const renderVideo = (entry) => {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.disableRemotePlayback = false;
    if (entry.poster || entry.thumb) video.poster = entry.poster || entry.thumb;

    const sources = entry.sources?.length ? entry.sources : entry.src ? [{ src: entry.src, type: 'video/mp4' }] : [];
    for (const source of sources) {
      const node = document.createElement('source');
      node.src = source.src;
      if (source.type) node.type = source.type;
      video.appendChild(node);
    }

    // Fires once every <source> has failed.
    video.addEventListener('error', () => showVideoFallback(entry), { once: true });
    stage.appendChild(video);

    video.play().catch(() => {
      /* autoplay blocked — the controls are right there */
    });
  };

  const showVideoFallback = (entry) => {
    stage.replaceChildren();
    const poster = entry.poster || entry.thumb;
    if (poster) {
      const img = document.createElement('img');
      img.src = poster;
      img.alt = entry.label || 'Trailer';
      stage.appendChild(img);
    }
    const note = el(
      `<p class="player__fallback">This trailer would not play here.${
        entry.storeUrl ? ` <a href="${escAttr(entry.storeUrl)}" target="_blank" rel="noopener noreferrer">Watch it on Steam</a>.` : ''
      }</p>`,
    );
    stage.appendChild(note);
  };

  const renderImage = (entry, index) => {
    const img = document.createElement('img');
    img.src = entry.src;
    img.alt = entry.label || 'Screenshot';
    // Animated formats must not be lazy-decoded, or the first frame is all
    // that ever paints.
    if (entry.animated) {
      img.loading = 'eager';
      img.decoding = 'sync';
    } else {
      img.loading = 'eager';
      img.decoding = 'async';
    }
    img.referrerPolicy = 'no-referrer';
    stage.appendChild(img);

    if (entry.animated) stage.appendChild(el('<span class="player__gif">GIF</span>'));

    if (onZoom) {
      const zoom = el('<button class="player__zoom" type="button">⤢ Enlarge</button>');
      zoom.addEventListener('click', () => onZoom(index));
      stage.appendChild(zoom);
    }
  };

  const render = (index) => {
    current = index;
    const entry = media[index];
    stage.replaceChildren();

    if (entry.kind === 'video') renderVideo(entry);
    else renderImage(entry, index);

    $$('.player__thumb', strip).forEach((thumb, i) => thumb.classList.toggle('is-active', i === index));
  };

  strip.addEventListener('click', (event) => {
    const button = event.target.closest('.player__thumb');
    if (!button) return;
    render(Number(button.dataset.index));
    button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });

  render(0);
  return { show: render, get index() { return current; } };
}

/* ------------------------------------------------------------------ *
 * Lightbox
 * ------------------------------------------------------------------ */

export const lightbox = (() => {
  const root = $('#lightbox');
  const img = $('#lightbox-img');
  const counter = $('#lightbox-count');
  let images = [];
  let index = 0;

  const draw = () => {
    if (!images.length) return;
    index = (index + images.length) % images.length;
    img.src = images[index];
    counter.textContent = `${index + 1} / ${images.length}`;
  };

  const close = () => {
    root.hidden = true;
    img.removeAttribute('src');
    document.body.style.removeProperty('overflow');
  };

  const open = (list, startIndex = 0) => {
    images = list.filter(Boolean);
    if (!images.length) return;
    index = startIndex;
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    draw();
  };

  root?.addEventListener('click', (event) => {
    if (event.target === root || event.target.closest('.lightbox__close')) close();
    else if (event.target.closest('.lightbox__nav--prev')) {
      index -= 1;
      draw();
    } else if (event.target.closest('.lightbox__nav--next')) {
      index += 1;
      draw();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (root.hidden) return;
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft') {
      index -= 1;
      draw();
    }
    if (event.key === 'ArrowRight') {
      index += 1;
      draw();
    }
  });

  return { open, close };
})();

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

export function toast(message, kind = 'info', ttl = 5200) {
  const host = $('#toasts');
  if (!host) return;
  const node = el(`<div class="toast toast--${esc(kind)}">${esc(message)}</div>`);
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s ease';
    setTimeout(() => node.remove(), 320);
  }, ttl);
}
