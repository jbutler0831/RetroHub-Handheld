const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, screen, powerMonitor } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { SYSTEMS, MAKERS, EMULATORS } = require('./systems');
const { scanLibrary, systemDir } = require('./library');
const { availableEmulators, resolve, readiness, launch, lastOutput } = require('./emulators');
const { coverPath, knownMissing, lookAgain } = require('./covers');
const scanner = require('./scanner');
const graphicsOptions = require('./graphics');
const { readJSON, writeFileAtomic } = require('./store');

const RECENT_LIMIT = 24;
// `--console` starts full screen in couch mode, for devices that boot straight into RetroHub.
const consoleMode = process.argv.includes('--console');
// `--dev` (npm run dev) keeps its settings in .devdata/desktop and its games in .devdata/Games at
// the repository root, like the Mac app's RetroHub Dev, so a real library and settings are never
// touched. `--data-dir=<folder>` does the same in another folder (the window checks use a fresh one).
const dataDirArg = process.argv.find((arg) => arg.startsWith('--data-dir='));
const devData = dataDirArg ? path.resolve(dataDirArg.slice('--data-dir='.length))
  : process.argv.includes('--dev') ? path.join(__dirname, '../../.devdata') : null;
if (devData) app.setPath('userData', path.join(devData, 'desktop'));

// ---- Settings ---------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  libraryRoot: devData ? path.join(devData, 'Games') : path.join(os.homedir(), 'Games'),
  favorites: [],
  lastPlayed: {},
  emulatorPaths: {},
  graphics: { ...graphicsOptions.DEFAULTS },
  // 'system' (follow the OS), 'light' or 'dark': RetroHub's window only, never the OS setting.
  appearance: 'system',
  // 'auto' (handheld on a small touch screen), 'handheld' or 'standard'.
  layout: 'auto',
};
const APPEARANCES = ['system', 'light', 'dark'];
const LAYOUTS = ['auto', 'handheld', 'standard'];
/** The handheld layout draws everything this much larger. */
const HANDHELD_ZOOM = 1.25;

/**
 * Whether to use the handheld layout. Automatic: a touch screen of about 1280×800 at its scaling
 * (Steam Deck, ROG Ally at 150%, Legion Go at 200%), up to 1600×1000. A laptop with a touch
 * screen may match too; Setup › Appearance › Layout overrides it.
 */
function handheldLayout() {
  if (settings.layout === 'handheld') return true;
  if (settings.layout !== 'auto') return false;
  const display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const long = Math.max(display.size.width, display.size.height), short = Math.min(display.size.width, display.size.height);
  return display.touchSupport === 'available' && long >= 1000 && long <= 1600 && short <= 1000;
}

function applyLayout() {
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(handheldLayout() ? HANDHELD_ZOOM : 1);
}

/** Said once when the window opens, such as settings brought back from their backup: { title, message }. */
let startupNotice = null;

function loadSettings() {
  const { data: saved, recovered, setAside } = readJSON(settingsFile());
  if (saved) settings = { ...settings, ...saved, graphics: { ...graphicsOptions.DEFAULTS, ...saved.graphics } };
  const kept = setAside ? ` The damaged file was kept as ${path.basename(setAside)}.` : '';
  if (recovered === 'backup') {
    startupNotice = { title: 'Settings restored', message: `RetroHub's settings file was damaged, so it went back to the last good copy. A change made just before may be missing.${kept}` };
  } else if (recovered === 'reset') {
    startupNotice = { title: 'Settings reset', message: `RetroHub's settings file was damaged and there was no good copy to go back to, so it started with the default settings.${kept}` };
  }
}

function saveSettings() {
  writeFileAtomic(settingsFile(), JSON.stringify(settings, null, 2));
}

// ---- Library state ----------------------------------------------------------

let games = {};
const gamesById = new Map();
const coversDir = () => path.join(app.getPath('userData'), 'covers');

// What the Smart Game Scanner has seen (src/scanner.js): the index of games, and when the user last
// reviewed the changes in Library Check. Kept apart from settings.json, which stays small.
const libraryFile = () => path.join(app.getPath('userData'), 'library.json');
let library = { index: null, reviewedAt: 0 };

/** A damaged index goes back to its backup, or starts over as a first scan: the games are still on disk. */
function loadLibrary() {
  const { data, text } = readJSON(libraryFile());
  if (data) library = { ...library, ...data };
  savedLibrary = text;
}

let savedLibrary = '';

/** Saves the index; RetroHub rescans when its window comes forward, so only when it changed. */
function saveLibrary() {
  const json = JSON.stringify(library);
  if (json === savedLibrary) return;
  writeFileAtomic(libraryFile(), json);
  savedLibrary = json;
}

