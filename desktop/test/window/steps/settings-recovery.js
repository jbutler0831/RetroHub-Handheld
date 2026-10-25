// A settings file cut off by a power cut or a crash (here: empty, with a good backup next to it):
// RetroHub goes back to the backup, says so once, keeps the damaged file, and loses no favorites.
const fs = require('fs');
const path = require('path');

const settingsDir = (dataDir) => path.join(dataDir, 'desktop');

module.exports = {
  settings(dataDir) {
    const favorite = path.join(dataDir, 'Games/NES/RetroHub Test Pattern.nes');
    fs.mkdirSync(settingsDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(settingsDir(dataDir), 'settings.json.bak'), JSON.stringify({ favorites: [favorite] }));
    fs.writeFileSync(path.join(settingsDir(dataDir), 'settings.json'), '');
    return null;
  },
  async run({ evaluate, check, log, shot, key, favorites, wait }, dataDir) {
    log('- opened with a damaged settings file');
    const title = await evaluate(`!document.getElementById('modal').hidden && document.getElementById('modal-title').textContent`);
    check(title === 'Settings restored', `RetroHub says it went back to the last good copy: ${JSON.stringify(title)}`);
    check(JSON.stringify(await favorites()) === '["RetroHub Test Pattern.nes"]', `the favorite is still there: ${await favorites()}`);
    const kept = fs.readdirSync(settingsDir(dataDir)).filter((f) => f.startsWith('settings.json.damaged-'));
    check(kept.length === 1, `the damaged file is kept: ${kept}`);
    await shot('settings restored');
    await key('Escape');
    await evaluate(`window.retrohub.toggleFavorite(S.games.nes[0].id)`); // a change, so settings.json is written again
    await wait(300);
  },
  async afterRelaunch({ evaluate, check, log, favorites }) {
    log('- after quitting and reopening');
    check(await evaluate(`document.getElementById('modal').hidden`), 'no message this time');
    check((await favorites()).length === 2, `both favorites are there: ${await favorites()}`);
  },
};
