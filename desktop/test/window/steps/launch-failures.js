// When a game can't start: an emulator that closes with an error straight away (a stand-in script
// that prints a BIOS complaint and exits 1), and a game file that's gone since the last scan. Each
// is explained in a message, and neither counts as played. Not on Windows, where an emulator has
// to be a .exe program.
const fs = require('fs');
const path = require('path');

module.exports = {
  platforms: ['darwin', 'linux'],
  skipReason: 'the stand-in emulator is a shell script; the unit tests cover the messages here',
  settings(dataDir) {
    const emulator = path.join(dataDir, 'failing emulator.sh');
    fs.writeFileSync(emulator, '#!/bin/sh\necho "Loading $1"\necho "Missing BIOS: scph5501.bin" >&2\nexit 1\n', { mode: 0o755 });
    return { emulatorPaths: { dolphin: emulator } };
  },
  async run({ evaluate, key, check, log, shot, click, wait }, dataDir) {
    const message = () => evaluate(`!document.getElementById('modal').hidden && document.getElementById('modal-message').textContent`);
    const recent = () => evaluate(`document.querySelector('[data-key="recent"] .badge')?.textContent.trim() || '0'`);

    log('- the emulator closes with an error at once');
    await click('[data-key="sys:gamecube"]');
    await wait(400);
    await evaluate(`document.getElementById('content').focus()`);
    await key('Enter');
    await wait(1200);
    const said = await message();
    check(typeof said === 'string' && said.startsWith('Dolphin closed with error code 1 right after starting Test Disc.'), `RetroHub says it failed: ${JSON.stringify(said)}`);
    check(typeof said === 'string' && said.includes('It said: Loading') && said.includes('Missing BIOS: scph5501.bin'), 'with what the emulator printed');
    check(await evaluate(`document.getElementById('launching').hidden`), '"Starting…" is gone');
    check(await recent() === '0', `it doesn't count as played: ${await recent()} in Recently Played`);
    await shot('emulator failed');
    await key('Escape');
    check(await message() === false, 'Esc closes the message');

    log('- the game file is gone');
    fs.rmSync(path.join(dataDir, 'Games/GameCube/Test Disc.iso'));
    await evaluate(`document.getElementById('content').focus()`);
    await key('Enter');
    await wait(800);
    const gone = await message();
    check(typeof gone === 'string' && gone.startsWith("Test Disc isn't where RetroHub found it (Test Disc.iso)."), `RetroHub says where it looked: ${JSON.stringify(gone)}`);
    check(await recent() === '0', 'and it still doesn\'t count as played');
    await shot('file gone');
  },
};
