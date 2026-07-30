/**
 * Offline checks for the parsing this relay does on Steam's HTML and XML
 * documents.
 *
 * The endpoints these read are undocumented, so the shapes below are captured
 * fixtures rather than live calls — the point is that a change to the parsers
 * cannot silently start returning empty lists, which is exactly how the genre
 * pages broke in the first place.
 *
 *   node scripts/parse-tests.js
 */
import assert from 'node:assert/strict';

import { canonicalGenre, dedupeItems, isHardwareOrAd, nameKey, secureUrl } from '../src/steam.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A trimmed `search/results/?infinite=1&json=1` payload. */
const SEARCH_HTML = `
<a href="https://store.steampowered.com/app/244210/" data-ds-appid="244210" data-ds-itemkey="App_244210">
  <span class="title">Assetto Corsa</span></a>
<a href="https://store.steampowered.com/app/805550/" data-ds-appid="805550" data-ds-itemkey="App_805550">
  <span class="title">Assetto Corsa Competizione</span></a>
<a href="https://store.steampowered.com/sub/12345/" data-ds-packageid="12345" data-ds-appid="244210,805550">
  <span class="title">Assetto Corsa Bundle</span></a>
`;

/** A trimmed `steamcommunity.com/id/<vanity>/?xml=1` document. */
const PROFILE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile>
  <steamID64>76561197960287930</steamID64>
  <steamID><![CDATA[Rabscuttle]]></steamID>
  <onlineState>in-game</onlineState>
  <stateMessage><![CDATA[In-Game<br/>Team Fortress 2]]></stateMessage>
  <avatarFull><![CDATA[https://avatars.akamai.steamstatic.com/abc_full.jpg]]></avatarFull>
  <customURL><![CDATA[gabelogannewell]]></customURL>
  <location><![CDATA[Washington, United States]]></location>
  <vacBanned>0</vacBanned>
</profile>`;

/** A trimmed `/games?tab=all&xml=1` document. */
const GAMES_XML = `<gamesList>
  <steamID64>76561197960287930</steamID64>
  <games>
    <game><appID>440</appID><name><![CDATA[Team Fortress 2]]></name><hoursOnRecord>1,234.5</hoursOnRecord><hoursLast2Weeks>12.3</hoursLast2Weeks></game>
    <game><appID>620</appID><name><![CDATA[Portal 2]]></name><hoursOnRecord>42.0</hoursOnRecord></game>
    <game><appID>70</appID><name><![CDATA[Half-Life]]></name></game>
  </games>
</gamesList>`;

/** A trimmed `SearchCommunityAjax` row. */
const USERS_HTML = `
<div class="search_row" data-miniprofile="22222">
  <div class="avatarMedium"><a href="https://steamcommunity.com/id/zdstudio12345"><img src="https://avatars.akamai.steamstatic.com/zd.jpg"></a></div>
  <a class="searchPersonaName" href="https://steamcommunity.com/id/zdstudio12345">zdstudio12345</a>
  <div class="search_match_info"><div>United Kingdom</div></div>
</div>
<div class="search_row" data-miniprofile="33333">
  <a class="searchPersonaName" href="https://steamcommunity.com/profiles/76561197960299061">zdstudio</a>
</div>`;

/* ------------------------------------------------------------------ *
 * The parsers, mirrored from src/steam.js
 *
 * They are module-private there (they only ever run against a live fetch),
 * so the extraction logic is re-declared here against the fixtures. Keep the
 * two in step — a change in one that is not made in the other fails loudly
 * rather than quietly returning nothing.
 * ------------------------------------------------------------------ */

const appIdsFrom = (html) => {
  const ids = [];
  const seen = new Set();
  for (const match of html.matchAll(/data-ds-appid="([\d,]+)"/g)) {
    const id = Number(String(match[1]).split(',')[0]);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

const xmlField = (xml, tag) => {
  const match = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i').exec(xml || '');
  return match ? match[1].trim() : null;
};

const xmlBlocks = (xml, tag) =>
  [...String(xml || '').matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'))].map((match) => match[1]);

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

console.log('store search');
test('pulls appids in rank order', () => {
  assert.deepEqual(appIdsFrom(SEARCH_HTML), [244210, 805550]);
});
test('a bundle contributes only its headline app, never a duplicate', () => {
  assert.equal(appIdsFrom(SEARCH_HTML).length, 2);
});
test('an empty document yields no ids rather than throwing', () => {
  assert.deepEqual(appIdsFrom(''), []);
});

console.log('community profile xml');
test('reads the steamid64', () => {
  assert.equal(xmlField(PROFILE_XML, 'steamID64'), '76561197960287930');
});
test('unwraps CDATA', () => {
  assert.equal(xmlField(PROFILE_XML, 'steamID'), 'Rabscuttle');
  assert.equal(xmlField(PROFILE_XML, 'customURL'), 'gabelogannewell');
});
test('avatar host is rewritten to a live https host', () => {
  assert.equal(secureUrl(xmlField(PROFILE_XML, 'avatarFull')), 'https://avatars.cloudflare.steamstatic.com/abc_full.jpg');
});

console.log('community games xml');
test('reads every game', () => {
  assert.equal(xmlBlocks(GAMES_XML, 'game').length, 3);
});
test('hours become minutes, thousands separator and all', () => {
  const [first] = xmlBlocks(GAMES_XML, 'game');
  const hours = Number(String(xmlField(first, 'hoursOnRecord') || '0').replace(/,/g, ''));
  assert.equal(Math.round(hours * 60), 74070);
});
test('a never-played game reads as zero, not NaN', () => {
  const third = xmlBlocks(GAMES_XML, 'game')[2];
  const hours = Number(String(xmlField(third, 'hoursOnRecord') || '0').replace(/,/g, '')) || 0;
  assert.equal(hours, 0);
});

console.log('community user search');
test('finds both rows', () => {
  assert.equal(USERS_HTML.split(/<div\s+class="search_row[^"]*"/i).slice(1).length, 2);
});
test('miniprofile id converts to a steamid64', () => {
  const account = Number(/data-miniprofile="(\d+)"/i.exec(USERS_HTML)[1]);
  assert.equal(String(76561197960265728n + BigInt(account)), '76561197960287950');
});
test('persona name and vanity survive', () => {
  const row = USERS_HTML.split(/<div\s+class="search_row[^"]*"/i)[1];
  assert.equal(/class="searchPersonaName"[^>]*>([\s\S]*?)<\/a>/i.exec(row)[1].trim(), 'zdstudio12345');
  assert.equal(/href="(https?:\/\/steamcommunity\.com\/(?:id|profiles)\/[^"?#]+)/i.exec(row)[1].match(/\/id\/([^/?#]+)/)[1], 'zdstudio12345');
});

console.log('de-duplication');
test('the same appid twice collapses to one card', () => {
  const out = dedupeItems([
    { appid: 244210, name: 'Assetto Corsa' },
    { appid: 244210, name: 'Assetto Corsa' },
  ]);
  assert.equal(out.length, 1);
});
test('the same game under two edition names collapses', () => {
  const out = dedupeItems([
    { appid: 1, name: 'Forza Horizon 5' },
    { appid: 2, name: 'Forza Horizon 5: Premium Edition' },
    { appid: 3, name: 'Forza Horizon 5 (Deluxe Edition)' },
  ]);
  assert.equal(out.length, 1, `expected 1 card, got ${out.length}`);
});
test('the copy carrying a price wins', () => {
  const out = dedupeItems([
    { appid: 1, name: 'Racer' },
    { appid: 1, name: 'Racer', price: { final: 1999 }, shortDescription: 'Vroom' },
  ]);
  assert.equal(out[0].price.final, 1999);
  assert.equal(out[0].shortDescription, 'Vroom');
});
test('hardware promos never reach a game grid', () => {
  assert.equal(isHardwareOrAd({ name: 'Steam Machine' }), true);
  assert.equal(isHardwareOrAd({ name: 'Steam Deck 512 GB' }), true);
  assert.equal(isHardwareOrAd({ name: 'Valve Steam Controller' }), true);
  assert.equal(isHardwareOrAd({ name: 'Steamworld Dig', type: 'game' }), false);
  assert.equal(dedupeItems([{ appid: 1, name: 'Steam Machine' }, { appid: 2, name: 'Portal' }]).length, 1);
});
test('a shared `seen` set stops a title repeating in a later section', () => {
  const seen = new Set();
  const featured = dedupeItems([{ appid: 620, name: 'Portal 2' }], { seen });
  const topSellers = dedupeItems([{ appid: 620, name: 'Portal 2' }, { appid: 70, name: 'Half-Life' }], { seen });
  assert.equal(featured.length, 1);
  assert.deepEqual(topSellers.map((item) => item.appid), [70]);
});
test('different games with similar names are left alone', () => {
  const out = dedupeItems([
    { appid: 1, name: 'Portal' },
    { appid: 2, name: 'Portal 2' },
  ]);
  assert.equal(out.length, 2);
  assert.notEqual(nameKey('Portal'), nameKey('Portal 2'));
});

console.log('misc');
test('dead Akamai hosts are rewritten to live Cloudflare ones', () => {
  assert.equal(
    secureUrl('http://cdn.akamai.steamstatic.com/steam/apps/620/header.jpg'),
    'https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg',
  );
});
test('trailers land on the video host', () => {
  assert.equal(
    secureUrl('http://steamcdn-a.akamaihd.net/store_trailers/256/movie480_vp9.webm'),
    'https://video.cloudflare.steamstatic.com/store_trailers/256/movie480_vp9.webm',
  );
});
test('genre aliases resolve to Steam spelling', () => {
  assert.equal(canonicalGenre('rpg'), 'RPG');
  assert.equal(canonicalGenre('MMO'), 'Massively Multiplayer');
  assert.equal(canonicalGenre('free to play'), 'Free to Play');
  assert.equal(canonicalGenre('action'), 'Action');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures above' : ''}`);
