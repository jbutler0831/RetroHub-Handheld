// Settings and library files. Each is written to a temporary file and renamed into place, so a crash,
// a power cut or a handheld going to sleep mid-write leaves the old file whole, never half a file.
// The last copy that read cleanly is kept as <file>.bak, and a damaged file is set aside, never
// overwritten, so favorites and play history can't be lost to one bad write.
const fs = require('fs');
const path = require('path');

/** Writes text to file in one step: readers see the old contents or the new, nothing in between. */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/** The object in a JSON file, or null when it can't be read or isn't a JSON object. */
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Reads a JSON object file: { data, text, recovered, setAside }.
 *   recovered null: read as usual, or there's no file yet (data null)
 *   recovered 'backup': the file was damaged; data comes from <file>.bak
 *   recovered 'reset': the file was damaged and there's no usable backup; data null
 * A damaged file is renamed to <file>.damaged-<time> (setAside) so the next save can't replace it.
 * A file that reads cleanly becomes the new backup.
 */
function readJSON(file, { now = Date.now() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { data: null, text: '', recovered: null, setAside: null };
  }
  const data = text === undefined ? null : parseObject(text);
  if (data) {
    try { writeFileAtomic(`${file}.bak`, text); } catch { /* a read-only folder: no backup */ }
    return { data, text, recovered: null, setAside: null };
  }
  let setAside = `${file}.damaged-${now}`;
  try { fs.renameSync(file, setAside); } catch { setAside = null; }
  let backup = null;
  try { backup = parseObject(fs.readFileSync(`${file}.bak`, 'utf8')); } catch { /* no backup */ }
  return backup ? { data: backup, text: '', recovered: 'backup', setAside } : { data: null, text: '', recovered: 'reset', setAside };
}

module.exports = { writeFileAtomic, readJSON };
