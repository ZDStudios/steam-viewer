/**
 * The media proxy against what a CDN really returns: missing assets, error
 * pages wearing an image content-type, an asset that moved hosts, and a host
 * that simply does not answer.
 */
import http from 'node:http';

// No network here: `fetch` is replaced below, so nothing leaves the machine.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const seen = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  seen.push(url);
  const host = new URL(url).hostname;
  const path = new URL(url).pathname;
  const is = (name) => path.endsWith(name);

  // /moved.jpg exists only on cdn.cloudflare — the old address 404s.
  if (is('/moved.jpg')) {
    if (host === 'cdn.cloudflare.steamstatic.com') {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
    }
    return new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });
  }
  // /errorpage.jpg 404s but the CDN types its error page as an image.
  if (is('/errorpage.jpg')) {
    return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'image/jpeg' } });
  }
  // /gone.jpg is missing everywhere.
  if (is('/gone.jpg')) {
    return new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } });
  }
  // /dead.jpg: the host never answers.
  if (is('/dead.jpg')) throw new Error('ETIMEDOUT');
  // Everything else is fine.
  return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
};

process.env.PORT = '8096';
await import('../src/index.js');
await new Promise((r) => setTimeout(r, 700));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

const get = async (steamUrl) => {
  const res = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:8096/media?url=${encodeURIComponent(steamUrl)}`, resolve).on('error', reject);
  });
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) };
};

{
  const r = await get('https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/1/header.jpg');
  check('a healthy asset is served', r.status === 200 && r.body.length === PNG.length, `${r.status}, ${r.body.length}B`);
  check('and cached hard, because it is immutable', /immutable/.test(r.headers['cache-control'] || ''), r.headers['cache-control']);
}

{
  seen.length = 0;
  const r = await get('https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1/moved.jpg');
  check('an asset that moved hosts is still found', r.status === 200 && r.body.length === PNG.length, `${r.status} after ${seen.length} tries`);
  check('the working host was reached by retrying', seen.length > 1, seen.map((u) => new URL(u).hostname).join(' → '));
}

{
  const r = await get('https://cdn.cloudflare.steamstatic.com/steam/apps/1/errorpage.jpg');
  // The right outcome is a refusal, not the error page relabelled as artwork.
  const servedAsImage = r.status === 200 || /^image\//.test(r.headers['content-type'] || '');
  check('an error page typed as an image is not passed off as one', !servedAsImage, `${r.status} ${r.headers['content-type']}`);
  check('and it is not cached', /no-store/.test(r.headers['cache-control'] || ''), r.headers['cache-control'] || '(none)');
}

{
  const r = await get('https://cdn.cloudflare.steamstatic.com/steam/apps/1/gone.jpg');
  check('a genuinely missing asset answers 404', r.status === 404, String(r.status));
  check('a 404 is never cached', /no-store/.test(r.headers['cache-control'] || ''), r.headers['cache-control'] || '(none)');
  let body = null;
  try { body = JSON.parse(r.body.toString()); } catch { /* not JSON */ }
  check('and it says which hosts were tried', Array.isArray(body?.error?.tried) && body.error.tried.length > 1, `${body?.error?.tried?.length} hosts`);
}

{
  const r = await get('https://cdn.cloudflare.steamstatic.com/steam/apps/1/dead.jpg');
  check('an unreachable host answers 502, not a hang', r.status === 502, String(r.status));
  check('and is not cached either', /no-store/.test(r.headers['cache-control'] || ''), r.headers['cache-control'] || '(none)');
}

{
  const r = await get('https://evil.example.com/x.jpg');
  check('a non-Steam host is still refused', r.status === 400, String(r.status));
}

{
  // Community screenshots are not store art; rewriting their host is pointless.
  seen.length = 0;
  await get('https://steamuserimages-a.akamaihd.net/ugc/1/gone.jpg');
  check('non-store hosts are not host-shuffled', seen.length === 1, `${seen.length} request(s)`);
}

console.log(failures === 0 ? '\nAll media-proxy checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
