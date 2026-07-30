/** Every screen in the app. Each view renders into `root` and may return a
 *  cleanup function that the router calls before the next navigation. */
import {
  cardsHtml,
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
import { $, $$, attachImageFallbacks, esc, escAttr, formatDate, formatNumber, formatPlaytime } from './util.js';

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

  root.innerHTML = `
    ${heroHtml(data.featured || [])}
    ${
      data.mostPlayed?.length
        ? sectionHtml({
            title: 'Most Played Right Now',
            note: 'live from Steam',
            link: '#/browse/mostplayed',
            body: cardsHtml(data.mostPlayed.slice(0, 8), { ranked: true, live: liveLabel }),
          })
        : ''
    }
    ${
      data.specials?.length
        ? sectionHtml({ title: 'Special Offers', link: '#/browse/specials', body: cardsHtml(data.specials.slice(0, 8)) })
        : ''
    }
    ${
      data.topSellers?.length
        ? sectionHtml({ title: 'Top Sellers', link: '#/browse/topsellers', body: cardsHtml(data.topSellers.slice(0, 8)) })
        : ''
    }
    ${
      data.newReleases?.length
        ? sectionHtml({ title: 'New Releases', link: '#/browse/newreleases', body: cardsHtml(data.newReleases.slice(0, 8)) })
        : ''
    }
    ${
      data.comingSoon?.length
        ? sectionHtml({ title: 'Coming Soon', link: '#/browse/comingsoon', body: cardsHtml(data.comingSoon.slice(0, 8)) })
        : ''
    }
  `;

  attachImageFallbacks(root);
  const stopHero = mountHero(root, data.featured || []);

  // The relay pushes a refreshed most-played list every couple of minutes.
  const off = ctx.relay.on('live', (payload) => {
    const section = $$('.section', root).find((node) => $('.section__title', node)?.textContent.startsWith('Most Played'));
    if (!section || !payload?.mostPlayed?.length) return;
    $('.grid', section).innerHTML = cardsHtml(payload.mostPlayed.slice(0, 8), { ranked: true, live: liveLabel });
    attachImageFallbacks(section);
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
          cardsHtml(items, {
            ranked: config.ranked,
            live: (item) => (item.concurrent ? `${formatNumber(item.concurrent)} playing now` : ''),
          }) || '<p class="loading-note">Steam returned nothing for this section right now.</p>',
      })}`;
    attachImageFallbacks(root);
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
          cardsHtml(items) ||
          `<p class="loading-note">Nothing matched “${esc(query)}”. Try a shorter or differently spelled term.</p>`,
      })}`;
    attachImageFallbacks(root);
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
        .map((section) => sectionHtml({ title: section.label, body: cardsHtml(section.items || []) }))
        .join('') || '<div class="empty"><h2>No titles found</h2><p>Steam returned an empty genre listing.</p></div>'}`;
    attachImageFallbacks(root);
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
    ...(game.movies || []).map((movie) => ({
      kind: 'video',
      thumb: movie.thumb,
      src: movie.mp4 || movie.webm || movie.mp4Low,
      poster: movie.thumb,
      label: movie.name || 'Trailer',
    })).filter((entry) => entry.src),
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
        ${game.developers?.length ? `<span>Developer: ${esc(game.developers.join(', '))}</span>` : ''}
        ${game.publishers?.length ? `<span>Publisher: ${esc(game.publishers.join(', '))}</span>` : ''}
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
        </div>

        <div class="livebox">
          <div><div class="livebox__num" id="live-players">—</div><div class="livebox__label">Playing now</div></div>
        </div>

        ${reviewSummaryHtml(payload.reviews?.summary)}

        <div class="factbox">
          ${factRow('Platforms', platformsHtml(game.platforms) || '—')}
          ${factRow('Release', esc(game.releaseDate || 'Unannounced'))}
          ${factRow('Developer', esc((game.developers || []).join(', ')))}
          ${factRow('Publisher', esc((game.publishers || []).join(', ')))}
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
  });

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

export async function libraryView(root, ctx) {
  ctx.setTitle('Library · Steam Viewer');

  const supported = ctx.relay.capabilities ? ctx.relay.capabilities.library !== false : true;
  const remembered = localStorage.getItem(LIBRARY_KEY) || '';

  const form = `
    <div class="empty">
      <h2>Look up a Steam library</h2>
      <p>Enter a SteamID64, a custom profile name, or a full <code>steamcommunity.com</code> URL.</p>
      ${supported ? '' : '<p style="color:#c15755;margin-top:10px">This relay has no <code>STEAM_API_KEY</code> set, so profile lookups are disabled. Add the key in Render and redeploy.</p>'}
      <form class="formrow" id="library-form">
        <input type="text" id="library-input" placeholder="76561197960287930 or gabelogannewell" value="${escAttr(remembered)}" ${supported ? '' : 'disabled'} />
        <button class="btn btn--green" type="submit" ${supported ? '' : 'disabled'}>Load library</button>
      </form>
      <p class="loading-note">The profile's game details must be public for Steam to return them.</p>
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

  if (remembered && supported) await loadLibrary(root, ctx, remembered);
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
        <li>Browse top sellers, new releases, specials, coming soon and the live most-played chart.</li>
        <li>Open any game for trailers, screenshots, the full store description, tags, system requirements, achievements, DLC, news and reviews.</li>
        <li>Switch store region to see local pricing.</li>
        <li>Look up any public Steam library (requires a <code>STEAM_API_KEY</code> on the relay).</li>
      </ul>
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
