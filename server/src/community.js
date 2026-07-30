/**
 * Steam Community lookups that need no API key and no logged-in visitor.
 *
 * Every public Steam profile still serves the legacy XML documents:
 *   https://steamcommunity.com/id/<vanity>/?xml=1
 *   https://steamcommunity.com/profiles/<id64>/games/?tab=all&xml=1
 *
 * That is how profiles and libraries are read here, so the relay works with an
 * empty `STEAM_API_KEY`. When a key *is* configured the Web API path in
 * steam.js is preferred, because it returns richer data and a proper
 * "profile is private" signal.
 */
import { fetchText, images, secureUrl, SteamError, COMMUNITY } from './steam.js';

const STEAMID64 = /^\d{17}$/;

/** Steam's XML is machine generated, so targeted extraction is safe here. */
function tag(xml, name) {
  const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

function tagAll(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi'))].map((match) => match[1]);
}

const num = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Accepts a SteamID64, a vanity name, a full profile URL, or the `#text=`
 * fragment from steamcommunity.com/search/users — whatever the visitor pastes.
 */
export function parseProfileInput(input) {
  let value = String(input || '').trim();
  if (!value) throw new SteamError('Enter a Steam profile', { status: 400 });

  const fragment = value.match(/[#?&]text=([^&\s]+)/i);
  if (fragment) value = decodeURIComponent(fragment[1]);

  const url = value.match(/steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)/i);
  if (url) return { kind: url[1] === 'profiles' ? 'id64' : 'vanity', value: decodeURIComponent(url[2]) };

  value = value.replace(/^@/, '');
  if (STEAMID64.test(value)) return { kind: 'id64', value };
  return { kind: 'vanity', value };
}

const profileUrl = (target) =>
  target.kind === 'id64'
    ? `${COMMUNITY}/profiles/${encodeURIComponent(target.value)}`
    : `${COMMUNITY}/id/${encodeURIComponent(target.value)}`;

/** Public profile summary, straight from the community XML. */
export async function getCommunityProfile(input) {
  const target = parseProfileInput(input);
  const xml = await fetchText(`${profileUrl(target)}/?xml=1`);

  const error = tag(xml, 'error');
  if (error) throw new SteamError(error, { status: 404 });

  const steamid = tag(xml, 'steamID64');
  if (!steamid) throw new SteamError('That Steam profile could not be read', { status: 404 });

  const privacy = (tag(xml, 'privacyState') || '').toLowerCase();

  return {
    steamid,
    name: tag(xml, 'steamID') || steamid,
    avatar: secureUrl(tag(xml, 'avatarFull') || tag(xml, 'avatarMedium') || tag(xml, 'avatarIcon')),
    profileUrl: `${COMMUNITY}/profiles/${steamid}`,
    customUrl: tag(xml, 'customURL'),
    onlineState: tag(xml, 'onlineState'),
    stateMessage: (tag(xml, 'stateMessage') || '').replace(/<[^>]+>/g, ' ').trim() || null,
    memberSince: tag(xml, 'memberSince'),
    location: tag(xml, 'location'),
    realname: tag(xml, 'realname'),
    summary: (tag(xml, 'summary') || '').replace(/<[^>]+>/g, ' ').trim() || null,
    // The XML calls a fully public profile "public"; anything else limits games.
    isPublic: privacy === 'public' || privacy === '',
    playingName: tag(xml, 'inGameInfo') ? tag(tag(xml, 'inGameInfo'), 'gameName') : null,
    vacBanned: tag(xml, 'vacBanned') === '1',
    source: 'community',
  };
}

/** Owned games with playtime — needs the profile's game details to be public. */
export async function getCommunityGames(steamidOrInput) {
  const target = parseProfileInput(steamidOrInput);
  const xml = await fetchText(`${profileUrl(target)}/games/?tab=all&xml=1`);

  const error = tag(xml, 'error');
  if (error) {
    throw new SteamError(
      /private/i.test(error)
        ? 'That profile keeps its game details private, so its library cannot be read.'
        : error,
      { status: 403 },
    );
  }

  const steamid = tag(xml, 'steamID64');
  const games = tagAll(xml, 'game')
    .map((block) => {
      const appid = num(tag(block, 'appID'));
      if (!appid) return null;
      const hours = num(tag(block, 'hoursOnRecord')) || 0;
      const recent = num(tag(block, 'hoursLast2Weeks')) || 0;
      return {
        appid,
        name: tag(block, 'name') || `App ${appid}`,
        header: images(appid).header,
        portrait: images(appid).portrait,
        capsule: images(appid).capsule,
        playtimeForever: Math.round(hours * 60),
        playtime2Weeks: Math.round(recent * 60),
        lastPlayed: null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.playtimeForever - a.playtimeForever);

  return { steamid, games, source: 'community' };
}

/**
 * Search public profiles by name — the JSON behind
 * steamcommunity.com/search/users.
 *
 * The endpoint only checks that the `sessionid` parameter matches the cookie
 * of the same name, so an anonymous caller can mint its own.
 */
export async function searchUsers({ text, page = 1 } = {}) {
  const query = String(text || '').trim();
  if (!query) return { total: 0, results: [], query: '' };

  const sessionid = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

  const url = `${COMMUNITY}/search/SearchCommunityAjax?${new URLSearchParams({
    text: query,
    filter: 'users',
    sessionid,
    steamid_user: 'false',
    page: String(Math.min(Math.max(Number(page) || 1, 1), 10)),
  })}`;

  let raw;
  try {
    raw = JSON.parse(await fetchText(url, { headers: { Cookie: `sessionid=${sessionid}` } }));
  } catch {
    raw = null;
  }

  // If the community search is unavailable, a direct profile hit is still
  // useful — most people type an exact vanity name anyway.
  if (!raw || raw.success !== 1) {
    const profile = await getCommunityProfile(query).catch(() => null);
    return profile ? { total: 1, results: [profile], query, degraded: true } : { total: 0, results: [], query, degraded: true };
  }

  const html = String(raw.html || '');
  const results = [];
  const seen = new Set();

  // Each row exposes the account's 32-bit id, which converts to a SteamID64.
  for (const block of html.split('<div class="search_row').slice(1)) {
    const mini = /data-miniprofile="(\d+)"/.exec(block);
    const link = /<a[^>]+class="searchPersonaName"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const avatar = /<img[^>]+src="([^"]+)"/.exec(block);
    if (!link) continue;

    const steamid = mini ? String(76561197960265728n + BigInt(mini[1])) : null;
    if (steamid && seen.has(steamid)) continue;
    if (steamid) seen.add(steamid);

    results.push({
      steamid,
      name: link[2].replace(/<[^>]+>/g, '').trim(),
      profileUrl: secureUrl(link[1]),
      avatar: secureUrl(avatar?.[1] || null),
      // Prefer the id64 for lookups; fall back to the vanity in the URL.
      lookup: steamid || (link[1].match(/\/id\/([^/?#]+)/)?.[1] ?? null),
    });

    if (results.length >= 20) break;
  }

  return { total: Number(raw.search_result_count) || results.length, results, query };
}
