/** Every screen in the app. Each view renders into `root` and may return a
 *  cleanup function that the router calls before the next navigation. */
import {
  cardsHtml,
  categoryTilesHtml,
  heroHtml,
  lightbox,
  mountCardPreviews,
  mountHero,
  mountPlayer,
  mountWishButtons,
  platformsHtml,
  playerHtml,
  portraitCardHtml,
  priceHtml,
  railHtml,
  sectionHtml,
  skeletonGrid,
  skeletonPage,
  studioLinksHtml,
  toast,
  isAnimated,
} from './components.js';
import { host, HostError, moonlightUrl, steamLinkUrl } from './host.js';
import { renderRichText } from './sanitize.js';
import { $, $$, attachImageFallbacks, esc, escAttr, formatDate, formatMoney, formatNumber, formatPlaytime } from './util.js';
import { wishlist } from './wishlist.js';

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

/** Every grid-bearing view wants the same three behaviours wired up. */
function mountGrids(root) {
  attachImageFallbacks(root);
  const offWish = mountWishButtons(root);
  const offPreview = mountCardPreviews(root);
  return () => {
    offWish?.();
    offPreview?.();
  };
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
  const wished = wishlist.all().slice(0, 8);

  root.innerHTML = `
    ${heroHtml(data.featured || [])}

    <section class="section section--tiles">
      <div class="section__head"><h2 class="section__title">Browse by category</h2>
        <a class="section__link" href="#/genres">All genres &rsaquo;</a>
      </div>
      ${categoryTilesHtml()}
    </section>

    ${
      data.specials?.length
        ? sectionHtml({
            title: 'Special Offers',
            note: 'live discounts',
            link: '#/browse/specials',
            body: railHtml(data.specials.slice(0, 12)),
            layout: 'raw',
          })
        : ''
    }

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
      wished.length
        ? sectionHtml({
            title: 'On Your Wishlist',
            note: `${wishlist.count} saved in this browser`,
            link: '#/wishlist',
            linkLabel: 'Open wishlist',
            body: cardsHtml(wished),
          })
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
      data.underTen?.length
        ? sectionHtml({ title: 'Under 10', note: 'discounted right now', link: '#/browse/specials', body: cardsHtml(data.underTen.slice(0, 8)) })
        : ''
    }

    ${
      data.freeToPlay?.length
        ? sectionHtml({
            title: 'Free to Play',
            link: '#/genre/Free%20to%20Play',
            body: cardsHtml(data.freeToPlay.slice(0, 8)),
          })
        : ''
    }

    ${
      data.comingSoon?.length
        ? sectionHtml({ title: 'Coming Soon', link: '#/browse/comingsoon', body: cardsHtml(data.comingSoon.slice(0, 8)) })
        : ''
    }

    <section class="section">
      <div class="section__head"><h2 class="section__title">Look someone up</h2></div>
      <div class="panel panel--split">
        <div>
          <h3 class="panel__title">Any Steam profile, no sign-in</h3>
          <p class="panel__text">
            Search Steam's community directory by name, or paste a profile URL, a SteamID64 or a
            <code>steamcommunity.com/search/users/#text=…</code> link.
          </p>
          <form class="formrow" id="home-userlookup">
            <input type="search" name="who" placeholder="zdstudio12345" aria-label="Steam username" />
            <button class="btn btn--green" type="submit">Find</button>
          </form>
        </div>
        <div>
          <h3 class="panel__title">Play your own library</h3>
          <p class="panel__text">
            Install the Steam Viewer Host on the PC your games are on and this page can list what is
            installed, launch it, and hand the stream to Moonlight or Steam Remote Play.
          </p>
          <p><a class="btn btn--ghost" href="#/remote">Set up Remote Play</a></p>
        </div>
      </div>
    </section>
  `;

  const offGrids = mountGrids(root);
  const stopHero = mountHero(root, data.featured || []);

  $('#home-userlookup', root)?.addEventListener('submit', (event) => {
    event.preventDefault();
    const who = new FormData(event.target).get('who')?.toString().trim();
    if (who) ctx.navigate(`#/library/${encodeURIComponent(who)}`);
  });

  // Prices on wishlisted games go stale in storage; refresh them quietly.
  if (wishlist.count) {
    ctx.relay
      .request('apps', { appids: wishlist.all().slice(0, 30).map((item) => item.appid), cc: ctx.region, l: ctx.language })
      .then((cards) => wishlist.merge(cards || []))
      .catch(() => {});
  }

  // The relay pushes a refreshed most-played list every couple of minutes.
  const off = ctx.relay.on('live', (payload) => {
    const section = $$('.section', root).find((node) => $('.section__title', node)?.textContent.startsWith('Most Played'));
    if (!section || !payload?.mostPlayed?.length) return;
    $('.grid', section).innerHTML = cardsHtml(payload.mostPlayed.slice(0, 8), { ranked: true, live: liveLabel });
    attachImageFallbacks(section);
  });

  return () => {
    stopHero?.();
    offGrids();
    off();
  };
}

/* ================================================================== *
 * Browse (a single home section, expanded)
 * ================================================================== */

const BROWSE = {
  topsellers: { title: 'Top Sellers', key: 'topSellers', query: { filter: 'topsellers' } },
  newreleases: { title: 'New Releases', key: 'newReleases', query: { filter: 'popularnew' } },
  specials: { title: 'Special Offers', key: 'specials', query: { specials: true } },
  comingsoon: { title: 'Coming Soon', key: 'comingSoon', query: { filter: 'comingsoon' } },
  freetoplay: { title: 'Free to Play', key: 'freeToPlay', query: { genre: 'Free to Play', filter: 'topsellers' } },
  mostplayed: { title: 'Most Played', key: 'mostPlayed', ranked: true },
};

