/** Every screen in the app. Each view renders into `root` and may return a
 *  cleanup function that the router calls before the next navigation. */
import {
  attachHoverPreviews,
  cardsHtml,
  dedupe,
  discoveryRowHtml,
  heroHtml,
  lightbox,
  mountHero,
  mountPlayer,
  platformsHtml,
  playerHtml,
  portraitCardHtml,
  priceHtml,
  sectionHtml,
  skeletonGrid,
  skeletonPage,
  toast,
} from './components.js?v=2026-08-05.4';
import * as account from './account.js?v=2026-08-05.4';
import { renderRichText } from './sanitize.js?v=2026-08-05.4';
import * as wishlist from './wishlist.js?v=2026-08-05.4';
import { pickCodec, ScreenPlayer } from './screen.js?v=2026-08-05.4';
import { $, $$, attachImageFallbacks, esc, escAttr, formatDate, formatMoney, formatNumber, formatPlaytime, movieSources, proxied, relayTrailer } from './util.js?v=2026-08-05.4';

/** Card options every grid shares: hide ignored titles, mark wishlisted ones. */
const cardOpts = (extra = {}) => ({ isWishlisted: (appid) => wishlist.has(appid), ...extra });
const visible = (items = []) => wishlist.filterIgnored(dedupe(items));

/**
 * The ☆ / Ignore controls are handled by one delegated listener per root.
 *
 * Views render into an element the router reuses, so attaching a fresh
 * listener on every render stacked them up: one click then ran every handler
 * a previous view had left behind, toggling the wishlist once per listener
 * (add, remove, add…) and reporting whichever stale name that view had
 * captured. Only the current view's lookup is kept.
 */
const itemLookups = new WeakMap();
const boundRoots = new WeakSet();

function bindItemActions(root, lookup) {
  itemLookups.set(root, lookup);
  if (boundRoots.has(root)) return;
  boundRoots.add(root);

  root.addEventListener('click', (event) => {
    const wishButton = event.target.closest('[data-wish]');
    const ignoreButton = event.target.closest('[data-ignore]');
    if (!wishButton && !ignoreButton) return;

    // These live inside <a class="card">, so stop the navigation.
    event.preventDefault();
    event.stopPropagation();

    const button = wishButton || ignoreButton;
    const appid = Number(button.dataset.wish || button.dataset.ignore);
    const game = itemLookups.get(root)?.(appid) || { appid, name: `App ${appid}` };

    if (wishButton) {
      const added = wishlist.toggle(game);
      toast(added ? `${game.name} added to your wishlist` : `${game.name} removed from your wishlist`, 'ok', 2600);
      for (const node of $$(`[data-wish="${appid}"]`, root)) {
        node.classList.toggle('is-on', added);
        node.textContent = node.classList.contains('btn') ? (added ? '★ On wishlist' : '☆ Add to wishlist') : added ? '★' : '☆';
        node.title = added ? 'Remove from wishlist' : 'Add to wishlist';
      }
      return;
    }

    wishlist.ignore(appid);
    toast(`${game.name} hidden from recommendations`, 'ok', 2600);
    ignoreButton.closest('.disco')?.remove();
    ignoreButton.closest('.card')?.remove();
  });
}

function errorHtml(error, { retryLabel = 'Try again' } = {}) {
  return `<div class="empty">
    <h2>That didn't load</h2>
    <p>${esc(error?.message || 'Unknown error')}</p>
    <p style="margin-top:16px"><button class="btn" type="button" data-retry>${esc(retryLabel)}</button></p>
  </div>`;
}

function bindRetry(root, run) {
  const button = $('[data-retry]', root);
  if (button) button.addEventListener('click', run);
}

/* ================================================================== *
 * Home
 * ================================================================== */

export async function homeView(root, ctx) {
  root.innerHTML = skeletonPage();

  let data;
  try {
    data = await ctx.relay.request('home', { cc: ctx.region, l: ctx.language });
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => homeView(root, ctx));
    return;
  }

  ctx.setTitle('Steam Viewer');

  const liveLabel = (item) => (item.concurrent ? `${formatNumber(item.concurrent)} playing now` : '');
  const featured = visible(data.featured || []);

  // Index every card on the page so the wishlist buttons can save real data.
  const index = new Map();
  for (const list of [data.featured, data.mostPlayed, data.specials, data.topSellers, data.newReleases, data.comingSoon]) {
    for (const item of list || []) index.set(item.appid, item);
  }

  root.innerHTML = `
    ${heroHtml(featured)}

    <div id="discovery-slot"></div>

    ${
      data.mostPlayed?.length
        ? sectionHtml({
            title: 'Most Played Right Now',
            note: 'live from Steam',
            link: '#/browse/mostplayed',
            body: cardsHtml(visible(data.mostPlayed).slice(0, 8), cardOpts({ ranked: true, live: liveLabel })),
          })
        : ''
    }
    ${
      data.specials?.length
        ? sectionHtml({ title: 'Special Offers', link: '#/browse/specials', body: cardsHtml(visible(data.specials).slice(0, 8), cardOpts()) })
        : ''
    }
    ${
      data.topSellers?.length
        ? sectionHtml({ title: 'Top Sellers', link: '#/browse/topsellers', body: cardsHtml(visible(data.topSellers).slice(0, 8), cardOpts()) })
        : ''
    }
    ${
      data.newReleases?.length
        ? sectionHtml({ title: 'New Releases', link: '#/browse/newreleases', body: cardsHtml(visible(data.newReleases).slice(0, 8), cardOpts()) })
        : ''
    }
    ${
      data.comingSoon?.length
        ? sectionHtml({ title: 'Coming Soon', link: '#/browse/comingsoon', body: cardsHtml(visible(data.comingSoon).slice(0, 8), cardOpts()) })
        : ''
    }
  `;

  attachImageFallbacks(root);
  attachHoverPreviews(root);
  bindItemActions(root, (appid) => index.get(appid));
  const stopHero = mountHero(root, featured);

  /* Discovery rows load after the fold so they never delay the storefront. */
  const slot = $('#discovery-slot', root);
  slot.innerHTML = `<div class="section"><div class="section__head"><h2 class="section__title">Recommended For You</h2></div>
    <div class="skeleton" style="height:280px"></div></div>`;

  ctx.relay
    .request('discovery', { seeds: wishlist.seeds(3), cc: ctx.region, l: ctx.language })
    .then((payload) => {
      const rows = (payload.rows || []).filter((row) => !wishlist.isIgnored(row.item?.appid));
      if (rows.length === 0) {
        slot.innerHTML = '';
        return;
      }
      for (const row of rows) index.set(row.item.appid, row.item);

      slot.innerHTML = `<section class="section">
        <div class="section__head">
          <h2 class="section__title">Recommended For You<small>${
            wishlist.count() ? 'based on your wishlist' : 'add games to your wishlist to tune this'
          }</small></h2>
          <a class="section__link" href="#/wishlist">Your wishlist (${wishlist.count()}) &rsaquo;</a>
        </div>
        ${rows.map((row) => discoveryRowHtml(row, { wishlisted: wishlist.has(row.item.appid) })).join('')}
      </section>`;

      attachImageFallbacks(slot);

      // Clicking a screenshot opens that game's shots in the lightbox.
      slot.addEventListener('click', (event) => {
        const button = event.target.closest('[data-shot]');
        if (!button) return;
        const appid = Number(button.closest('.disco')?.dataset.appid);
        const row = rows.find((entry) => entry.item.appid === appid);
        if (!row) return;
        lightbox.open(
          (row.item.screenshots || []).map((shot) => shot.full || shot.thumb),
          Number(button.dataset.shot) || 0,
        );
      });
    })
    .catch(() => {
      slot.innerHTML = '';
    });

  // The relay pushes a refreshed most-played list every couple of minutes.
  const off = ctx.relay.on('live', (payload) => {
    const section = $$('.section', root).find((node) => $('.section__title', node)?.textContent.startsWith('Most Played'));
    if (!section || !payload?.mostPlayed?.length) return;
    $('.grid', section).innerHTML = cardsHtml(visible(payload.mostPlayed).slice(0, 8), cardOpts({ ranked: true, live: liveLabel }));
    attachImageFallbacks(section);
    attachHoverPreviews(section);
  });

  return () => {
    stopHero?.();
    off();
  };
}

/* ================================================================== *
 * Browse (a single home section, expanded)
 * ================================================================== */

const BROWSE = {
  topsellers: { title: 'Top Sellers', key: 'topSellers' },
  newreleases: { title: 'New Releases', key: 'newReleases' },
  specials: { title: 'Special Offers', key: 'specials' },
  comingsoon: { title: 'Coming Soon', key: 'comingSoon' },
  mostplayed: { title: 'Most Played', key: 'mostPlayed', ranked: true },
};

export async function browseView(root, ctx, which) {
  const config = BROWSE[which] || BROWSE.topsellers;
  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(config.title)}</div>${skeletonGrid(12)}`;
  ctx.setTitle(`${config.title} · Steam Viewer`);

  try {
    const items =
      which === 'mostplayed'
        ? await ctx.relay.request('mostplayed', { cc: ctx.region, l: ctx.language, limit: 25 })
        : (await ctx.relay.request('home', { cc: ctx.region, l: ctx.language }))[config.key] || [];

    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(config.title)}</div>
      ${sectionHtml({
        title: config.title,
        note: `${items.length} title${items.length === 1 ? '' : 's'}`,
        body:
          cardsHtml(
            visible(items),
            cardOpts({
              ranked: config.ranked,
              live: (item) => (item.concurrent ? `${formatNumber(item.concurrent)} playing now` : ''),
            }),
          ) || '<p class="loading-note">Steam returned nothing for this section right now.</p>',
      })}`;
    attachImageFallbacks(root);
    attachHoverPreviews(root);
    bindItemActions(root, (appid) => items.find((item) => item.appid === appid));
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => browseView(root, ctx, which));
  }
}

/* ================================================================== *
 * Search
 * ================================================================== */

export async function searchView(root, ctx, term) {
  const query = String(term || '').trim();
  ctx.setTitle(`${query || 'Search'} · Steam Viewer`);

  if (!query) {
    root.innerHTML = '<div class="empty"><h2>Search the Steam store</h2><p>Type a game name in the box above.</p></div>';
    return;
  }

  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Search</div>${skeletonGrid(9)}`;

  try {
    const result = await ctx.relay.request('search', { term: query, cc: ctx.region, l: ctx.language, limit: 60 });
    const items = result.items || [];

    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Search</div>
      ${sectionHtml({
        title: `Results for “${query}”`,
        note: `${formatNumber(result.total ?? items.length)} match${(result.total ?? items.length) === 1 ? '' : 'es'}`,
        body:
          cardsHtml(items, cardOpts()) ||
          `<p class="loading-note">Nothing matched “${esc(query)}”. Try a shorter or differently spelled term.</p>`,
      })}`;
    attachImageFallbacks(root);
    attachHoverPreviews(root);
    bindItemActions(root, (appid) => items.find((item) => item.appid === appid));
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => searchView(root, ctx, query));
  }
}

/* ================================================================== *
 * Genre
 * ================================================================== */