async function scanOnce() {
  const found = await scanLibrary(settings.libraryRoot);
  games = found;
  gamesById.clear();
  for (const list of Object.values(games)) for (const game of list) gamesById.set(game.id, game);
  const now = Date.now();
  // The first scan is the baseline: what's there already isn't news.
  if (!library.index) library.reviewedAt = now;
  library.index = scanner.updateIndex(library.index, games, { now });
  scanned = true;
  saveLibrary();
  fingerprintInBackground();
}

/** Whether the library has been scanned since RetroHub opened; until then the window says it's looking. */
let scanned = false;
let scanning = null;
let scanAgain = false;
let lastScanEnded = 0;
// Coming back to RetroHub rescans, so new and moved games show up, but not more often than this:
// switching windows back and forth shouldn't keep reading an SD card.
const FOCUS_RESCAN_MS = 15000;

/**
 * Scans the library without blocking the window. A rescan asked for while one runs (the games
 * folder just changed, say) runs once more when it ends; every caller waits for the scan it needs.
 */
function rescan() {
  if (scanning) {
    scanAgain = true;
    return scanning;
  }
  scanning = (async () => {
    try {
      do {
        scanAgain = false;
        await scanOnce();
      } while (scanAgain);
    } finally {
      scanning = null;
      lastScanEnded = Date.now();
    }
  })();
  return scanning;
}

let fingerprinting = false;

/** Fingerprints new and changed files after the scan, a file at a time, then redraws. */
async function fingerprintInBackground() {
  if (fingerprinting) return;
  fingerprinting = true;
  let found = 0;
  try {
    for (const file of scanner.needsFingerprint(library.index)) {
      const entry = library.index[file];
      try {
        const fp = await scanner.fingerprint(file);
        // Only if the file is still the one indexed: a rescan may have replaced the entry.
        if (library.index[file] === entry) {
          entry.fp = fp;
          found++;
        }
      } catch { /* unreadable: matched on size only */ }
    }
  } finally {
    fingerprinting = false;
  }
  if (found) {
    saveLibrary();
    sendState();
  }
}

/** Library Check: the scanner's summary, with what each change affects. */
function libraryCheck() {
  const summary = scanner.summarize(library.index || {}, library.reviewedAt);
  const carries = (file) => ({ favorite: settings.favorites.includes(file), lastPlayed: settings.lastPlayed[file] || null });
  const noArt = [...gamesById.values()].filter((g) => knownMissing(g, coversDir()))
    .map((g) => ({ id: g.id, system: g.system, title: g.displayTitle }));
  return {
    reviewedAt: library.reviewedAt,
    added: summary.added,
    renamed: summary.renamed.map((r) => ({ ...r, ...carries(r.from) })),
    missing: summary.missing.map((m) => ({ ...m, ...carries(m.path) })),
    duplicates: summary.duplicates,
    noArt,
    // What the banner counts: news since the last review. Games still missing from before (an
    // unplugged drive, say) stay listed in Library Check without bringing the banner back.
    news: { added: summary.added.length, renamed: summary.renamed.length,
            missing: summary.missing.filter((m) => m.since > library.reviewedAt).length },
  };
}

/** Moves a game's favorite and play history to its new path (a confirmed rename). */
function moveGameState(from, to) {
  if (settings.favorites.includes(from)) {
    settings.favorites = [...new Set(settings.favorites.map((f) => (f === from ? to : f)))];
  }
  if (settings.lastPlayed[from]) {
    settings.lastPlayed[to] = Math.max(settings.lastPlayed[to] || 0, settings.lastPlayed[from]);
    delete settings.lastPlayed[from];
  }
}

/** Forgets a missing game: its index entry, favorite and play history. */
function forgetGame(file) {
  delete library.index[file];
  settings.favorites = settings.favorites.filter((f) => f !== file);
  delete settings.lastPlayed[file];
}

const LIBRARY_ACTIONS = {
  applyRename: ({ from, to }) => {
    if (!library.index[from]?.missingSince || !library.index[to] || library.index[to].missingSince) return;
    moveGameState(from, to);
    delete library.index[from];
  },
  notRenamed: ({ from }) => {
    if (library.index[from]?.missingSince) library.index[from].notRenamed = true;
  },
  removeMissing: ({ paths }) => {
    for (const file of paths) if (library.index[file]?.missingSince) forgetGame(file);
  },
  markReviewed: () => { library.reviewedAt = Date.now(); },
  lookAgain: ({ ids }) => {
    for (const id of ids) if (gamesById.has(id)) lookAgain(gamesById.get(id), coversDir());
  },
};

