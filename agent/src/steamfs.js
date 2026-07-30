/**
 * Reads the local Steam installation: where the libraries are, and which games
 * are actually installed.
 *
 * Steam stores this in its own key-value text format (VDF). The files involved
 * are small and flat, so a focused reader beats pulling in a dependency.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Candidate Steam roots per platform, most likely first. */
function steamRootCandidates() {
  const home = os.homedir();

  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const programFiles64 = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(programFiles, 'Steam'),
      path.join(programFiles64, 'Steam'),
      'C:\\Steam',
      'D:\\Steam',
      'D:\\SteamLibrary',
    ];
  }

  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Steam')];
  }

  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.steam', 'root'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
  ];
}

const exists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

export async function findSteamRoot(override) {
  const candidates = override ? [override, ...steamRootCandidates()] : steamRootCandidates();
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'steamapps'))) return candidate;
  }
  return null;
}

/**
 * Pull `"key" "value"` pairs out of a VDF document.
 * Nested blocks are flattened, which is all the callers here need.
 */
function parseVdfPairs(text) {
  const pairs = [];
  for (const match of text.matchAll(/"([^"]+)"\s+"([^"]*)"/g)) {
    pairs.push([match[1], match[2]]);
  }
  return pairs;
}

/** Every steamapps directory Steam knows about, including extra drives. */
export async function findLibraryFolders(steamRoot) {
  const primary = path.join(steamRoot, 'steamapps');
  const folders = new Set([primary]);

  for (const name of ['libraryfolders.vdf', 'config/libraryfolders.vdf']) {
    const file = path.join(steamRoot, name.includes('/') ? name.replace('/', path.sep) : path.join('steamapps', name));
    if (!(await exists(file))) continue;

    try {
      const text = await fs.readFile(file, 'utf8');
      for (const [key, value] of parseVdfPairs(text)) {
        // Modern Steam uses "path"; very old installs used numeric keys.
        if (key !== 'path' && !/^\d+$/.test(key)) continue;
        if (!value || !value.includes(path.sep === '\\' ? '\\' : '/')) continue;
        const resolved = path.join(value.replace(/\\\\/g, '\\'), 'steamapps');
        if (await exists(resolved)) folders.add(resolved);
      }
    } catch {
      // Unreadable library index: the primary folder still works.
    }
  }

  return [...folders];
}

/** Parse one `appmanifest_<appid>.acf` into an installed-game record. */
async function readManifest(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const fields = Object.fromEntries(parseVdfPairs(text));
    const appid = Number(fields.appid);
    if (!Number.isFinite(appid) || appid <= 0) return null;

    return {
      appid,
      name: fields.name || `App ${appid}`,
      installDir: fields.installdir || null,
      sizeOnDisk: Number(fields.SizeOnDisk) || 0,
      lastUpdated: Number(fields.LastUpdated) || null,
      lastPlayed: Number(fields.LastPlayed) || null,
      // StateFlags 4 = fully installed; anything else is mid-download.
      fullyInstalled: (Number(fields.StateFlags) & 4) === 4,
    };
  } catch {
    return null;
  }
}

/** Every installed game across every library folder. */
export async function listInstalledGames(steamRoot) {
  const folders = await findLibraryFolders(steamRoot);
  const games = new Map();

  for (const folder of folders) {
    let entries = [];
    try {
      entries = await fs.readdir(folder);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!/^appmanifest_\d+\.acf$/i.test(entry)) continue;
      const game = await readManifest(path.join(folder, entry));
      // Steamworks Common Redistributables etc. are not playable titles.
      if (!game || game.appid === 228980) continue;
      games.set(game.appid, { ...game, library: folder });
    }
  }

  return [...games.values()].sort((a, b) => a.name.localeCompare(b.name));
}