export async function genreView(root, ctx, genre) {
  const name = decodeURIComponent(genre || '');
  ctx.setTitle(`${name} · Steam Viewer`);
  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(name)}</div>${skeletonGrid(8)}`;

  let data;
  try {
    data = await ctx.relay.request('genre', { genre: name, cc: ctx.region, l: ctx.language });
  } catch (error) {
    // A relay too old to know about tag filtering answers 404 for genres it
    // cannot resolve. Rather than leaving the Genres menu as a dead end, fall
    // back to a plain store search for the genre name — which is what the
    // relay's own last resort does anyway.
    try {
      const result = await ctx.relay.request('search', { term: name, cc: ctx.region, l: ctx.language, limit: 40 });
      const items = result.items || [];
      if (items.length === 0) throw error;
      data = { genre: name, matchedBy: 'term', sections: [{ key: 'search', label: `Games matching “${name}”`, items }] };
    } catch {
      root.innerHTML = errorHtml(error);
      bindRetry(root, () => genreView(root, ctx, genre));
      return;
    }
  }

  const sections = data.sections || [];
  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(data.genre || name)}</div>
    <h1 class="apphead__title" style="margin-bottom:6px">${esc(data.genre || name)}</h1>
    <p class="loading-note" style="text-align:left;margin:0 0 18px">
      ${
        data.matchedBy === 'term' || data.matchedBy === 'unverified'
          ? `Steam has no tag called “${esc(name)}”, so these are search matches rather than a tagged listing.`
          : `Tagged “${esc(data.genre || name)}” on the Steam store.`
      }
    </p>
    ${
      sections
        .map((section) => sectionHtml({ title: section.label, body: cardsHtml(visible(section.items || []), cardOpts()) }))
        .join('') || '<div class="empty"><h2>No titles found</h2><p>Steam returned an empty genre listing.</p></div>'
    }`;
  attachImageFallbacks(root);
  attachHoverPreviews(root);
  const all = sections.flatMap((section) => section.items || []);
  bindItemActions(root, (appid) => all.find((item) => item.appid === appid));
}

/* ================================================================== *
 * Game page
 * ================================================================== */

function scoreClass(desc = '') {
  const text = desc.toLowerCase();
  if (text.includes('positive')) return 'score--positive';
  if (text.includes('negative')) return 'score--negative';
  return 'score--mixed';
}

function factRow(key, value) {
  if (!value) return '';
  return `<div class="factbox__row"><div class="factbox__key">${esc(key)}</div><div class="factbox__val">${value}</div></div>`;
}

/** Studio names become links to their catalogue page. */
function creatorLinks(names = [], role = 'developer') {
  if (!names?.length) return '';
  return names
    .slice(0, 4)
    .map((name) => `<a href="#/${role}/${encodeURIComponent(name)}">${esc(name)}</a>`)
    .join(', ');
}

/**
 * SteamDB-style panel. The figures come from SteamSpy and Steam's own charts —
 * SteamDB is linked rather than scraped, since it sits behind bot protection
 * and its terms do not permit it.
 */
