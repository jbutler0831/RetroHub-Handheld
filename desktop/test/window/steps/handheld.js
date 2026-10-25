// The handheld layout (Setup › Appearance › Layout › Handheld) on a Steam Deck-sized screen,
// 1280×800, and held upright, 800×1280: drawn 25% larger, nothing cut off or scrolling sideways,
// buttons big enough for a thumb, and tap to pick a game, tap again to play. The screen and touch
// are EMULATED through Chromium's DevTools protocol, not a real handheld.
const fs = require('fs');
const path = require('path');

const SIZES = [[1280, 800, 'landscape'], [800, 1280, 'portrait']];
/** The smallest a button may be, in screen pixels: about the size of a fingertip at 7–8". */
const MIN_TARGET = 40;

/** Elements that stick out of the window, leaving out what scrolls by design (as in small-screens). */
const overflow = (root) => `[...document.querySelectorAll(${JSON.stringify(root)} + ' *')]
  .filter((el) => !el.closest('.carousel, .couch-backdrop, .tabs, #nav, #content') && el.getClientRects().length)
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1); })
  .map((el) => (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : el.tagName.toLowerCase()) + (el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 20) + '"' : ''))
  .slice(0, 6)`;

/** Buttons shorter than MIN_TARGET screen pixels (CSS pixels × the zoom). */
const small = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.getClientRects().length)
  .filter((el) => el.getBoundingClientRect().height * 1.25 < ${MIN_TARGET} - 0.5)
  .map((el) => el.textContent.trim().slice(0, 20) + ' ' + Math.round(el.getBoundingClientRect().height * 1.25) + 'px').slice(0, 6)`;

module.exports = {
  settings() {
    return { layout: 'handheld' };
  },
  async run({ evaluate, check, log, shot, click, wait, send, key }, dataDir) {
    for (const [width, height, name] of SIZES) {
      log(`- ${width}×${height} (${name})`);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await click('[data-key="sys:nes"]');
      await wait(500);
      check(await evaluate(`document.documentElement.classList.contains('handheld')`), 'the handheld layout is on');
      const cssWidth = await evaluate('innerWidth');
      check(Math.abs(cssWidth - width / 1.25) <= 1, `and drawn 25% larger: ${width} screen pixels hold ${cssWidth} of the page's`);
      const browser = await evaluate(overflow('#app'));
      const sideways = await evaluate(`document.documentElement.scrollWidth > innerWidth || document.getElementById('app').scrollWidth > innerWidth`);
      check(!sideways && browser.length === 0, `the games fit: ${browser.length ? browser.join(', ') : 'nothing cut off'}`);
      const tinySidebar = await evaluate(small('.nav-item, .icon-button, .search'));
      check(tinySidebar.length === 0, `sidebar and toolbar buttons are at least ${MIN_TARGET} px tall: ${tinySidebar.join(', ') || 'all are'}`);
      await shot(`games ${name}`);

      await evaluate(`document.getElementById('content').focus(); void gameMenu(selectedGame[selection])`);
      await wait(300);
      const box = await evaluate(`(() => { const r = document.querySelector('.modal-box').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
      check(box, 'a dialog is fully on screen');
      const tinyDialog = await evaluate(small('.modal-box .button'));
      check(tinyDialog.length === 0, `with buttons at least ${MIN_TARGET} px tall: ${tinyDialog.join(', ') || 'all are'}`);
      await key('Escape');

      await click('[data-key="setup"]');
      await wait(500);
      const setup = await evaluate(overflow('#app'));
      const setupSideways = await evaluate(`document.getElementById('content').scrollWidth > document.getElementById('content').clientWidth + 1`);
      check(!setupSideways && setup.length === 0, `Setup fits without scrolling sideways: ${setup.join(', ') || 'nothing cut off'}`);
      const tinySetup = await evaluate(small('#content .button, #content .segmented button'));
      check(tinySetup.length === 0, `Setup's buttons are at least ${MIN_TARGET} px tall: ${tinySetup.join(', ') || 'all are'}`);
      await shot(`setup ${name}`);

      await click('#couch-button');
      await wait(1200);
      const couch = await evaluate(overflow('#couch'));
      check(couch.length === 0, `couch mode fits: ${couch.join(', ') || 'nothing cut off'}`);
      await shot(`couch ${name}`);
      await click('[data-exit]');
      await wait(1200);
    }

    log('- touch');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // Two GameCube games for this, so the first tap has to change the pick.
    fs.copyFileSync(path.join(dataDir, 'Games/GameCube/Test Disc.iso'), path.join(dataDir, 'Games/GameCube/Another Disc.iso'));
    await evaluate(`window.retrohub.rescan().then((s) => applyState(s, true))`);
    await click('[data-key="sys:gamecube"]');
    await wait(500);
    const tap = async (selector) => {
      const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(400);
    };
    const second = '.card:nth-child(2) .card-title';
    await tap(second);
    check(await evaluate(`document.querySelector('.card:nth-child(2)').classList.contains('selected')`)
      && await evaluate(`document.getElementById('modal').hidden && document.getElementById('launching').hidden`), 'a tap picks the game, and starts nothing');
    const playVisible = await evaluate(`getComputedStyle(document.querySelector('.card.selected .play-button')).opacity`);
    check(Number(playVisible) === 1, `its Play button shows without hovering: opacity ${playVisible}`);
    const ready = await evaluate(`S.systems.find((s) => s.id === 'gamecube').readiness.ready`);
    if (ready) {
      log('  (GameCube can play here: not tapping again, which would start a real emulator)');
    } else {
      await tap(second);
      check(await evaluate(`!document.getElementById('modal').hidden`), 'a second tap plays it (here: explains the setup needed)');
      await tap('#modal-actions .button');
      check(await evaluate(`document.getElementById('modal').hidden`), 'and a tap on OK closes the message');
    }
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.clearDeviceMetricsOverride');
  },
};