/** Everything the window needs to draw itself. */
function state() {
  const emulators = availableEmulators();
  return {
    platform: process.platform,
    consoleMode,
    scanned,
    libraryRoot: settings.libraryRoot,
    makers: MAKERS,
    systems: SYSTEMS.map(({ backends, ...info }) => ({ ...info, readiness: readiness({ backends, ...info }, settings.emulatorPaths) })),
    emulators: emulators.map((e) => {
      const found = resolve(e, settings.emulatorPaths);
      const covers = SYSTEMS.filter((s) => s.backends.some((b) => (b.type === 'app' ? b.emulator : b.type) === e.id));
      return { id: e.id, name: e.name, color: e.color, installed: !!found, location: found?.display || null,
               covers: covers.map((s) => s.folder).join(', ') };
    }),
    games,
    favorites: settings.favorites,
    lastPlayed: settings.lastPlayed,
    recentLimit: RECENT_LIMIT,
    graphics: settings.graphics,
    appearance: settings.appearance,
    layout: settings.layout,
    handheld: handheldLayout(),
    libraryCheck: libraryCheck(),
    shadersMissing: graphicsOptions.shadersMissing(resolve(EMULATORS.find((e) => e.id === 'retroarch'), settings.emulatorPaths),
                                                   settings.graphics),
  };
}

let win;
/**
 * The game RetroHub started, from the moment Play is pressed until its emulator closes:
 * { game, label, process, startedAt, previousPlayed }. label and process are null while it starts.
 */
let session = null;
/** An emulator that closes with an error this soon after starting failed to start the game. */
const EARLY_EXIT_MS = 5000;
/** What the last game's emulator printed (overwritten by the next game). */
const gameLogFile = () => path.join(app.getPath('userData'), 'logs', 'last-game.log');

function sendState() {
  win?.webContents.send('state', state());
}

function bringForward() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

/**
 * RetroHub comes back to the front when the game is closed, as the Mac app does. An emulator that
 * closes with an error within a few seconds (a missing BIOS, a core that can't load the game)
 * didn't really start it: RetroHub says so, with the emulator's last words, and the game doesn't
 * count as played.
 */
function gameEnded(child, code, signal) {
  if (session?.process !== child) return;
  const ended = session;
  session = null;
  const failed = (code !== 0 || signal) && Date.now() - ended.startedAt < EARLY_EXIT_MS;
  if (failed) {
    if (ended.previousPlayed) settings.lastPlayed[ended.game.id] = ended.previousPlayed;
    else delete settings.lastPlayed[ended.game.id];
    saveSettings();
    sendState();
  }
  bringForward();
  if (failed) {
    const how = signal ? `stopped (${signal})` : `closed with error code ${code}`;
    const said = lastOutput(gameLogFile());
    win?.webContents.send('error', [
      `${ended.label} ${how} right after starting ${ended.game.displayTitle}.`,
      said ? `It said: ${said}` : null,
      'Check that the game file works in the emulator on its own, and that any BIOS or firmware it needs is installed.',
    ].filter(Boolean).join('\n\n'));
  }
}

async function play(id) {
  const game = gamesById.get(id);
  if (!game) return { error: 'That game is no longer in your library.' };
  // One game at a time: A pressed again while the emulator starts, or while it's open behind
  // RetroHub, mustn't start a second copy. The session starts before anything is awaited, so a
  // second press can't slip in while the first is still starting.
  if (session && !session.process) return { busy: true };
  if (session) return { error: `${session.label} is still running ${session.game.displayTitle}. Close it to start another game.` };
  session = { game, label: null, process: null, startedAt: Date.now(), previousPlayed: settings.lastPlayed[id] || null };
  try {
    // Console mode (a device that boots into RetroHub) always plays full screen.
    const fullscreen = consoleMode || settings.graphics.fullscreen !== false;
    const started = await launch(game, settings.emulatorPaths, settings.graphics, { fullscreen, log: gameLogFile() });
    settings.lastPlayed[id] = Date.now();
    saveSettings();
    if (started.process) {
      Object.assign(session, { label: started.label, process: started.process });
      // It may already have ended (an emulator that fails at once); 'exit' has fired by then.
      if (started.process.exitCode !== null || started.process.signalCode !== null) {
        gameEnded(started.process, started.process.exitCode, started.process.signalCode);
      } else {
        started.process.once('exit', (code, signal) => gameEnded(started.process, code, signal));
      }
    } else {
      session = null; // OpenEmu: macOS opens it, and it stays open as a library app after the game.
    }
    sendState();
    return { ok: true, label: started.label };
  } catch (error) {
    session = null;
    return { error: error.message };
  }
}

function toggleFavorite(id) {
  const set = new Set(settings.favorites);
  set.has(id) ? set.delete(id) : set.add(id);
  settings.favorites = [...set];
  saveSettings();
  sendState();
}

