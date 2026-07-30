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

/**
 * Steam's XML is machine generated, so targeted extraction is safe here.
 * Elements may carry attributes — `<achievement closed="1">` is how unlocked
 * achievements are marked — so the open tag has to tolerate them.
 */
const OPEN = (name) => `<${name}(?:\\s[^>]*)?>`;

function tag(xml, name) {
  const match = new RegExp(`${OPEN(name)}(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

function tagAll(xml, name) {
  return [...xml.matchAll(new RegExp(`${OPEN(name)}([\\s\\S]*?)</${name}>`, 'gi'))].map((match) => match[1]);
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
  const inGame = /<inGameInfo>([\s\S]*?)<\/inGameInfo>/i.exec(xml)?.[1] || '';

  // The profile XML carries the same "most played" block the real profile page
  // shows under Recent Activity, including hours in the last two weeks.
  const mostPlayed = tagAll(xml, 'mostPlayedGame')
    .map((block) => {
      const link = tag(block, 'gameLink') || '';
      const appid = Number(tag(block, 'statsName') || link.match(/\/app\/(\d+)/)?.[1]);
      if (!Number.isFinite(appid)) return null;
      return {
        appid,
        name: tag(block, 'gameName') || `App ${appid}`,
        header: images(appid).header,
        capsule: images(appid).capsule,
        portrait: images(appid).portrait,
        icon: secureUrl(tag(block, 'gameIcon')),
        playtime2Weeks: Math.round((num(tag(block, 'hoursPlayed')) || 0) * 60),
        playtimeForever: Math.round((num(tag(block, 'hoursOnRecord')) || 0) * 60),
      };
    })
    .filter(Boolean);

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
    headline: (tag(xml, 'headline') || '').replace(/<[^>]+>/g, ' ').trim() || null,
    summary: (tag(xml, 'summary') || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .trim() || null,
    // The XML calls a fully public profile "public"; anything else limits games.
    isPublic: privacy === 'public' || privacy === '',
    playingName: tag(inGame, 'gameName') || null,
    playingAppId: Number(tag(inGame, 'gameLink')?.match(/\/app\/(\d+)/)?.[1]) || null,
    vacBanned: tag(xml, 'vacBanned') === '1',
    limitedAccount: tag(xml, 'isLimitedAccount') === '1',
    hours2Weeks: num(tag(xml, 'hoursPlayed2Wk')),
    groupCount: tagAll(xml, 'group').length,
    mostPlayed,
    source: 'community',
  };
}

/**
 * Friends of a public profile, read from the community friends page.
 *
 * There is no key-less XML for friends, and this page is public, so the markup
 * is parsed for the few fields the sidebar needs. Unexpected markup yields
 * fewer friends rather than an error.
 */
export async function getCommunityFriends(input, { limit = 40 } = {}) {
  const target = parseProfileInput(input);

  let html;
  try {
    html = await fetchText(`${profileUrl(target)}/friends/`);
  } catch {
    return { friends: [], total: 0, available: false };
  }

  const friends = [];
  const seen = new Set();

  for (const block of html.split('friend_block_v2').slice(1)) {
    const steamid = /data-steamid="(\d+)"/.exec(block)?.[1];
    if (!steamid || seen.has(steamid)) continue;
    seen.add(steamid);

    // State lives in the element's own class list, right at the start.
    const head = block.slice(0, 300);
    const state = /\bin-game\b/.test(head) ? 'in-game' : /\bonline\b/.test(head) ? 'online' : 'offline';

    const content = /friend_block_content"?>([\s\S]*?)<\/div>/i.exec(block)?.[1] || '';
    const parts = content.split(/<br\s*\/?>/i);
    const name = (parts[0] || '').replace(/<[^>]+>/g, '').trim();
    const status = (parts[1] || '').replace(/<[^>]+>/g, '').trim();

    friends.push({
      steamid,
      name: name || steamid,
      avatar: secureUrl(/<img[^>]+src="([^"]+)"/i.exec(block)?.[1] || null),
      state,
      status: status || null,
      profileUrl: `${COMMUNITY}/profiles/${steamid}`,
    });

    if (friends.length >= limit) break;
  }

  return { friends, total: seen.size, available: true };
}

/**
 * Per-game achievement progress from the public stats XML — this is what puts
 * the "5 of 156" bars under Recent Activity without needing an API key.
 */
export async function getCommunityAchievements(steamid, appid) {
  const id = Number(appid);
  if (!Number.isFinite(id)) return null;

  let xml;
  try {
    xml = await fetchText(`${COMMUNITY}/profiles/${encodeURIComponent(steamid)}/stats/${id}/?xml=1`);
  } catch {
    return null;
  }
  if (tag(xml, 'error')) return null;

  const all = tagAll(xml, 'achievement');
  if (all.length === 0) return null;

  // `closed="1"` on the element marks an unlocked achievement.
  const unlocked = [...xml.matchAll(/<achievement[^>]*closed="1"[^>]*>([\s\S]*?)<\/achievement>/gi)].map((match) => match[1]);

  return {
    appid: id,
    total: all.length,
    unlocked: unlocked.length,
    icons: unlocked
      .slice(-5)
      .map((block) => ({ name: tag(block, 'name'), icon: secureUrl(tag(block, 'iconClosed')) }))
      .filter((entry) => entry.icon),
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