export async function browseView(root, ctx, which) {
  const config = BROWSE[which] || BROWSE.topsellers;
  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(config.title)}</div>${skeletonGrid(12)}`;
  ctx.setTitle(`${config.title} · Steam Viewer`);

  try {
    let items;
    if (which === 'mostplayed') {
      items = await ctx.relay.request('mostplayed', { cc: ctx.region, l: ctx.language, limit: 25 });
    } else if (config.query) {
      // The search backend goes deeper than the front page's own lists.
      items = await ctx.relay.request('browse', { cc: ctx.region, l: ctx.language, limit: 30, ...config.query });
    } else {
      items = (await ctx.relay.request('home', { cc: ctx.region, l: ctx.language }))[config.key] || [];
    }

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
    return mountGrids(root);
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => browseView(root, ctx, which));
  }
  return undefined;
}

/* ================================================================== *
 * Search
 * ================================================================== */

export async function searchView(root, ctx, term) {
  const query = String(term || '').trim();
  ctx.setTitle(`${query || 'Search'} · Steam Viewer`);

  if (!query) {
    root.innerHTML = '<div class="empty"><h2>Search the Steam store</h2><p>Type a game name in the box above.</p></div>';
    return undefined;
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
      })}
      <p class="loading-note">Looking for a person rather than a game?
        <a href="#/library/${encodeURIComponent(query)}">Search Steam profiles for “${esc(query)}”</a>.</p>`;
    return mountGrids(root);
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => searchView(root, ctx, query));
  }
  return undefined;
}

/* ================================================================== *
 * Genres
 * ================================================================== */

