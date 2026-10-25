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
      <button class="play-button" data-play tabindex="-1" title="Play" aria-label="Play ${esc(game.displayTitle)}">${I.play({ size: 22 })}</button>
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
  el.title = padName ? 'A: play · B: back · X: options · Y: favorite · LB/RB: switch · Start: couch mode · Select: Setup' : 'Connect a controller and press any button';
}

/**
 * Where focus is among the page's buttons, to put it back after a redraw: a selector made of the
 * button's data attributes (the same button after the redraw), and its place in the list (the
 * nearest one, when that button is gone).
 */
function focusMark() {
  const el = document.activeElement;
  if (!content.contains(el) || el === content) return null;
  const attributes = [...el.attributes].filter((a) => a.name.startsWith('data-'));
  return {
    selector: attributes.length ? `${el.tagName.toLowerCase()}${attributes.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('')}` : null,
    index: focusables().indexOf(el),
  };
}

function restoreFocus(mark) {
  if (!mark) return;
  const list = focusables();
  const el = (mark.selector && content.querySelector(mark.selector)) || list[Math.min(mark.index, list.length - 1)];
  (el || content).focus({ preventScroll: true });
}

function renderContent() {
  const info = itemInfo(selection);
  $('toolbar-title').textContent = info.title;
  const scroll = content.scrollTop;
  const mark = focusMark();
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
  restoreFocus(mark);
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
        <div class="panel graphics-panel layout-panel">
          ${graphicsRow('Layout', `Handheld makes text and buttons larger for small screens held at arm's length. Automatic uses it on small touch screens${S.handheld && S.layout === 'auto' ? ', like this one' : ''}.`,
            `<div class="segmented">${[['auto', 'Automatic'], ['handheld', 'Handheld'], ['standard', 'Standard']].map(([value, label]) =>
              `<button class="${S.layout === value ? 'active' : ''}" data-layout="${value}">${label}</button>`).join('')}</div>`)}
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
              ? 'Ready. These buttons work everywhere in RetroHub:'
              : 'Connect one, then press any button so RetroHub can see it. Built-in controls on handhelds count too.'}</div>
          </div>
        </div>
        <div class="panel controls-list">${[
          ['D-pad / stick', 'Move (hold to keep going)'], ['A', 'Play, or press the button that\'s picked'], ['B', 'Back'],
          ['X', 'Game options'], ['Y', 'Favorite'], ['LB / RB', 'Previous / next system'],
          ['Start / Menu', 'Couch mode, full screen'], ['Select / View', 'Setup'],
        ].map(([button, action]) => `<div class="control-row"><span class="button-badge">${esc(button)}</span><span>${esc(action)}</span></div>`).join('')}</div>
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
    const sure = await openDialog({
      title: count === 1 ? 'Remove the missing game?' : `Remove all ${count} missing games?`,
      message: 'Their favorites and play history are forgotten.',
      buttons: [{ label: 'Remove', value: true, destructive: true }, { label: 'Cancel', value: false, primary: true }],
      cancel: false,
    });
    if (!sure) return;
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
  const hint = (button, label, cmd, optional = false) =>
    `<button class="hint${optional ? ' optional' : ''}" data-command="${cmd}"><span class="button-badge">${button}</span><span class="label">${label}</span></button>`;
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
    <div class="couch-hints">${hint('A', 'Play', 'play')}${hint('X', 'Options', 'menu', true)}${hint('Y', 'Favorite', 'favorite')}${hint('LB RB', 'Switch', 'next')}${hint('Select', 'Setup', 'setup', true)}${hint('B', 'Exit', 'back')}</div>`;
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
  setupFromCouch = false;
  const keys = couchKeys();
  if (on && keys.length && !keys.includes(selection)) selection = keys[0];
  couchIndex = pickedIndex();
  api.setFullScreen(on || S.consoleMode);
  render();
  if (!on) content.focus();
}

// ---- Dialogs -----------------------------------------------------------------------

/** The open dialog: { buttons, cancel, resolve, returnFocus }, or null. */
let dialog = null;

/**
 * An in-app dialog, which works with a controller, touch, the keyboard and the mouse (the system's
 * own dialogs and menus don't take a controller). Resolves with the chosen button's value, or with
 * `cancel` for B, Esc or a tap outside. Focus goes to the first button and back to where it was.
 */
function openDialog({ title, message = '', alert = true, buttons, cancel = null }) {
  const returnFocus = dialog ? dialog.returnFocus : document.activeElement;
  if (dialog) dialog.resolve(dialog.cancel);
  hideLaunching();
  $('modal-title').textContent = title;
  $('modal-message').textContent = message;
  $('modal-message').hidden = !message;
  modal.querySelector('.modal-icon').innerHTML = alert ? I.alert({ size: 34 }) : '';
  $('modal-actions').innerHTML = buttons.map((b, i) =>
    `<button class="button${b.primary ? ' primary' : ''}${b.destructive ? ' destructive' : ''}" data-dialog="${i}">${esc(b.label)}</button>`).join('');
  modal.hidden = false;
  $('modal-actions').querySelector('button').focus();
  return new Promise((resolve) => {
    dialog = { buttons, cancel, returnFocus, resolve: (value) => {
      dialog = null;
      modal.hidden = true;
      const back = returnFocus && returnFocus !== document.body && document.contains(returnFocus) ? returnFocus : content;
      back.focus({ preventScroll: true });
      resolve(value);
    } };
  });
}

const closeDialog = () => dialog?.resolve(dialog.cancel);

function showModal(message, title = "Couldn't start the game") {
  return openDialog({ title, message, buttons: [{ label: 'OK', primary: true, value: true }], cancel: true });
}

/** Play, favorite or show a game: X on the controller, right-click, a long press, or the Menu key. */
async function gameMenu(id) {
  const game = allGames().find((g) => g.id === id);
  if (!game) return;
  const favorite = S.favorites.includes(id);
  const choice = await openDialog({
    title: game.displayTitle,
    message: systemById(game.system).name,
    alert: false,
    buttons: [
      { label: 'Play', value: 'play', primary: true },
      { label: favorite ? 'Remove from Favorites' : 'Add to Favorites', value: 'favorite' },
      { label: S.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder', value: 'show' },
      { label: 'Cancel', value: null },
    ],
  });
  if (choice === 'play') play(id);
  else if (choice === 'favorite') api.toggleFavorite(id);
  else if (choice === 'show') api.showFile(id);
}

/** A short message at the bottom that goes away by itself, such as a controller connecting. */
function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---- Actions -----------------------------------------------------------------------

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
  if (result.busy) return hideLaunching();
  if (!document.hasFocus()) return hideLaunching(); // The emulator is already in front.
  if (launching?.id === id) showLaunching(game, result.label);
  if (couch && selection === 'recent') couchIndex = 0; // The game just moved to the front.
}

function select(id, scroll = false) {
  selectedGame[selection] = id;
  content.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
  const card = content.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  card?.classList.add('selected');
  if (scroll) card?.scrollIntoView({ block: 'nearest', behavior: inputMode() === 'pointer' ? 'smooth' : 'auto' });
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

/**
 * Moves the picked game. Off the left edge of the grid goes to the sidebar, and off the top to the
 * buttons above it (the Library changed banner, Get <emulator>), so the controller reaches them.
 */
function move(dx, dy) {
  const games = visibleGames();
  if (!games.length) return;
  const current = games.findIndex((g) => g.id === selectedGame[selection]);
  if (current < 0) return select(games[0].id, true);
  const columns = gridColumns();
  if (dx < 0 && current % columns === 0) return focusSidebar();
  if (dy < 0 && current < columns) {
    const above = focusables();
    if (above.length) return focusElement(above[above.length - 1]);
  }
  const next = Math.min(Math.max(current + dx + dy * columns, 0), games.length - 1);
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

/** The buttons the D-pad can reach in a part of the window, in page order. Play buttons on covers are for the mouse. */
function focusables(root = content) {
  return [...root.querySelectorAll('button, input, select, [tabindex="0"]')]
    .filter((el) => !el.disabled && !el.matches('.play-button') && el.getClientRects().length);
}

function focusElement(el) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

/** Moves focus to the nearest button that way; false when there's none. */
function moveFocus(direction, root = content) {
  const list = focusables(root);
  const from = list.indexOf(document.activeElement);
  if (from < 0) {
    if (list[0]) focusElement(list[0]);
    return !!list[0];
  }
  const next = SPATIAL.nextInDirection(list.map((el) => el.getBoundingClientRect()), from, direction);
  if (next < 0) return false;
  focusElement(list[next]);
  return true;
}

/** Into the page from the sidebar: the games, or the first button on a page without games. */
function enterContent() {
  if (gamesFor(selection).length && selection !== 'setup' && selection !== 'check') return content.focus();
  const first = focusables()[0];
  first ? focusElement(first) : content.focus();
}

/** Setup from couch mode (Select): B on Setup goes back to couch mode. */
let setupFromCouch = false;

const DIRECTIONS = ['up', 'down', 'left', 'right'];

/**
 * Handles a controller or keyboard command. What it does depends on where focus is: a dialog, the
 * sidebar, buttons on a page, or the game grid. B always goes back a step, so focus is never stuck.
 */
function command(cmd) {
  if (dialog) {
    if (DIRECTIONS.includes(cmd)) moveFocus(cmd, modal);
    else if (cmd === 'play') (modal.contains(document.activeElement) && document.activeElement.matches('button') ? document.activeElement : $('modal-actions').querySelector('button'))?.click();
    else if (cmd === 'back') closeDialog();
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
      case 'menu': return games[couchIndex] && gameMenu(games[couchIndex].id);
      case 'setup':
        show('setup');
        setupFromCouch = true;
        return enterContent();
      case 'back': case 'couch': return setCouch(false);
    }
    return;
  }
  switch (cmd) {
    case 'prev': return cycle(-1);
    case 'next': return cycle(1);
    case 'couch': return setCouch(true);
    case 'setup':
      show('setup');
      return enterContent();
  }
  const active = document.activeElement;
  if (nav.contains(active)) {
    if (cmd === 'up' || cmd === 'down') return stepSidebar(cmd === 'up' ? -1 : 1);
    if (cmd === 'right' || cmd === 'play') return enterContent();
    return;
  }
  const onButton = content.contains(active) && active !== content;
  const games = selection === 'setup' || selection === 'check' ? [] : visibleGames();
  // Buttons: Setup, Library Check, a page without games, or the buttons above the games.
  if (onButton || !games.length) {
    if (DIRECTIONS.includes(cmd)) {
      if (moveFocus(cmd)) return;
      if (cmd === 'left') return focusSidebar();
      if (cmd === 'down' && games.length) return content.focus();
      return;
    }
    if (cmd === 'play') return onButton ? active.click() : enterContent();
    if (cmd === 'back') {
      if (setupFromCouch && selection === 'setup') return setCouch(true);
      return onButton && games.length ? content.focus() : focusSidebar();
    }
    return;
  }
  if (!content.contains(active)) content.focus(); // From the search field, say: the games take the controller.
  const id = selectedGame[selection];
  switch (cmd) {
    case 'left': return move(-1, 0);
    case 'right': return move(1, 0);
    case 'up': return move(0, -1);
    case 'down': return move(0, 1);
    case 'play': return id && games.some((g) => g.id === id) && play(id);
    case 'favorite': return id && api.toggleFavorite(id);
    case 'menu': return id && games.some((g) => g.id === id) && gameMenu(id);
    case 'back': return focusSidebar();
  }
}

// ---- Events ------------------------------------------------------------------------

/**
 * How the window is being used: 'nav' (controller or keyboard), so the focused button gets a
 * clear outline, or 'pointer' (mouse or touch). lastPointer is 'mouse', 'touch' or 'pen'.
 */
let lastPointer = 'mouse';
const inputMode = () => document.documentElement.dataset.input || 'pointer';
const setInputMode = (mode) => { document.documentElement.dataset.input = mode; };
window.addEventListener('pointerdown', (event) => {
  lastPointer = event.pointerType;
  setInputMode('pointer');
}, true);

nav.addEventListener('click', (event) => {
  const item = event.target.closest('[data-key]');
  if (!item) return;
  selection = item.dataset.key;
  render();
  focusSidebar();
});

async function handleButtons(event) {
  const target = event.target.closest('[data-download], [data-open-folder], [data-choose-root], [data-locate], [data-play], [data-exit], [data-tab], [data-graphics], [data-appearance], [data-layout], [data-show], [data-check], [data-command]');
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
  else if ('layout' in d) applyState(await api.setLayout(d.layout));
  else if ('show' in d) { show(d.show); enterContent(); }
  else if ('check' in d) await checkAction(d.check, target);
  else if ('command' in d) command(d.command);
  return true;
}

content.addEventListener('click', async (event) => {
  if (await handleButtons(event)) return;
  const card = event.target.closest('.card');
  if (card) {
    // On a touch screen, a tap picks a game and a second tap plays it.
    const picked = card.classList.contains('selected');
    select(card.dataset.id);
    content.focus();
    if (picked && lastPointer === 'touch') play(card.dataset.id);
  }
});
content.addEventListener('dblclick', (event) => {
  const card = event.target.closest('.card');
  if (card && !event.target.closest('button') && lastPointer !== 'touch') play(card.dataset.id);
});
content.addEventListener('contextmenu', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  event.preventDefault();
  select(card.dataset.id);
  gameMenu(card.dataset.id);
});

couchEl.addEventListener('click', async (event) => {
  if (await handleButtons(event)) return;
  const el = event.target.closest('[data-index]');
  if (el) {
    const index = Number(el.dataset.index);
    if (index === couchIndex && lastPointer === 'touch') return command('play');
    couchIndex = index;
    updateCouch();
  }
});
couchEl.addEventListener('dblclick', (event) => {
  const el = event.target.closest('[data-index]');
  if (el && lastPointer !== 'touch') command('play');
});
couchEl.addEventListener('contextmenu', (event) => {
  const el = event.target.closest('[data-index]');
  if (!el) return;
  event.preventDefault();
  couchIndex = Number(el.dataset.index);
  updateCouch();
  command('menu');
});

modal.addEventListener('click', (event) => {
  const button = event.target.closest('[data-dialog]');
  if (button && dialog) dialog.resolve(dialog.buttons[Number(button.dataset.dialog)].value);
  else if (event.target === modal) closeDialog(); // A tap outside the box.
});

$('couch-button').innerHTML = I.tv({ size: 18 });
$('rescan-button').innerHTML = I.refresh({ size: 17 });
document.querySelector('.search-icon').innerHTML = I.search({ size: 14 });
$('couch-button').addEventListener('click', () => setCouch(true));
$('rescan-button').addEventListener('click', async () => applyState(await api.rescan(), true));
$('search').addEventListener('input', (event) => {
  search = event.target.value;
  renderContent();
});

const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'play', f: 'favorite', F: 'favorite',
               Escape: 'back', ContextMenu: 'menu' };
// Ctrl (⌘ on a Mac) shortcuts, as in the Mac app's menus: Setup, Find, Previous/Next System, Rescan.
const SHORTCUTS = {
  ',': () => command('setup'),
  f: findGames,
  '[': () => cycle(-1),
  ']': () => cycle(1),
  r: async () => applyState(await api.rescan(), true),
};
window.addEventListener('keydown', (event) => {
  setInputMode('nav');
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const shortcut = !dialog && SHORTCUTS[event.key.toLowerCase()];
    if (shortcut) {
      event.preventDefault();
      shortcut();
    }
    return; // Copy, paste and the rest behave as usual.
  }
  if (event.key === 'Tab' && dialog) {
    // Tab stays in the dialog.
    const buttons = focusables(modal);
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    return;
  }
  if (event.target.id === 'search' && !dialog) {
    if (event.key === 'Escape') event.target.blur();
    if (event.key === 'Enter' || event.key === 'ArrowDown') content.focus();
    return;
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

// Standard gamepad mapping: 0 A/✕, 1 B/○, 2 X/□, 3 Y/△, 4 LB, 5 RB, 8 View/Select/Share, 9 Menu/Start/Options,
// 12–15 D-pad. Steam Deck, ROG Ally and Legion Go controllers report the same layout.
const BUTTONS = { 0: 'play', 1: 'back', 2: 'menu', 3: 'favorite', 4: 'prev', 5: 'next', 8: 'setup', 9: 'couch',
                  12: 'up', 13: 'down', 14: 'left', 15: 'right' };
/** Held directions repeat, so a long list doesn't take a press per game: after this long, this often. */
const REPEAT_DELAY_MS = 500;
const REPEAT_EVERY_MS = 90;
/** Inputs held down: key → { since, last } (when it was pressed, and when it last fired). */
const held = new Map();

function cleanPadName(id) {
  return id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || 'Controller';
}

/**
 * Fires a command when an input goes from released to pressed, then again while a direction is
 * held, but only while RetroHub is in front (not while a game is).
 */
function edge(key, down, cmd, now) {
  const state = held.get(key);
  if (!down) {
    held.delete(key);
    return;
  }
  if (!state) {
    held.set(key, { since: now, last: now });
  } else if (DIRECTIONS.includes(cmd) && now - state.since >= REPEAT_DELAY_MS && now - state.last >= REPEAT_EVERY_MS) {
    state.last = now;
  } else {
    return;
  }
  if (!document.hasFocus()) return;
  setInputMode('nav');
  command(cmd);
}

function pollGamepads(now) {
  const pads = [...navigator.getGamepads()].filter((pad) => pad && pad.connected !== false);
  const name = pads[0] ? cleanPadName(pads[0].id) : null;
  if (name !== padName) {
    // Not at startup: a controller that's already connected isn't news.
    if (pollGamepads.started) showToast(name ? `${name} connected` : 'Controller disconnected');
    padName = name;
    renderController();
    if (selection === 'setup' && !couch) renderContent();
  }
  pollGamepads.started = true;
  // A controller that goes away mid-press mustn't leave a direction repeating.
  const connected = new Set(pads.map((pad) => `${pad.index}:`));
  for (const key of held.keys()) if (![...connected].some((prefix) => key.startsWith(prefix))) held.delete(key);
  for (const pad of pads) {
    for (const [index, cmd] of Object.entries(BUTTONS)) edge(`${pad.index}:${index}`, !!pad.buttons[index]?.pressed, cmd, now);
    const [x = 0, y = 0] = pad.axes;
    edge(`${pad.index}:x-`, x < -0.6, 'left', now);
    edge(`${pad.index}:x+`, x > 0.6, 'right', now);
    edge(`${pad.index}:y-`, y < -0.6, 'up', now);
    edge(`${pad.index}:y+`, y > 0.6, 'down', now);
  }
  requestAnimationFrame(pollGamepads);
}

// ---- Startup -------------------------------------------------------------------------

function applyState(state, force = false) {
  const json = JSON.stringify(state);
  if (!force && json === lastStateJSON) return;
  lastStateJSON = json;
  S = state;
  document.documentElement.classList.toggle('handheld', !!S.handheld);
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
