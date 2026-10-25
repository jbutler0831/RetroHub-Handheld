// Finds games in the library folder. Mirrors mac/Sources/RetroHub/Library.swift.
// Scanning reads the disk without blocking, so the window keeps answering the controller while a
// large library on an SD card or external drive is read.
const fs = require('fs');
const path = require('path');
const { SYSTEMS } = require('./systems');

/** Removes tags like "(USA)" or "[!]": "Contra (USA) [!]" → "Contra". */
function stripTags(title) {
  return title.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
}

/** Clean title for display; also turns "Legend of Zelda, The" back into "The Legend of Zelda". */
function displayTitle(title) {
  let name = stripTags(title);
  const article = name.match(/, (The|A|An)$/);
  if (article) name = `${article[1]} ${name.slice(0, -article[0].length)}`;
  return name || title;
}

function exists(file) {
  try { return fs.statSync(file) && true; } catch { return false; }
}

async function existsAsync(file) {
  try { return !!(await fs.promises.stat(file)); } catch { return false; }
}

/** The first of these files that exists, or undefined. */
async function firstExisting(files) {
  for (const file of files) if (await existsAsync(file)) return file;
  return undefined;
}

/** A folder's entries without hidden files; an unreadable or missing folder is empty. */
async function listDir(dir) {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  } catch {
    return [];
  }
}

function makeGame(system, title, bootPath, localCovers) {
  return { id: bootPath, system: system.id, title, displayTitle: displayTitle(title), bootPath, localCovers };
}

async function scanFiles(system, dir) {
  const games = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      games.push(...(await scanFiles(system, full)));
    } else if (system.exts.includes(path.extname(entry.name).slice(1).toLowerCase())) {
      const base = full.slice(0, -path.extname(full).length);
      games.push(makeGame(system, path.basename(base), full, ['png', 'jpg', 'jpeg'].map((ext) => `${base}.${ext}`)));
    }
  }
  return games;
}

/** Disc dumps keep EBOOT.BIN under PS3_GAME/USRDIR; PSN games keep it under USRDIR. */
async function scanPS3(system, dir) {
  const games = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory()) continue;
    const gameDir = path.join(dir, entry.name);
    const eboot = await firstExisting(['PS3_GAME/USRDIR/EBOOT.BIN', 'USRDIR/EBOOT.BIN'].map((p) => path.join(gameDir, p)));
    if (!eboot) continue;
    let title = null;
    for (const p of ['PS3_GAME/PARAM.SFO', 'PARAM.SFO']) title ||= await sfoTitle(path.join(gameDir, p));
    const covers = ['cover.png', 'cover.jpg', 'PS3_GAME/ICON0.PNG', 'ICON0.PNG'].map((p) => path.join(gameDir, p));
    games.push(makeGame(system, title || entry.name, eboot, covers));
  }
  return games;
}

/** PS4 game dumps keep eboot.bin at the top of the folder and their details under sce_sys. */
async function scanPS4(system, dir) {
  const games = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory()) continue;
    const gameDir = path.join(dir, entry.name);
    const eboot = path.join(gameDir, 'eboot.bin');
    if (!(await existsAsync(eboot))) continue;
    const title = (await sfoTitle(path.join(gameDir, 'sce_sys/param.sfo'))) || entry.name;
    const covers = ['cover.png', 'cover.jpg', 'sce_sys/icon0.png'].map((p) => path.join(gameDir, p));
    games.push(makeGame(system, title, eboot, covers));
  }
  return games;
}

/** Where Vita3K keeps installed games (its default storage location), one folder per title ID. */
function vita3kAppsDir() {
  const home = require('os').homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Vita3K/Vita3K/ux0/app');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), 'Vita3K/Vita3K/ux0/app');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'Vita3K/Vita3K/ux0/app');
}

/** A system's games folder. PS Vita games live in Vita3K rather than the library. */
function systemDir(root, system) {
  return system.id === 'vita' ? vita3kAppsDir() : path.join(root, system.folder);
}

/** Games installed in Vita3K: one folder per title ID, with details under sce_sys. */
async function scanVita(system, dir) {
  const games = [];
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory()) continue;
    const gameDir = path.join(dir, entry.name);
    const sfo = path.join(gameDir, 'sce_sys/param.sfo');
    if (!(await existsAsync(sfo))) continue;
    games.push(makeGame(system, (await sfoTitle(sfo)) || entry.name, gameDir, [path.join(gameDir, 'sce_sys/icon0.png')]));
  }
  return games;
}

/** Reads the TITLE entry from a PS3, PS4 or PS Vita PARAM.SFO file (little-endian key/value table). */
async function sfoTitle(file) {
  let data;
  try { data = await fs.promises.readFile(file); } catch { return null; }
  return sfoTitleFrom(data);
}

function sfoTitleFrom(data) {
  if (data.length < 20 || data.readUInt32BE(0) !== 0x00505346) return null;
  const keyTable = data.readUInt32LE(8), dataTable = data.readUInt32LE(12), count = data.readUInt32LE(16);
  for (let i = 0; i < count; i++) {
    const entry = 20 + i * 16;
    if (entry + 16 > data.length) return null;
    const keyStart = keyTable + data.readUInt16LE(entry);
    const keyEnd = keyStart < data.length ? data.indexOf(0, keyStart) : -1;
    if (keyEnd < 0) return null;
    if (data.toString('utf8', keyStart, keyEnd) !== 'TITLE') continue;
    const length = data.readUInt32LE(entry + 4), start = dataTable + data.readUInt32LE(entry + 12);
    if (start + length > data.length) return null;
    const title = data.toString('utf8', start, start + length).replace(/\n/g, ' ').replace(/[\x00-\x1f]/g, '').trim();
    return title || null;
  }
  return null;
}

/** Creates a folder per system under root and resolves with { systemId: [game] }. */
async function scanLibrary(root) {
  const result = {};
  for (const system of SYSTEMS) {
    const dir = systemDir(root, system);
    if (system.id !== 'vita') {
      try { await fs.promises.mkdir(dir, { recursive: true }); } catch { /* read-only or unplugged drive: just scan */ }
    }
    const scan = { ps3: scanPS3, ps4: scanPS4, vita: scanVita }[system.id] || scanFiles;
    const games = await scan(system, dir);
    result[system.id] = games.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  }
  return result;
}

module.exports = { scanLibrary, systemDir, stripTags, sfoTitle, sfoTitleFrom, exists };
