/**
 * The signed-in Steam account.
 *
 * Sign-in runs through Steam's own OpenID provider (see `server/src/openid.js`):
 * the visitor types their password on steamcommunity.com and comes back with a
 * SteamID the relay has verified with Steam directly. Nothing secret ends up
 * here — a SteamID64 is public information, the same number that appears in a
 * profile URL — so `localStorage` is the right place for it and signing out is
 * genuinely just forgetting a number.
 *
 * What this does *not* do is hold a Steam session. That distinction decides
 * what the rest of the app can show, so it is spelled out in `LIMITS` and
 * surfaced in the UI rather than left for someone to discover.
 */
const KEY = 'steam-viewer:account';

const listeners = new Set();

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && /^\d{17}$/.test(String(raw.steamid))) return raw;
  } catch {
    /* corrupt entry — treat as signed out */
  }
  return null;
}

let current = read();

const notify = () => {
  for (const handler of listeners) {
    try {
      handler(current);
    } catch (error) {
      console.error('[account] listener threw', error);
    }
  }
};

export const get = () => current;
export const isConnected = () => Boolean(current);
export const steamid = () => current?.steamid || '';

export function onChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function set(steamid64, extra = {}) {
  if (!/^\d{17}$/.test(String(steamid64))) return null;
  current = { steamid: String(steamid64), connectedAt: Date.now(), ...extra };
  localStorage.setItem(KEY, JSON.stringify(current));
  notify();
  return current;
}

/** Fill in the display name and avatar once the profile has been loaded. */
export function decorate({ name, avatar } = {}) {
  if (!current) return;
  current = { ...current, name: name || current.name, avatar: avatar || current.avatar };
  localStorage.setItem(KEY, JSON.stringify(current));
  notify();
}

export function clear() {
  current = null;
  localStorage.removeItem(KEY);
  notify();
}

/** Send the browser to Steam to sign in, returning to this exact page. */
export function beginSignIn(relayBaseUrl) {
  if (!relayBaseUrl) throw new Error('Connect a relay first — sign-in is verified by the relay, not this page.');
  const back = new URL(window.location.href);
  // Do not carry a previous attempt's parameters into the next one.
  back.searchParams.delete('steamid');
  back.searchParams.delete('steam_error');
  window.location.href = `${relayBaseUrl}/auth/steam?return=${encodeURIComponent(back.toString())}`;
}

/**
 * Pick up the result of a sign-in.
 *
 * The relay redirects back with `?steamid=` (or `?steam_error=`) on whatever
 * page the visitor started from. Both are stripped from the address bar
 * afterwards so a reload, a bookmark or a shared link does not carry them.
 *
 * @returns {{steamid?: string, error?: string} | null}
 */
export function consumeRedirect() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('steamid');
  const error = params.get('steam_error');
  if (!id && !error) return null;

  params.delete('steamid');
  params.delete('steam_error');
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  );

  if (id && /^\d{17}$/.test(id)) {
    set(id);
    return { steamid: id };
  }
  return { error: error || 'Steam did not complete the sign-in.' };
}

/**
 * What signing in can and cannot reach, stated once so every screen says the
 * same thing.
 */
export const LIMITS = {
  available: [
    'Your profile, Steam level and member-since date',
    'Your games, playtime and achievement progress',
    'Recent activity and your friends list',
    'Account value priced against your own store region',
  ],
  unavailable: [
    {
      what: 'Your shopping cart',
      why: 'The cart lives in an authenticated Steam store session. Valve publishes no API for it — not with a Web API key, not with OpenID, not to anyone.',
    },
    {
      what: 'Your wallet balance',
      why: 'Same story: it is readable only from a signed-in Steam store session, so the only way to reach it would be to capture a real Steam login, which this site will not ask you for.',
    },
    {
      what: 'Anything your privacy settings hide',
      why: 'Signing in proves who you are; it does not grant this site permission to read what your profile keeps private. A private library stays private here too.',
    },
  ],
};