function statsHtml(spy, game) {
  const links = spy?.steamdb || {
    app: `https://steamdb.info/app/${game.appid}/`,
    charts: `https://steamdb.info/app/${game.appid}/charts/`,
    depots: `https://steamdb.info/app/${game.appid}/depots/`,
    history: `https://steamdb.info/app/${game.appid}/price/`,
  };

  const tiles = spy
    ? [
        ['Owners (est.)', spy.owners || '—'],
        ['Peak players today', spy.ccu ? formatNumber(spy.ccu) : '—'],
        ['Positive reviews', spy.positivePercent !== null ? `${spy.positivePercent}%` : '—'],
        ['Total reviews', spy.reviewTotal ? formatNumber(spy.reviewTotal) : '—'],
        ['Average playtime', spy.averagePlaytimeForever ? formatPlaytime(spy.averagePlaytimeForever) : '—'],
        ['Median playtime', spy.medianPlaytimeForever ? formatPlaytime(spy.medianPlaytimeForever) : '—'],
        ['Played last 2 weeks', spy.averagePlaytime2Weeks ? formatPlaytime(spy.averagePlaytime2Weeks) : '—'],
        ['App ID', String(game.appid)],
      ]
    : [];

  return `
    ${
      spy
        ? `<div class="stats">${tiles
            .map(([label, value]) => `<div class="stats__tile"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
            .join('')}</div>`
        : '<p class="loading-note" style="text-align:left">SteamSpy has no estimates for this title. The SteamDB links below still work.</p>'
    }

    ${
      spy?.tags?.length
        ? `<h3 style="color:#fff;font-size:14px;margin:18px 0 8px">Community tags</h3>
           <div>${spy.tags.map((tag) => `<span class="chip">${esc(tag.name)} <small>${formatNumber(tag.votes)}</small></span>`).join('')}</div>`
        : ''
    }

    <h3 style="color:#fff;font-size:14px;margin:18px 0 8px">Open on SteamDB</h3>
    <div class="disco__actions">
      <a class="btn btn--ghost btn--sm" href="${escAttr(links.app)}" target="_blank" rel="noopener noreferrer">App page</a>
      <a class="btn btn--ghost btn--sm" href="${escAttr(links.charts)}" target="_blank" rel="noopener noreferrer">Player charts</a>
      <a class="btn btn--ghost btn--sm" href="${escAttr(links.history)}" target="_blank" rel="noopener noreferrer">Price history</a>
      <a class="btn btn--ghost btn--sm" href="${escAttr(links.depots)}" target="_blank" rel="noopener noreferrer">Depots</a>
    </div>
    <p class="loading-note" style="text-align:left;margin-top:10px">
      Estimates from SteamSpy${spy ? '' : ' (unavailable)'} and Steam's own charts. SteamDB is linked, not scraped.
    </p>`;
}

function reviewSummaryHtml(summary) {
  if (!summary || !summary.totalReviews) return '';
  const positive = summary.totalPositive || 0;
  const total = summary.totalReviews || 1;
  const percent = Math.round((positive / total) * 100);

  return `<div class="reviewsummary">
    <div class="reviewsummary__score ${scoreClass(summary.reviewScoreDesc)}">${esc(summary.reviewScoreDesc || 'No score')}</div>
    <div class="reviewsummary__bar"><span style="width:${percent}%"></span></div>
    <div class="reviewsummary__meta">${percent}% of ${formatNumber(total)} reviews are positive</div>
  </div>`;
}

function reviewHtml(review) {
  const hours = formatPlaytime(review.author?.playtimeForever || 0);
  const verdict = review.votedUp
    ? '<span class="review__verdict review__verdict--up"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M2 21h4V9H2v12Zm20-11a2 2 0 0 0-2-2h-6.3l1-4.6v-.3a1.5 1.5 0 0 0-.5-1.1L13 1 6.6 7.4A2 2 0 0 0 6 8.8V19a2 2 0 0 0 2 2h9a2 2 0 0 0 1.8-1.2l3-7a2 2 0 0 0 .2-.8v-2Z"/></svg>Recommended</span>'
    : '<span class="review__verdict review__verdict--down"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M22 3h-4v12h4V3ZM2 14a2 2 0 0 0 2 2h6.3l-1 4.6v.3c0 .4.2.8.5 1.1l1.1 1.1 6.5-6.5c.4-.4.6-.9.6-1.4V5a2 2 0 0 0-2-2H7a2 2 0 0 0-1.8 1.2l-3 7a2 2 0 0 0-.2.8v2Z"/></svg>Not Recommended</span>';

  return `<article class="review">
    <div class="review__side">
      ${verdict}
      <div>${esc(hours)} on record</div>
      ${review.created ? `<div>Posted ${esc(formatDate(review.created))}</div>` : ''}
      ${review.earlyAccess ? '<div>Early Access review</div>' : ''}
    </div>
    <div>
      <div class="review__text">${esc(review.text || '').slice(0, 4000)}</div>
      <div class="review__foot">
        ${formatNumber(review.votesUp || 0)} found this helpful${review.votesFunny ? ` · ${formatNumber(review.votesFunny)} found it funny` : ''}
      </div>
    </div>
  </article>`;
}

function newsHtml(items) {
  if (!items?.length) return '<p class="loading-note">No recent announcements for this title.</p>';
  return items
    .map(
      (item) => `<article class="newsitem">
        <div class="newsitem__head">
          <a class="newsitem__title" href="${escAttr(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>
          <span class="newsitem__date">${esc(formatDate(item.date))}</span>
        </div>
        <div class="gamedesc" data-news="${escAttr(item.id)}"></div>
      </article>`,
    )
    .join('');
}

function requirementsHtml(requirements) {
  const blocks = [];
  for (const [label, key] of [
    ['Windows', 'windows'],
    ['macOS', 'mac'],
    ['SteamOS / Linux', 'linux'],
  ]) {
    const entry = requirements?.[key];
    if (!entry) continue;
    blocks.push(`<div>
      <h3 style="color:#fff;font-size:14px;margin-bottom:8px">${esc(label)}</h3>
      ${entry.minimum ? `<div class="gamedesc" data-req="${key}-min"></div>` : ''}
      ${entry.recommended ? `<div class="gamedesc" data-req="${key}-rec" style="margin-top:10px"></div>` : ''}
    </div>`);
  }
  if (!blocks.length) return '<p class="loading-note">Steam lists no system requirements for this title.</p>';
  return `<div class="sysreq">${blocks.join('')}</div>`;
}

export async function appView(root, ctx, appid) {
  const id = Number(appid);
  root.innerHTML = skeletonPage();

  let payload;
  try {
    payload = await ctx.relay.request('app', { appid: id, cc: ctx.region, l: ctx.language });
  } catch (error) {
    root.innerHTML = errorHtml(error, { retryLabel: 'Reload this game' });
    bindRetry(root, () => appView(root, ctx, appid));
    return;
  }

  const game = payload.game;
  ctx.setTitle(`${game.name} · Steam Viewer`);

  const media = [
    ...(game.movies || [])
      .map((movie, index) => ({
        kind: 'video',
        thumb: movie.thumb,
        // A current relay has already probed these and put a responding host
        // first. movieSources() also expands the CDN host variants itself, so
        // trailers still play against an older relay, and the player walks the
        // rest of the list on a stall as well as on an error — then falls
        // through to the relay, exactly as the images do.
        // The relay's own copy goes last: it is the only source that does not
        // depend on this browser holding a Steam address that still works.
        // Six Steam addresses is already every host worth trying; more just
        // adds stall time before the relay gets its turn.
        sources: [...movieSources(movie).slice(0, 6), relayTrailer(game.appid, index)].filter(Boolean),
        poster: movie.thumb,
        // The header image is the one picture every app definitely has, so it
        // stands in when the trailer's own thumbnail cannot be resolved.
        fallbackPoster: game.header || game.capsule,
        label: movie.name || 'Trailer',
      }))
      .filter((entry) => entry.sources.length > 0),
    ...(game.screenshots || []).map((shot, index) => ({
      kind: 'image',
      thumb: shot.thumb,
      src: shot.full,
      label: `Screenshot ${index + 1}`,
    })),
  ];
  const screenshotUrls = (game.screenshots || []).map((shot) => shot.full);
  const firstScreenshotIndex = media.findIndex((entry) => entry.kind === 'image');

  // "Steam lists trailers for this game and none of them reached us" is a
  // completely different problem from "this game has no trailers", and both
  // used to look like an empty strip. Say which one it is.
  const videoCount = media.filter((entry) => entry.kind === 'video').length;
  const droppedVideos = (game.movies || []).length - videoCount;

  const genreChips = (game.genres || [])
    .map((genre) => `<a class="chip" href="#/genre/${encodeURIComponent(genre)}">${esc(genre)}</a>`)
    .join('');
  const categoryChips = (game.categories || []).slice(0, 12).map((c) => `<span class="chip">${esc(c)}</span>`).join('');

  root.innerHTML = `
    ${game.background ? `<div class="apppage__backdrop" style="background-image:url('${escAttr(game.background)}')"></div>` : ''}

    <div class="breadcrumbs">
      <a href="#/">Store</a>
      ${game.genres?.[0] ? ` &rsaquo; <a href="#/genre/${encodeURIComponent(game.genres[0])}">${esc(game.genres[0])}</a>` : ''}
      &rsaquo; ${esc(game.name)}
    </div>

    <header class="apphead">
      <h1 class="apphead__title">${esc(game.name)}</h1>
      <div class="apphead__sub">
        ${game.releaseDate ? `<span>${game.comingSoon ? 'Planned release' : 'Released'}: ${esc(game.releaseDate)}</span>` : ''}
        ${game.developers?.length ? `<span>Developer: ${creatorLinks(game.developers, 'developer')}</span>` : ''}
        ${game.publishers?.length ? `<span>Publisher: ${creatorLinks(game.publishers, 'publisher')}</span>` : ''}
        ${game.metacritic ? `<span>Metacritic: ${esc(game.metacritic)}</span>` : ''}
      </div>
    </header>

    <div class="applayout">
      <div class="applayout__media">
        ${playerHtml(media)}
        ${
          droppedVideos > 0
            ? `<p class="loading-note" style="text-align:left">
                 Steam lists ${formatNumber(game.movies.length)} trailer${game.movies.length === 1 ? '' : 's'} for this
                 game but sent no playable address for ${droppedVideos === game.movies.length ? 'any of them' : `${formatNumber(droppedVideos)} of them`} —
                 that is the relay's copy of the store page, not your connection.
                 <a href="#/diagnostics">Run the media check</a> or
                 <a href="${escAttr(game.storeUrl)}" target="_blank" rel="noopener noreferrer">watch on Steam</a>.
               </p>`
            : ''
        }
      </div>

      <div class="applayout__body">
        <div class="tabs" id="app-tabs" role="tablist">
          <button class="is-active" data-tab="about" role="tab">About</button>
          <button data-tab="reviews" role="tab">Reviews</button>
          <button data-tab="news" role="tab">News</button>
          <button data-tab="requirements" role="tab">System Requirements</button>
          <button data-tab="stats" role="tab">Stats</button>
          ${game.dlc?.length ? '<button data-tab="dlc" role="tab">DLC</button>' : ''}
          ${game.achievements?.total ? '<button data-tab="achievements" role="tab">Achievements</button>' : ''}
        </div>

        <div id="tab-about" class="tabpanel">
          <div class="gamedesc" id="about-body"></div>
        </div>

        <div id="tab-reviews" class="tabpanel" hidden>
          <div class="toolbar">
            <select id="review-filter">
              <option value="all">Most helpful</option>
              <option value="recent">Most recent</option>
              <option value="updated">Recently updated</option>
            </select>
            <select id="review-type">
              <option value="all">All reviews</option>
              <option value="positive">Positive only</option>
              <option value="negative">Negative only</option>
            </select>
          </div>
          <div id="reviews-list"></div>
          <p style="text-align:center;margin-top:14px">
            <button class="btn btn--ghost" type="button" id="reviews-more">Load more reviews</button>
          </p>
        </div>

        <div id="tab-news" class="tabpanel" hidden>${newsHtml(payload.news)}</div>

        <div id="tab-requirements" class="tabpanel" hidden>${requirementsHtml(game.requirements)}</div>

        <div id="tab-stats" class="tabpanel" hidden><div id="stats-body"><p class="loading-note">Loading estimates…</p></div></div>

        ${game.dlc?.length ? '<div id="tab-dlc" class="tabpanel" hidden><div class="grid" id="dlc-grid">' + skeletonGrid(4) + '</div></div>' : ''}

        ${
          game.achievements?.total
            ? `<div id="tab-achievements" class="tabpanel" hidden>
                <p class="loading-note" style="text-align:left">${formatNumber(game.achievements.total)} achievements in this game.</p>
                <div class="achievements">
                  ${game.achievements.highlighted
                    .map(
                      (achievement) =>
                        `<figure><img src="${escAttr(achievement.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><figcaption title="${escAttr(achievement.name)}">${esc(achievement.name)}</figcaption></figure>`,
                    )
                    .join('')}
                </div>
              </div>`
            : ''
        }
      </div>

      <aside class="aside">
        <img class="aside__capsule" src="${escAttr(game.header)}" data-fallback="${escAttr(game.capsule || '')}"
             alt="${escAttr(game.name)}" referrerpolicy="no-referrer" />
        <p class="aside__blurb">${esc(game.shortDescription || '')}</p>

        <div class="buybox">
          <span class="buybox__label">${game.comingSoon ? 'Coming soon' : 'Price on Steam'}</span>
          ${priceHtml(game.price)}
          <a class="btn btn--green" href="${escAttr(game.storeUrl)}" target="_blank" rel="noopener noreferrer">View on Steam</a>
          <button class="btn" type="button" data-wish="${game.appid}">${wishlist.has(game.appid) ? '★ On wishlist' : '☆ Add to wishlist'}</button>
        </div>

        <div class="livebox">
          <div><div class="livebox__num" id="live-players">—</div><div class="livebox__label">Playing now</div></div>
        </div>

        ${reviewSummaryHtml(payload.reviews?.summary)}

        <div class="factbox">
          ${factRow('Platforms', platformsHtml(game.platforms) || '—')}
          ${factRow('Release', esc(game.releaseDate || 'Unannounced'))}
          ${factRow('Developer', creatorLinks(game.developers, 'developer'))}
          ${factRow('Publisher', creatorLinks(game.publishers, 'publisher'))}
          ${factRow('Reviews', game.recommendations ? `${formatNumber(game.recommendations)} recommendations` : '')}
          ${factRow('Metacritic', game.metacritic ? `<a href="${escAttr(game.metacriticUrl || '#')}" target="_blank" rel="noopener noreferrer">${esc(game.metacritic)}</a>` : '')}
          ${factRow('Website', game.website ? `<a href="${escAttr(game.website)}" target="_blank" rel="noopener noreferrer">Official site</a>` : '')}
          ${factRow('App ID', String(game.appid))}
        </div>

        ${genreChips ? `<div class="factbox"><div class="factbox__key" style="margin-bottom:6px">Genres</div>${genreChips}</div>` : ''}
        ${categoryChips ? `<div class="factbox"><div class="factbox__key" style="margin-bottom:6px">Features</div>${categoryChips}</div>` : ''}
      </aside>
    </div>
  `;

  attachImageFallbacks(root);

  /* — media player — */
  mountPlayer(root, media, {
    onZoom: (index) => {
      const imageIndex = index - firstScreenshotIndex;
      lightbox.open(screenshotUrls, imageIndex >= 0 ? imageIndex : 0);
    },
  });

  /* — Steam-authored HTML, sanitised — */
  renderRichText($('#about-body', root), game.detailedDescription || game.aboutTheGame || game.shortDescription);
  for (const [key, entry] of Object.entries(game.requirements || {})) {
    if (!entry) continue;
    const min = $(`[data-req="${key}-min"]`, root);
    const rec = $(`[data-req="${key}-rec"]`, root);
    if (min && entry.minimum) renderRichText(min, entry.minimum);
    if (rec && entry.recommended) renderRichText(rec, entry.recommended);
  }
  for (const item of payload.news || []) {
    const target = $(`[data-news="${CSS.escape(String(item.id))}"]`, root);
    if (target) renderRichText(target, item.contents);
  }
  // Store descriptions embed their looping clips as <video> and their art as
  // <img>; both arrive after the pass above, so they need binding here or the
  // animations on the About tab have no fallback at all.
  attachImageFallbacks(root);

  /* — tabs — */
  const tabs = $('#app-tabs', root);
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tab]');
    if (!button) return;
    $$('button', tabs).forEach((node) => node.classList.toggle('is-active', node === button));
    $$('.tabpanel', root).forEach((panel) => {
      panel.hidden = panel.id !== `tab-${button.dataset.tab}`;
    });
    if (button.dataset.tab === 'dlc') loadDlc();
    if (button.dataset.tab === 'stats') loadStats();
  });

  /* — wishlist button — */
  bindItemActions(root, () => game);

  /* — SteamDB-style stats (lazy) — */
  let statsLoaded = false;
  async function loadStats() {
    if (statsLoaded) return;
    statsLoaded = true;
    const body = $('#stats-body', root);
    try {
      const spy = await ctx.relay.request('steamspy', { appid: id });
      body.innerHTML = statsHtml(spy, game);
    } catch {
      // SteamSpy is frequently slow or down; the SteamDB links still help.
      body.innerHTML = statsHtml(null, game);
    }
  }

  /* — reviews — */
  let cursor = payload.reviews?.cursor || null;
  const list = $('#reviews-list', root);
  const moreButton = $('#reviews-more', root);
  const filterSelect = $('#review-filter', root);
  const typeSelect = $('#review-type', root);

  const paintReviews = (reviews, append) => {
    const html = reviews.map(reviewHtml).join('') || '<p class="loading-note">No reviews matched this filter.</p>';
    if (append) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html;
  };

  paintReviews(payload.reviews?.reviews || [], false);

  const loadReviews = async ({ append }) => {
    moreButton.disabled = true;
    moreButton.textContent = 'Loading…';
    try {
      const data = await ctx.relay.request('reviews', {
        appid: id,
        filter: filterSelect.value,
        reviewType: typeSelect.value,
        cursor: append ? cursor || '*' : '*',
        numPerPage: 20,
      });
      cursor = data.cursor;
      paintReviews(data.reviews || [], append);
      moreButton.hidden = !data.reviews?.length;
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      moreButton.disabled = false;
      moreButton.textContent = 'Load more reviews';
    }
  };

  moreButton.addEventListener('click', () => loadReviews({ append: true }));
  filterSelect.addEventListener('change', () => loadReviews({ append: false }));
  typeSelect.addEventListener('change', () => loadReviews({ append: false }));

  /* — DLC (lazy) — */
  let dlcLoaded = false;
  async function loadDlc() {
    if (dlcLoaded || !game.dlc?.length) return;
    dlcLoaded = true;
    try {
      const items = await ctx.relay.request('apps', { appids: game.dlc.slice(0, 12), cc: ctx.region, l: ctx.language });
      const grid = $('#dlc-grid', root);
      grid.innerHTML = cardsHtml(items) || '<p class="loading-note">Steam returned no DLC details.</p>';
      attachImageFallbacks(grid);
    } catch (error) {
      $('#dlc-grid', root).innerHTML = `<p class="loading-note">${esc(error.message)}</p>`;
    }
  }

  /* — live player count — */
  const liveNode = $('#live-players', root);
  const paintPlayers = (value) => {
    liveNode.textContent = typeof value === 'number' ? formatNumber(value) : 'n/a';
  };

  ctx.relay
    .request('players', { appid: id })
    .then((data) => paintPlayers(data.players))
    .catch(() => paintPlayers(null));

  ctx.relay.subscribe(id);
  const offPlayers = ctx.relay.on('players', (data) => {
    if (Number(data?.appid) === id) paintPlayers(data.players);
  });

  return () => {
    ctx.relay.unsubscribe(id);
    offPlayers();
  };
}

/* ================================================================== *
 * Library (needs STEAM_API_KEY on the relay)
 * ================================================================== */

const LIBRARY_KEY = 'steam-viewer:last-profile';

/**
 * Shown on your own profile once you have signed in through Steam.
 *
 * It exists to answer a question people reasonably ask — "why can't I see my
 * cart and my wallet?" — in the one place they would look for them, rather
 * than leaving a gap that reads like a bug.
 */
function accountPanelHtml() {
  return `<section class="panel account" style="margin-bottom:18px">
    <div class="panel__head">
      <h2>Your Steam account</h2>
      <span>verified by Steam</span>
    </div>
    <div class="panel__body account__body">
      <div>
        <h3 class="account__h">Connected, so this page can show</h3>
        <ul class="account__list account__list--yes">
          ${account.LIMITS.available.map((line) => `<li>${esc(line)}</li>`).join('')}
        </ul>
        <p class="pstat">
          <a class="btn btn--ghost btn--sm" href="#/wishlist">Your wishlist &amp; cart</a>
          <a class="btn btn--ghost btn--sm" href="https://store.steampowered.com/cart/" target="_blank" rel="noopener noreferrer">Steam cart</a>
          <a class="btn btn--ghost btn--sm" href="https://store.steampowered.com/account/" target="_blank" rel="noopener noreferrer">Steam wallet</a>
        </p>
      </div>
      <div>
        <h3 class="account__h">Not available to any site, including this one</h3>
        <ul class="account__list account__list--no">
          ${account.LIMITS.unavailable.map((entry) => `<li><strong>${esc(entry.what)}</strong> — ${esc(entry.why)}</li>`).join('')}
        </ul>
      </div>
    </div>
  </section>`;
}