export function genresView(root, ctx) {
  ctx.setTitle('Genres · Steam Viewer');
  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Genres</div>
    <h1 class="apphead__title" style="margin-bottom:18px">Browse by genre</h1>
    ${categoryTilesHtml()}`;
}

export async function genreView(root, ctx, genre) {
  const name = decodeURIComponent(genre || '');
  ctx.setTitle(`${name} · Steam Viewer`);
  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; <a href="#/genres">Genres</a> &rsaquo; ${esc(name)}</div>${skeletonGrid(8)}`;

  try {
    const data = await ctx.relay.request('genre', { genre: name, cc: ctx.region, l: ctx.language });
    const sections = data.sections || [];

    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; <a href="#/genres">Genres</a> &rsaquo; ${esc(data.genre || name)}</div>
      <h1 class="apphead__title" style="margin-bottom:18px">${esc(data.genre || name)}</h1>
      ${
        sections
          .map((section) => sectionHtml({ title: section.label, note: `${section.items?.length || 0} titles`, body: cardsHtml(section.items || []) }))
          .join('') ||
        `<div class="empty"><h2>No titles found</h2>
          <p>Steam's search returned nothing for “${esc(name)}” just now.</p>
          <p style="margin-top:14px"><a class="btn btn--ghost" href="#/search/${encodeURIComponent(name)}">Search the store instead</a></p>
        </div>`
      }`;
    return mountGrids(root);
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => genreView(root, ctx, genre));
  }
  return undefined;
}

/* ================================================================== *
 * Developer / publisher
 * ================================================================== */

export async function developerView(root, ctx, name, role = 'developer') {
  const studio = decodeURIComponent(name || '');
  const roleLabel = role === 'publisher' ? 'Publisher' : 'Developer';
  ctx.setTitle(`${studio} · Steam Viewer`);

  root.innerHTML = `<div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(roleLabel)} &rsaquo; ${esc(studio)}</div>${skeletonGrid(9)}`;

  let data;
  try {
    data = await ctx.relay.request('developer', { name: studio, role, cc: ctx.region, l: ctx.language });
  } catch (error) {
    root.innerHTML = errorHtml(error);
    bindRetry(root, () => developerView(root, ctx, name, role));
    return undefined;
  }

  const games = data.games || [];
  const banner = games.find((game) => game.header)?.header || '';
  const totalReviews = games.reduce((sum, game) => sum + (game.recommendations || 0), 0);
  const years = games.map((game) => Number(String(game.releaseDate || '').match(/\d{4}/)?.[0])).filter(Boolean);

  root.innerHTML = `
    ${banner ? `<div class="apppage__backdrop" style="background-image:url('${escAttr(banner)}')"></div>` : ''}
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; ${esc(roleLabel)} &rsaquo; ${esc(studio)}</div>

    <header class="studiohead">
      <div>
        <div class="studiohead__kicker">${esc(roleLabel)}</div>
        <h1 class="apphead__title">${esc(data.name || studio)}</h1>
        <div class="apphead__sub">
          <span>${formatNumber(games.length)} title${games.length === 1 ? '' : 's'} on Steam</span>
          ${years.length ? `<span>${Math.min(...years)}–${Math.max(...years)}</span>` : ''}
          ${totalReviews ? `<span>${formatNumber(totalReviews)} recommendations</span>` : ''}
          ${data.storeUrl ? `<span><a href="${escAttr(data.storeUrl)}" target="_blank" rel="noopener noreferrer">Open on Steam</a></span>` : ''}
        </div>
        ${
          data.exact === false
            ? '<p class="loading-note" style="text-align:left;margin-top:8px">Steam has no exact studio page for this name, so these are titles that credit it.</p>'
            : ''
        }
      </div>
      <div class="studiohead__toggle">
        <a class="btn btn--sm ${role === 'developer' ? 'btn--green' : 'btn--ghost'}" href="#/developer/${encodeURIComponent(studio)}">As developer</a>
        <a class="btn btn--sm ${role === 'publisher' ? 'btn--green' : 'btn--ghost'}" href="#/publisher/${encodeURIComponent(studio)}">As publisher</a>
      </div>
    </header>

    ${
      data.highlights?.length
        ? sectionHtml({ title: 'Best known for', body: railHtml(data.highlights), layout: 'raw' })
        : ''
    }

    ${sectionHtml({
      title: `All titles`,
      note: `${games.length} on Steam`,
      body: cardsHtml(games) || '<p class="loading-note">Steam returned no titles for this studio.</p>',
    })}

    ${
      data.related?.length
        ? `<section class="section"><div class="section__head"><h2 class="section__title">${
            role === 'developer' ? 'Published by' : 'Developed by'
          }</h2></div>
          <div class="chiprow">${data.related
            .map(
              (other) =>
                `<a class="chip" href="#/${role === 'developer' ? 'publisher' : 'developer'}/${encodeURIComponent(other)}">${esc(other)}</a>`,
            )
            .join('')}</div></section>`
        : ''
    }`;

  return mountGrids(root);
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

/** The SteamDB panel — real SteamDB numbers when it answers, Steam's own when not. */
function steamdbHtml(stats) {
  if (!stats) return '<p class="loading-note">Loading SteamDB stats…</p>';

  const stat = (label, value, suffix = '') =>
    `<div class="dbstat"><b>${value === null || value === undefined ? '—' : formatNumber(value)}${suffix}</b><span>${esc(label)}</span></div>`;

  return `
    <div class="dbstats">
      ${stat('Playing now', stats.current)}
      ${stat('24-hour peak', stats.peak24h)}
      ${stat('All-time peak', stats.peakAllTime)}
      ${stats.rank ? stat('Concurrent rank', stats.rank) : ''}
    </div>
    <p class="loading-note" style="text-align:left">
      ${
        stats.available
          ? 'Read live from SteamDB.'
          : esc(stats.note || 'SteamDB did not answer, so these come from Steam’s own charts service.')
      }
    </p>
    <div class="chiprow">
      <a class="chip" href="${escAttr(stats.links?.app || '#')}" target="_blank" rel="noopener noreferrer">SteamDB app page</a>
      <a class="chip" href="${escAttr(stats.links?.charts || '#')}" target="_blank" rel="noopener noreferrer">Player charts</a>
      <a class="chip" href="${escAttr(stats.links?.history || '#')}" target="_blank" rel="noopener noreferrer">Price history</a>
      <a class="chip" href="${escAttr(stats.links?.depots || '#')}" target="_blank" rel="noopener noreferrer">Depots</a>
      <a class="chip" href="${escAttr(stats.links?.patchnotes || '#')}" target="_blank" rel="noopener noreferrer">Patch notes</a>
    </div>`;
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
    return undefined;
  }

  const game = payload.game;
  ctx.setTitle(`${game.name} · Steam Viewer`);

  const media = [
    ...(game.movies || []).map((movie) => ({
      kind: 'video',
      thumb: movie.thumb,
      // Every rendition the relay found, best first — the player walks the
      // list itself if one of them will not load.
      sources: movie.sources?.length ? movie.sources : [movie.mp4, movie.webm].filter(Boolean).map((src) => ({ src, type: /webm/i.test(src) ? 'video/webm' : 'video/mp4' })),
      poster: movie.thumb,
      label: movie.name || 'Trailer',
      storeUrl: game.storeUrl,
    })).filter((entry) => entry.sources.length),
    ...(game.screenshots || []).map((shot, index) => ({
      kind: 'image',
      thumb: shot.thumb,
      src: shot.full,
      label: `Screenshot ${index + 1}`,
      animated: isAnimated(shot.full),
    })),
  ];
  const screenshotUrls = (game.screenshots || []).map((shot) => shot.full);
  const firstScreenshotIndex = media.findIndex((entry) => entry.kind === 'image');

  const genreChips = (game.genres || [])
    .map((genre) => `<a class="chip" href="#/genre/${encodeURIComponent(genre)}">${esc(genre)}</a>`)
    .join('');
  const categoryChips = (game.categories || []).slice(0, 12).map((c) => `<span class="chip">${esc(c)}</span>`).join('');
  const onWishlist = wishlist.has(game.appid);

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
        ${game.developers?.length ? `<span>Developer: ${studioLinksHtml(game.developers, 'developer')}</span>` : ''}
        ${game.publishers?.length ? `<span>Publisher: ${studioLinksHtml(game.publishers, 'publisher')}</span>` : ''}
        ${game.metacritic ? `<span>Metacritic: ${esc(game.metacritic)}</span>` : ''}
      </div>
    </header>

    <div class="applayout">
      <div class="applayout__media">${playerHtml(media)}</div>

      <div class="applayout__body">
        <div class="tabs" id="app-tabs" role="tablist">
          <button class="is-active" data-tab="about" role="tab">About</button>
          <button data-tab="reviews" role="tab">Reviews</button>
          <button data-tab="steamdb" role="tab">SteamDB</button>
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

        <div id="tab-steamdb" class="tabpanel" hidden><div id="steamdb-body"></div></div>

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
          <button class="btn btn--ghost btn--wide${onWishlist ? ' is-on' : ''}" type="button" id="app-wish">
            ${onWishlist ? '★ On your wishlist' : '☆ Add to wishlist'}
          </button>
          <button class="btn btn--ghost btn--wide" type="button" id="app-play">▶ Play on my PC</button>
        </div>

        <div class="livebox">
          <div><div class="livebox__num" id="live-players">—</div><div class="livebox__label">Playing now</div></div>
        </div>

        ${reviewSummaryHtml(payload.reviews?.summary)}

        <div class="factbox">
          ${factRow('Platforms', platformsHtml(game.platforms) || '—')}
          ${factRow('Release', esc(game.releaseDate || 'Unannounced'))}
          ${factRow('Developer', studioLinksHtml(game.developers, 'developer'))}
          ${factRow('Publisher', studioLinksHtml(game.publishers, 'publisher'))}
          ${factRow('Reviews', game.recommendations ? `${formatNumber(game.recommendations)} recommendations` : '')}
          ${factRow('Metacritic', game.metacritic ? `<a href="${escAttr(game.metacriticUrl || '#')}" target="_blank" rel="noopener noreferrer">${esc(game.metacritic)}</a>` : '')}
          ${factRow('Website', game.website ? `<a href="${escAttr(game.website)}" target="_blank" rel="noopener noreferrer">Official site</a>` : '')}
          ${factRow('SteamDB', `<a href="https://steamdb.info/app/${game.appid}/" target="_blank" rel="noopener noreferrer">steamdb.info/app/${game.appid}</a>`)}
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

  /* — wishlist — */
  const wishButton = $('#app-wish', root);
  const paintWish = () => {
    const on = wishlist.has(game.appid);
    wishButton.classList.toggle('is-on', on);
    wishButton.textContent = on ? '★ On your wishlist' : '☆ Add to wishlist';
  };
  wishButton.addEventListener('click', () => {
    const added = wishlist.toggle(game);
    paintWish();
    toast(added ? `${game.name} added to your wishlist` : `${game.name} removed from your wishlist`, added ? 'ok' : 'info', 2600);
  });
  const offWish = wishlist.on(paintWish);

  /* — play on the visitor's own PC, via the host agent — */
  $('#app-play', root).addEventListener('click', async () => {
    if (!host.connected) {
      await host.discover();
    }
    if (!host.connected) {
      ctx.navigate('#/remote');
      return;
    }
    try {
      const result = await host.launch(game.appid, 'local');
      toast(result?.message || `Launching ${game.name} on ${host.info?.hostname || 'your PC'}…`, 'ok');
    } catch (error) {
      if (error instanceof HostError && error.needsPairing) ctx.navigate('#/remote');
      else toast(error.message, 'error');
    }
  });

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
    if (button.dataset.tab === 'steamdb') loadSteamDb();
  });

  /* — SteamDB (lazy: it is a scrape attempt, not a cheap call) — */
  let steamdbLoaded = false;
  async function loadSteamDb() {
    if (steamdbLoaded) return;
    steamdbLoaded = true;
    const body = $('#steamdb-body', root);
    body.innerHTML = steamdbHtml(null);
    try {
      const stats = await ctx.relay.request('steamdb', { appid: game.appid, cc: ctx.region });
      body.innerHTML = steamdbHtml(stats);
    } catch (error) {
      body.innerHTML = `<p class="loading-note">${esc(error.message)}</p>
        <div class="chiprow"><a class="chip" href="https://steamdb.info/app/${game.appid}/" target="_blank" rel="noopener noreferrer">Open on SteamDB</a></div>`;
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
    offWish();
  };
}

/* ================================================================== *
 * Wishlist (browser-local)
 * ================================================================== */

export function wishlistView(root, ctx) {
  ctx.setTitle('Wishlist · Steam Viewer');

  const paint = () => {
    const items = wishlist.all();
    const totals = wishlist.totals();

    if (items.length === 0) {
      root.innerHTML = `
        <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Wishlist</div>
        <div class="empty">
          <h2>Your wishlist is empty</h2>
          <p>Press the heart on any game to save it here. It lives in this browser only — no account, no sign-in.</p>
          <p style="margin-top:16px">
            <a class="btn btn--green" href="#/">Browse the store</a>
            <button class="btn btn--ghost" type="button" id="wish-import">Import a wishlist file</button>
          </p>
        </div>`;
      bindImportExport();
      return;
    }

    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Wishlist</div>

      <header class="wishhead">
        <div>
          <h1 class="apphead__title">Your wishlist</h1>
          <p class="loading-note" style="text-align:left">
            Saved in this browser. Clearing site data clears it, so export a copy if it matters.
          </p>
        </div>
        <div class="wishhead__stats">
          <div class="profilecard__stat"><b>${formatNumber(totals.count)}</b><span>Games</span></div>
          <div class="profilecard__stat"><b>${esc(formatMoney(totals.total, totals.currency))}</b><span>Total${totals.priced < totals.count ? ` (${totals.priced} priced)` : ''}</span></div>
          ${totals.discounted ? `<div class="profilecard__stat"><b>${totals.discounted}</b><span>On sale</span></div>` : ''}
          ${totals.free ? `<div class="profilecard__stat"><b>${totals.free}</b><span>Free</span></div>` : ''}
        </div>
      </header>

      <div class="toolbar">
        <select id="wish-sort">
          <option value="added">Sort: date added</option>
          <option value="name">Sort: alphabetical</option>
          <option value="price">Sort: price</option>
          <option value="discount">Sort: biggest discount</option>
        </select>
        <button class="btn btn--ghost btn--sm" type="button" id="wish-refresh">Refresh prices</button>
        <button class="btn btn--ghost btn--sm" type="button" id="wish-export">Export</button>
        <button class="btn btn--ghost btn--sm" type="button" id="wish-import">Import</button>
        <button class="btn btn--ghost btn--sm" type="button" id="wish-clear">Clear all</button>
      </div>

      <div id="wish-list"></div>`;

    const listNode = $('#wish-list', root);
    const sortSelect = $('#wish-sort', root);

    const paintList = () => {
      let sorted = wishlist.all();
      if (sortSelect.value === 'name') sorted = [...sorted].sort((a, b) => a.name.localeCompare(b.name));
      else if (sortSelect.value === 'price') sorted = [...sorted].sort((a, b) => (a.price?.final ?? Infinity) - (b.price?.final ?? Infinity));
      else if (sortSelect.value === 'discount') sorted = [...sorted].sort((a, b) => (b.price?.discountPercent || 0) - (a.price?.discountPercent || 0));

      listNode.innerHTML = sorted
        .map(
          (item, index) => `<div class="wishrow" data-appid="${item.appid}">
            <a class="wishrow__shot" href="#/app/${item.appid}">
              <img src="${escAttr(item.header || item.capsule || '')}" alt="${escAttr(item.name)}" loading="lazy" referrerpolicy="no-referrer"
                   data-fallback="${escAttr(`https://cdn.cloudflare.steamstatic.com/steam/apps/${item.appid}/header.jpg`)}" />
            </a>
            <div class="wishrow__body">
              <a class="wishrow__name" href="#/app/${item.appid}">${esc(item.name)}</a>
              <div class="wishrow__meta">
                ${platformsHtml(item.platforms)}
                ${item.releaseDate ? `<span>${esc(item.releaseDate)}</span>` : ''}
                ${item.genres?.length ? `<span>${esc(item.genres.join(', '))}</span>` : ''}
              </div>
            </div>
            <div class="wishrow__price">${priceHtml(item.price)}</div>
            <div class="wishrow__actions">
              <button class="btn btn--ghost btn--sm" type="button" data-move="${item.appid}" data-delta="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
              <button class="btn btn--ghost btn--sm" type="button" data-move="${item.appid}" data-delta="1" ${index === sorted.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
              <button class="btn btn--ghost btn--sm" type="button" data-drop="${item.appid}">Remove</button>
            </div>
          </div>`,
        )
        .join('');
      attachImageFallbacks(listNode);
    };

    sortSelect.addEventListener('change', paintList);

    listNode.addEventListener('click', (event) => {
      const drop = event.target.closest('[data-drop]');
      if (drop) {
        wishlist.remove(drop.dataset.drop);
        return;
      }
      const move = event.target.closest('[data-move]');
      if (move) wishlist.move(move.dataset.move, Number(move.dataset.delta));
    });

    $('#wish-clear', root).addEventListener('click', () => {
      if (window.confirm(`Remove all ${wishlist.count} games from your wishlist?`)) wishlist.clear();
    });

    $('#wish-refresh', root).addEventListener('click', async () => {
      const button = $('#wish-refresh', root);
      button.disabled = true;
      button.textContent = 'Refreshing…';
      try {
        const cards = await ctx.relay.request('apps', {
          appids: wishlist.all().slice(0, 30).map((item) => item.appid),
          cc: ctx.region,
          l: ctx.language,
        });
        wishlist.merge(cards || []);
        toast('Prices refreshed for the first 30 games.', 'ok');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Refresh prices';
      }
    });

    bindImportExport();
    paintList();
  };

  function bindImportExport() {
    $('#wish-export', root)?.addEventListener('click', () => {
      const blob = new Blob([wishlist.export()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'steam-viewer-wishlist.json';
      link.click();
      URL.revokeObjectURL(url);
    });

    $('#wish-import', root)?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const count = wishlist.import(await file.text());
          toast(`Imported ${count} game${count === 1 ? '' : 's'}.`, 'ok');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      input.click();
    });
  }

  paint();
  const off = wishlist.on(() => paint());
  return off;
}

/* ================================================================== *
 * Library — any public profile, no sign-in
 * ================================================================== */

const LIBRARY_KEY = 'steam-viewer:last-profile';

export async function libraryView(root, ctx, who) {
  ctx.setTitle('Library · Steam Viewer');

  const target = String(who || '').trim() || localStorage.getItem(LIBRARY_KEY) || '';
  if (target) return loadLibrary(root, ctx, target);

  root.innerHTML = lookupFormHtml('');
  bindLookup(root, ctx);
  return undefined;
}

function lookupFormHtml(value, { results = null, term = '', busy = false } = {}) {
  return `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Library</div>
    <div class="lookup">
      <h1 class="apphead__title">Look up a Steam library</h1>
      <p class="lookup__lead">
        No account, no sign-in, no API key. Type a Steam display name to search the community directory —
        the same index behind <code>steamcommunity.com/search/users/#text=…</code> — or paste a profile URL,
        a custom URL name, or a SteamID64.
      </p>
      <form class="formrow formrow--big" id="library-form">
        <input type="search" id="library-input" placeholder="zdstudio12345" value="${escAttr(value)}" autocomplete="off" spellcheck="false" />
        <button class="btn btn--green" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Searching…' : 'Search'}</button>
      </form>
      <p class="loading-note" style="text-align:left">The profile's game details have to be public for Steam to hand them over.</p>
      <div id="library-results">${results === null ? '' : userResultsHtml(results, term)}</div>
    </div>`;
}

function userResultsHtml(results, term) {
  if (!results.length) {
    return `<div class="empty"><h2>No profiles matched “${esc(term)}”</h2>
      <p>Steam's directory only matches whole display names and custom URLs. A SteamID64 or a full profile link always works.</p>
      <p style="margin-top:12px"><a href="https://steamcommunity.com/search/users/#text=${encodeURIComponent(term)}" target="_blank" rel="noopener noreferrer">Try this search on Steam itself</a></p>
    </div>`;
  }

  return `<h2 class="section__title" style="margin:18px 0 10px">${results.length} profile${results.length === 1 ? '' : 's'}</h2>
    <div class="userlist">
      ${results
        .map(
          (user) => `<button class="usercard" type="button" data-user="${escAttr(user.steamid || user.vanity || '')}">
            <img src="${escAttr(user.avatar || '')}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <span class="usercard__body">
              <span class="usercard__name">${esc(user.name)}</span>
              ${user.location ? `<span class="usercard__meta">${esc(user.location)}</span>` : ''}
              ${user.vanity ? `<span class="usercard__meta">/id/${esc(user.vanity)}</span>` : user.steamid ? `<span class="usercard__meta">${esc(user.steamid)}</span>` : ''}
            </span>
          </button>`,
        )
        .join('')}
    </div>`;
}

function bindLookup(root, ctx) {
  const form = $('#library-form', root);
  const input = $('#library-input', root);
  const results = $('#library-results', root);

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;

    // Anything that identifies exactly one profile skips the directory search.
    if (/^\d{17}$/.test(value) || /steamcommunity\.com\/(profiles|id)\//i.test(value)) {
      ctx.navigate(`#/library/${encodeURIComponent(value)}`);
      return;
    }

    results.innerHTML = '<p class="loading-note">Searching Steam’s community directory…</p>';
    try {
      const found = await ctx.relay.request('users', { text: value, limit: 24 });
      results.innerHTML = userResultsHtml(found || [], value);

      // One unambiguous hit is what people mean; go straight there.
      if (found?.length === 1) ctx.navigate(`#/library/${encodeURIComponent(found[0].steamid || found[0].vanity)}`);
    } catch (error) {
      results.innerHTML = `<div class="empty"><h2>That search failed</h2><p>${esc(error.message)}</p></div>`;
    }
  });

  results?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-user]');
    if (card?.dataset.user) ctx.navigate(`#/library/${encodeURIComponent(card.dataset.user)}`);
  });

  input?.focus();
}

