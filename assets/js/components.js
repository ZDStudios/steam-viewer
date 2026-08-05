/** Reusable pieces of Steam-flavoured UI: cards, price blocks, media player,
 *  carousel, lightbox and toasts. */
import { $, $$, attachImageFallbacks, attachMediaFallbacks, el, esc, escAttr, formatMoney, videoCandidates } from './util.js?v=2026-08-05.1';

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
/**
 * Steam has moved store art between CDN hosts several times and still 404s on
 * plenty of older capsules, so every image carries an ordered list of
 * alternates that `attachImageFallbacks` walks on error.
 */
function imageChain(item, primary) {
  const appid = item.appid;
  const chain = [
    item.header,
    item.capsule,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
  ].filter((url, index, all) => url && url !== primary && all.indexOf(url) === index);
  return chain.join('|');
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

export function cardHtml(item, { rank = null, live = null, wishlisted = false } = {}) {
  if (!item) return '';
  const primary = item.header || item.capsule || `https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/header.jpg`;
  const tags = (item.genres || []).slice(0, 3).join(', ');
  const meta = item.releaseDate && !tags ? item.releaseDate : tags;
  // Muted looping webm on hover — Steam's "microtrailer" behaviour.
  const preview = item.preview?.webm || item.preview?.mp4 || '';

  return `<a class="card" href="#/app/${item.appid}" data-appid="${item.appid}"${preview ? ` data-preview="${escAttr(preview)}"` : ''}>
    <div class="card__shot">
      <img src="${escAttr(primary)}" data-fallback="${escAttr(imageChain(item, primary))}"
           alt="${escAttr(item.name)}" loading="lazy" decoding="async" />
      ${rank ? `<span class="card__rank">#${rank}</span>` : ''}
      ${item.hasVideo || preview ? '<span class="card__video">TRAILER</span>' : ''}
      <button class="card__wish${wishlisted ? ' is-on' : ''}" type="button" data-wish="${item.appid}"
              title="${wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}"
              aria-label="${wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}">${wishlisted ? '★' : '☆'}</button>
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

/**
 * Play a card's microtrailer while the pointer is over it. One shared element
 * is moved between cards so a grid never holds dozens of decoders open.
 */
export function attachHoverPreviews(root = document) {
  if (window.matchMedia('(hover: none), (prefers-reduced-motion: reduce)').matches) return;

  for (const card of $$('.card[data-preview]', root)) {
    if (card.dataset.previewBound) continue;
    card.dataset.previewBound = '1';

    let video = null;
    let timer = null;

    const stop = () => {
      clearTimeout(timer);
      if (!video) return;
      video.remove();
      video.removeAttribute('src');
      video = null;
      card.classList.remove('is-previewing');
    };

    card.addEventListener('mouseenter', () => {
      // A short delay stops a sweep across the grid from starting ten videos.
      timer = setTimeout(() => {
        video = document.createElement('video');
        video.className = 'card__preview';
        // Microtrailers live on the same shuffled CDN hosts as the full ones,
        // so they get the same fallback chain rather than one shot at one host.
        const candidates = videoCandidates(card.dataset.preview);
        video.src = candidates[0];
        video.dataset.fallback = candidates.slice(1).join('|');
        // Decorative, and a sweep across a grid would start a lot of these —
        // walking CDN hosts is free, streaming them through the relay is not.
        video.dataset.noProxy = '1';
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'none';
        // Only give up once every host and the relay have been tried.
        video.addEventListener('media-exhausted', stop);
        $('.card__shot', card)?.appendChild(video);
        attachMediaFallbacks(card);
        card.classList.add('is-previewing');
        video.play().catch(stop);
      }, 320);
    });

    card.addEventListener('mouseleave', stop);
  }
}

/** Belt-and-braces de-duplication for anything assembled client-side. */
export function dedupe(items = []) {
  const ids = new Set();
  const names = new Set();
  return items.filter((item) => {
    const appid = Number(item?.appid);
    if (!Number.isFinite(appid)) return false;
    const key = String(item.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
    if (ids.has(appid) || (key && names.has(key))) return false;
    ids.add(appid);
    if (key) names.add(key);
    return true;
  });
}

/**
 * A discovery-queue row: big capsule on the left, a 2×2 screenshot grid on the
 * right, and the store's action buttons underneath the title.
 */
export function discoveryRowHtml(row, { wishlisted = false } = {}) {
  const item = row.item;
  if (!item) return '';
  const shots = (item.screenshots || []).slice(0, 4);
  const hero = item.capsule || item.header;

  // Someone who has asked not to see motion gets the still, as before.
  const stillOnly =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const trailer = stillOnly
    ? []
    : [item.preview?.webm, item.preview?.mp4].filter(Boolean).flatMap(videoCandidates);

  return `<section class="disco" data-appid="${item.appid}">
    <header class="disco__head">
      <div>
        <a class="disco__title" href="#/app/${item.appid}">${esc(item.name)}</a>
        <div class="disco__reason">${esc(row.reason)} ${row.because ? `<strong>${esc(row.because)}</strong>` : ''}</div>
      </div>
      <div class="disco__actions">
        <a class="btn btn--ghost btn--sm" href="#/app/${item.appid}">Visit Product Page</a>
        <button class="btn btn--ghost btn--sm" type="button" data-wish="${item.appid}">${wishlisted ? '★ On wishlist' : '☆ Add to wishlist'}</button>
        <button class="btn btn--ghost btn--sm" type="button" data-ignore="${item.appid}">Ignore</button>
        ${item.genres?.[0] ? `<a class="btn btn--ghost btn--sm" href="#/genre/${encodeURIComponent(item.genres[0])}">Find More like this</a>` : ''}
      </div>
    </header>

    <div class="disco__body">
      <a class="disco__hero${trailer.length ? ' disco__hero--video' : ''}" href="#/app/${item.appid}">
        ${
          trailer.length
            ? // Steam's own discovery queue plays the trailer here rather than
              // showing a still, and the relay has been sending the clip all
              // along — it was simply never rendered. Muted and looping, so it
              // behaves like the store's tile and needs no interaction.
              // data-no-proxy: nobody asked to watch this, so it walks CDN
              // hosts but never spends relay bandwidth. If Steam cannot serve
              // it, the poster still is the right outcome.
              `<video src="${escAttr(trailer[0])}" data-fallback="${escAttr(trailer.slice(1).join('|'))}"
                      data-no-proxy="1" poster="${escAttr(item.preview?.thumb || hero)}"
                      muted loop playsinline autoplay
                      preload="metadata" aria-label="${escAttr(`${item.name} trailer`)}"></video>
               <span class="disco__playing">TRAILER</span>`
            : `<img src="${escAttr(hero)}" data-fallback="${escAttr(imageChain(item, hero))}" alt="${escAttr(item.name)}" loading="lazy" decoding="async" />`
        }
      </a>
      <div class="disco__shots">
        ${shots
          .map(
            (shot, index) =>
              `<button class="disco__shot" type="button" data-shot="${index}" aria-label="Screenshot ${index + 1}">
                 <img src="${escAttr(shot.thumb || shot.full)}" alt="" loading="lazy" decoding="async" />
               </button>`,
          )
          .join('')}
      </div>
    </div>

    <footer class="disco__foot">
      ${platformsHtml(item.platforms)}
      <span class="disco__tags">${esc((item.genres || []).slice(0, 3).join(', '))}</span>
      ${priceHtml(item.price)}
    </footer>
  </section>`;
}

export function portraitCardHtml(game, { subtitle = '' } = {}) {
  const appid = game.appid;
  const portrait = game.portrait || `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`;
  const fallbacks = [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    game.capsule,
    game.header,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
  ].filter((url, index, all) => url && url !== portrait && all.indexOf(url) === index);

  return `<a class="pcard" href="#/app/${appid}" title="${escAttr(game.name)}">
    <span class="pcard__fallback">${esc(game.name)}</span>
    <img class="pcard__img" src="${escAttr(portrait)}" data-fallback="${escAttr(fallbacks.join('|'))}"
         alt="${escAttr(game.name)}" loading="lazy" decoding="async" />
    <span class="pcard__foot"><span>${esc(game.name)}</span>${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</span>
  </a>`;
}

export function sectionHtml({ title, note = '', link = null, linkLabel = 'See all', body = '', layout = 'grid' }) {
  return `<section class="section">
    <div class="section__head">
      <h2 class="section__title">${esc(title)}${note ? `<small>${esc(note)}</small>` : ''}</h2>
      ${link ? `<a class="section__link" href="${escAttr(link)}">${esc(linkLabel)} &rsaquo;</a>` : ''}
    </div>
    <div class="${layout === 'rail' ? 'rail' : layout === 'portrait' ? 'grid grid--portrait' : 'grid'}">${body}</div>
  </section>`;
}

export function cardsHtml(items = [], options = {}) {
  return dedupe(items)
    .map((item, index) =>
      cardHtml(item, {
        rank: options.ranked ? index + 1 : null,
        live: options.live?.(item),
        wishlisted: options.isWishlisted?.(item.appid) || false,
      }),
    )
    .join('');
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
  const first = items[0];
  const art = first.capsule || first.header;
  return `<div class="hero" id="hero">
    <button class="hero__arrow hero__arrow--prev" type="button" aria-label="Previous">&#8249;</button>
    <button class="hero__arrow hero__arrow--next" type="button" aria-label="Next">&#8250;</button>
    <div class="hero__frame">
      <a class="hero__media" id="hero-media" href="#/app/${first.appid}" style="--hero-bg:url(&quot;${escAttr(art)}&quot;)">
        <img id="hero-img" src="${escAttr(art)}" data-fallback="${escAttr(imageChain(first, art))}"
             alt="${escAttr(first.name)}" />
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
    const art = item.capsule || item.header;
    media.href = `#/app/${item.appid}`;
    title.href = `#/app/${item.appid}`;

    // Rebuild the fallback chain for the new slide, and let the shared image
    // machinery re-bind so this one can fall back to the relay too.
    img.dataset.fallback = imageChain(item, art);
    delete img.dataset.fallbackBound;
    delete img.dataset.proxied;
    delete img.dataset.originalSrc;
    img.src = art;
    img.alt = item.name;
    media.style.setProperty('--hero-bg', `url("${art}")`);
    attachImageFallbacks(hero);
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

export function playerHtml(media) {
  if (!media.length) {
    return '<div class="player"><div class="player__stage"><p class="loading-note">No media for this title.</p></div></div>';
  }

  return `<div class="player" id="player">
    <div class="player__stage" id="player-stage"></div>
    <div class="player__strip" id="player-strip">
      ${media
        .map(
          (entry, index) => `<button class="player__thumb${entry.kind === 'video' ? ' player__thumb--video' : ''}${index === 0 ? ' is-active' : ''}"
              type="button" data-index="${index}" aria-label="${escAttr(entry.label || `Media ${index + 1}`)}">
              <img src="${escAttr(entry.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </button>`,
        )
        .join('')}
    </div>
  </div>`;
}

/**
 * @param {Array<{kind:'video'|'image', thumb:string, src:string, poster?:string, label?:string}>} media
 */
export function mountPlayer(root, media, { onZoom } = {}) {
  const stage = $('#player-stage', root);
  const strip = $('#player-strip', root);
  if (!stage || !media.length) return;

  let current = 0;

  const render = (index) => {
    current = index;
    const entry = media[index];
    stage.replaceChildren();

    if (entry.kind === 'video') {
      const video = document.createElement('video');
      video.poster = entry.poster || entry.thumb;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      // NB: no crossorigin attribute. Steam's video CDN sends no
      // Access-Control-Allow-Origin, so requesting a CORS fetch makes the
      // browser refuse every trailer.

      // Steam offers the same trailer at several bitrates, in two containers,
      // across several CDN hosts. The shared media machinery walks them —
      // the same code the images use, which matters because it moves on from a
      // host that has *stalled* as well as one that has failed. A hung request
      // never fires `error`, so a walker driven by `error` alone left the
      // player sitting on a black frame indefinitely, which is what a dead
      // trailer looked like.
      const sources = (entry.sources || [entry.src]).filter(Boolean).slice(0, 10);
      video.src = sources[0];
      video.dataset.fallback = sources.slice(1).join('|');

      video.addEventListener('media-exhausted', () => {
        stage.replaceChildren(
          el(`<div class="player__failed">
                <p>This trailer would not load — not from Steam's CDNs, and not through the relay.</p>
                <p><a href="${escAttr(sources[0] || '#')}" target="_blank" rel="noopener noreferrer">Open it directly</a>
                   &middot; <a href="#/diagnostics">Run the media check</a></p>
                <details><summary>${sources.length} URL${sources.length === 1 ? '' : 's'} tried</summary>
                  <ol>${sources.map((url) => `<li>${esc(url)}</li>`).join('')}</ol>
                </details>
              </div>`),
        );
      });

      stage.appendChild(video);
      attachMediaFallbacks(stage);
      video.play().catch(() => {
        /* autoplay blocked — the controls are right there */
      });
    } else {
      const img = document.createElement('img');
      img.src = entry.src;
      img.alt = entry.label || 'Screenshot';
      img.loading = 'eager';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      stage.appendChild(img);

      if (onZoom) {
        const zoom = el('<button class="player__zoom" type="button">⤢ Enlarge</button>');
        zoom.addEventListener('click', () => onZoom(index));
        stage.appendChild(zoom);
      }
    }

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