export async function libraryView(root, ctx, who = '') {
  ctx.setTitle('Library · Steam Viewer');

  const requested = decodeURIComponent(who || '');
  // A connected account is the default profile — that is the whole point of
  // connecting one — but an explicit link still wins.
  const remembered = requested || account.steamid() || localStorage.getItem(LIBRARY_KEY) || '';

  const connected = account.get();

  const form = `
    <div class="empty">
      <h2>Look up a Steam library</h2>

      <div class="signin">
        ${
          connected
            ? `<p class="signin__who">Connected as <strong>${esc(connected.name || connected.steamid)}</strong></p>
               <div class="stream__actions" style="justify-content:center">
                 <a class="btn btn--green btn--sm" href="#/library/${escAttr(connected.steamid)}">Open my library</a>
                 <button class="btn btn--ghost btn--sm" type="button" id="steam-signout">Disconnect</button>
               </div>`
            : `<button class="btn btn--green" type="button" id="steam-signin">
                 <span class="signin__mark" aria-hidden="true">◈</span> Sign in through Steam
               </button>
               <p class="loading-note" style="margin-top:8px">
                 Opens Steam's own sign-in page. You type your password on <strong>steamcommunity.com</strong> and
                 nowhere else — this site is told your account number and nothing more.
               </p>`
        }
      </div>

      <p style="margin-top:22px">Or look someone up without signing in:</p>
      <form class="formrow" id="library-form">
        <input type="text" id="library-input" placeholder="76561197960287930 or gabelogannewell" value="${escAttr(remembered)}" />
        <button class="btn btn--ghost" type="submit">Load library</button>
      </form>
      <p class="loading-note">
        Public profiles are read straight from Steam Community.
        Don't know the exact name? <a href="#/users">Search for a profile</a>.
      </p>
      <p class="loading-note">The profile's game details must be public for Steam to list them.</p>
    </div>`;

  root.innerHTML = form;

  const submit = async (event) => {
    event?.preventDefault();
    const value = $('#library-input', root)?.value.trim();
    if (!value) return;
    localStorage.setItem(LIBRARY_KEY, value);
    await loadLibrary(root, ctx, value);
  };

  $('#library-form', root)?.addEventListener('submit', submit);
  $('#steam-signin', root)?.addEventListener('click', () => {
    try {
      account.beginSignIn(ctx.relay.baseUrl);
    } catch (error) {
      toast(error.message, 'error', 7000);
    }
  });
  $('#steam-signout', root)?.addEventListener('click', () => {
    account.clear();
    localStorage.removeItem(LIBRARY_KEY);
    toast('Steam account disconnected', 'ok');
    libraryView(root, ctx);
  });

  if (remembered) await loadLibrary(root, ctx, remembered);
}