async function loadLibrary(root, ctx, who) {
  root.innerHTML = `<p class="loading-note">Loading library…</p>${skeletonGrid(10)}`;

  let data;
  try {
    data = await ctx.relay.request('profile', { id: who, cc: ctx.region, l: ctx.language });
  } catch (error) {
    root.innerHTML = `${lookupFormHtml(who)}
      <div class="empty"><h2>Could not open that library</h2><p>${esc(error.message)}</p></div>`;
    bindLookup(root, ctx);
    localStorage.removeItem(LIBRARY_KEY);
    return undefined;
  }

  localStorage.setItem(LIBRARY_KEY, who);

  const profile = data.profile || {};
  const games = data.games || [];
  const totalMinutes = games.reduce((sum, game) => sum + (game.playtimeForever || 0), 0);
  const played = games.filter((game) => game.playtimeForever > 0);
  ctx.setTitle(`${profile.name || data.steamid} · Steam Viewer`);

  root.innerHTML = `
    <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; <a href="#/library">Library</a> &rsaquo; ${esc(profile.name || data.steamid)}</div>

    <div class="profilecard">
      ${profile.avatar ? `<img src="${escAttr(profile.avatar)}" alt="" referrerpolicy="no-referrer" />` : ''}
      <div>
        <div class="profilecard__name">${esc(profile.name || data.steamid)}${profile.vacBanned ? ' <span class="chip chip--warn">VAC ban on record</span>' : ''}</div>
        <div class="profilecard__meta">
          ${profile.playingName ? `Currently playing ${esc(profile.playingName)}` : profile.country ? esc(profile.country) : 'Steam profile'}
          ${profile.memberSince ? ` · Member since ${esc(profile.memberSince)}` : ''}
          ${profile.profileUrl ? ` · <a href="${escAttr(profile.profileUrl)}" target="_blank" rel="noopener noreferrer">Community profile</a>` : ''}
          · <a href="https://steamdb.info/calculator/${esc(data.steamid)}/" target="_blank" rel="noopener noreferrer">SteamDB calculator</a>
        </div>
      </div>
      <div class="profilecard__stats">
        <div class="profilecard__stat"><b>${formatNumber(data.gameCount || games.length)}</b><span>Games</span></div>
        <div class="profilecard__stat"><b>${Math.round(totalMinutes / 60).toLocaleString()}</b><span>Hours</span></div>
        <div class="profilecard__stat"><b>${formatNumber(games.length - played.length)}</b><span>Never played</span></div>
        ${data.level !== null && data.level !== undefined ? `<div class="profilecard__stat"><b>${esc(data.level)}</b><span>Level</span></div>` : ''}
      </div>
    </div>

    <section class="section" id="calc-section">
      <div class="section__head">
        <h2 class="section__title">SteamDB stats<small>account value, playtime spread</small></h2>
        <button class="btn btn--ghost btn--sm" type="button" id="calc-run">Calculate</button>
      </div>
      <div id="calc-body"><p class="loading-note" style="text-align:left">
        Runs SteamDB's calculator for this account. If SteamDB will not answer this server, the same figure is
        summed from live Steam store prices instead.
      </p></div>
    </section>

    ${
      data.recent?.length
        ? sectionHtml({
            title: 'Recent Games',
            note: 'last two weeks',
            layout: 'portrait',
            body: data.recent
              .map((game) => portraitCardHtml(game, { subtitle: formatPlaytime(game.playtime2Weeks || game.playtimeForever), wish: true }))
              .join(''),
          })
        : ''
    }

    <section class="section">
      <div class="section__head">
        <h2 class="section__title">All Games<small id="library-count">${formatNumber(games.length)} owned</small></h2>
        <button class="btn btn--ghost btn--sm" type="button" id="library-change">Look up someone else</button>
      </div>

      <div class="library">
        <aside class="library__side">
          <input type="search" id="library-search" placeholder="Search this library" aria-label="Filter games" />
          <select id="library-sort">
            <option value="playtime">Sort: playtime</option>
            <option value="name">Sort: alphabetical</option>
            <option value="recent">Sort: recently played</option>
          </select>
          <div class="library__list" id="library-list"></div>
        </aside>

        <div class="library__main">
          <div class="libhero" id="library-hero"></div>
          <div class="grid grid--portrait" id="library-grid"></div>
        </div>
      </div>
    </section>`;

  const grid = $('#library-grid', root);
  const listNode = $('#library-list', root);
  const heroNode = $('#library-hero', root);
  const countNode = $('#library-count', root);
  const searchInput = $('#library-search', root);
  const sortSelect = $('#library-sort', root);

  let visible = [];
  let selected = games[0] || null;

  const paintHero = (game) => {
    if (!game) {
      heroNode.innerHTML = '<p class="loading-note">Nothing to show for this filter.</p>';
      return;
    }
    selected = game;
    const hero = `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/library_hero.jpg`;
    const logo = `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/logo.png`;

    heroNode.innerHTML = `
      <img class="libhero__bg" src="${escAttr(hero)}" alt="" referrerpolicy="no-referrer"
           data-fallback="${escAttr([game.capsule, game.header].filter(Boolean).join('|'))}" />
      <div class="libhero__inner">
        <img class="libhero__logo" src="${escAttr(logo)}" alt="${escAttr(game.name)}" referrerpolicy="no-referrer"
             data-fallback="${escAttr(game.header || '')}" />
        <div class="libhero__meta">
          <span>${esc(game.playtimeForever ? `${formatPlaytime(game.playtimeForever)} on record` : 'Never played')}</span>
          ${game.playtime2Weeks ? `<span>${esc(formatPlaytime(game.playtime2Weeks))} in the last two weeks</span>` : ''}
          ${game.lastPlayed ? `<span>Last played ${esc(formatDate(game.lastPlayed))}</span>` : ''}
        </div>
        <div class="libhero__actions">
          <button class="btn btn--green" type="button" data-play="${game.appid}">▶ Play on my PC</button>
          <a class="btn btn--ghost" href="#/app/${game.appid}">Store page</a>
          <a class="btn btn--ghost" href="https://steamdb.info/app/${game.appid}/" target="_blank" rel="noopener noreferrer">SteamDB</a>
        </div>
      </div>`;
    attachImageFallbacks(heroNode);
  };

  const paint = () => {
    const term = searchInput.value.trim().toLowerCase();
    let filtered = games.filter((game) => !term || game.name.toLowerCase().includes(term));

    if (sortSelect.value === 'name') filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    else if (sortSelect.value === 'recent') filtered = [...filtered].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || b.playtime2Weeks - a.playtime2Weeks);
    else filtered = [...filtered].sort((a, b) => b.playtimeForever - a.playtimeForever);

    visible = filtered.slice(0, 300);
    countNode.textContent = `${formatNumber(filtered.length)} shown${filtered.length > visible.length ? ` (first ${visible.length})` : ''}`;

    listNode.innerHTML =
      visible
        .map(
          (game) => `<button class="libitem${game.appid === selected?.appid ? ' is-active' : ''}" type="button" data-pick="${game.appid}">
            <img src="${escAttr(game.capsule || game.header || '')}" alt="" loading="lazy" referrerpolicy="no-referrer" />
            <span class="libitem__name">${esc(game.name)}</span>
            <span class="libitem__hours">${esc(game.playtimeForever ? formatPlaytime(game.playtimeForever) : '—')}</span>
          </button>`,
        )
        .join('') || '<p class="loading-note">No games match that filter.</p>';

    grid.innerHTML =
      visible
        .map((game) =>
          portraitCardHtml(game, {
            subtitle: game.playtimeForever ? formatPlaytime(game.playtimeForever) : 'never played',
            wish: true,
          }),
        )
        .join('') || '';

    if (!visible.some((game) => game.appid === selected?.appid)) paintHero(visible[0] || null);
    attachImageFallbacks(root);
  };

  searchInput.addEventListener('input', paint);
  sortSelect.addEventListener('change', paint);

  listNode.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pick]');
    if (!button) return;
    const game = games.find((entry) => entry.appid === Number(button.dataset.pick));
    if (!game) return;
    paintHero(game);
    $$('.libitem', listNode).forEach((node) => node.classList.toggle('is-active', node === button));
  });

  root.addEventListener('click', async (event) => {
    const play = event.target.closest('[data-play]');
    if (!play) return;
    event.preventDefault();
    if (!host.connected) await host.discover();
    if (!host.connected) {
      ctx.navigate('#/remote');
      return;
    }
    try {
      const result = await host.launch(play.dataset.play, 'local');
      toast(result?.message || 'Launching on your PC…', 'ok');
    } catch (error) {
      if (error instanceof HostError && error.needsPairing) ctx.navigate('#/remote');
      else toast(error.message, 'error');
    }
  });

  $('#library-change', root).addEventListener('click', () => {
    localStorage.removeItem(LIBRARY_KEY);
    ctx.navigate('#/library');
    root.innerHTML = lookupFormHtml('');
    bindLookup(root, ctx);
  });

  /* — SteamDB calculator, on demand — */
  $('#calc-run', root).addEventListener('click', async () => {
    const button = $('#calc-run', root);
    const body = $('#calc-body', root);
    button.disabled = true;
    button.textContent = 'Working…';
    body.innerHTML = '<p class="loading-note" style="text-align:left">Pricing this library…</p>';

    try {
      const calc = await ctx.relay.request('calculator', { id: data.steamid, cc: ctx.region, l: ctx.language }, { timeoutMs: 90_000 });
      body.innerHTML = calculatorHtml(calc);
    } catch (error) {
      body.innerHTML = `<p class="loading-note" style="text-align:left">${esc(error.message)}</p>`;
    } finally {
      button.disabled = false;
      button.textContent = 'Recalculate';
    }
  });

  paintHero(selected);
  paint();
  return mountGrids(root);
}

