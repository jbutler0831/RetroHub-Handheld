// One game at a time, with a stand-in emulator (a script that runs 3 seconds) set as Dolphin.
// Not on Windows, where an emulator has to be a .exe program.
const fs = require('fs');
const path = require('path');

const startsIn = (dataDir) => {
  const log = path.join(dataDir, 'emulator.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
};

module.exports = {
  platforms: ['darwin', 'linux'],
  skipReason: 'the stand-in emulator is a shell script; the unit tests cover starting and ending a process here',
  settings(dataDir) {
    const emulator = path.join(dataDir, 'emulator.sh');
    fs.writeFileSync(emulator, `#!/bin/sh\necho "start $*" >> "${path.join(dataDir, 'emulator.log')}"\nsleep 3\n`, { mode: 0o755 });
    return { emulatorPaths: { dolphin: emulator } };
  },
  async run({ evaluate, key, check, log, shot, click, wait }, dataDir) {
    log('- play');
    await click('[data-key="sys:gamecube"]');
    await wait(400);
    await evaluate(`document.getElementById('content').focus()`);
    await key('Enter');
    await wait(600);
    check(startsIn(dataDir) === 1, `Return starts the game once: ${startsIn(dataDir)} start(s)`);
    const starting = () => evaluate(`!document.getElementById('launching').hidden && document.getElementById('launching-title').textContent`);
    check(await starting() === 'Starting Test Disc…', `it says it's starting the game: ${await starting()}`);
    log('- pressed again while it starts');
    await key('Enter');
    await wait(600);
    check(startsIn(dataDir) === 1, `a second press starts nothing: ${startsIn(dataDir)} start(s)`);
    check(await evaluate(`document.getElementById('modal').hidden`), 'and shows no message');
    await shot('starting');
    await key('Escape');
    check(await starting() === false, 'Esc hides "Starting…"');
    log('- play again while it runs');
    await key('Enter');
    await wait(600);
    const message = await evaluate(`!document.getElementById('modal').hidden && document.getElementById('modal-message').textContent`);
    check(message === 'Dolphin is still running Test Disc. Close it to start another game.', `RetroHub explains instead: ${message}`);
    check(startsIn(dataDir) === 1, `and starts no second copy: ${startsIn(dataDir)} start(s)`);
    await shot('still running');
    await key('Enter');
    log('- two Play requests at the same moment');
    await wait(3500); // the game closes
    const replies = await evaluate(`Promise.all([window.retrohub.play(selectedGame[selection]), window.retrohub.play(selectedGame[selection])])`);
    await wait(600);
    // The second is turned away as busy (the first is still starting) or as still running (it just started).
    const turnedAway = replies[1].busy || /still running/.test(replies[1].error || '');
    check(startsIn(dataDir) === 2 && replies[0].ok && turnedAway, `one starts the game, the other is turned away: ${startsIn(dataDir) - 1} start(s), ${JSON.stringify(replies)}`);
    log('- after the game closes');
    await wait(3500);
    await key('Enter');
    await wait(600);
    await key('Escape');
    check(startsIn(dataDir) === 3, `the next Play starts it again: ${startsIn(dataDir)} start(s)`);
    check(await evaluate(`document.querySelector('[data-key="recent"] .badge')?.textContent.trim()`) === '1', 'and it is in Recently Played');
  },
};
