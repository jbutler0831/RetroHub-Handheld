// Finds installed emulators on macOS, Windows and Linux, and starts games in them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SYSTEMS, EMULATORS } = require('./systems');
const { exists } = require('./library');
const graphicsOptions = require('./graphics');

const platform = process.platform;
const home = os.homedir();

/** Emulators that exist on this OS (OpenEmu is Mac-only). */
function availableEmulators() {
  return EMULATORS.filter((e) => (platform === 'darwin' ? e.mac || e.macBinary : platform === 'win32' ? e.win || e.scoop : e.linux || e.flatpak));
}

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? `%${name}%`);
}

function onPath(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* keep looking */ }
  }
  return null;
}

function flatpakInstalled(id) {
  return [path.join(home, '.local/share/flatpak/app', id), path.join('/var/lib/flatpak/app', id)].some(exists);
}

/** The executable inside a .app bundle, from its Info.plist. */
function macExecutable(appPath) {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents/Info.plist'), 'utf8');
    const name = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (name) return path.join(appPath, 'Contents/MacOS', name);
  } catch { /* fall through */ }
  return null;
}

/**
 * How to run an emulator: { command, prefix, display, flatpak? } or null when it isn't installed.
 * A path the user picked in Setup always wins.
 */
function resolve(emulator, customPaths) {
  const custom = customPaths[emulator.id];
  if (custom && exists(custom)) {
    const command = custom.endsWith('.app') ? macExecutable(custom) : custom;
    if (command) return { command, prefix: [], display: custom, appPath: custom.endsWith('.app') ? custom : null };
  }
  if (platform === 'darwin') {
    for (const dir of ['/Applications', path.join(home, 'Applications')]) {
      for (const name of emulator.mac || []) {
        const appPath = path.join(dir, name);
        const command = exists(appPath) && macExecutable(appPath);
        if (command) return { command, prefix: [], display: appPath, appPath };
      }
      for (const name of emulator.macBinary || []) {
        const command = path.join(dir, name);
        if (exists(command)) return { command, prefix: [], display: command };
      }
    }
  } else if (platform === 'win32') {
    const candidates = (emulator.win || []).map(expandEnv);
    if (emulator.scoop) candidates.push(path.join(home, 'scoop/apps', emulator.scoop[0], 'current', emulator.scoop[1]));
    const found = candidates.find(exists);
    if (found) return { command: found, prefix: [], display: found };
  } else {
    for (const name of emulator.linux || []) {
      const found = onPath(name);
      if (found) return { command: found, prefix: [], display: found };
    }
    if (emulator.flatpak && flatpakInstalled(emulator.flatpak)) {
      return { command: 'flatpak', prefix: ['run', emulator.flatpak], display: `Flatpak (${emulator.flatpak})`, flatpak: true };
    }
  }
  return null;
}

/** Folders where RetroArch keeps its cores, for this install. */
function coreDirs(retroarch) {
  if (platform === 'darwin') return [path.join(home, 'Library/Application Support/RetroArch/cores')];
  if (platform === 'win32') return [path.join(path.dirname(retroarch.command), 'cores')];
  if (retroarch.flatpak) return [path.join(home, '.var/app/org.libretro.RetroArch/config/retroarch/cores')];
  return [path.join(home, '.config/retroarch/cores'), '/usr/lib/x86_64-linux-gnu/libretro', '/usr/lib/aarch64-linux-gnu/libretro', '/usr/lib/libretro', '/usr/lib64/libretro'];
}

const coreExt = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so';

/**
 * Starts a program and resolves with its process once it's running. It's detached, so it keeps
 * running if RetroHub quits, but its 'exit' event still fires while RetroHub is open. The program
 * gets its arguments as a list, never through a shell, so nothing in a file name is run as a command.
 * With `log`, what the program prints goes to that file (a file rather than a pipe, so the emulator
 * keeps running normally if RetroHub quits first).
 */
function startProcess(command, args, { log } = {}) {
  return new Promise((resolvePromise, reject) => {
    let output = 'ignore';
    if (log) {
      try {
        fs.mkdirSync(path.dirname(log), { recursive: true });
        output = fs.openSync(log, 'w');
      } catch { /* no log, but still start the game */ }
    }
    const closeLog = () => typeof output === 'number' && fs.closeSync(output);
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: ['ignore', output, output] });
    } catch (error) {
      closeLog();
      return reject(error);
    }
    child.once('error', (error) => {
      closeLog();
      reject(error);
    });
    child.once('spawn', () => {
      closeLog(); // The child has its own copy.
      child.unref();
      resolvePromise(child);
    });
  });
}

/**
 * What to tell the user when a program can't be started at all, from the operating system's error.
 * Batch files are refused up front: on Windows they only run through a shell, and RetroHub doesn't
 * use one.
 */
function startProblem(error, command) {
  const name = path.basename(command);
  if (error.code === 'ENOENT') return `The program ${name} wasn't found. It may have been moved or uninstalled: choose it again with Locate… in Setup.`;
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return platform === 'linux'
      ? `${name} isn't allowed to run. If it's an AppImage, make it executable (right-click › Properties › Allow executing, or chmod +x).`
      : `${name} isn't allowed to run. Check its permissions, or choose the emulator's program again with Locate… in Setup.`;
  }
  if (error.code === 'EINVAL' && /\.(bat|cmd)$/i.test(command)) return batchProblem(name);
  return error.message;
}

const batchProblem = (name) => `${name} is a batch file, which RetroHub doesn't run. Choose the emulator's .exe program with Locate… in Setup.`;