function calculatorHtml(calc) {
  if (!calc) return '';
  const worth = calc.available ? calc.worthFormatted : formatMoney(calc.worth || 0, calc.currency || 'USD');

  return `
    <div class="dbstats">
      <div class="dbstat"><b>${esc(worth || '—')}</b><span>Account value</span></div>
      <div class="dbstat"><b>${formatNumber(calc.games || 0)}</b><span>Games</span></div>
      <div class="dbstat"><b>${formatNumber(calc.hours || 0)}</b><span>Hours played</span></div>
      ${calc.neverPlayed !== undefined ? `<div class="dbstat"><b>${formatNumber(calc.neverPlayed)}</b><span>Never played</span></div>` : ''}
      ${calc.averageMinutes ? `<div class="dbstat"><b>${esc(formatPlaytime(calc.averageMinutes))}</b><span>Average per game</span></div>` : ''}
    </div>
    <p class="loading-note" style="text-align:left">
      ${calc.available ? 'Read live from SteamDB.' : esc(calc.note || '')}
      ${calc.url ? ` <a href="${escAttr(calc.url)}" target="_blank" rel="noopener noreferrer">Open the SteamDB calculator</a>.` : ''}
    </p>`;
}

/* ================================================================== *
 * Remote play
 * ================================================================== */

