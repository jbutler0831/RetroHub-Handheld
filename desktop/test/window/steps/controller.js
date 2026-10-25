// The controller, SIMULATED: a stand-in gamepad replaces navigator.getGamepads(), so this checks
// RetroHub's mapping, its one-action-per-press rule, held directions repeating and controller-only
// navigation of the whole window (sidebar, games, Setup, dialogs, couch mode) — not a real
// controller, its drivers, or Steam Input.
const BUTTON = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

module.exports = {
  async run({ evaluate, check, log, shot, click, title, focus, favorites, wait }) {
    await evaluate(`window.__pad = { index: 0, id: 'Simulated Controller (STANDARD GAMEPAD)', connected: true, mapping: 'standard',
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
      window.__pads = [window.__pad];
      navigator.getGamepads = () => window.__pads;`);
    // Held for several frames, as a real press is, then released.
    const press = async (button, hold = 150) => {
      await evaluate(`window.__pad.buttons[${button}].pressed = true`);
      await wait(hold);
      await evaluate(`window.__pad.buttons[${button}].pressed = false`);
      await wait(250);
    };
    const picked = () => evaluate(`selectedGame[selection]?.split(/[\\\\/]/).pop()`);
    const pickedIndex = () => evaluate(`visibleGames().findIndex((g) => g.id === selectedGame[selection])`);
    const dialogTitle = () => evaluate(`!document.getElementById('modal').hidden && document.getElementById('modal-title').textContent`);
    const focused = () => evaluate(`document.activeElement.textContent.trim()`);
    await wait(300);
    log('- connected (simulated)');
    check(await evaluate(`document.getElementById('controller-status').textContent.trim()`) === 'Simulated Controller', 'the sidebar shows its name');
    await click('[data-key="sys:nes"]');
    await wait(300);
    check(await focus() === 'sidebar', 'a click leaves focus in the sidebar');

    log('- from the sidebar into the games, and back');
    const first = await picked();
    await press(BUTTON.RIGHT);
    check(await focus() === 'games' && await picked() === first, '→ goes into the games, on the game picked before');
    await press(BUTTON.RIGHT, 400);
    check(await pickedIndex() === 1, 'a held → moves one game, once');
    await evaluate(`window.__pad.axes[0] = -1`);
    await wait(400);
    await evaluate(`window.__pad.axes[0] = 0`);
    await wait(250);
    check(await picked() === first, 'the stick held left moves back one game, once');
    await press(BUTTON.LEFT);
    check(await focus() === 'sidebar', '← past the first game goes to the sidebar');
    await press(BUTTON.A);
    check(await focus() === 'games', 'A goes back into the games');
    await press(BUTTON.B);
    check(await focus() === 'sidebar', 'B goes back to the sidebar');
    await press(BUTTON.A);

    log('- buttons');
    const before = (await favorites()).length;
    await press(BUTTON.Y);
    check((await favorites()).length === before + 1, 'Y toggles one favorite, once');
    await press(BUTTON.RB);
    check(await title() === 'Super Nintendo', `RB goes to the next system: ${await title()}`);
    await press(BUTTON.LB);
    check(await title() === 'NES', `LB comes back: ${await title()}`);

    log('- game options (X)');
    await press(BUTTON.X);
    check(await dialogTitle() === 'The Legend of Placeholder', `X opens the game's options: ${await dialogTitle()}`);
    check(await focused() === 'Play', 'with Play picked');
    await press(BUTTON.DOWN);
    check(await focused() === 'Remove from Favorites', `↓ moves to the next option: ${await focused()}`);
    await shot('game options');
    await press(BUTTON.B);
    check(await dialogTitle() === false && await focus() === 'games', 'B closes it, and focus is back on the games');
    await press(BUTTON.X);
    await press(BUTTON.DOWN);
    await press(BUTTON.A);
    check((await favorites()).length === before && await dialogTitle() === false, 'A on Remove from Favorites does it and closes');

    log('- held directions repeat');
    await press(BUTTON.B);
    await press(BUTTON.UP, 100);
    const row = await evaluate(`sidebarKeys().indexOf(selection)`);
    await press(BUTTON.DOWN, 1500);
    const moved = (await evaluate(`sidebarKeys().indexOf(selection)`)) - row;
    // Pressed, then repeating every 90 ms after half a second: about ten rows in 1.5 s.
    check(moved >= 5 && moved <= 14, `holding ↓ for 1.5 s moves down the sidebar steadily: ${moved} rows`);
    await click('[data-key="sys:nes"]');
    await wait(300);

    log('- couch mode, and Setup from it');
    await press(BUTTON.START);
    await wait(1200);
    check(!(await evaluate(`document.getElementById('couch').hidden`)), 'Start opens couch mode');
    await shot('couch mode');
    await press(BUTTON.SELECT);
    await wait(300);
    check(await title() === 'Setup' && await focus() === 'games' && await evaluate(`document.activeElement.matches('button')`),
      `Select opens Setup with a button picked: ${await focused()}`);
    const top = () => evaluate(`document.activeElement.getBoundingClientRect().top`);
    const start = await top();
    await press(BUTTON.DOWN);
    check(await top() > start, `↓ moves to a button further down: ${await focused()}`);
    await shot('setup by controller');
    await press(BUTTON.B);
    await wait(1200);
    check(!(await evaluate(`document.getElementById('couch').hidden`)), 'B goes back to couch mode');
    await press(BUTTON.B);
    await wait(1200);
    check(await evaluate(`document.getElementById('couch').hidden`), 'B leaves it');

    log('- a Setup button pressed with A');
    await click('[data-key="setup"]');
    await wait(300);
    await press(BUTTON.A);
    const appearance = () => evaluate(`S.appearance`);
    // Down to the Appearance buttons, then onto Dark, and A.
    for (let i = 0; i < 40 && !(await evaluate(`document.activeElement.dataset.appearance !== undefined`)); i++) await press(BUTTON.DOWN, 60);
    for (let i = 0; i < 3 && (await evaluate(`document.activeElement.dataset.appearance`)) !== 'dark'; i++) await press(BUTTON.RIGHT, 60);
    await press(BUTTON.A);
    check(await appearance() === 'dark', `the D-pad reaches Appearance › Dark and A chooses it: ${await appearance()}`);
    check(await evaluate(`document.activeElement.dataset.appearance`) === 'dark', 'and the button keeps focus after the page redraws');
    await press(BUTTON.LEFT);
    await press(BUTTON.LEFT);
    await press(BUTTON.A);
    await press(BUTTON.LEFT);
    check(await focus() === 'sidebar', '← from the first button in a row goes to the sidebar');

    log('- disconnecting and reconnecting');
    await evaluate(`window.__pads = []`);
    await wait(300);
    const toast = () => evaluate(`!document.getElementById('toast').hidden && document.getElementById('toast').textContent`);
    check(await toast() === 'Controller disconnected', `RetroHub says so: ${await toast()}`);
    check(await evaluate(`document.getElementById('controller-status').textContent.trim()`) === 'No controller', 'and the sidebar shows it');
    await evaluate(`window.__pads = [window.__pad]`);
    await wait(300);
    check(await toast() === 'Simulated Controller connected', `and when it's back: ${await toast()}`);
    await press(BUTTON.DOWN);
    check(await title() !== 'Setup', 'and it works straight away');

    log('- A on a system that needs setup');
    await click('[data-key="sys:ps1"]');
    await wait(300);
    const ready = await evaluate(`S.systems.find((s) => s.id === 'ps1').readiness.ready`);
    if (ready) {
      log('  (PlayStation can play here: not pressing A, which would start a real emulator)');
    } else {
      await press(BUTTON.A);
      await press(BUTTON.A);
      await wait(400);
      check(await dialogTitle() === "Couldn't start the game", 'A in the sidebar goes to the games, and A again explains what setup is needed');
      await press(BUTTON.B);
      check(await dialogTitle() === false, 'and B closes the message');
    }
  },
};
