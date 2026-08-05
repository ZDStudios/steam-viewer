/**
 * "Sign in through Steam" — Steam's OpenID 2.0 provider.
 *
 * This is Valve's own, public, documented identity endpoint. It needs no API
 * key and no registration. The visitor is sent to Steam, types their password
 * on **steamcommunity.com** and nothing else, and Steam sends them back with a
 * signed assertion that the relay re-checks with Steam directly. The relay
 * never sees, stores or asks for a password, and the only thing it learns is
 * the 64-bit SteamID.
 *
 * What that does and does not unlock is worth being precise about, because the
 * difference is not obvious:
 *
 *   • It proves *who you are*. That is enough to load your profile, level,
 *     library, playtime, achievements, friends and recently-played games
 *     without typing an ID — everything this site already renders.
 *
 *   • It is not a Steam *session*. Your cart and your wallet balance live
 *     behind an authenticated store session (the `steamLoginSecure` cookie);
 *     Valve exposes no API for either, to anyone, with or without a key. The
 *     only way to read them would be to capture a real Steam login, which this
 *     project will not do and nobody should paste into a third-party site.
 *
 *   • Privacy settings still apply. Signing in does not authorise the relay to
 *     read anything your profile hides from the public; a private library is
 *     private here too.
 */
import { SteamError } from './steam.js';

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Where the visitor may be sent back to.
 *
 * Redirecting to an arbitrary URL after a login is an open redirect, so the
 * target has to be vouched for. `SITE_ORIGINS` is the explicit list; without
 * it the defaults cover where this project is actually deployed — GitHub Pages
 * — plus local development.
 */
const CONFIGURED_ORIGINS = (process.env.SITE_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const DEFAULT_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.github\.io$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/i,
];

export function returnAllowed(rawUrl, selfOrigin = '') {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const origin = url.origin;
  if (origin === selfOrigin) return url;
  if (CONFIGURED_ORIGINS.includes(origin)) return url;
  // An explicit list replaces the defaults rather than adding to them, so a
  // locked-down deployment stays locked down.
  if (CONFIGURED_ORIGINS.length === 0 && DEFAULT_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) return url;
  return null;
}

const selfOriginOf = (req) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto.split(',')[0].trim()}://${req.get('host')}`;
};

/**
 * Build the redirect to Steam.
 *
 * `identity`/`claimed_id` are the OpenID 2.0 "identifier select" constants —
 * they tell Steam to work out which account is signing in rather than us
 * naming one.
 */
export function authorizeUrl({ returnTo, realm }) {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${OPENID_ENDPOINT}?${params}`;
}

/**
 * Re-ask Steam whether it really signed this assertion.
 *
 * The parameters come back through the visitor's browser, so they are
 * attacker-controlled until Steam confirms them. `check_authentication` is the
 * confirmation, and skipping it is the classic way to get a "login" that
 * anyone can forge by editing a URL.
 */
export async function verifyAssertion(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('openid.')) continue;
    params.set(key, Array.isArray(value) ? value[0] : String(value));
  }
  params.set('openid.mode', 'check_authentication');

  if (!params.get('openid.signed') || !params.get('openid.sig')) {
    throw new SteamError('Steam did not return a signed response', { status: 400 });
  }

  let body;
  try {
    const response = await fetch(OPENID_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    body = await response.text();
  } catch (error) {
    throw new SteamError(`Could not reach Steam to verify the sign-in: ${error.message}`, { status: 502, retryable: true });
  }

  if (!/is_valid\s*:\s*true/i.test(body)) {
    throw new SteamError('Steam rejected that sign-in — please try again', { status: 401 });
  }

  const claimed = params.get('openid.claimed_id') || '';
  const match = CLAIMED_ID.exec(claimed);
  if (!match) throw new SteamError('Steam returned an identity this relay does not recognise', { status: 400 });

  return match[1];
}

/**
 * Mount `/auth/steam` and `/auth/steam/return`.
 *
 * These are plain browser navigations rather than actions on the WebSocket,
 * because an OpenID round trip *is* a navigation — the visitor has to end up
 * on Steam's own domain to type their password.
 */
export function mountSteamAuth(app) {
  app.get('/auth/steam', (req, res) => {
    const selfOrigin = selfOriginOf(req);
    const target = returnAllowed(String(req.query.return || ''), selfOrigin);

    if (!target) {
      res.status(400).json({
        ok: false,
        error: {
          message:
            'That return address is not allowed. Set SITE_ORIGINS on the relay to the origin your page is served from.',
          status: 400,
        },
      });
      return;
    }

    // Steam sends the assertion to `return_to`; the page we finally land on
    // rides along in the query so it survives the round trip.
    const returnTo = new URL('/auth/steam/return', selfOrigin);
    returnTo.searchParams.set('to', target.toString());

    res.redirect(authorizeUrl({ returnTo: returnTo.toString(), realm: selfOrigin }));
  });

  app.get('/auth/steam/return', async (req, res) => {
    const selfOrigin = selfOriginOf(req);
    const target = returnAllowed(String(req.query.to || ''), selfOrigin);
    if (!target) {
      res.status(400).type('text').send('That sign-in came back with a return address this relay will not redirect to.');
      return;
    }

    let steamid;
    try {
      steamid = await verifyAssertion(req.query);
    } catch (error) {
      target.searchParams.set('steam_error', error.message);
      res.redirect(target.toString());
      return;
    }

    // The page reads this once and stores it itself; nothing is kept here.
    target.searchParams.set('steamid', steamid);
    res.redirect(target.toString());
  });
}