// ---- IPC --------------------------------------------------------------------

ipcMain.handle('state', () => state());
ipcMain.handle('takeNotice', () => {
  const notice = startupNotice;
  startupNotice = null;
  return notice;
});
ipcMain.handle('rescan', async () => { await rescan(); return state(); });
ipcMain.handle('play', (_, id) => play(id));
ipcMain.handle('toggleFavorite', (_, id) => toggleFavorite(id));
ipcMain.handle('libraryAction', (_, action, details = {}) => {
  const run = LIBRARY_ACTIONS[action];
  if (run) {
    run(details);
    saveSettings();
    saveLibrary();
  }
  return state();
});

ipcMain.handle('setGraphics', (_, changes) => {
  const next = { ...settings.graphics, ...changes };
  if (['off', 'crt', 'smooth'].includes(next.filter) && [1, 2, 3, 4].includes(next.scale)) {
    settings.graphics = { filter: next.filter, scale: next.scale, widescreen: !!next.widescreen, fullscreen: next.fullscreen !== false };
    saveSettings();
  }
  return state();
});

ipcMain.handle('setLayout', (_, layout) => {
  if (LAYOUTS.includes(layout)) {
    settings.layout = layout;
    saveSettings();
    applyLayout();
  }
  return state();
});

ipcMain.handle('setAppearance', (_, appearance) => {
  if (APPEARANCES.includes(appearance)) {
    settings.appearance = appearance;
    nativeTheme.themeSource = appearance;
    saveSettings();
  }
  return state();
});

ipcMain.handle('cover', async (_, id) => {
  const game = gamesById.get(id);
  const file = game && (await coverPath(game, coversDir()));
  return file ? pathToFileURL(file).href : null;
});

ipcMain.handle('chooseRoot', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose Games Folder',
    message: 'RetroHub will create a folder for each system inside it.',
    defaultPath: settings.libraryRoot,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) {
    settings.libraryRoot = result.filePaths[0];
    saveSettings();
    await rescan();
  }
  return state();
});

ipcMain.handle('locateEmulator', async (_, id) => {
  const emulator = EMULATORS.find((e) => e.id === id);
  if (!emulator) return state();
  const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [];
  const result = await dialog.showOpenDialog(win, {
    title: `Locate ${emulator.name}`,
    message: `Choose the ${emulator.name} program.`,
    properties: process.platform === 'darwin' ? ['openFile', 'treatPackageAsDirectory'] : ['openFile'],
    defaultPath: process.platform === 'darwin' ? '/Applications' : undefined,
    filters,
  });
  if (!result.canceled && result.filePaths[0]) {
    settings.emulatorPaths[id] = result.filePaths[0];
    saveSettings();
  }
  return state();
});

ipcMain.handle('openDownload', (_, id) => {
  const emulator = EMULATORS.find((e) => e.id === id);
  if (emulator) shell.openExternal(emulator.url);
});

ipcMain.handle('openFolder', (_, systemId) => {
  const system = SYSTEMS.find((s) => s.id === systemId);
  shell.openPath(system ? systemDir(settings.libraryRoot, system) : settings.libraryRoot);
});

// Only files RetroHub knows about, such as the copies Library Check lists as duplicates.
ipcMain.handle('showFile', (_, file) => {
  if (library.index?.[file] && !library.index[file].missingSince) shell.showItemInFolder(file);
});

ipcMain.handle('setFullScreen', (_, on) => win?.setFullScreen(!!on));

// ---- Window -----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: consoleMode ? 320 : 820,
    minHeight: consoleMode ? 240 : 520,
    fullscreen: consoleMode,
    title: 'RetroHub',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#f5f5f7',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', applyLayout);
  win.on('focus', () => {
    if (scanning || Date.now() - lastScanEnded < FOCUS_RESCAN_MS) return;
    rescan().then(sendState, () => {});
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

// One RetroHub at a time: a second copy would also read the controller and overwrite the same
// settings file. Opening RetroHub again brings the open window forward instead.
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  if (!firstCopy) return;
  loadSettings();
  loadLibrary();
  // Before the window is created, so it opens in the chosen appearance without a flash.
  nativeTheme.themeSource = APPEARANCES.includes(settings.appearance) ? settings.appearance : 'system';
  // The window opens straight away and says it's looking for games until the first scan is done.
  createWindow();
  rescan().then(sendState, () => {});
  // After sleep, an SD card or drive may have come or gone.
  powerMonitor.on('resume', () => rescan().then(sendState, () => {}));
  screen.on('display-metrics-changed', () => {
    applyLayout();
    sendState();
  });
});

app.on('window-all-closed', () => app.quit());
