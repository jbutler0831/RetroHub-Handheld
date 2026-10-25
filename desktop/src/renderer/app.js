// RetroHub window: sidebar, game grid, Setup page, couch mode and controller input.
const api = window.retrohub;
const I = window.ICONS;

let S = null;                 // State from the main process.
let lastStateJSON = '';
let selection = 'sys:nes';    // 'favorites' | 'recent' | 'setup' | 'sys:<id>'
let search = '';
const selectedGame = {};      // selection → game id
let couch = false;
let couchIndex = 0;
let padName = null;
let launching = null;         // { id, timer } from Play until the emulator's window takes over
const coverCache = new Map(); // game id → Promise<file URL | null>

const $ = (id) => document.getElementById(id);
const nav = $('nav');
const content = $('content');
const couchEl = $('couch');
const modal = $('modal');

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const orList = new Intl.ListFormat('en', { type: 'disjunction' });
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// ---- Data helpers -------------------------------------------------------------

const systemById = (id) => S.systems.find((s) => s.id === id);
const systemFor = (key) => (key.startsWith('sys:') ? systemById(key.slice(4)) : null);
/** The sidebar, top to bottom: the lists and Setup, then each maker's systems under its name. */
const sidebarSections = () => [{ title: null, keys: ['favorites', 'recent', 'setup'] },
  ...S.makers.map((maker) => ({ title: maker, keys: S.systems.filter((s) => s.maker === maker).map((s) => `sys:${s.id}`) }))];
const sidebarKeys = () => sidebarSections().flatMap((section) => section.keys);
/** The game lists in sidebar order: what LB/RB and Ctrl+[ / Ctrl+] step through. */
const listKeys = () => sidebarKeys().filter((key) => key !== 'setup');
/** Couch mode only shows lists with games, so the controller never lands on a blank screen. */
const couchKeys = () => listKeys().filter((key) => gamesFor(key).length);
const allGames = () => S.systems.flatMap((s) => S.games[s.id] || []);

function gamesFor(key) {
  const system = systemFor(key);
  if (system) return S.games[system.id] || [];
  if (key === 'favorites') {
    const favorites = new Set(S.favorites);
    return allGames().filter((g) => favorites.has(g.id));
  }
  if (key === 'recent') {
    return allGames()
      .filter((g) => S.lastPlayed[g.id])
      .sort((a, b) => S.lastPlayed[b.id] - S.lastPlayed[a.id])
      .slice(0, S.recentLimit);
  }
  return [];
}

function visibleGames() {
  const query = search.trim().toLowerCase();
  const games = gamesFor(selection);
  return query ? games.filter((g) => g.displayTitle.toLowerCase().includes(query)) : games;
}

function itemInfo(key) {
  const system = systemFor(key);
  if (system) return { title: system.name, color: system.color, label: system.label };
  return {
    favorites: { title: 'Favorites', color: '#ffb800', icon: I.star },
    recent: { title: 'Recently Played', color: '#ff9500', icon: I.clock },
    setup: { title: 'Setup', color: '#8e8e93', icon: I.wrench },
    check: { title: 'Library Check', color: '#5856d6', icon: I.refresh },
  }[key];
}

function fileHint(system) {
  if (system.id === 'ps1') return '.cue (with its .bin files), .chd or .pbp files';
  if (system.id === 'xbox') return 'XISO-format .iso files';
  if (system.id === 'ps3') return 'game folders (each containing PS3_GAME or USRDIR)';
  if (system.id === 'ps4') return 'game folders (each containing eboot.bin and sce_sys)';
  if (system.id === 'vita') return 'games installed in Vita3K (File › Install .pkg or .vpk); they show up here';
  if (system.id === 'segacd' || system.id === 'saturn') return '.cue (with its .bin files) or .chd files';
  if (system.id === 'neogeo' || system.id === 'arcade') return 'FinalBurn Neo ROM sets (.zip), named as the emulator expects';
  return `${orList.format([...system.exts].sort().map((e) => `.${e}`))} files`;
}