async function loadLibrary(root, ctx, who) {
  root.innerHTML = `<p class="loading-note">Loading library…</p>${skeletonGrid(10)}`;

  let data;
  try {
    data = await ctx.relay.request('profile', { id: who, cc: ctx.region, l: ctx.language });
  } catch (error) {
    root.innerHTML = errorHtml(error, { retryLabel: 'Back to lookup' });
    bindRetry(root, () => {
      localStorage.removeItem(LIBRARY_KEY);
      libraryView(root, ctx);
    });
    return;
  }

  const profile = data.profile || {};
  // Viewing your own connected account unlocks nothing extra from Steam, but
  // it does change what this page should tell you about — see `accountPanel`.
  const isMe = account.isConnected() && String(data.steamid) === account.steamid();
  if (isMe) account.decorate({ name: profile.name, avatar: profile.avatar });

  const totalMinutes = data.games.reduce((sum, game) => sum + (game.playtimeForever || 0), 0);
  const online = profile.playingName ? 'in-game' : /online|away|busy|snooze|looking/i.test(profile.onlineState || '') ? 'online' : 'offline';

  const statusLine = profile.playingName
    ? `Currently playing <a href="#/app/${profile.playingAppId || ''}">${esc(profile.playingName)}</a>`
    : esc(profile.stateMessage || (online === 'online' ? 'Online' : 'Offline'));

  /* One activity row per recently played game, with its achievement bar. */
  const activityRow = (game) => {
    const ach = game.achievements;
    const percent = ach?.total ? Math.round((ach.unlocked / ach.total) * 100) : 0;

    return `<article class="activity">
      <a class="activity__art" href="#/app/${game.appid}">
        <img src="${escAttr(game.header)}" data-fallback="${escAttr([game.capsule, game.portrait].filter(Boolean).join('|'))}"
             alt="${escAttr(game.name)}" loading="lazy" decoding="async" />
      </a>
      <div class="activity__body">
        <a class="activity__name" href="#/app/${game.appid}">${esc(game.name)}</a>
        <div class="activity__hours">
          <span>${esc(formatPlaytime(game.playtimeForever))} on record</span>
          ${game.playtime2Weeks ? `<span>${esc(formatPlaytime(game.playtime2Weeks))} past 2 weeks</span>` : ''}
          ${game.lastPlayed ? `<span>last played ${esc(formatDate(game.lastPlayed))}</span>` : ''}
        </div>
      </div>
      ${
        ach
          ? `<div class="activity__ach">
               <span class="activity__achlabel">Achievement Progress <b>${formatNumber(ach.unlocked)} of ${formatNumber(ach.total)}</b></span>
               <span class="activity__bar"><span style="width:${percent}%"></span></span>
               <span class="activity__icons">
                 ${(ach.icons || []).map((icon) => `<img src="${escAttr(icon.icon)}" alt="" title="${escAttr(icon.name || '')}" loading="lazy" />`).join('')}
               </span>
             </div>`
          : ''
      }
    </article>`;
  };

  const friendRow = (friend) => `<a class="friend friend--${esc(friend.state)}" href="#/library/${encodeURIComponent(friend.steamid)}">
      <img src="${escAttr(friend.avatar || '')}" alt="" loading="lazy" />
      <span>
        <span class="friend__name">${esc(friend.name)}</span>
        <span class="friend__state">${esc(friend.status || friend.state)}</span>
      </span>
    </a>`;

  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/library">Profiles</a> &rsaquo; ${esc(profile.name || data.steamid)}</div>

    ${isMe ? accountPanelHtml() : ''}

    <header class="phead">
      <img class="phead__avatar phead__avatar--${esc(online)}" src="${escAttr(profile.avatar || '')}"
           alt="${escAttr(profile.name || '')}" />
      <div class="phead__id">
        <h1 class="phead__name">${esc(profile.name || data.steamid)}</h1>
        ${profile.realname ? `<div class="phead__real">${esc(profile.realname)}</div>` : ''}
        ${profile.country ? `<div class="phead__real">${esc(profile.country)}</div>` : ''}
        ${profile.summary ? `<p class="phead__summary">${esc(profile.summary)}</p>` : ''}
        ${profile.vacBanned ? '<p class="phead__ban">VAC ban on record</p>' : ''}
      </div>
      <div class="phead__side">
        ${
          data.level !== null && data.level !== undefined
            ? `<div class="phead__level">Level <span>${esc(data.level)}</span></div>`
            : ''
        }
        <div class="phead__actions">
          <a class="btn btn--ghost btn--sm" href="${escAttr(profile.profileUrl)}" target="_blank" rel="noopener noreferrer">View on Steam</a>
          <a class="btn btn--ghost btn--sm" href="${escAttr(data.inventoryUrl)}" target="_blank" rel="noopener noreferrer">Inventory</a>
        </div>
      </div>
    </header>

    <div class="players">
      <div class="players__main">
        <section class="panel">
          <div class="panel__head">
            <h2>Recent Activity</h2>
            <span>${data.hours2Weeks !== null && data.hours2Weeks !== undefined ? `${esc(data.hours2Weeks)} hours past 2 weeks` : ''}</span>
          </div>
          <div class="panel__body">
            ${
              data.recent?.length
                ? data.recent.map(activityRow).join('')
                : '<p class="loading-note">No games played in the last two weeks.</p>'
            }
          </div>
        </section>
      </div>

      <aside class="players__side">
        <section class="panel">
          <div class="panel__head"><h2 class="panel__status panel__status--${esc(online)}">${
            online === 'offline' ? 'Currently Offline' : online === 'in-game' ? 'Currently In-Game' : 'Currently Online'
          }</h2></div>
          <div class="panel__body">
            <p class="pstat">${statusLine}</p>
            <a class="pstat pstat--link" href="#library-all">Games <b>${formatNumber(data.gameCount || data.games.length)}</b></a>
            <a class="pstat pstat--link" href="${escAttr(data.inventoryUrl)}" target="_blank" rel="noopener noreferrer">Inventory</a>
            <a class="pstat pstat--link" href="${escAttr(data.badgesUrl)}" target="_blank" rel="noopener noreferrer">Badges</a>
            ${data.groupCount ? `<span class="pstat">Groups <b>${formatNumber(data.groupCount)}</b></span>` : ''}
            ${profile.memberSince ? `<span class="pstat">Member since <b>${esc(profile.memberSince)}</b></span>` : ''}
          </div>
        </section>

        <section class="panel">
          <div class="panel__head"><h2>Friends ${data.friendCount ? `<b>${formatNumber(data.friendCount)}</b>` : ''}</h2></div>
          <div class="panel__body">
            ${
              data.friends?.length
                ? data.friends.slice(0, 24).map(friendRow).join('')
                : `<p class="loading-note">${
                    data.friendsAvailable ? 'No friends to show.' : "This profile's friends list is private or unavailable."
                  }</p>`
            }
          </div>
        </section>
      </aside>
    </div>

    ${
      data.libraryError
        ? `<p class="loading-note" style="text-align:left">${esc(data.libraryError)}</p>`
        : `<section class="section">
             <div class="section__head">
               <h2 class="section__title">Account Value<small>SteamDB-style calculator</small></h2>
               <a class="section__link" href="https://steamdb.info/calculator/${escAttr(data.steamid)}/" target="_blank" rel="noopener noreferrer">Open on SteamDB &rsaquo;</a>
             </div>
             <div id="calc-body"><p class="loading-note">Pricing ${formatNumber(data.games.length)} games…</p></div>
           </section>`
    }

    <section class="section" id="library-all">
      <div class="section__head">
        <h2 class="section__title">All Games<small id="library-count">${formatNumber(data.games.length)} owned</small></h2>
      </div>
      <div class="toolbar">
        <input type="search" id="library-search" placeholder="filter by name" />
        <select id="library-sort">
          <option value="playtime">Sort: playtime</option>
          <option value="name">Sort: alphabetical</option>
          <option value="recent">Sort: recently played</option>
        </select>
        <button class="btn btn--ghost btn--sm" type="button" id="library-change">Look up someone else</button>
      </div>
      <div class="grid grid--portrait" id="library-grid"></div>
    </section>`;

  const grid = $('#library-grid', root);
  const countNode = $('#library-count', root);
  const searchInput = $('#library-search', root);
  const sortSelect = $('#library-sort', root);

  const paint = () => {
    const term = searchInput.value.trim().toLowerCase();
    let games = data.games.filter((game) => !term || game.name.toLowerCase().includes(term));

    if (sortSelect.value === 'name') games = [...games].sort((a, b) => a.name.localeCompare(b.name));
    else if (sortSelect.value === 'recent') games = [...games].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    else games = [...games].sort((a, b) => b.playtimeForever - a.playtimeForever);

    const visible = games.slice(0, 300);
    countNode.textContent = `${formatNumber(games.length)} shown${games.length > visible.length ? ` (first ${visible.length})` : ''}`;
    grid.innerHTML =
      visible
        .map((game) =>
          portraitCardHtml(game, {
            subtitle: game.playtimeForever ? formatPlaytime(game.playtimeForever) : 'never played',
          }),
        )
        .join('') || '<p class="loading-note">No games match that filter.</p>';
    attachImageFallbacks(grid);
  };

  searchInput.addEventListener('input', paint);
  sortSelect.addEventListener('change', paint);
  $('#library-change', root).addEventListener('click', () => {
    localStorage.removeItem(LIBRARY_KEY);
    libraryView(root, ctx);
  });

  paint();
  attachImageFallbacks(root);

  /* Account value — a lot of price lookups, so it lands after the grid. */
  const calcBody = $('#calc-body', root);
  if (calcBody) {
    ctx.relay
      .request('calculator', { id: data.steamid, cc: ctx.region, l: ctx.language }, { timeoutMs: 90_000 })
      .then((calc) => {
        const money = (minor) => formatMoney(minor, calc.currency);
        calcBody.innerHTML = `<div class="stats">
            <div class="stats__tile"><b>${money(calc.valueAtFullPrice)}</b><span>Value at full price</span></div>
            <div class="stats__tile"><b>${money(calc.valueAtCurrentPrice)}</b><span>At today's prices</span></div>
            <div class="stats__tile"><b>${calc.costPerHourMinor === null ? '—' : money(calc.costPerHourMinor)}</b><span>Per hour played</span></div>
            <div class="stats__tile"><b>${formatNumber(calc.playtimeHours)}</b><span>Hours played</span></div>
            <div class="stats__tile"><b>${calc.playedPercent}%</b><span>Games played</span></div>
            <div class="stats__tile"><b>${formatNumber(calc.neverPlayed)}</b><span>Never played</span></div>
            <div class="stats__tile"><b>${formatNumber(calc.priced)}</b><span>Paid titles</span></div>
            <div class="stats__tile"><b>${formatNumber(calc.free)}</b><span>Free titles</span></div>
          </div>
          <p class="loading-note" style="text-align:left">
            Priced in ${esc(calc.currency)} for the ${esc(ctx.region.toUpperCase())} store${calc.truncated ? `, over the first ${formatNumber(calc.gamesConsidered)} of ${formatNumber(calc.gamesTotal)} games` : ''}.
            ${calc.unknown ? `${formatNumber(calc.unknown)} titles have no current store page.` : ''}
          </p>`;
      })
      .catch((error) => {
        calcBody.innerHTML = `<p class="loading-note" style="text-align:left">Could not price this library: ${esc(error.message)}</p>`;
      });
  }
}

/* ================================================================== *
 * Wishlist (this browser only)
 * ================================================================== */

export function wishlistView(root, ctx) {
  ctx.setTitle('Wishlist · Steam Viewer');

  const paint = () => {
    const items = wishlist.all();
    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Wishlist</div>
      <h1 class="apphead__title" style="margin-bottom:6px">Your wishlist</h1>
      <p class="loading-note" style="text-align:left;margin:0 0 16px">
        Saved in this browser — no Steam sign-in, and nothing leaves your device.
        ${items.length ? 'It also tunes the “Recommended For You” rows on the home page.' : ''}
      </p>

      <div class="toolbar">
        <button class="btn btn--ghost btn--sm" type="button" id="wl-export" ${items.length ? '' : 'disabled'}>Export</button>
        <button class="btn btn--ghost btn--sm" type="button" id="wl-import">Import</button>
        <button class="btn btn--ghost btn--sm" type="button" id="wl-clear" ${items.length ? '' : 'disabled'}>Clear all</button>
        <input type="file" id="wl-file" accept="application/json" hidden />
        ${wishlist.ignoredIds().length ? `<button class="btn btn--ghost btn--sm" type="button" id="wl-unignore">Un-hide ${wishlist.ignoredIds().length} ignored</button>` : ''}
      </div>

      ${
        items.length
          ? sectionHtml({ title: 'Saved games', note: `${items.length} title${items.length === 1 ? '' : 's'}`, body: cardsHtml(items, cardOpts()) })
          : `<div class="empty">
               <h2>Nothing saved yet</h2>
               <p>Press ☆ on any game to keep it here.</p>
               <p style="margin-top:16px"><a class="btn btn--green" href="#/">Browse the store</a></p>
             </div>`
      }`;

    attachImageFallbacks(root);
    attachHoverPreviews(root);

    $('#wl-export', root)?.addEventListener('click', () => {
      const blob = new Blob([wishlist.exportJson()], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'steam-viewer-wishlist.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    $('#wl-import', root)?.addEventListener('click', () => $('#wl-file', root).click());
    $('#wl-file', root)?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const added = wishlist.importJson(await file.text());
        toast(`Imported ${added} game${added === 1 ? '' : 's'}`, 'ok');
        paint();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('#wl-clear', root)?.addEventListener('click', () => {
      wishlist.clear();
      toast('Wishlist cleared', 'ok');
      paint();
    });

    $('#wl-unignore', root)?.addEventListener('click', () => {
      for (const appid of wishlist.ignoredIds()) wishlist.unignore(appid);
      toast('Ignored games restored', 'ok');
      paint();
    });

    bindItemActions(root, (appid) => items.find((item) => item.appid === appid));
  };

  paint();
  return wishlist.onChange(() => {
    // Only repaint when the change came from somewhere else (another tab).
    if (!root.isConnected) return;
  });
}

/* ================================================================== *
 * Developer / publisher pages
 * ================================================================== */

export async function creatorView(root, ctx, role, name) {
  const creator = decodeURIComponent(name || '');
  const label = role === 'publisher' ? 'Publisher' : 'Developer';
  ctx.setTitle(`${creator} · Steam Viewer`);
  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(creator)}</div>${skeletonGrid(8)}`;

  let data;
  try {
    data = await ctx.relay.request('creator', { name: creator, role, cc: ctx.region, l: ctx.language });
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => creatorView(root, ctx, role, name));
    return;
  }

  const catalogue = data.catalogue || [];
  const genres = [...new Set(catalogue.flatMap((item) => item.genres || []))].slice(0, 10);
  const rated = catalogue.filter((item) => item.metacritic);
  const averageScore = rated.length ? Math.round(rated.reduce((sum, item) => sum + item.metacritic, 0) / rated.length) : null;

  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(label)} &rsaquo; ${esc(data.name)}</div>

    <div class="profilecard">
      <div>
        <div class="profilecard__name">${esc(data.name)}</div>
        <div class="profilecard__meta">${esc(label)} on Steam</div>
      </div>
      <div class="profilecard__stats">
        <div class="profilecard__stat"><b>${formatNumber(data.total || catalogue.length)}</b><span>Titles</span></div>
        ${averageScore ? `<div class="profilecard__stat"><b>${averageScore}</b><span>Avg Metacritic</span></div>` : ''}
      </div>
    </div>

    ${genres.length ? `<div style="margin-bottom:18px">${genres.map((genre) => `<a class="chip" href="#/genre/${encodeURIComponent(genre)}">${esc(genre)}</a>`).join('')}</div>` : ''}

    ${(data.sections || []).map((section) => sectionHtml({ title: section.label, body: cardsHtml(visible(section.items), cardOpts()) })).join('')}

    <p class="loading-note" style="text-align:left">
      <a href="https://store.steampowered.com/search/?${role}=${encodeURIComponent(data.name)}" target="_blank" rel="noopener noreferrer">
        See every ${esc(label.toLowerCase())} title on Steam &rsaquo;
      </a>
    </p>`;

  attachImageFallbacks(root);
  attachHoverPreviews(root);
  bindItemActions(root, (appid) => catalogue.find((item) => item.appid === appid));
}

/* ================================================================== *
 * Find people
 * ================================================================== */

export async function usersView(root, ctx, query) {
  const term = decodeURIComponent(query || '');
  ctx.setTitle('Find people · Steam Viewer');

  const form = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Find people</div>
    <h1 class="apphead__title" style="margin-bottom:6px">Find a Steam profile</h1>
    <p class="loading-note" style="text-align:left;margin:0 0 12px">
      Search by persona name, or paste a SteamID64, a custom URL name, or a full
      <code>steamcommunity.com</code> link. No sign-in needed — public profiles only.
    </p>
    <form class="formrow" id="users-form" style="justify-content:flex-start">
      <input type="text" id="users-input" placeholder="zdstudio12345" value="${escAttr(term)}" />
      <button class="btn btn--green" type="submit">Search</button>
    </form>
    <div id="users-results"></div>`;

  root.innerHTML = form;

  const results = $('#users-results', root);

  const run = async (text) => {
    if (!text) return;
    results.innerHTML = '<p class="loading-note">Searching Steam Community…</p>';
    try {
      const data = await ctx.relay.request('usersearch', { text });
      if (!data.results?.length) {
        results.innerHTML = `<div class="empty"><h2>No profiles matched “${esc(text)}”</h2>
          <p>Try the exact custom URL name, or paste the profile link.</p></div>`;
        return;
      }

      results.innerHTML = `<section class="section">
        <div class="section__head"><h2 class="section__title">Profiles<small>${formatNumber(data.total)} found</small></h2></div>
        <div class="grid grid--wide">
          ${data.results
            .map(
              (person) => `<a class="usercard" href="#/library/${encodeURIComponent(person.lookup || person.steamid || '')}">
                  <img src="${escAttr(person.avatar || '')}" alt="" loading="lazy" />
                  <div>
                    <div class="usercard__name">${esc(person.name)}</div>
                    <div class="usercard__id">${esc(person.steamid || '')}</div>
                  </div>
                </a>`,
            )
            .join('')}
        </div>
        ${data.degraded ? '<p class="loading-note">Community search was unavailable, so this is a direct profile match.</p>' : ''}
      </section>`;
      attachImageFallbacks(results);
    } catch (error) {
      results.innerHTML = errorHtml(error);
      bindRetry(results, () => run(text));
    }
  };

  $('#users-form', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#users-input', root).value.trim();
    if (value) window.location.hash = `#/users/${encodeURIComponent(value)}`;
  });

  if (term) await run(term);
}

/* ================================================================== *
 * Remote play
 * ================================================================== */

const AGENT_KEY = 'steam-viewer:agent-code';
const STREAM_KEY = 'steam-viewer:web-stream-url';

/**
 * A Remote Play card.
 *
 * These used to reuse the store's portrait card, which asks for
 * `library_600x900.jpg`. A large share of installed apps have no portrait art
 * at all — tools, older titles, anything published before Valve introduced the
 * library capsule — so the card rendered empty for exactly the games people
 * have installed. `header.jpg` is the one asset every app on Steam has, so
 * these are built landscape around it, with the appid-derived URLs listed as
 * fallbacks so a card still fills in when the relay never answers.
 */
function installedCard(game, store) {
  const appid = game.appid;
  const name = store?.name || game.name;
  const primary =
    store?.header || store?.capsule || `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
  const chain = [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
    `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
    store?.capsule,
    store?.portrait,
  ].filter((url, index, all) => url && url !== primary && all.indexOf(url) === index);

  return `<a class="installed__art" href="#/app/${appid}" title="${escAttr(name)}">
      <span class="installed__fallback">${esc(name)}</span>
      <img src="${escAttr(primary)}" data-fallback="${escAttr(chain.join('|'))}"
           alt="${escAttr(name)}" loading="lazy" decoding="async" />
    </a>
    <div class="installed__name" title="${escAttr(name)}">${esc(name)}</div>
    <div class="installed__state">${game.fullyInstalled ? 'installed' : 'downloading'}${
      game.sizeOnDisk ? ` · ${formatBytes(game.sizeOnDisk)}` : ''
    }</div>`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

/**
 * A link that opens the stream on its own, with everything needed to play it
 * in the URL: which relay to talk to and which PC to watch. Anyone who has the
 * link can watch — the pairing code *is* the credential, which is why the
 * agent rotates it on every restart.
 */
export function watchLink(relayBase, code) {
  const url = new URL(window.location.href);
  url.hash = `#/watch/${encodeURIComponent(String(code || '').toUpperCase())}`;
  url.search = relayBase ? `?server=${encodeURIComponent(relayBase)}` : '';
  return url.toString();
}

