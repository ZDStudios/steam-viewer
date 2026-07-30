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
} from './components.js';
import { renderRichText } from './sanitize.js';
import * as wishlist from './wishlist.js';
import { $, $$, attachImageFallbacks, esc, escAttr, formatDate, formatMoney, formatNumber, formatPlaytime } from './util.js';

/** Card options every grid shares: hide ignored titles, mark wishlisted ones. */
const cardOpts = (extra = {}) => ({ isWishlisted: (appid) => wishlist.has(appid), ...extra });
const visible = (items = []) => wishlist.filterIgnored(dedupe(items));

/** Wire up every ☆ / Ignore control inside `root`. */
function bindItemActions(root, lookup) {
  root.addEventListener('click', (event) => {
    const wishButton = event.target.closest('[data-wish]');
    const ignoreButton = event.target.closest('[data-ignore]');
    if (!wishButton && !ignoreButton) return;

    // These live inside <a class="card">, so stop the navigation.
    event.preventDefault();
    event.stopPropagation();

    const appid = Number((wishButton || ignoreButton).dataset.wish || (wishButton || ignoreButton).dataset.ignore);
    const game = lookup?.(appid) || { appid, name: `App ${appid}` };

    if (wishButton) {
      const added = wishlist.toggle(game);
      toast(added ? `${game.name} added to your wishlist` : `${game.name} removed from your wishlist`, 'ok', 2600);
      for (const button of $$(`[data-wish="${appid}"]`, root)) {
        button.classList.toggle('is-on', added);
        button.textContent = button.classList.contains('btn') ? (added ? '★ On wishlist' : '☆ Add to wishlist') : added ? '★' : '☆';
        button.title = added ? 'Remove from wishlist' : 'Add to wishlist';
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

  try {
    const data = await ctx.relay.request('genre', { genre: name, cc: ctx.region, l: ctx.language });
    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(data.genre || name)}</div>
      <h1 class="apphead__title" style="margin-bottom:18px">${esc(data.genre || name)}</h1>
      ${(data.sections || [])
        .map((section) => sectionHtml({ title: section.label, body: cardsHtml(visible(section.items || []), cardOpts()) }))
        .join('') || '<div class="empty"><h2>No titles found</h2><p>Steam returned an empty genre listing.</p></div>'}`;
    attachImageFallbacks(root);
    attachHoverPreviews(root);
    const all = (data.sections || []).flatMap((section) => section.items || []);
    bindItemActions(root, (appid) => all.find((item) => item.appid === appid));
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => genreView(root, ctx, genre));
  }
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
      .map((movie) => ({
        kind: 'video',
        thumb: movie.thumb,
        // Ordered by preference; mountPlayer falls through on error.
        sources: [movie.mp4, movie.mp4Low, movie.webm].filter(Boolean),
        poster: movie.thumb,
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
      <div class="applayout__media">${playerHtml(media)}</div>

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

export async function libraryView(root, ctx, who = '') {
  ctx.setTitle('Library · Steam Viewer');

  const requested = decodeURIComponent(who || '');
  const remembered = requested || localStorage.getItem(LIBRARY_KEY) || '';

  const form = `
    <div class="empty">
      <h2>Look up a Steam library</h2>
      <p>Enter a SteamID64, a custom profile name, or a full <code>steamcommunity.com</code> URL.</p>
      <form class="formrow" id="library-form">
        <input type="text" id="library-input" placeholder="76561197960287930 or gabelogannewell" value="${escAttr(remembered)}" />
        <button class="btn btn--green" type="submit">Load library</button>
      </form>
      <p class="loading-note">
        No sign-in needed — public profiles are read straight from Steam Community.
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
  const totalMinutes = data.games.reduce((sum, game) => sum + (game.playtimeForever || 0), 0);

  root.innerHTML = `
    <div class="profilecard">
      ${profile.avatar ? `<img src="${escAttr(profile.avatar)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <div>
        <div class="profilecard__name">${esc(profile.name || data.steamid)}</div>
        <div class="profilecard__meta">
          ${profile.playingName ? `Currently playing ${esc(profile.playingName)}` : profile.country ? esc(profile.country) : 'Steam profile'}
          ${profile.profileUrl ? ` · <a href="${escAttr(profile.profileUrl)}" target="_blank" rel="noopener noreferrer">Community profile</a>` : ''}
        </div>
      </div>
      <div class="profilecard__stats">
        <div class="profilecard__stat"><b>${formatNumber(data.gameCount || data.games.length)}</b><span>Games</span></div>
        <div class="profilecard__stat"><b>${Math.round(totalMinutes / 60).toLocaleString()}</b><span>Hours</span></div>
        ${data.level !== null && data.level !== undefined ? `<div class="profilecard__stat"><b>${esc(data.level)}</b><span>Level</span></div>` : ''}
      </div>
    </div>

    ${
      data.recent?.length
        ? sectionHtml({
            title: 'Recent Games',
            note: 'last two weeks',
            layout: 'portrait',
            body: data.recent.map((game) => portraitCardHtml(game, { subtitle: formatPlaytime(game.playtime2Weeks || game.playtimeForever) })).join(''),
          })
        : ''
    }

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

    <section class="section">
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

export async function playView(root, ctx) {
  ctx.setTitle('Remote Play · Steam Viewer');
  const saved = localStorage.getItem(AGENT_KEY) || '';

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
          Streaming the picture into this page is not something a browser can do: neither Moonlight's GameStream
          protocol nor Steam Link has a web client. If you install
          <a href="https://app.lizardbyte.dev/Sunshine/" target="_blank" rel="noopener noreferrer">Sunshine</a> on the PC and
          <a href="https://moonlight-stream.org/" target="_blank" rel="noopener noreferrer">Moonlight</a> on this device, the
          agent detects it and the Stream button hands off to Moonlight already pointed at your PC.
        </p>
      </div>
    </div>`;

  const body = $('#agent-body', root);

  const connect = async (code) => {
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

      ${
        streaming.available
          ? `<div class="buybox" style="margin-bottom:16px">
               <span class="buybox__label">Stream this PC</span>
               <a class="btn btn--green" href="${escAttr(streaming.moonlightUrl || '#')}">Open in Moonlight</a>
               ${streaming.sunshineWebUi ? `<a class="btn btn--ghost" href="${escAttr(streaming.sunshineWebUi)}" target="_blank" rel="noopener noreferrer">Sunshine settings</a>` : ''}
             </div>`
          : `<p class="loading-note" style="text-align:left">${esc(streaming.note || 'Streaming is not set up on that PC.')}</p>`
      }

      <div class="toolbar">
        <input type="search" id="agent-filter" placeholder="filter installed games" />
        <button class="btn btn--ghost btn--sm" type="button" id="agent-refresh">Rescan library</button>
      </div>

      <div class="grid grid--portrait" id="agent-grid"></div>`;

    const grid = $('#agent-grid', body);
    const filter = $('#agent-filter', body);

    const paint = () => {
      const term = filter.value.trim().toLowerCase();
      const shown = games.filter((game) => !term || game.name.toLowerCase().includes(term));
      grid.innerHTML =
        shown
          .map(
            (game) => `<div class="installed">
                ${portraitCardHtml({ appid: game.appid, name: game.name }, { subtitle: game.fullyInstalled ? 'installed' : 'downloading' })}
                <button class="btn btn--green btn--sm" type="button" data-launch="${game.appid}">▶ Play on PC</button>
              </div>`,
          )
          .join('') || '<p class="loading-note">No installed games match that filter.</p>';
      attachImageFallbacks(grid);
    };

    filter.addEventListener('input', paint);
    paint();

    grid.addEventListener('click', async (event) => {
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
            or the profile's owner.</li>
        <li>Pair your gaming PC under <a href="#/play">Remote Play</a> to list and launch your installed games.</li>
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

      <h2>Remote play, honestly</h2>
      <p>
        The <a href="#/play">agent</a> you run on your PC reads your installed games from Steam's own manifest files and
        can start any of them with a <code>steam://</code> link. It never sees your Steam password, and it dials out to
        the relay so nothing needs port-forwarding.
      </p>
      <p>
        <strong>The video does not stream into this page.</strong> Moonlight's GameStream protocol and Steam's Remote
        Play protocol have no browser client, and Valve ships no web SDK for Steam Link — re-implementing either over
        WebRTC is a separate project. What works instead: install
        <a href="https://app.lizardbyte.dev/Sunshine/" target="_blank" rel="noopener noreferrer">Sunshine</a> on the PC,
        and the Stream button hands off to your native
        <a href="https://moonlight-stream.org/" target="_blank" rel="noopener noreferrer">Moonlight</a> client already
        pointed at the right machine, with the game already starting.
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