/** Full screen or in a window, for this run only (RetroArch's own setting is left alone). */
function retroArchWindowArgs(fullscreen) {
  return fullscreen ? ['-f'] : [];
}

/**
 * The first installed way to play a system: { label, start(gamePath) } or null. start resolves
 * with the emulator's process, or null for OpenEmu, which macOS opens and which stays open as a
 * library app after the game.
 */
function plan(system, customPaths, graphics = graphicsOptions.DEFAULTS, { fullscreen = false, log } = {}) {
  const run = (command, args) => startLogged(command, args, { log });
  for (const backend of system.backends) {
    if (backend.type === 'retroarch') {
      const retroarch = resolve(EMULATORS.find((e) => e.id === 'retroarch'), customPaths);
      if (!retroarch) continue;
      const dirs = coreDirs(retroarch);
      for (const core of backend.cores) {
        const corePath = dirs.map((d) => path.join(d, `${core.id}_libretro.${coreExt}`)).find(exists);
        if (corePath) {
          return {
            label: `RetroArch (${core.name})`,
            start: (game) => run(retroarch.command, [...retroarch.prefix, ...retroArchWindowArgs(fullscreen), '-L', corePath,
              ...graphicsOptions.retroArchArgs(system.id, core, retroarch, graphics), game]),
          };
        }
      }
    } else if (backend.type === 'openemu') {
      if (platform !== 'darwin') continue;
      const openemu = resolve(EMULATORS.find((e) => e.id === 'openemu'), customPaths);
      if (openemu) return { label: 'OpenEmu', start: (game) => run('open', ['-a', openemu.appPath, game]).then(() => null) };
    } else {
      const emulator = EMULATORS.find((e) => e.id === backend.emulator);
      const resolved = resolve(emulator, customPaths);
      if (resolved) {
        // Vita3K runs installed games by title ID, the name of the game's folder.
        const target = (game) => (emulator.id === 'vita3k' ? path.basename(game) : game);
        return { label: emulator.name, start: (game) => run(resolved.command, [...resolved.prefix, ...backend.args, target(game)]) };
      }
    }
  }
  return null;
}

const listFormat = new Intl.ListFormat('en', { type: 'disjunction' });

/** Status for a system's header: { ready, summary, detail, missing }. */
function readiness(system, customPaths) {
  const found = plan(system, customPaths);
  if (found) return { ready: true, summary: `Plays with ${found.label}`, detail: system.note || null, missing: null };

  const usable = new Set(availableEmulators().map((e) => e.id));
  const backends = system.backends.filter((b) => usable.has(b.type === 'app' ? b.emulator : b.type));
  const retroarchBackend = backends.find((b) => b.type === 'retroarch');
  if (retroarchBackend && resolve(EMULATORS.find((e) => e.id === 'retroarch'), customPaths)) {
    const names = listFormat.format(retroarchBackend.cores.map((c) => c.name));
    return {
      ready: false, summary: 'Setup needed', missing: null,
      detail: `RetroArch needs the ${names} core. In RetroArch open Main Menu › Online Updater › Core Downloader and install it.`,
    };
  }
  const ids = backends.map((b) => (b.type === 'app' ? b.emulator : b.type));
  const names = listFormat.format(ids.map((id) => EMULATORS.find((e) => e.id === id).name));
  const notes = ids.map((id) => EMULATORS.find((e) => e.id === id).installNote?.[platform]).filter(Boolean);
  const detail = [`Install ${names} to play ${system.name} games.`, ...notes].join(' ');
  return { ready: false, summary: 'Setup needed', detail, missing: ids[0] || null };
}

/** startProcess, refusing batch files on Windows before trying (see startProblem). */
function startLogged(command, args, options) {
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
    return Promise.reject(Object.assign(new Error(batchProblem(path.basename(command))), { code: 'BATCH' }));
  }
  return startProcess(command, args, options);
}

/**
 * Starts the game; resolves with { label, process } (process is null for OpenEmu). options:
 * { fullscreen, log } where log is the file the emulator's output goes to.
 */
async function launch(game, customPaths, graphics, options = {}) {
  const system = SYSTEMS.find((s) => s.id === game.system);
  // An unplugged drive or a file removed since the last scan: say so rather than leave it to the emulator.
  if (!exists(game.bootPath)) {
    throw new Error(`${game.displayTitle} isn't where RetroHub found it (${path.basename(game.bootPath)}). If it's on a drive or SD card, connect it, then try again.`);
  }
  const found = plan(system, customPaths, graphics, options);
  if (!found) throw new Error(readiness(system, customPaths).detail);
  try {
    return { label: found.label, process: await found.start(game.bootPath) };
  } catch (error) {
    throw new Error(`Couldn't start ${found.label}. ${error.code === 'BATCH' ? error.message : startProblem(error, error.path || '')}`);
  }
}

/** The last lines an emulator printed, for an error message: at most `max` characters, or ''. */
function lastOutput(log, max = 300) {
  let text;
  try {
    const handle = fs.openSync(log, 'r');
    try {
      const size = fs.fstatSync(handle).size;
      const length = Math.min(size, 4096);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
  let result = '';
  for (let i = lines.length - 1; i >= 0 && result.length + lines[i].length < max; i--) result = result ? `${lines[i]}\n${result}` : lines[i];
  return result || (lines.length ? `${lines[lines.length - 1].slice(0, max - 1)}…` : '');
}

module.exports = { availableEmulators, resolve, readiness, launch, startProcess, startProblem, lastOutput, retroArchWindowArgs };