/**
 * Wire a <video> to an agent's screen stream and keep it fed.
 *
 * Shared by the panel on the Remote Play page and the standalone watch page so
 * both behave identically — including stopping the encoder on the way out.
 *
 * @returns {{stop: () => void}}
 */
async function attachStream({ ctx, code, video, say, onEnded }) {
  const choice = pickCodec();
  if (!choice) throw new Error('This browser cannot play the stream — no supported video codec.');

  // Fragments only ever arrive as binary WebSocket frames. Issuing
  // `stream.watch` over the HTTP fallback registers a connection that can
  // never receive them, which is how a freshly-opened share link ended up
  // watching a stream that never started.
  const online = await ctx.relay.whenOnline();
  if (!online) throw new Error('The relay is not reachable over WebSocket, so the stream cannot be delivered.');

  say?.('starting the encoder…');
  await ctx.relay.request('stream.watch', { code });
  await ctx.relay.request('agent', { code, op: 'stream.start', codec: choice.codec }, { timeoutMs: 40_000 });

  const player = new ScreenPlayer(
    video,
    ({ state, detail, behindMs }) => {
      if (state === 'stats') say?.(behindMs > 1500 ? `live · ${(behindMs / 1000).toFixed(1)} s behind` : `live · ${behindMs} ms behind`);
      else if (state === 'playing') say?.('live');
      else if (state === 'waiting') say?.('waiting for the first frame…');
      else if (state === 'error') {
        say?.('');
        toast(detail || 'The stream failed.', 'error', 8000);
      } else if (detail) say?.(detail);
    },
    choice.mime,
  );
  player.start();

  const offChunk = ctx.relay.on('stream-chunk', (buffer) => player.push(buffer));
  const offState = ctx.relay.on('stream', (payload) => {
    if (payload?.state === 'ended') {
      say?.(payload.reason || 'the stream ended');
      onEnded?.(payload);
    }
  });

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      offChunk();
      offState();
      player.stop();
      ctx.relay.request('agent', { code, op: 'stream.stop' }).catch(() => {});
      ctx.relay.request('stream.leave', {}).catch(() => {});
    },
  };
}

/* ------------------------------------------------------------------ *
 * Standalone watch page — #/watch/<code>
 * ------------------------------------------------------------------ */

export async function watchView(root, ctx, arg) {
  const code = decodeURIComponent(String(arg || ''))
    .trim()
    .toUpperCase();
  ctx.setTitle(`${code || 'Watch'} · Steam Viewer`);

  if (!/^[A-Z0-9]{6,16}$/.test(code)) {
    root.innerHTML = `<div class="empty"><h2>That watch link is incomplete</h2>
      <p>A watch link looks like <code>#/watch/K7QM2XPD</code>. Open <a href="#/play">Remote Play</a> and copy the share
      link from there.</p></div>`;
    return;
  }

  root.innerHTML = `
    <div class="theatre">
      <div class="theatre__head">
        <div>
          <h1 class="theatre__title">Watching <code>${esc(code)}</code></h1>
          <p class="theatre__meta" id="watch-status">connecting…</p>
        </div>
        <div class="stream__actions">
          <button class="btn btn--ghost btn--sm" type="button" id="watch-full">Fullscreen</button>
          <button class="btn btn--ghost btn--sm" type="button" id="watch-copy">Copy this link</button>
          <a class="btn btn--ghost btn--sm" href="#/play">Remote Play</a>
        </div>
      </div>
      <video id="watch-video" class="theatre__video" playsinline muted autoplay></video>
      <div id="watch-problem"></div>
      <p class="loading-note" style="text-align:left">
        Everything this page needs is in the address bar — the relay and the pairing code — so the link works in any
        browser, on any machine, with nothing set up first. Anyone who has it can watch, so treat it like a password.
      </p>
    </div>`;

  const video = $('#watch-video', root);
  const status = $('#watch-status', root);
  const say = (text) => {
    status.textContent = text;
  };

  $('#watch-full', root).addEventListener('click', () => {
    (video.requestFullscreen?.() || video.webkitEnterFullscreen?.())?.catch?.(() => {});
  });
  $('#watch-copy', root).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(watchLink(ctx.relay.baseUrl, code));
      toast('Watch link copied', 'ok');
    } catch {
      toast('Could not copy — the link is in the address bar', 'info');
    }
  });

  // The page chrome stays up whatever happens: a shared link that cannot
  // connect should say why on a page that still looks like the watch page,
  // with the code visible, rather than replacing itself with a bare error.
  const problem = $('#watch-problem', root);
  let session = null;

  const connect = async () => {
    problem.innerHTML = '';
    video.hidden = false;
    try {
      session = await attachStream({ ctx, code, video, say, onEnded: () => say('the stream ended') });
    } catch (error) {
      say('not connected');
      video.hidden = true;
      problem.innerHTML = errorHtml(error, { retryLabel: 'Try again' });
      bindRetry(problem, connect);
    }
  };

  await connect();

  return () => session?.stop();
}

