/**
 * Trailer resolution: the two ways a trailer arrives with no playable address,
 * and what the relay does about each.
 *
 * No network here — `fetch` is replaced in every case, so nothing leaves the
 * machine and the results do not depend on Steam being reachable or on which
 * game happens to have a trailer today.
 */
const APPID = 3241660;

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const appdetails = (movies, appid = APPID) => ({
  [appid]: {
    success: true,
    data: {
      type: 'game',
      name: 'Test Game',
      steam_appid: appid,
      is_free: false,
      platforms: { windows: true },
      release_date: { coming_soon: false, date: '26 Feb, 2025' },
      movies,
    },
  },
});

/* ------------------------------------------------------------------ *
 * 1. Steam names no addresses at all — rebuild them from the movie id
 * ------------------------------------------------------------------ */
{
  const MOVIE_ID = 257084045;
  // Only the vp9 webm exists, and it is not the first name guessed.
  const LIVE = `https://video.cloudflare.steamstatic.com/store_trailers/${MOVIE_ID}/movie_max_vp9.webm`;
  let probes = 0;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (/\.(mp4|webm)(\?|$)/i.test(url)) {
      probes += 1;
      const ok = url.split('?')[0] === LIVE;
      return { ok, status: ok ? 206 : 404, body: null };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const steam = await import('../src/steam.js');
  const game = steam.toFull(
    appdetails([
      {
        id: MOVIE_ID,
        name: 'PC Launch Trailer',
        thumbnail: `https://video.cloudflare.steamstatic.com/store_trailers/${MOVIE_ID}/movie_600x337.jpg?t=1`,
        highlight: true,
        // No mp4. No webm. This is the payload that produced "0 address(es)".
      },
    ])[APPID].data,
  );

  const movie = game.movies[0];
  check('a trailer with no addresses is not dropped', Boolean(movie), movie?.name);
  check('addresses are rebuilt from the movie id', movie.sources.length > 0, `${movie.sources.length} candidates`);
  check('and flagged as rebuilt rather than quoted', movie.derivedOnly === true);
  check(
    'the folder comes from the thumbnail, not an assumption',
    movie.sources[0].includes(`/store_trailers/${MOVIE_ID}/`),
    movie.sources[0],
  );
  check(
    'every format is tried on the good host before other hosts',
    movie.sources.slice(0, 6).every((url) => url.includes('video.cloudflare')),
    movie.sources.slice(0, 6).map((url) => url.split('/').pop()).join(', '),
  );

  const [resolved] = await steam.resolveMovies([movie]);
  check('probing finds the one address that answers', resolved.verified === true && resolved.sources[0] === LIVE, resolved.sources[0]);
  check('probing stays bounded', probes <= 8, `${probes} probed`);
}

/* ------------------------------------------------------------------ *
 * 2. Rebuilt names are wrong — read the real ones off the store page
 * ------------------------------------------------------------------ *
 * This is the "only one of the three worked" case: guessing was right for one
 * trailer and wrong for the other two.
 */
{
  const MOVIES = [
    { id: 257111001, name: 'Cosmetic Update' },
    { id: 257111002, name: 'Monster Update' },
    { id: 257111003, name: 'Museum Update' },
  ];
  const REAL = {
    257111001: 'https://video.cloudflare.steamstatic.com/store_trailers/257111001/movie_max_h264.mp4?t=17',
    // The only one whose name the rebuilder would have guessed.
    257111002: 'https://video.cloudflare.steamstatic.com/store_trailers/257111002/movie_max.mp4?t=17',
    257111003: 'https://video.cloudflare.steamstatic.com/store_trailers/257111003/movie265.mp4?t=17',
  };
  const STORE_HTML = `<html><body>${Object.entries(REAL)
    .map(([id, url]) => `<div id="highlight_movie_${id}" data-mp4-source="${url}"></div>`)
    .join('')}</body></html>`;

  let storePageFetches = 0;
  const live = new Set(Object.values(REAL).map((url) => url.split('?')[0]));

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/appdetails')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            appdetails(
              MOVIES.map((movie) => ({
                id: movie.id,
                name: movie.name,
                thumbnail: `https://video.cloudflare.steamstatic.com/store_trailers/${movie.id}/movie_600x337.jpg?t=17`,
                highlight: true,
              })),
            ),
          ),
      };
    }
    if (/\/app\/\d+\//.test(url)) {
      storePageFetches += 1;
      return { ok: true, status: 200, text: async () => STORE_HTML };
    }
    if (/\.(mp4|webm)(\?|$)/i.test(url)) {
      const ok = live.has(url.split('?')[0]);
      return { ok, status: ok ? 206 : 404, body: null };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const { runAction } = await import('../src/actions.js');
  const { data } = await runAction('app', { appid: APPID });
  const movies = data.game.movies;

  check('all three trailers come through', movies.length === 3, `${movies.length}`);
  check('the store page is consulted once, not per trailer', storePageFetches === 1, `${storePageFetches} fetches`);
  for (const movie of movies) {
    check(`“${movie.name}” resolves to its own real address`, movie.sources[0] === REAL[movie.id], movie.sources[0]);
    check(`“${movie.name}” is verified against the CDN`, movie.verified === true);
  }
  check(
    'addresses are never mixed between trailers',
    movies.every((movie) => movie.sources[0].includes(`/store_trailers/${movie.id}/`)),
  );

  /* A payload that names its addresses must not pay for the store page. */
  const before = storePageFetches;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/appdetails')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            appdetails(
              [{
                id: 900,
                name: 'T',
                thumbnail: 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/movie.jpg',
                mp4: { max: 'http://video.akamai.steamstatic.com/store_trailers/900/movie_max.mp4?t=1' },
              }],
              620,
            ),
          ),
      };
    }
    if (/\/app\/\d+\//.test(url)) {
      storePageFetches += 1;
      return { ok: true, status: 200, text: async () => STORE_HTML };
    }
    return { ok: false, status: 404, body: null, text: async () => '{}' };
  };
  const quoted = await runAction('app', { appid: 620 });
  check('a payload with addresses skips the store page', storePageFetches === before, `${storePageFetches - before} extra`);
  check('quoted addresses are upgraded to https', quoted.data.game.movies[0].sources.every((url) => url.startsWith('https://')));
}

/* ------------------------------------------------------------------ *
 * 3. Probing must never delete the trailer it is probing
 * ------------------------------------------------------------------ */
{
  globalThis.fetch = async () => {
    throw new Error('no route to Steam');
  };
  const steam = await import('../src/steam.js');
  const movie = (id) => ({
    id,
    name: `Trailer ${id}`,
    thumb: 'https://cdn.cloudflare.steamstatic.com/t.jpg',
    sources: [`https://video.cloudflare.steamstatic.com/store_trailers/${id}/movie_max.mp4`],
  });

  const out = await steam.resolveMovies([movie(1), movie(2), movie(3), movie(4)]);
  check('an unreachable relay keeps every trailer', out.length === 4, `${out.length} of 4`);
  check('their addresses survive for the browser to walk', out.every((entry) => entry.sources.length > 0));
  check('and they are reported as unverified', out.every((entry) => entry.verified === false));
}

console.log(failures === 0 ? '\nAll trailer checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
