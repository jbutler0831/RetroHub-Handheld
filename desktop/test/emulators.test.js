// Mirrors the "game process" checks in mac/Sources/RetroHub/SelfTests.swift: RetroHub learns when
// the emulator's process ends, with its exit status, also when it fails straight away.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startProcess, startProblem, lastOutput, launch, retroArchWindowArgs } = require('../src/emulators');
const graphics = require('../src/graphics');

// Emulators are started detached and unreferenced, so they don't hold RetroHub open. In the app,
// Electron keeps running and hears the exit; here a timer keeps Node running until it does.
const exitOf = (child) => new Promise((resolve) => {
  const keepAlive = setInterval(() => {}, 1000);
  child.once('exit', (code) => {
    clearInterval(keepAlive);
    resolve(code);
  });
});

test('a running emulator is reported, then its end with its exit status', async () => {
  const child = await startProcess(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 300)']);
  assert.strictEqual(child.exitCode, null, 'running after it starts');
  assert.strictEqual(await exitOf(child), 0);
});

test('an emulator that fails straight away still reports its end', async () => {
  const child = await startProcess(process.execPath, ['-e', 'process.exit(3)']);
  assert.strictEqual(child.exitCode === null ? await exitOf(child) : child.exitCode, 3);
});

test('a missing emulator is an error, not a silent failure', async () => {
  await assert.rejects(startProcess('/nonexistent/emulator', []));
});

test('RetroArch games start full screen unless turned off', () => {
  assert.strictEqual(graphics.DEFAULTS.fullscreen, true, 'on by default');
  assert.deepStrictEqual(retroArchWindowArgs(true), ['-f']);
  assert.deepStrictEqual(retroArchWindowArgs(false), [], 'or in a window, as RetroArch is set');
});

test('what an emulator prints goes to the game log, and its last lines can be shown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrohub-log-'));
  const log = path.join(dir, 'logs/last-game.log');
  const child = await startProcess(process.execPath, ['-e', 'console.log("Loading game"); console.error("\\x1b[31mMissing BIOS: scph5501.bin\\x1b[0m"); process.exit(1)'], { log });
  assert.strictEqual(child.exitCode === null ? await exitOf(child) : child.exitCode, 1);
  assert.strictEqual(lastOutput(log), 'Loading game\nMissing BIOS: scph5501.bin', 'colour codes removed');
  assert.strictEqual(lastOutput(path.join(dir, 'none.log')), '', 'no log, nothing to show');
  fs.writeFileSync(log, `${'x'.repeat(1000)}\n`);
  assert.ok(lastOutput(log).length <= 300, 'a long line is cut short');
});

test('a game file with spaces, quotes and shell characters reaches the emulator as one argument, and runs nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrohub-args-'));
  // Windows doesn't allow " in file names.
  const game = path.join(dir, `Tom's ${process.platform === 'win32' ? '' : '"Game" '}$(touch pwned) & more; %PATH% (USA).nes`);
  const out = path.join(dir, 'args.json');
  const child = await startProcess(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1)))`, game]);
  if (child.exitCode === null) await exitOf(child);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [game]);
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'pwned')) && !fs.existsSync(path.join(dir, 'pwned')));
});

test('start errors are explained in words', () => {
  assert.match(startProblem({ code: 'ENOENT', message: 'spawn ENOENT' }, '/opt/emu/retroarch'), /retroarch wasn't found.*Locate…/);
  assert.match(startProblem({ code: 'EACCES', message: 'spawn EACCES' }, '/home/deck/Cemu.AppImage'), /Cemu\.AppImage isn't allowed to run/);
  assert.match(startProblem({ code: 'EINVAL', message: 'spawn EINVAL' }, 'C:\\Emu\\start.bat'), /batch file.*\.exe/);
  assert.strictEqual(startProblem({ code: 'EOTHER', message: 'something else' }, '/x'), 'something else');
});

test('a game whose file is gone is explained before any emulator starts', async () => {
  const game = { system: 'nes', displayTitle: 'Contra', bootPath: path.join(os.tmpdir(), 'retrohub-gone', 'Contra (USA).nes') };
  await assert.rejects(launch(game, {}, graphics.DEFAULTS, {}), { message: "Contra isn't where RetroHub found it (Contra (USA).nes). If it's on a drive or SD card, connect it, then try again." });
});