export async function playView(root, ctx) {
  ctx.setTitle('Remote Play · Steam Viewer');
  const saved = localStorage.getItem(AGENT_KEY) || '';

  // Navigating away must stop the encoder on the PC, not leave it running.
  const streamCleanups = [];

  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Remote Play</div>
    <h1 class="apphead__title" style="margin-bottom:6px">Remote Play</h1>
    <p class="loading-note" style="text-align:left;margin:0 0 14px">
      Run <strong>Steam Viewer Agent</strong> on your gaming PC and pair it here. The site can then list the games you
      actually have installed and start them on that machine — no Steam password involved, and nothing to port-forward.
    </p>

    <form class="formrow" id="agent-form" style="justify-content:flex-start">
      <input type="text" id="agent-code" placeholder="Pairing code (e.g. K7QM2XPD)" value="${escAttr(saved)}" maxlength="16" style="text-transform:uppercase" />
      <button class="btn btn--green" type="submit">Connect</button>
      ${saved ? '<button class="btn btn--ghost" type="button" id="agent-forget">Forget</button>' : ''}
    </form>

    <div id="agent-body">
      <div class="empty" style="margin-top:20px">
        <h2>Not paired yet</h2>
        <p style="max-width:620px;margin:0 auto">On the PC that has your games:</p>
        <pre class="setup">git clone this repo
cd steam-viewer/agent
npm install
npm start -- --relay ${esc(ctx.relay.baseUrl || 'https://your-service.onrender.com')}</pre>
        <p>It prints a pairing code — type that above.</p>
        <p class="loading-note" style="max-width:620px;margin:14px auto 0">
          To watch the game in this page as well, install
          <a href="https://app.lizardbyte.dev/Sunshine/" target="_blank" rel="noopener noreferrer">Sunshine</a> and
          <a href="https://github.com/MrCreativ3001/moonlight-web-stream" target="_blank" rel="noopener noreferrer">moonlight-web-stream</a>
          on the same PC. The agent detects it and the player appears here. Give it a certificate in its
          <code>server/config.json</code> and it embeds inline; without one it opens in its own tab, because an HTTPS
          page cannot embed a plain-http origin. A native
          <a href="https://moonlight-stream.org/" target="_blank" rel="noopener noreferrer">Moonlight</a> client is
          detected too, if you prefer it.
        </p>
      </div>
    </div>`;

  const body = $('#agent-body', root);

  const connect = async (code) => {
    // Reconnecting rebuilds the panel; retire the previous one's teardown.
    while (streamCleanups.length) streamCleanups.pop()();
    body.innerHTML = '<p class="loading-note">Contacting your PC…</p>';
    try {
      const data = await ctx.relay.request('agent', { code, op: 'games' });
      localStorage.setItem(AGENT_KEY, code);
      renderAgent(data, code);
    } catch (error) {
      body.innerHTML = errorHtml(error, { retryLabel: 'Try again' });
      bindRetry(body, () => connect(code));
    }
  };

  const renderAgent = (data, code) => {
    const games = data.games || [];
    const streaming = data.streaming || { available: false };

    body.innerHTML = `
      <div class="profilecard" style="margin-top:18px">
        <div>
          <div class="profilecard__name">${esc(data.host || 'Your PC')}</div>
          <div class="profilecard__meta">
            Paired as <code>${esc(code)}</code> ·
            ${streaming.available ? 'Sunshine detected — streaming available' : 'no streaming host detected'}
          </div>
        </div>
        <div class="profilecard__stats">
          <div class="profilecard__stat"><b>${formatNumber(games.length)}</b><span>Installed</span></div>
        </div>
      </div>

      <div id="builtin-slot"></div>
      <div id="stream-slot"></div>

      <div class="toolbar">
        <input type="search" id="agent-filter" placeholder="filter installed games" />
        <button class="btn btn--ghost btn--sm" type="button" id="agent-refresh">Rescan library</button>
      </div>

      <div class="grid grid--installed" id="agent-grid"></div>`;

    /* — built-in streaming (agent + ffmpeg) — */
    const builtIn = streaming.builtIn || {};
    let session = null;

    const paintBuiltIn = () => {
      const slot = $('#builtin-slot', body);
      if (!slot) return;

      slot.innerHTML = `
        <section class="panel stream" style="margin-bottom:16px">
          <div class="panel__head">
            <h2>Watch this PC</h2>
            <span>${builtIn.available ? 'built in' : 'unavailable'}</span>
          </div>
          <div class="panel__body">
            ${
              builtIn.available
                ? `<div class="stream__actions">
                     <button class="btn btn--green btn--sm" type="button" id="builtin-start">▶ Start watching</button>
                     <button class="btn btn--ghost btn--sm" type="button" id="builtin-stop" hidden>Stop</button>
                     <a class="btn btn--ghost btn--sm" href="#/watch/${escAttr(code)}" target="_blank" rel="noopener">Open in a new tab</a>
                     <button class="btn btn--ghost btn--sm" type="button" id="builtin-share">Copy share link</button>
                     <span class="stream__status" id="builtin-status"></span>
                   </div>
                   <video id="builtin-video" class="stream__video" playsinline muted hidden></video>
                   <p class="loading-note" style="text-align:left">
                     Encoded on your PC with ffmpeg and delivered through the relay, one frame per fragment so nothing
                     waits on a buffer. The page shows the delay it is actually measuring rather than a number we
                     promised. <strong>Open in a new tab</strong> gives a self-contained link — the relay and the
                     pairing code are both in the URL, so it plays for anyone you send it to, on any machine, with
                     nothing installed. For controller and mouse <em>input</em> as well as picture, use the
                     moonlight-web-stream panel below.
                   </p>`
                : `<p class="loading-note" style="text-align:left">
                     ${esc(builtIn.reason || 'Built-in streaming is not available on that PC.')}
                     Install <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer">ffmpeg</a>,
                     make sure <code>ffmpeg</code> runs from a terminal, and restart the agent.
                   </p>`
            }
          </div>
        </section>`;

      if (!builtIn.available) return;

      const video = $('#builtin-video', slot);
      const startButton = $('#builtin-start', slot);
      const stopButton = $('#builtin-stop', slot);
      const status = $('#builtin-status', slot);
      const say = (text) => {
        status.textContent = text;
      };

      const stopWatching = () => {
        session?.stop();
        session = null;
        video.hidden = true;
        startButton.hidden = false;
        stopButton.hidden = true;
        say('');
      };

      startButton.addEventListener('click', async () => {
        startButton.disabled = true;
        try {
          session = await attachStream({ ctx, code, video, say, onEnded: stopWatching });
        } catch (error) {
          say('');
          toast(error.message, 'error', 8000);
          startButton.disabled = false;
          return;
        }

        video.hidden = false;
        startButton.hidden = true;
        startButton.disabled = false;
        stopButton.hidden = false;
      });

      stopButton.addEventListener('click', stopWatching);

      $('#builtin-share', slot)?.addEventListener('click', async () => {
        const link = watchLink(ctx.relay.baseUrl, code);
        try {
          await navigator.clipboard.writeText(link);
          toast('Share link copied — it plays anywhere', 'ok', 4000);
        } catch {
          // Clipboard access needs a secure context and a user gesture; if the
          // browser refuses, show the link so it can still be copied by hand.
          toast(link, 'info', 12_000);
        }
      });

      // Leaving the page must not leave ffmpeg running on the PC.
      streamCleanups.push(() => session?.stop());
    };

    /* — in-browser streaming via moonlight-web-stream — */
    const streamSlot = $('#stream-slot', body);
    const savedStream = localStorage.getItem(STREAM_KEY) || '';
    const webStream = streaming.webStream || {};
    const canStream = Boolean(streaming.builtIn?.available || savedStream || webStream.url || webStream.localUrl);
    // A manual override wins: the agent can only see its own machine.
    const streamUrl = savedStream || webStream.url || webStream.localUrl || '';
    const streamSecure = streamUrl.startsWith('https://');

    const paintStream = () => {
      streamSlot.innerHTML = `
        <section class="panel stream" style="margin-bottom:16px">
          <div class="panel__head">
            <h2>Stream in browser</h2>
            <span>${
              streamUrl
                ? esc(webStream.source === 'configured' ? 'configured' : savedStream ? 'manual' : 'detected')
                : 'not set up'
            }</span>
          </div>
          <div class="panel__body">
            ${
              streamUrl
                ? `<p class="pstat">
                     <span>moonlight-web-stream at <code>${esc(streamUrl)}</code></span>
                   </p>
                   ${
                     streamSecure
                       ? `<div class="stream__actions">
                            <button class="btn btn--green btn--sm" type="button" id="stream-open">Open the player here</button>
                            <a class="btn btn--ghost btn--sm" href="${escAttr(streamUrl)}" target="_blank" rel="noopener noreferrer">Open in a new tab</a>
                          </div>
                          <div id="stream-frame"></div>`
                       : `<div class="stream__actions">
                            <a class="btn btn--green btn--sm" href="${escAttr(streamUrl)}" target="_blank" rel="noopener noreferrer">Open the player in a new tab</a>
                          </div>
                          <p class="diag__warn">
                            This page is served over HTTPS, so it can only embed another <strong>https</strong> origin —
                            a plain-http player has to open in its own tab. To watch it inline, give
                            moonlight-web-stream a certificate: set <code>certificate</code> in its
                            <code>server/config.json</code>, restart it, then visit it once directly to accept the
                            certificate.
                          </p>`
                   }`
                : `<p class="loading-note" style="text-align:left">
                     No moonlight-web-stream server found on that PC.
                     <a href="https://github.com/MrCreativ3001/moonlight-web-stream" target="_blank" rel="noopener noreferrer">Install it</a>
                     alongside Sunshine, run its <code>web-server</code>, then reconnect here — or enter its address below
                     if it runs somewhere else.
                   </p>`
            }

            <form class="formrow" id="stream-form" style="justify-content:flex-start;margin-top:6px">
              <input type="url" id="stream-url" placeholder="https://192.168.1.50:8080" value="${escAttr(savedStream)}" />
              <button class="btn btn--ghost btn--sm" type="submit">Use this address</button>
              ${savedStream ? '<button class="btn btn--ghost btn--sm" type="button" id="stream-clear">Clear</button>' : ''}
            </form>

            ${
              streaming.moonlightUrl
                ? `<p class="pstat"><span>Native client</span>
                     <a class="btn btn--ghost btn--sm" href="${escAttr(streaming.moonlightUrl)}">Open in Moonlight</a></p>`
                : ''
            }
            ${
              streaming.sunshineWebUi
                ? `<p class="pstat"><span>Sunshine settings</span>
                     <a class="btn btn--ghost btn--sm" href="${escAttr(streaming.sunshineWebUi)}" target="_blank" rel="noopener noreferrer">Open</a></p>`
                : ''
            }
            ${!streaming.sunshine ? `<p class="loading-note" style="text-align:left">${esc(streaming.note || '')}</p>` : ''}
          </div>
        </section>`;

      $('#stream-open', streamSlot)?.addEventListener('click', () => {
        const frame = $('#stream-frame', streamSlot);
        if (frame.querySelector('iframe')) {
          frame.replaceChildren();
          $('#stream-open', streamSlot).textContent = 'Open the player here';
          return;
        }
        frame.innerHTML = `<iframe class="stream__frame" src="${escAttr(streamUrl)}"
            allow="autoplay; fullscreen; gamepad; clipboard-write; encrypted-media"
            allowfullscreen referrerpolicy="no-referrer"></iframe>`;
        $('#stream-open', streamSlot).textContent = 'Close the player';
      });

      $('#stream-form', streamSlot)?.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = $('#stream-url', streamSlot).value.trim();
        if (!value) return;
        localStorage.setItem(STREAM_KEY, value);
        toast('Stream address saved', 'ok');
        connect(code);
      });

      $('#stream-clear', streamSlot)?.addEventListener('click', () => {
        localStorage.removeItem(STREAM_KEY);
        connect(code);
      });
    };

    paintBuiltIn();
    paintStream();

    const grid = $('#agent-grid', body);
    const filter = $('#agent-filter', body);

    /**
     * The agent only knows an appid and the name in Steam's manifest, so the
     * store art is fetched from the relay and merged in — the same cards the
     * rest of the site uses, rather than guessed URLs that 404.
     */
    const art = new Map();

    const paint = () => {
      const term = filter.value.trim().toLowerCase();
      const shown = games.filter((game) => !term || game.name.toLowerCase().includes(term));
      grid.innerHTML =
        shown
          .map(
            (game) => `<div class="installed">
                ${installedCard(game, art.get(game.appid))}
                <button class="btn btn--green btn--sm" type="button" data-launch="${game.appid}">▶ Play on PC</button>
                ${canStream ? `<button class="btn btn--ghost btn--sm" type="button" data-stream="${game.appid}">▶ Play &amp; stream</button>` : ''}
              </div>`,
          )
          .join('') || '<p class="loading-note">No installed games match that filter.</p>';
      attachImageFallbacks(grid);
    };

    /** Pull store art in batches; repaint as each batch lands. */
    const loadArt = async () => {
      const ids = games.map((game) => game.appid);
      for (let index = 0; index < ids.length; index += 25) {
        const batch = ids.slice(index, index + 25);
        try {
          const items = await ctx.relay.request('apps', { appids: batch, cc: ctx.region, l: ctx.language }, { timeoutMs: 60_000 });
          for (const item of items) art.set(item.appid, item);
          paint();
        } catch {
          // A batch that fails just keeps the constructed-URL fallbacks.
        }
      }
    };

    filter.addEventListener('input', paint);
    paint();
    loadArt();

    grid.addEventListener('click', async (event) => {
      const streamButton = event.target.closest('[data-stream]');
      if (streamButton) {
        // Start the game on the PC, then hand the visitor the player.
        const appid = Number(streamButton.dataset.stream);
        streamButton.disabled = true;
        try {
          await ctx.relay.request('agent', { code, op: 'launch', appid });
          toast('Game starting — opening the stream', 'ok');

          // moonlight-web-stream carries input as well as picture, so it wins
          // when it is set up. Otherwise fall back to the built-in encoder,
          // which needs nothing installed — previously this branch opened an
          // empty URL, which is why "Play & stream" appeared to do nothing on
          // a PC without Sunshine.
          if (streamUrl && streamSecure) {
            $('#stream-open', body)?.click();
            $('#stream-slot', body)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else if (streamUrl) {
            window.open(streamUrl, '_blank', 'noopener');
          } else if (builtIn.available) {
            if (!session) $('#builtin-start', body)?.click();
            $('#builtin-slot', body)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } catch (error) {
          toast(error.message, 'error', 7000);
        } finally {
          streamButton.disabled = false;
        }
        return;
      }

      const button = event.target.closest('[data-launch]');
      if (!button) return;
      const appid = Number(button.dataset.launch);
      button.disabled = true;
      button.textContent = 'Launching…';
      try {
        const result = await ctx.relay.request('agent', { code, op: 'launch', appid });
        toast(`${result.name} is starting on ${data.host}`, 'ok');
        if (streaming.available && streaming.moonlightUrl) {
          toast('Open Moonlight to watch it', 'info', 6000);
        }
      } catch (error) {
        toast(error.message, 'error', 7000);
      } finally {
        button.disabled = false;
        button.textContent = '▶ Play on PC';
      }
    });

    $('#agent-refresh', body).addEventListener('click', async () => {
      try {
        await ctx.relay.request('agent', { code, op: 'refresh' });
        await connect(code);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  };

  $('#agent-form', root).addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('#agent-code', root).value.trim().toUpperCase();
    if (code) connect(code);
  });

  $('#agent-forget', root)?.addEventListener('click', () => {
    localStorage.removeItem(AGENT_KEY);
    playView(root, ctx);
  });

  if (saved) await connect(saved);

  // The router calls this before the next navigation.
  return () => {
    for (const stop of streamCleanups) {
      try {
        stop();
      } catch {
        /* best effort */
      }
    }
  };
}

/* ================================================================== *
 * Diagnostics
 * ================================================================== */

/** Features this build of the page expects the relay to provide. */
const EXPECTED_FEATURES = [
  'trailer-probe',
  'genre-search',
  'creator-pages',
  'discovery-rows',
  'profile-rich',
  'profile-keyless',
  'calculator',
  'steamspy',
  'remote-play',
  'dedupe',
  'media-proxy',
  'agent-stream',
  'genre-tags',
  'steam-openid',
];

/** Can the browser actually load this media URL? */
function probeMedia(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = performance.now();
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;

    const finish = (ok, note) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load?.();
      resolve({ url, ok, ms: Math.round(performance.now() - started), note });
    };

    const timer = setTimeout(() => finish(false, 'timed out'), timeoutMs);
    video.addEventListener('loadedmetadata', () => finish(true, `${Math.round(video.duration || 0)}s`), { once: true });
    video.addEventListener('error', () => finish(false, 'blocked, 404 or unsupported'), { once: true });
    video.src = url;
  });
}

function probeImage(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = performance.now();
    const image = new Image();
    const finish = (ok, note) => {
      clearTimeout(timer);
      resolve({ url, ok, ms: Math.round(performance.now() - started), note });
    };
    const timer = setTimeout(() => finish(false, 'timed out'), timeoutMs);
    image.onload = () => finish(true, `${image.naturalWidth}×${image.naturalHeight}`);
    image.onerror = () => finish(false, 'blocked or 404');
    image.src = url;
  });
}

const resultRow = (result) =>
  `<tr class="${result.ok ? 'is-ok' : 'is-bad'}">
     <td>${result.ok ? '✔' : '✘'}</td>
     <td class="diag__url">${esc(result.url)}</td>
     <td>${esc(result.note || '')}</td>
     <td>${result.ms}ms</td>
   </tr>`;

export async function diagnosticsView(root, ctx) {
  ctx.setTitle('Diagnostics · Steam Viewer');

  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Diagnostics</div>
    <h1 class="apphead__title" style="margin-bottom:6px">Media &amp; relay check</h1>
    <p class="loading-note" style="text-align:left;margin:0 0 16px">
      Runs from your browser against your relay and Steam's CDNs. If trailers or images are not showing, this says
      which part is at fault — screenshot it and it is usually obvious.
    </p>
    <div class="toolbar">
      <input type="number" id="diag-appid" value="620" min="1" style="width:130px" aria-label="App ID to test" />
      <button class="btn btn--green btn--sm" type="button" id="diag-run">Run the check</button>
    </div>
    <div id="diag-out"></div>`;

  const out = $('#diag-out', root);

  const run = async () => {
    const appid = Number($('#diag-appid', root).value) || 620;
    out.innerHTML = '<p class="loading-note">Checking…</p>';

    /* 1 — relay identity and feature set */
    let caps = null;
    let capsError = null;
    try {
      caps = await ctx.relay.request('capabilities', {}, { timeoutMs: 75_000 });
    } catch (error) {
      capsError = error.message;
    }

    const missing = caps ? EXPECTED_FEATURES.filter((feature) => !(caps.features || []).includes(feature)) : [];

    /* 2 — the game payload, and where its trailers point */
    let game = null;
    let gameError = null;
    try {
      const payload = await ctx.relay.request('app', { appid, cc: ctx.region, l: ctx.language }, { timeoutMs: 75_000 });
      game = payload.game;
    } catch (error) {
      gameError = error.message;
    }

    const movie = game?.movies?.[0] || null;
    const sources = movieSources(movie).slice(0, 6);

    out.innerHTML = `
      <section class="section">
        <div class="section__head"><h2 class="section__title">Relay</h2></div>
        <table class="diag">
          <tr><td>URL</td><td class="diag__url">${esc(ctx.relay.baseUrl || 'not configured')}</td></tr>
          <tr><td>Transport</td><td>${esc(ctx.relay.state)}</td></tr>
          <tr><td>Page build</td><td>${esc(window.STEAM_VIEWER_CLIENT_BUILD || 'unknown')}</td></tr>
          <tr><td>Relay build</td><td>${caps ? esc(caps.build || 'unknown (old relay)') : `<span class="is-bad">unreachable — ${esc(capsError)}</span>`}</td></tr>
          <tr><td>Asset proxy</td><td>${
            caps ? ((caps.features || []).includes('media-proxy') ? '<span class="is-ok">available</span>' : 'not on this relay') : '—'
          }</td></tr>
          <tr><td>Steam API key</td><td>${caps ? (caps.apiKey ? 'set' : 'not set (profiles still work)') : '—'}</td></tr>
          <tr><td>Features</td><td>${
            !caps
              ? '—'
              : missing.length === 0
                ? '<span class="is-ok">all present</span>'
                : `<span class="is-bad">missing: ${esc(missing.join(', '))}</span>`
          }</td></tr>
        </table>
        ${
          caps && missing.length
            ? `<p class="diag__warn">
                 Your relay is answering, but it is running older code than this page — it is missing
                 <strong>${esc(missing.join(', '))}</strong>.
                 In Render, check that the service's <em>Branch</em> is the branch you are deploying from, then
                 Manual Deploy ▸ Deploy latest commit. Trailers, genres and profile detail all depend on relay-side
                 changes.
               </p>`
            : ''
        }
      </section>

      <section class="section">
        <div class="section__head"><h2 class="section__title">Trailer sources<small>app ${appid}</small></h2></div>
        ${
          gameError
            ? `<p class="diag__warn">Could not load the game: ${esc(gameError)}</p>`
            : !movie
              ? '<p class="loading-note" style="text-align:left">Steam returned no trailers for this app. Try 620 (Portal 2) or 730.</p>'
              : `<p class="loading-note" style="text-align:left">
                   Steam lists ${formatNumber(game.movies.length)} trailer(s) for this app. The relay sent
                   ${movie.sources ? `${formatNumber(movie.sources.length)} candidate source(s)` : 'no candidate list (older relay)'}${
                     movie.verified === false ? ', none of which it could verify itself' : movie.verified ? ', one of which it verified' : ''
                   }${movie.probeFailed ? ' (its own probe failed, so the list is unordered)' : ''}.
                   Testing ${sources.length} of them in this browser, then the relay if none work.
                 </p>
                 <table class="diag" id="diag-media"><tbody><tr><td colspan="4">testing…</td></tr></tbody></table>`
        }
      </section>

      <section class="section">
        <div class="section__head"><h2 class="section__title">Image CDNs</h2></div>
        <table class="diag" id="diag-images"><tbody><tr><td colspan="4">testing…</td></tr></tbody></table>
      </section>`;

    /* 3 + 4 — try every candidate, and the image hosts, all at once. One
       unreachable URL must not hold the whole report up. */
    const mediaDone = sources.length
      ? Promise.all(sources.map((url) => probeMedia(url))).then(async (results) => {
          const table = $('#diag-media tbody', out);
          if (!table) return;
          const anyDirect = results.some((result) => result.ok);

          // The game page does not give up when every CDN host fails — it
          // re-requests the trailer through the relay. Reporting a flat
          // failure without testing that would call a working page broken.
          let viaRelay = null;
          if (!anyDirect) {
            table.innerHTML = `${results.map(resultRow).join('')}<tr><td colspan="4">no CDN host answered — trying the relay…</td></tr>`;
            // /trailer is where the game page ends up: the relay resolves the
            // address itself, so it works even when every URL above is wrong.
            const relayUrl = relayTrailer(appid, 0) || proxied(sources[0]);
            viaRelay = relayUrl
              ? { ...(await probeMedia(relayUrl, 30_000)), note: 'served by your relay' }
              : { url: '—', ok: false, ms: 0, note: 'relay has no /media route, so there is no fallback' };
          }

          table.innerHTML =
            results.map(resultRow).join('') +
            (viaRelay && viaRelay.url !== '—' ? resultRow(viaRelay) : '') +
            `<tr><td colspan="4">${
              anyDirect
                ? '<span class="is-ok">At least one source plays directly — trailers should work on the game page.</span>'
                : viaRelay?.ok
                  ? '<span class="is-ok">No CDN host answered, but the relay served it — trailers will play, just routed through your relay.</span>'
                  : `<span class="is-bad">Nothing played, directly or through the relay.${
                      caps && missing.length
                        ? ' Your relay is running older code than this page (see above) — deploy the latest commit first; that is the most likely cause.'
                        : " Something between this browser and Steam's video CDN is blocking it — a network filter, DNS, a VPN or an extension."
                    }</span>`
            }</td></tr>`;
        })
      : Promise.resolve();

    const imagesDone = Promise.all(
      [
        `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
        `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
      ].map((url) => probeImage(url)),
    ).then((results) => {
      const table = $('#diag-images tbody', out);
      if (table) table.innerHTML = results.map(resultRow).join('');
    });

    await Promise.all([mediaDone, imagesDone]);
  };

  $('#diag-run', root).addEventListener('click', run);
  await run();
}