function timeAgo(ms) {
  const seconds = (ms - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

function cover(id) {
  if (!coverCache.has(id)) coverCache.set(id, api.cover(id).catch(() => null));
  return coverCache.get(id);
}

const emulatorName = (id) => S.emulators.find((e) => e.id === id)?.name || id;

// ---- Building blocks -------------------------------------------------------------

function tile(key, size = '') {
  const info = itemInfo(key);
  const iconSize = { huge: 36, big: 28 }[size] || 14;
  const inner = info.label ? esc(info.label) : info.icon({ size: iconSize });
  return `<span class="tile ${size}" style="--c:${info.color}">${inner}</span>`;
}

function placeholder(game, system) {
  return `<div class="placeholder"><span class="label">${esc(system.label)}</span><span class="ph-title">${esc(game.displayTitle)}</span></div>`;
}

function statusHtml(system) {
  const r = system.readiness;
  const pill = `<span class="pill ${r.ready ? 'ready' : 'needs-setup'}" title="${esc(r.detail || '')}">` +
    `${r.ready ? I.check({ size: 13 }) : I.alert({ size: 13 })} ${esc(r.summary)}</span>`;
  const get = r.missing ? ` <button class="button primary small" data-download="${r.missing}">Get ${esc(emulatorName(r.missing))}</button>` : '';
  return pill + get;
}

function cardHtml(game, showSystem) {
  const system = systemById(game.system);
  const favorite = S.favorites.includes(game.id);
  return `<div class="card${game.id === selectedGame[selection] ? ' selected' : ''}" data-id="${esc(game.id)}">
    <div class="cover" style="--c:${system.color}" data-cover="${esc(game.id)}">
      ${placeholder(game, system)}<img alt="" hidden>
      ${favorite ? `<span class="fav-badge">${I.star({ size: 12 })}</span>` : ''}
      <button class="play-button" data-play title="Play" aria-label="Play ${esc(game.displayTitle)}">${I.play({ size: 22 })}</button>
    </div>
    <div class="card-title">${esc(game.displayTitle)}</div>
    ${showSystem ? `<div class="card-sub">${esc(system.name)}</div>` : ''}
  </div>`;
}

/** Swaps each placeholder for its cover art once it loads. */
function loadCovers(root) {
  for (const el of root.querySelectorAll('[data-cover]')) {
    cover(el.dataset.cover).then((url) => {
      const img = el.querySelector('img');
      if (!url || !img) return;
      img.onload = () => {
        img.hidden = false;
        el.querySelector('.placeholder')?.remove();
      };
      img.src = url;
    });
  }
}

// ---- Rendering -------------------------------------------------------------------

function render() {
  renderSidebar();
  renderController();
  if (couch) {
    couchEl.hidden = false;
    renderCouch();
  } else {
    couchEl.hidden = true;
    renderContent();
  }
}

const gamesText = (count) => (count === 1 ? '1 game' : `${count} games`);

/** A sidebar row's tooltip: what's in the list and, for a system with games, what plays them. */
function rowHelp(key, count) {
  if (key === 'setup') return 'Emulators, games folder, graphics, controller and BIOS files';
  const system = systemFor(key);
  if (!system) return `${itemInfo(key).title}: ${gamesText(count)}`;
  if (!count) return `${system.name}: no games yet`;
  const r = system.readiness;
  return `${system.name}: ${gamesText(count)}. ${r.ready ? r.summary : `Setup needed. ${r.detail || ''}`}`;
}

function renderSidebar() {
  const row = (key, count) => {
    // An orange count with a warning sign (not color alone) when nothing installed can play the games.
    const setupNeeded = count > 0 && systemFor(key)?.readiness.ready === false;
    const label = [itemInfo(key).title, ...(count === undefined ? [] : [gamesText(count)]), ...(setupNeeded ? ['setup needed'] : [])];
    // Only the selected row is a Tab stop; ↑ and ↓ move between rows.
    return `<button class="nav-item${key === selection ? ' active' : ''}" data-key="${key}" tabindex="${key === selection ? 0 : -1}"
        title="${esc(rowHelp(key, count))}" aria-label="${esc(label.join(', '))}">
      ${tile(key)}<span class="name">${esc(itemInfo(key).title)}</span>${count ? `<span class="badge${setupNeeded ? ' setup-needed' : ''}">${setupNeeded ? I.alert({ size: 10 }) : ''}${count}</span>` : ''}
    </button>`;
  };
  const sidebarFocused = nav.contains(document.activeElement);
  nav.innerHTML = sidebarSections().map((section) => `<div class="nav-section">${section.title ? `<div class="nav-heading">${section.title}</div>` : ''}
      ${section.keys.map((key) => row(key, key === 'setup' ? undefined : gamesFor(key).length)).join('')}
    </div>`).join('');
  const active = nav.querySelector('.nav-item.active');
  // Redrawing the rows mustn't take keyboard focus out of the sidebar.
  if (sidebarFocused) active?.focus({ preventScroll: true });
  // LB/RB and the keyboard can select a row that's out of view.
  active?.scrollIntoView({ block: 'nearest' });
}

function renderController() {
  const el = $('controller-status');
  el.classList.toggle('connected', !!padName);
  el.innerHTML = `${I.gamepad({ size: 18 })}<span>${esc(padName || 'No controller')}</span>`;
  el.title = padName ? 'A: play · Y: favorite · LB/RB: switch · Start: couch mode' : 'Connect a controller and press any button';
}

function renderContent() {
  const info = itemInfo(selection);
  $('toolbar-title').textContent = info.title;
  const scroll = content.scrollTop;
  if (selection === 'setup') {
    renderSetup();
  } else if (selection === 'check') {
    renderCheck();
  } else {
    const games = visibleGames();
    if (games.length && !games.some((g) => g.id === selectedGame[selection])) selectedGame[selection] = games[0].id;
    const system = systemFor(selection);
    const total = gamesFor(selection).length;
    content.innerHTML = `<div class="page-backdrop" style="--c:${info.color}"></div>${bannerHtml()}
      <div class="page-header">${tile(selection, 'big')}
        <div><h2>${esc(info.title)}</h2>
          <div class="page-meta"><span>${search.trim() ? `${games.length} of ${gamesText(total)}` : gamesText(total)}</span>${system ? statusHtml(system) : ''}</div>
        </div>
      </div>
      ${games.length ? `<div class="grid" id="grid">${games.map((g) => cardHtml(g, !system)).join('')}</div>` : emptyHtml(system)}`;
    loadCovers(content);
    announce(games, selectedGame[selection]);
  }
  content.scrollTop = scroll;
}

const lookingHtml = () => `<div class="empty"><h3>Looking for games…</h3><p>Reading ${esc(S.libraryRoot)}.</p></div>`;

function emptyHtml(system) {
  if (!S.scanned) return lookingHtml();
  if (search.trim()) {
    return `<div class="empty"><h3>No results for “${esc(search.trim())}”</h3><p>Check the spelling or try a different search.</p></div>`;
  }
  if (selection === 'favorites') {
    return `<div class="empty">${tile('favorites', 'huge')}<h3>No favorites yet</h3>
      <p>Right-click a game and choose Add to Favorites, press F, or press Y on your controller.</p></div>`;
  }
  if (selection === 'recent') {
    return `<div class="empty">${tile('recent', 'huge')}<h3>Nothing played yet</h3>
      <p>The games you play will show up here so you can jump right back in.</p></div>`;
  }
  const r = system.readiness;
  return `<div class="empty">${tile(selection, 'huge')}<h3>Let's add some ${esc(system.name)} games</h3>
    <div class="panel steps">
      <div class="step">
        <span class="step-number${r.ready ? ' done' : ''}">${r.ready ? I.check({ size: 14 }) : '1'}</span>
        <div class="step-text"><strong>${esc(r.ready ? r.summary : 'Get an emulator')}</strong>${r.detail ? `<span>${esc(r.detail)}</span>` : ''}</div>
        ${r.missing ? `<button class="button primary" data-download="${r.missing}">Get ${esc(emulatorName(r.missing))}</button>` : ''}
      </div>
      <div class="step">
        <span class="step-number">2</span>
        <div class="step-text"><strong>Add your games</strong><span>${system.id === 'vita' ? 'Install them in Vita3K (File › Install .pkg or .vpk); they show up here.'
          : `Put ${esc(fileHint(system))} in the ${esc(system.folder)} folder.`}</span></div>
        <button class="button" data-open-folder="${system.id}">Open Folder</button>
      </div>
    </div></div>`;
}

function renderSetup() {
  const installed = S.emulators.filter((e) => e.installed).length;
  const emulatorCard = (e) => `<div class="panel emulator-card">
      <span class="letter" style="--c:${e.color}">${esc(e.name[0].toUpperCase())}</span>
      <div class="info">
        <strong>${esc(e.name)}</strong>
        <span class="covers">${esc(e.covers)}</span>
        ${e.location ? `<span class="location" title="${esc(e.location)}">${esc(e.location)}</span>` : ''}
        <div class="actions">
          ${e.installed ? `<span class="installed">${I.check({ size: 14 })} Installed</span>`
                        : `<button class="button primary small" data-download="${e.id}">Download</button>`}
          <button class="button small" data-locate="${e.id}">${e.installed ? 'Change…' : 'Locate…'}</button>
        </div>
      </div>
    </div>`;
  const notes = S.systems.filter((s) => s.note);
  const g = S.graphics;
  const segmented = (key, options) => `<div class="segmented">${options.map(([value, label]) =>
    `<button class="${g[key] === value ? 'active' : ''}" data-graphics="${key}" data-value="${esc(JSON.stringify(value))}">${esc(label)}</button>`).join('')}</div>`;
  const graphicsRow = (title, detail, control) => `<div class="graphics-row">
      <div class="grow"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>${control}</div>`;
  content.innerHTML = `<div class="page-backdrop" style="--c:#8e8e93"></div>
    <div class="page-header">${tile('setup', 'big')}
      <div><h2>Setup</h2><div class="page-meta">${installed
        ? `${installed} of ${S.emulators.length} emulators installed`
        : 'Welcome! Install an emulator below to get started.'}</div></div>
    </div>
    <div class="setup">
      <section>
        <h3>Emulators</h3>
        <p class="subtitle">RetroHub opens your games in these free emulators. Install the ones for the systems you want to play.
          If one isn't found automatically, click Locate… and pick its program file.</p>
        <div class="emulator-grid">${S.emulators.map(emulatorCard).join('')}</div>
      </section>
      <section>
        <h3>Games Folder</h3>
        <p class="subtitle">Each system has its own folder inside this one.</p>
        <div class="panel row-panel">
          <span class="tile" style="--c:#007aff;width:36px;height:36px;border-radius:9px">${I.folder({ size: 18 })}</span>
          <div class="grow mono" title="${esc(S.libraryRoot)}">${esc(S.libraryRoot)}</div>
          <button class="button" data-open-folder="">Open</button>
          <button class="button" data-choose-root>Change…</button>
        </div>
      </section>
      <section>
        <h3>Library</h3>
        <p class="subtitle">RetroHub notices new, moved, renamed, missing and duplicate games each time it scans, and asks before changing anything.</p>
        <div class="panel row-panel">
          <div class="grow">${esc(checkSummary() || 'No changes since you last checked.')}</div>
          <button class="button" data-show="check">Check Library…</button>
        </div>
      </section>
      <section>
        <h3>Graphics</h3>
        <p class="subtitle">Applied when RetroHub starts a game in RetroArch. RetroArch's own settings stay as they are.</p>
        <div class="panel graphics-panel">
          ${graphicsRow('Full screen', 'Games start full screen in RetroArch. Press F in RetroArch to switch between full screen and a window.',
                        segmented('fullscreen', [[true, 'On'], [false, 'Off']]))}
          ${graphicsRow('Screen filter', '2D systems such as NES, SNES, Genesis, Game Boy and arcade. CRT adds scanlines and a curved screen; Smooth HD rounds off pixel edges.',
                        segmented('filter', [['off', 'Off'], ['crt', 'CRT'], ['smooth', 'Smooth HD']]))}
          ${S.shadersMissing ? `<div class="graphics-warning">Download RetroArch's shaders first: Main Menu › Online Updater › Update Slang Shaders.</div>` : ''}
          ${graphicsRow('3D resolution', 'N64, PlayStation and Dreamcast. Higher looks sharper but needs a faster computer.',
                        segmented('scale', [[1, 'Native'], [2, '2×'], [3, '3×'], [4, '4×']]))}
          ${graphicsRow('Widescreen hack', 'N64, PlayStation and Dreamcast. Shows more of the 3D world in 16:9; some games glitch at the edges.',
                        segmented('widescreen', [[false, 'Off'], [true, 'On']]))}
        </div>
      </section>
      <section>
        <h3>Appearance</h3>
        <p class="subtitle">For RetroHub only: your computer's own setting stays as it is. Couch mode always has its dark TV look.</p>
        <div class="panel row-panel">
          <div class="segmented">${[['system', 'Follow System'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) =>
            `<button class="${S.appearance === value ? 'active' : ''}" data-appearance="${value}">${label}</button>`).join('')}</div>
        </div>
      </section>
      <section>
        <h3>Controller</h3>
        <p class="subtitle">PS5 DualSense and Xbox controllers work over Bluetooth or USB.</p>
        <div class="panel row-panel">
          <span class="tile" style="--c:${padName ? '#28a745' : '#8e8e93'};width:36px;height:36px;border-radius:9px">${I.gamepad({ size: 20 })}</span>
          <div class="grow">
            <strong>${esc(padName || 'No controller connected')}</strong>
            <div class="card-sub" style="text-align:left">${padName
              ? 'A to play · Y to favorite · LB/RB to switch · Start for couch mode'
              : 'Connect one, then press any button so RetroHub can see it.'}</div>
          </div>
        </div>
      </section>
      <section>
        <h3>BIOS &amp; Firmware</h3>
        <p class="subtitle">Some systems need files from your own console. These can't be included.</p>
        <div class="panel bios-list">${notes.map((s) => `<div class="bios-row">${tile(`sys:${s.id}`)}<strong>${esc(s.name)}</strong><span>${esc(s.note)}</span></div>`).join('')}</div>
      </section>
    </div>`;
}

// ---- Library Check ---------------------------------------------------------------------

const fileName = (file) => file.split(/[\\/]/).pop();
let listBeforeCheck = null;   // Where Done goes back to.

/** "3 new · 1 moved or renamed · 2 missing": what changed since the last review, or ''. */
function checkSummary() {
  const n = S.libraryCheck.news;
  return [n.added && `${n.added} new`, n.renamed && `${n.renamed} moved or renamed`, n.missing && `${n.missing} missing`]
    .filter(Boolean).join(' · ');
}

function bannerHtml() {
  const summary = checkSummary();
  return summary ? `<div class="library-banner" role="status">${I.refresh({ size: 14 })}<span class="grow">Library changed: ${esc(summary)}</span>
    <button class="button small" data-show="check">Review</button></div>` : '';
}

/** What confirming or removing would affect: "favorite · played 3 days ago". */
function carriesText(item) {
  const parts = [item.favorite && 'favorite', item.lastPlayed && `played ${timeAgo(item.lastPlayed)}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no favorite or play history';
}

function renderCheck() {
  const c = S.libraryCheck;
  const gameCell = (title, system, ...details) =>
    `${tile(`sys:${system}`)}<div class="grow"><strong>${esc(title)}</strong>${details.map((d) => `<span>${esc(d)}</span>`).join('')}</div>`;
  const section = (title, subtitle, items, row, actions = '') => `<section>
      <div class="check-heading"><h3>${esc(title)} <span class="count">${items.length}</span></h3>${items.length ? actions : ''}</div>
      <p class="subtitle">${esc(subtitle)}</p>
      ${items.length ? `<div class="panel check-list">${items.map(row).join('')}</div>` : '<p class="check-none">None.</p>'}
    </section>`;
  const summary = checkSummary();
  content.innerHTML = `<div class="page-backdrop" style="--c:#5856d6"></div>
    <div class="page-header">${tile('check', 'big')}
      <div><h2>Library Check</h2><div class="page-meta">${esc(summary ? `Since you last checked: ${summary}` : 'No changes since you last checked.')}</div></div>
    </div>
    <div class="setup check">
      ${section('Moved or renamed', 'Files that turned up under a new name. Their favorite and play history move with them only when you confirm.',
        c.renamed, (r) => `<div class="check-row">${gameCell(r.title, r.system, `Now: ${fileName(r.to)} · ${carriesText(r)}`, `Was: ${fileName(r.from)}`)}
          <button class="button small primary" data-check="applyRename" data-from="${esc(r.from)}" data-to="${esc(r.to)}">Same game</button>
          <button class="button small" data-check="notRenamed" data-from="${esc(r.from)}">Not the same</button></div>`,
        '<button class="button small" data-check="applyAllRenames">Same game for all</button>')}
      ${section('Missing', "Games whose files are gone. They're kept, with their favorites and play history, until you remove them, so nothing is lost if the files come back (from an external drive, say).",
        c.missing, (m) => `<div class="check-row">${gameCell(m.title, m.system, `${fileName(m.path)} · missing since ${timeAgo(m.since)} · ${carriesText(m)}`)}
          <button class="button small" data-check="removeMissing" data-path="${esc(m.path)}">Remove</button></div>`,
        '<button class="button small" data-check="removeAllMissing">Remove all</button>')}
      ${section('New', 'Games added since you last checked. They are already in your library.',
        c.added, (a) => `<div class="check-row">${gameCell(a.title, a.system, `${systemById(a.system)?.name || a.system} · ${fileName(a.path)}`)}</div>`)}
      ${section('Duplicates', 'The same file in more than one place.',
        c.duplicates, (d) => `<div class="check-row">${gameCell(d.title, d.system, d.paths.map(fileName).join(' · '))}
          ${d.paths.map((p, i) => `<button class="button small" data-check="showFile" data-path="${esc(p)}" title="${esc(p)}">Show copy ${i + 1}</button>`).join('')}</div>`)}
      ${section('No cover art found', 'RetroHub looked for these covers and found none. Put an image with the same name next to the game, or look again.',
        c.noArt, (g) => `<div class="check-row">${gameCell(g.title, g.system, systemById(g.system)?.name || g.system)}</div>`,
        '<button class="button small" data-check="lookAgain">Look again</button>')}
      <div class="check-done"><button class="button primary" data-check="markReviewed">Done</button></div>
    </div>`;
}

/** A button on the Library Check page. Nothing changes without one of these. */
async function checkAction(action, target) {
  const c = S.libraryCheck;
  const d = target.dataset;
  let next;
  if (action === 'applyRename') next = await api.libraryAction('applyRename', { from: d.from, to: d.to });
  else if (action === 'applyAllRenames') for (const r of c.renamed) next = await api.libraryAction('applyRename', { from: r.from, to: r.to });
  else if (action === 'notRenamed') next = await api.libraryAction('notRenamed', { from: d.from });
  else if (action === 'removeMissing') next = await api.libraryAction('removeMissing', { paths: [d.path] });
  else if (action === 'removeAllMissing') {
    const count = c.missing.length;
    if (!confirm(`Remove ${count === 1 ? 'the missing game' : `all ${count} missing games`}? Their favorites and play history are forgotten.`)) return;
    next = await api.libraryAction('removeMissing', { paths: c.missing.map((m) => m.path) });
  } else if (action === 'lookAgain') {
    for (const g of c.noArt) coverCache.delete(g.id);
    next = await api.libraryAction('lookAgain', { ids: c.noArt.map((g) => g.id) });
  } else if (action === 'showFile') return api.showFile(d.path);
  else if (action === 'markReviewed') {
    applyState(await api.libraryAction('markReviewed'), true);
    return show(listBeforeCheck || 'sys:nes');
  }
  if (next) applyState(next, true);
}

// ---- Couch mode --------------------------------------------------------------------

/** Cover width and gap in pixels, from the CSS (they shrink on small screens). */
function coverMetrics() {
  const style = getComputedStyle(document.documentElement);
  return { width: parseFloat(style.getPropertyValue('--cover-w')), gap: parseFloat(style.getPropertyValue('--cover-gap')) };
}

/** Where the game picked in this list is, in the browser or couch mode, so going back lands on it. */
function pickedIndex() {
  return Math.max(0, gamesFor(selection).findIndex((g) => g.id === selectedGame[selection]));
}

function renderCouch() {
  const keys = couchKeys();
  // The list on screen emptied (the last favorite removed, or the first scan just finished): go to one with games.
  if (keys.length && !keys.includes(selection)) {
    selection = keys[0];
    couchIndex = pickedIndex();
  }
  const games = gamesFor(selection);
  couchIndex = Math.min(couchIndex, Math.max(0, games.length - 1));
  const hint = (button, label) => `<span><span class="button-badge">${button}</span><span class="label">${label}</span></span>`;
  couchEl.innerHTML = `<div class="couch-backdrop" id="couch-backdrop"></div>
    <button class="couch-close icon-button" data-exit title="Exit couch mode (Esc)">${I.close({ size: 22 })}</button>
    <div class="couch-tabs">
      <span class="button-badge">LB</span>
      <div class="tabs">${keys.map((k) => `<span class="tab${k === selection ? ' active' : ''}" data-tab="${k}">${esc(itemInfo(k).title)}</span>`).join('')}</div>
      <span class="button-badge">RB</span>
    </div>
    <div class="couch-stage">${games.length
      ? `<div class="carousel" id="carousel">${games.map((g, i) => `<div class="cover" style="--c:${systemById(g.system).color}" data-cover="${esc(g.id)}" data-index="${i}">${placeholder(g, systemById(g.system))}<img alt="" hidden></div>`).join('')}</div>
         <div class="couch-details" id="couch-details"></div>`
      : S.scanned ? `<div class="couch-empty">${I.gamepad({ size: 64 })}<h2>No games yet</h2><p>Add games to ${esc(S.libraryRoot)} to see them here.</p></div>`
      : `<div class="couch-empty">${I.gamepad({ size: 64 })}<h2>Looking for games…</h2></div>`}
    </div>
    <div class="couch-hints">${hint('A', 'Play')}${hint('Y', 'Favorite')}${hint('LB RB', 'Switch')}${hint('B', 'Exit')}</div>`;
  loadCovers(couchEl);
  // On a small screen not every tab fits: keep the current list's tab in the middle.
  couchEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  updateCouch();
}

/** Moves the carousel and refreshes the title and backdrop without rebuilding it. */
function updateCouch() {
  const games = gamesFor(selection);
  const game = games[couchIndex];
  const carousel = $('carousel');
  if (!game || !carousel) return;
  selectedGame[selection] = game.id;
  carousel.querySelectorAll('.cover').forEach((el, i) => el.classList.toggle('current', i === couchIndex));
  const { width, gap } = coverMetrics();
  carousel.style.transform = `translateX(${window.innerWidth / 2 - (couchIndex * (width + gap) + width / 2)}px)`;

  announce(games, game.id);
  const system = systemById(game.system);
  const last = S.lastPlayed[game.id];
  $('couch-details').innerHTML = `<h2>${esc(game.displayTitle)}${S.favorites.includes(game.id) ? `<span class="star">${I.star({ size: 26 })}</span>` : ''}</h2>
    <p>${esc(system.name)}${last ? ` · Last played ${timeAgo(last)}` : ''}</p>`;
  cover(game.id).then((url) => {
    if (gamesFor(selection)[couchIndex]?.id !== game.id) return;
    $('couch-backdrop').style.backgroundImage = url ? `url(${JSON.stringify(url)})` : 'none';
  });
}

function setCouch(on) {
  couch = on;
  const keys = couchKeys();
  if (on && keys.length && !keys.includes(selection)) selection = keys[0];
  couchIndex = pickedIndex();
  api.setFullScreen(on || S.consoleMode);
  render();
  if (!on) content.focus();
}

// ---- Actions -----------------------------------------------------------------------

function showModal(message, title = "Couldn't start the game") {
  hideLaunching();
  $('modal-title').textContent = title;
  $('modal-message').textContent = message;
  $('modal').querySelector('.modal-icon').innerHTML = I.alert({ size: 34 });
  modal.hidden = false;
  $('modal-ok').focus();
}

function hideModal() {
  modal.hidden = true;
  content.focus();
}

/**
 * "Starting Contra…" from the moment Play is pressed until the emulator's window comes to the front
 * (RetroHub's window loses focus), so a press is never met with nothing; emulators can take several
 * seconds to open. Play is ignored meanwhile, and B or Esc hides it.
 */
function showLaunching(game, label = null) {
  clearTimeout(launching?.timer);
  launching = { id: game.id, timer: label ? setTimeout(hideLaunching, 10000) : null };
  $('launching-title').textContent = `Starting ${game.displayTitle}…`;
  $('launching-detail').textContent = label ? `Opening ${label}` : '';
  $('launching').hidden = false;
}

function hideLaunching() {
  clearTimeout(launching?.timer);
  launching = null;
  $('launching').hidden = true;
}

async function play(id) {
  if (launching) return;
  if (!couch) select(id);
  const game = allGames().find((g) => g.id === id);
  if (!game) return;
  showLaunching(game);
  let result;
  try {
    result = await api.play(id);
  } catch (error) {
    result = { error: error.message };
  }
  if (result.error) return showModal(result.error);
  if (result.busy) return hideLaunching(); // Already starting from the game's menu.
  if (!document.hasFocus()) return hideLaunching(); // The emulator is already in front.
  if (launching?.id === id) showLaunching(game, result.label);
  if (couch && selection === 'recent') couchIndex = 0; // The game just moved to the front.
}

function select(id, scroll = false) {
  selectedGame[selection] = id;
  content.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  const card = content.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  card?.classList.add('selected');
  if (scroll) card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  announce(visibleGames(), id);
}

/**
 * Tells screen readers which game is picked, such as "Contra, 2 of 5, favorite". Keyboard focus
 * stays on the list as the pick moves, so without this nothing would be read out. Only changes
 * are read, so redrawing the same list says nothing.
 */
function announce(games, id) {
  const index = games.findIndex((g) => g.id === id);
  const text = index < 0 ? '' : `${games[index].displayTitle}, ${index + 1} of ${games.length}${S.favorites.includes(id) ? ', favorite' : ''}`;
  const el = $('announcer');
  if (el.textContent !== text) el.textContent = text;
}

function gridColumns() {
  const cards = [...content.querySelectorAll('.card')];
  return Math.max(1, cards.filter((c) => c.offsetTop === cards[0]?.offsetTop).length);
}

function move(dx, dy) {
  const games = visibleGames();
  if (!games.length) return;
  const current = games.findIndex((g) => g.id === selectedGame[selection]);
  if (current < 0) return select(games[0].id, true);
  const next = Math.min(Math.max(current + dx + dy * gridColumns(), 0), games.length - 1);
  select(games[next].id, true);
}

function cycle(step) {
  const keys = couch ? couchKeys() : listKeys();
  if (!keys.length) return;
  let index = keys.indexOf(selection);
  if (index < 0) index = step > 0 ? -1 : 0;
  selection = keys[(index + step + keys.length) % keys.length];
  couchIndex = pickedIndex();
  render();
}

/** Shows a list or Setup in the browser, leaving couch mode. */
function show(key) {
  if (couch) setCouch(false);
  if (key === 'check' && selection !== 'check') listBeforeCheck = selection;
  selection = key;
  render();
}

/** Puts the cursor in the search field (Ctrl+F). */
function findGames() {
  if (couch) setCouch(false);
  $('search').focus();
  $('search').select();
}

/** The sidebar row above (-1) or below (1), Setup included; focus stays in the sidebar. */
function stepSidebar(step) {
  const keys = sidebarKeys();
  const index = keys.indexOf(selection);
  const next = keys[Math.min(Math.max(index + step, 0), keys.length - 1)];
  if (next === selection) return;
  selection = next;
  render();
}

const focusSidebar = () => nav.querySelector('.nav-item.active')?.focus();

/** Handles a controller or keyboard command. */
function command(cmd) {
  if (!modal.hidden) {
    if (cmd === 'play' || cmd === 'back') hideModal();
    return;
  }
  if (launching) {
    if (cmd === 'back') hideLaunching();
    return;
  }
  if (couch) {
    const games = gamesFor(selection);
    switch (cmd) {
      case 'left': case 'right':
        couchIndex = Math.min(Math.max(couchIndex + (cmd === 'left' ? -1 : 1), 0), Math.max(0, games.length - 1));
        return updateCouch();
      case 'up': case 'prev': return cycle(-1);
      case 'down': case 'next': return cycle(1);
      case 'play': return games[couchIndex] && play(games[couchIndex].id);
      case 'favorite': return games[couchIndex] && api.toggleFavorite(games[couchIndex].id);
      case 'back': case 'couch': return setCouch(false);
    }
    return;
  }
  const id = selectedGame[selection];
  switch (cmd) {
    case 'left': return move(-1, 0);
    case 'right': return move(1, 0);
    case 'up': return move(0, -1);
    case 'down': return move(0, 1);
    case 'play': return id && visibleGames().some((g) => g.id === id) && play(id);
    case 'favorite': return id && api.toggleFavorite(id);
    case 'prev': return cycle(-1);
    case 'next': return cycle(1);
    case 'couch': return setCouch(true);
  }
}

// ---- Events ------------------------------------------------------------------------

nav.addEventListener('click', (event) => {
  const item = event.target.closest('[data-key]');
  if (!item) return;
  selection = item.dataset.key;
  render();
  focusSidebar();
});

async function handleButtons(event) {
  const target = event.target.closest('[data-download], [data-open-folder], [data-choose-root], [data-locate], [data-play], [data-exit], [data-tab], [data-graphics], [data-appearance], [data-show], [data-check]');
  if (!target) return false;
  const d = target.dataset;
  if ('download' in d) api.openDownload(d.download);
  else if ('openFolder' in d) api.openFolder(d.openFolder);
  else if ('chooseRoot' in d) applyState(await api.chooseRoot());
  else if ('locate' in d) applyState(await api.locateEmulator(d.locate));
  else if ('play' in d) play(target.closest('[data-id]').dataset.id);
  else if ('exit' in d) setCouch(false);
  else if ('tab' in d) { selection = d.tab; couchIndex = pickedIndex(); render(); }
  else if ('graphics' in d) applyState(await api.setGraphics({ [d.graphics]: JSON.parse(d.value) }));
  else if ('appearance' in d) applyState(await api.setAppearance(d.appearance));
  else if ('show' in d) { show(d.show); content.focus(); }
  else if ('check' in d) await checkAction(d.check, target);
  return true;
}

content.addEventListener('click', async (event) => {
  if (await handleButtons(event)) return;
  const card = event.target.closest('.card');
  if (card) {
    select(card.dataset.id);
    content.focus();
  }
});
content.addEventListener('dblclick', (event) => {
  const card = event.target.closest('.card');
  if (card && !event.target.closest('button')) play(card.dataset.id);
});
content.addEventListener('contextmenu', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  event.preventDefault();
  select(card.dataset.id);
  api.gameMenu(card.dataset.id);
});

couchEl.addEventListener('click', async (event) => {
  if (await handleButtons(event)) return;
  const el = event.target.closest('[data-index]');
  if (el) {
    couchIndex = Number(el.dataset.index);
    updateCouch();
  }
});
couchEl.addEventListener('dblclick', (event) => {
  const el = event.target.closest('[data-index]');
  if (el) command('play');
});

$('couch-button').innerHTML = I.tv({ size: 18 });
$('rescan-button').innerHTML = I.refresh({ size: 17 });
document.querySelector('.search-icon').innerHTML = I.search({ size: 14 });
$('couch-button').addEventListener('click', () => setCouch(true));
$('rescan-button').addEventListener('click', async () => applyState(await api.rescan(), true));
$('modal-ok').addEventListener('click', hideModal);
$('search').addEventListener('input', (event) => {
  search = event.target.value;
  renderContent();
});

const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'play', f: 'favorite', F: 'favorite', Escape: 'back' };
// Ctrl (⌘ on a Mac) shortcuts, as in the Mac app's menus: Setup, Find, Previous/Next System, Rescan.
const SHORTCUTS = {
  ',': () => show('setup'),
  f: findGames,
  '[': () => cycle(-1),
  ']': () => cycle(1),
  r: async () => applyState(await api.rescan(), true),
};
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const shortcut = modal.hidden && SHORTCUTS[event.key.toLowerCase()];
    if (shortcut) {
      event.preventDefault();
      shortcut();
    }
    return; // Copy, paste and the rest behave as usual.
  }
  if (launching && event.key === 'Escape') {
    event.preventDefault();
    return hideLaunching();
  }
  if (event.target.id === 'search') {
    if (event.key === 'Escape') event.target.blur();
    if (event.key === 'Enter' || event.key === 'ArrowDown') content.focus();
    return;
  }
  if (!couch && modal.hidden && nav.contains(event.target)) {
    // In the sidebar: ↑ and ↓ move through the lists; Return or → opens the games.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      stepSidebar(event.key === 'ArrowUp' ? -1 : 1);
    } else if ((event.key === 'Enter' || event.key === 'ArrowRight') && selection !== 'setup') {
      event.preventDefault();
      content.focus();
    }
    return;
  }
  if (!couch && modal.hidden && event.key === 'Escape') {
    event.preventDefault();
    return focusSidebar();
  }
  const cmd = KEYS[event.key];
  if (!cmd) return;
  event.preventDefault();
  command(cmd);
});
window.addEventListener('resize', () => couch && updateCouch());
// The emulator's window came to the front.
window.addEventListener('blur', () => launching?.timer && hideLaunching());