export async function remotePlayView(root, ctx) {
  ctx.setTitle('Remote Play · Steam Viewer');

  const render = async () => {
    root.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Store</a> &rsaquo; Remote Play</div>
      <h1 class="apphead__title">Play your own games through this page</h1>
      <p class="lookup__lead">
        A web page cannot read your Steam install or start a game — no browser allows that. So the piece that
        can lives on your PC: a small companion program that this page talks to over
        <code>127.0.0.1</code>. It lists what is installed, launches it, and hands the stream to
        <strong>Moonlight</strong> (via Sunshine) or to <strong>Steam Remote Play</strong>.
      </p>
      <div id="remote-body"><p class="loading-note">Looking for the host agent on this machine…</p></div>`;

    const body = $('#remote-body', root);
    const info = await host.discover();

    if (!info) {
      body.innerHTML = setupHtml();
      $('#remote-retry', body)?.addEventListener('click', render);
      return;
    }

    if (!host.paired) {
      body.innerHTML = `
        <div class="panel">
          <h3 class="panel__title">Found ${esc(info.hostname || 'a PC')} — pair this browser</h3>
          <p class="panel__text">
            The agent printed a six-character pairing code in its window when it started. Enter it once; this
            browser is then remembered.
          </p>
          <form class="formrow" id="pair-form">
            <input type="text" id="pair-code" placeholder="A1B2C3" maxlength="12" autocomplete="off" spellcheck="false" />
            <button class="btn btn--green" type="submit">Pair</button>
          </form>
          <p class="modal__note" id="pair-status"></p>
        </div>`;

      $('#pair-form', body).addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = $('#pair-status', body);
        status.textContent = 'Pairing…';
        status.className = 'modal__note';
        try {
          await host.pair($('#pair-code', body).value);
          toast('Paired with your PC.', 'ok');
          render();
        } catch (error) {
          status.textContent = error.message;
          status.className = 'modal__note is-error';
        }
      });
      return;
    }

    body.innerHTML = '<p class="loading-note">Reading your installed games…</p>';

    let library;
    let targets;
    try {
      [library, targets] = await Promise.all([host.library(), host.streamTargets().catch(() => null)]);
    } catch (error) {
      body.innerHTML = `<div class="empty"><h2>The host agent refused that</h2><p>${esc(error.message)}</p>
        <p style="margin-top:14px"><button class="btn btn--ghost" type="button" id="remote-retry">Try again</button></p></div>`;
      $('#remote-retry', body)?.addEventListener('click', render);
      return;
    }

    const installed = library.games || [];
    const moonlight = targets?.moonlight;
    const addresses = targets?.addresses || [];

    body.innerHTML = `
      <div class="panel panel--split">
        <div>
          <h3 class="panel__title">Connected to ${esc(library.hostname || info.hostname || 'your PC')}</h3>
          <p class="panel__text">
            ${formatNumber(installed.length)} installed game${installed.length === 1 ? '' : 's'} found in
            ${formatNumber(library.libraryFolders?.length || 1)} Steam library folder${(library.libraryFolders?.length || 1) === 1 ? '' : 's'}.
          </p>
          <p><button class="btn btn--ghost btn--sm" type="button" id="remote-unpair">Unpair this browser</button></p>
        </div>
        <div>
          <h3 class="panel__title">Streaming</h3>
          ${
            moonlight?.available
              ? `<p class="panel__text">Sunshine is running on this PC, so Moonlight can connect to
                  <code>${esc(moonlight.host || addresses[0] || 'this machine')}</code>.</p>
                 <p><a class="btn btn--green" href="${escAttr(moonlightUrl({ address: moonlight.host || addresses[0], port: moonlight.port }) || '#')}">Open in Moonlight</a></p>`
              : `<p class="panel__text">
                  No Sunshine host detected. Steam's own Remote Play still works — start a game below and connect
                  from the Steam Link app on the device you want to play on.
                </p>
                <p>
                  <a class="btn btn--ghost btn--sm" href="https://github.com/LizardByte/Sunshine/releases" target="_blank" rel="noopener noreferrer">Install Sunshine</a>
                  <a class="btn btn--ghost btn--sm" href="https://store.steampowered.com/remoteplay" target="_blank" rel="noopener noreferrer">About Steam Remote Play</a>
                </p>`
          }
        </div>
      </div>

      <div class="toolbar">
        <input type="search" id="remote-search" placeholder="Filter installed games" aria-label="Filter installed games" />
        <button class="btn btn--ghost btn--sm" type="button" id="remote-refresh">Refresh</button>
      </div>
      <div class="grid grid--portrait" id="remote-grid"></div>`;

    const grid = $('#remote-grid', body);
    const search = $('#remote-search', body);

    const paint = () => {
      const term = search.value.trim().toLowerCase();
      const shown = installed.filter((game) => !term || game.name.toLowerCase().includes(term));
      grid.innerHTML =
        shown
          .map((game) =>
            portraitCardHtml(game, {
              subtitle: game.sizeOnDisk ? `${(game.sizeOnDisk / 1024 ** 3).toFixed(1)} GB` : 'installed',
              badge: 'INSTALLED',
              installed: true,
              action: 'Play',
            }),
          )
          .join('') || '<p class="loading-note">Nothing matches that filter.</p>';
      attachImageFallbacks(grid);
    };

    search.addEventListener('input', paint);
    $('#remote-refresh', body).addEventListener('click', render);
    $('#remote-unpair', body).addEventListener('click', () => {
      host.unpair();
      render();
    });

    grid.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-play]');
      if (!button) return;
      event.preventDefault();

      button.disabled = true;
      button.textContent = 'Starting…';
      try {
        const result = await host.launch(button.dataset.play, moonlight?.available ? 'stream' : 'local');
        toast(result?.message || 'Launching on your PC…', 'ok');
        if (result?.streamUrl) window.location.href = result.streamUrl;
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        button.disabled = false;
        button.textContent = 'Play';
      }
    });

    paint();
  };

  await render();
  return undefined;
}

function setupHtml() {
  return `
    <div class="panel">
      <h3 class="panel__title">No host agent running on this machine</h3>
      <p class="panel__text">
        Install it on the PC your Steam library is on — it is a single Node script in the
        <code>host/</code> folder of this repository, with no dependencies to install.
      </p>
      <ol class="setup">
        <li>Copy <code>host/steam-viewer-host.mjs</code> to that PC.</li>
        <li>Run <code>node steam-viewer-host.mjs</code>. It prints a pairing code.</li>
        <li>Open this page <em>on that same PC</em> and enter the code once.</li>
      </ol>
      <p class="panel__text">
        The agent only ever listens on <code>127.0.0.1</code>, so nothing outside the machine can reach it,
        and it refuses every request until it has been paired.
      </p>
      <p class="panel__text">
        Chrome, Edge and Firefox allow a page to talk to <code>127.0.0.1</code>. Safari does not, so use one of
        the others for this part.
      </p>
      <p><button class="btn btn--green" type="button" id="remote-retry">Look again</button></p>
    </div>`;
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
        <code>{"action":"search","params":{"term":"portal"}}</code>. The relay calls Steam's public endpoints, caches
        every response in memory and answers. It also pushes live updates: the most-played chart every couple of minutes,
        and player counts for whichever game you are looking at.
      </p>
      <p>
        If the WebSocket cannot be established, the page silently falls back to <code>GET /api/&lt;action&gt;</code> on the
        same host, so everything except the live pushes keeps working.
      </p>
      <h2>No sign-in anywhere</h2>
      <p>
        Profiles and libraries come from steamcommunity.com's own XML documents and its user-search index — the same
        thing behind <code>steamcommunity.com/search/users/#text=…</code>. Those need no key, no login and no session,
        so anyone can look up any public profile. Setting <code>STEAM_API_KEY</code> on the relay is optional and only
        adds Steam levels and two-week recents.
      </p>
      <h2>Your wishlist</h2>
      <p>
        The wishlist here is stored in your own browser under <code>localStorage</code>. It never reaches the relay and
        it is not your Steam wishlist — it is a local stand-in so the feature works without an account. Export it from
        the wishlist page if you want a copy that survives clearing site data.
      </p>
      <h2>SteamDB</h2>
      <p>
        SteamDB has no public API and sits behind Cloudflare, so the relay attempts it and falls back to computing the
        same figures from Steam's own key-less endpoints when it is refused. Every panel says which of the two you are
        looking at, and links to the real SteamDB page.
      </p>
      <h2>Remote play</h2>
      <p>
        <a href="#/remote">Remote Play</a> talks to a companion program you run on your own PC. Browsers cannot read a
        local Steam install or launch a game; the companion can, and it hands streaming off to Moonlight (through
        Sunshine) or to Steam's own Remote Play.
      </p>
      <h2>What you can do here</h2>
      <ul>
        <li>Search the whole Steam catalogue, with suggestions as you type.</li>
        <li>Browse top sellers, new releases, specials, coming soon, free-to-play and the live most-played chart.</li>
        <li>Open any game for trailers, screenshots, the full store description, tags, system requirements, achievements, DLC, news, reviews and SteamDB stats.</li>
        <li>Browse by genre, and open any developer's or publisher's back catalogue.</li>
        <li>Keep a wishlist without an account.</li>
        <li>Look up any public Steam library, no sign-in required.</li>
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
