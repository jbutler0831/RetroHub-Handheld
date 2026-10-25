// Finding games: odd file names, nested folders, a missing or unreadable games folder, and a large
// library read without holding up everything else (on a handheld, the controller and the window).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanLibrary } = require('../src/library');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'retrohub-library-'));
const write = (root, file) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), file);
};

test('games are found in nested folders, whatever their names, without hidden files or other types', async () => {
  const root = path.join(folder(), 'My Games (SD card) & more');
  const names = [`NES/Tom's Game & Friends (USA) [!].nes`, 'NES/日本語のゲーム.nes', 'NES/Sub folder/Deep/Nested.NES', 'NES/.hidden.nes', 'NES/readme.txt'];
  for (const name of names) write(root, name);
  const games = await scanLibrary(root);
  assert.deepStrictEqual(games.nes.map((g) => path.relative(root, g.bootPath).split(path.sep).join('/')).sort(),
    ['NES/Sub folder/Deep/Nested.NES', `NES/Tom's Game & Friends (USA) [!].nes`, 'NES/日本語のゲーム.nes'].sort());
  assert.strictEqual(games.nes.find((g) => g.title.startsWith('Tom')).displayTitle, "Tom's Game & Friends");
});

test('a games folder that is missing is created, with a folder per system', async () => {
  const root = path.join(folder(), 'Games');
  const games = await scanLibrary(root);
  assert.ok(fs.existsSync(path.join(root, 'NES')) && fs.existsSync(path.join(root, 'PS2')));
  assert.deepStrictEqual(games.nes, []);
});

test('a games folder that can\'t be read or created (an unplugged drive) is empty, not an error', async () => {
  const blocker = path.join(folder(), 'not a folder');
  fs.writeFileSync(blocker, '');
  const games = await scanLibrary(path.join(blocker, 'Games'));
  assert.ok(Object.values(games).every((list) => Array.isArray(list) && list.length === 0));
});

test('a large library is read without blocking: other work keeps running during the scan', async () => {
  const root = folder();
  const systems = ['NES', 'SNES', 'GB', 'GBA', 'Genesis', 'N64'];
  const exts = { NES: 'nes', SNES: 'sfc', GB: 'gb', GBA: 'gba', Genesis: 'md', N64: 'z64' };
  for (const system of systems) {
    fs.mkdirSync(path.join(root, system));
    for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(root, system, `Game ${i} (USA).${exts[system]}`), '');
  }
  let ticks = 0;
  let longestGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
    ticks++;
  }, 5);
  const started = Date.now();
  const games = await scanLibrary(root);
  clearInterval(timer);
  const total = Object.values(games).reduce((n, list) => n + list.length, 0);
  assert.strictEqual(total, 6000);
  assert.ok(ticks > 0, 'other work ran during the scan');
  // Sorting each system's list is the longest stretch of work that doesn't wait for the disk.
  assert.ok(longestGap < 250, `nothing else waited more than ${longestGap} ms (scan took ${Date.now() - started} ms)`);
});