// ---- Controller ----------------------------------------------------------------------

// Standard gamepad mapping: 0 A/✕, 1 B/○, 3 Y/△, 4 LB, 5 RB, 9 Start/Options, 12–15 D-pad.
const BUTTONS = { 0: 'play', 1: 'back', 3: 'favorite', 4: 'prev', 5: 'next', 9: 'couch', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
const held = new Map();

function cleanPadName(id) {
  return id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || 'Controller';
}

/** Fires a command when an input goes from released to pressed, but only while RetroHub is in front. */
function edge(key, down, cmd) {
  const wasDown = held.get(key);
  held.set(key, down);
  if (down && !wasDown && document.hasFocus()) {
    if (nav.contains(document.activeElement)) content.focus();
    command(cmd);
  }
}

function pollGamepads() {
  const pads = [...navigator.getGamepads()].filter(Boolean);
  const name = pads[0] ? cleanPadName(pads[0].id) : null;
  if (name !== padName) {
    padName = name;
    renderController();
    if (selection === 'setup' && !couch) renderContent();
  }
  for (const pad of pads) {
    for (const [index, cmd] of Object.entries(BUTTONS)) edge(`${pad.index}:${index}`, !!pad.buttons[index]?.pressed, cmd);
    const [x = 0, y = 0] = pad.axes;
    edge(`${pad.index}:x-`, x < -0.6, 'left');
    edge(`${pad.index}:x+`, x > 0.6, 'right');
    edge(`${pad.index}:y-`, y < -0.6, 'up');
    edge(`${pad.index}:y+`, y > 0.6, 'down');
  }
  requestAnimationFrame(pollGamepads);
}

// ---- Startup -------------------------------------------------------------------------

function applyState(state, force = false) {
  const json = JSON.stringify(state);
  if (!force && json === lastStateJSON) return;
  lastStateJSON = json;
  S = state;
  render();
}

api.onState((state) => applyState(state));
api.onError(showModal);

api.state().then((state) => {
  // New users land on Setup until they have an emulator.
  selection = state.emulators.some((e) => e.installed) ? 'sys:nes' : 'setup';
  applyState(state);
  if (state.consoleMode) setCouch(true);
  content.focus();
  requestAnimationFrame(pollGamepads);
  api.takeNotice().then((notice) => notice && showModal(notice.message, notice.title));
});