/* ================================================================== *
 * About
 * ================================================================== */

export function aboutView(root, ctx) {
  ctx.setTitle('About · Steam Viewer');
  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; About</div>
    <h1 class="apphead__title" style="margin-bottom:14px">How this works</h1>
    <div class="gamedesc" style="max-width:760px">
      <p>
        This page is static — it is served by GitHub Pages and contains no Steam credentials. All data comes from a small
        relay you host yourself (the <code>server/</code> folder in this repository, deployed to Render).
      </p>
      <h2>The relay</h2>
      <p>
        The browser opens a WebSocket to <code>wss://your-service.onrender.com/ws</code> and sends action envelopes such as
        <code>{"action":"search","params":{"term":"portal"}}</code>. The relay calls Steam's public store endpoints, caches
        every response in memory and answers. It also pushes live updates: the most-played chart every couple of minutes,
        and player counts for whichever game you are looking at.
      </p>
      <p>
        If the WebSocket cannot be established, the page silently falls back to <code>GET /api/&lt;action&gt;</code> on the
        same host, so everything except the live pushes keeps working.
      </p>
      <h2>What you can do here</h2>
      <ul>
        <li>Search the whole Steam catalogue, with suggestions as you type.</li>
        <li>Browse top sellers, new releases, specials, coming soon, genres and the live most-played chart.</li>
        <li>Open any game for trailers, screenshots, the full store description, tags, system requirements,
            achievements, DLC, news, reviews and ownership stats.</li>
        <li>Open a developer or publisher to see everything they have shipped.</li>
        <li>Keep a <a href="#/wishlist">wishlist</a> in this browser — it needs no Steam sign-in and it tunes the
            “Recommended For You” rows on the home page.</li>
        <li>Look up <a href="#/library">any public Steam profile</a> and value its library, with no sign-in from you
            or the profile's owner — or <a href="#/library">connect your own account</a> through Steam so it opens
            straight to yours.</li>
        <li>Pair your gaming PC under <a href="#/play">Remote Play</a> to list and launch your installed games, and
            watch the screen in the browser — including from a <a href="#/play">shareable link</a> that carries
            everything it needs in the URL.</li>
        <li>Switch store region to see local pricing.</li>
      </ul>

      <h2>Where the numbers come from</h2>
      <p>
        Store data, prices, reviews, player counts and the most-played chart come from Steam's own public endpoints.
        Ownership and playtime estimates come from SteamSpy. The account-value calculator is computed here from
        Steam's bulk price API against the profile's library.
      </p>
      <p>
        SteamDB is <em>linked</em>, never scraped — it sits behind bot protection and its terms do not allow it. Every
        stats panel has direct links to the matching SteamDB app, charts, price-history and calculator pages.
      </p>

      <h2>Profiles without signing in</h2>
      <p>
        Every public Steam profile still serves the legacy community XML documents, so the relay reads profiles and
        libraries from <code>steamcommunity.com/id/&lt;name&gt;/?xml=1</code>. Nobody has to log in. If the relay
        happens to have a <code>STEAM_API_KEY</code>, it uses the Web API instead for richer data. A profile whose game
        details are set to private cannot be read either way — that is Steam's setting, not a limitation here.
      </p>

      <h2>Connecting your Steam account</h2>
      <p>
        <a href="#/library">Sign in through Steam</a> uses Valve's own OpenID provider. You are sent to
        <strong>steamcommunity.com</strong>, you type your password there and nowhere else, and Steam sends you back
        with a signed assertion that the relay re-checks with Steam directly. All this site ever learns is your
        SteamID64 — the same public number that appears in your profile URL. There is no password to store and
        “disconnecting” is literally forgetting a number.
      </p>
      <p>
        That gets you your profile, level, library, playtime, achievements, friends and account value without typing an
        ID. It does <em>not</em> get you your cart or your wallet balance, and it is worth saying why rather than
        leaving a gap: both live behind an authenticated Steam <em>store session</em>, and Valve publishes no API for
        either — not with a Web API key, not through OpenID, not to anyone. The only way any site could show them is by
        capturing a real Steam login, which this project will not build and which you should never hand to a
        third-party page. Your own cart and wallet are one click away on Steam, and the account panel links straight to
        them. Signing in also does not override your privacy settings: a private library stays private here too.
      </p>

      <h2>Remote play, honestly</h2>
      <p>
        The <a href="#/play">agent</a> you run on your PC reads your installed games from Steam's own manifest files and
        can start any of them with a <code>steam://</code> link. It never sees your Steam password, and it dials out to
        the relay so nothing needs port-forwarding.
      </p>
      <p>
        For video in the browser, install
        <a href="https://app.lizardbyte.dev/Sunshine/" target="_blank" rel="noopener noreferrer">Sunshine</a> and
        <a href="https://github.com/MrCreativ3001/moonlight-web-stream" target="_blank" rel="noopener noreferrer">moonlight-web-stream</a>
        on the same PC. The agent finds it and the player appears on the Remote Play page, with a
        <em>Play &amp; stream</em> button on every installed game. Give it a certificate in its
        <code>server/config.json</code> and it embeds inline; without one it opens in its own tab, because an HTTPS
        page cannot embed a plain-http origin. A native
        <a href="https://moonlight-stream.org/" target="_blank" rel="noopener noreferrer">Moonlight</a> client is
        detected too.
      </p>
      <h2>If something looks broken</h2>
      <p>
        <a href="#/diagnostics">Run the media check</a>. It reports which relay you are on, whether its build has every
        feature this page expects, and which Steam CDN hosts actually answer from your browser. A relay deploying from
        an older branch is by far the most common cause, and it says so plainly.
      </p>
      <h2>Keyboard</h2>
      <ul>
        <li><strong>/</strong> — jump to search</li>
        <li><strong>Esc</strong> — close the search suggestions or the screenshot viewer</li>
        <li><strong>&larr; &rarr;</strong> — move between screenshots in the viewer</li>
      </ul>
      <p style="margin-top:20px">
        Steam Viewer is an unofficial project and is not affiliated with or endorsed by Valve Corporation.
      </p>
    </div>`;
}
