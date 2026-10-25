// Settings survive a damaged or half-written file: the last good copy is used, and the damaged
// file is kept rather than overwritten.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, readJSON } = require('../src/store');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'retrohub-store-'));

test('no file yet is a first launch, not damage', () => {
  const result = readJSON(path.join(folder(), 'settings.json'));
  assert.deepStrictEqual(result, { data: null, text: '', recovered: null, setAside: null });
});

test('a write replaces the file whole and leaves no temporary file', () => {
  const dir = folder();
  const file = path.join(dir, 'nested/settings.json');
  writeFileAtomic(file, '{"a":1}');
  writeFileAtomic(file, '{"a":2}');
  assert.deepStrictEqual(readJSON(file).data, { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).sort(), ['settings.json', 'settings.json.bak']);
});

test('a file that reads cleanly becomes the backup', () => {
  const file = path.join(folder(), 'settings.json');
  writeFileAtomic(file, '{"favorites":["a"]}');
  readJSON(file);
  assert.strictEqual(fs.readFileSync(`${file}.bak`, 'utf8'), '{"favorites":["a"]}');
});

for (const [name, damaged] of [['empty (a write cut off by a power cut)', ''], ['cut off halfway', '{"favorites":["a"'], ['not an object', '[1,2]'], ['null', 'null']]) {
  test(`a damaged file (${name}) goes back to the backup and is set aside`, () => {
    const file = path.join(folder(), 'settings.json');
    writeFileAtomic(file, '{"favorites":["a"]}');
    readJSON(file); // makes the backup
    fs.writeFileSync(file, damaged);
    const result = readJSON(file, { now: 42 });
    assert.strictEqual(result.recovered, 'backup');
    assert.deepStrictEqual(result.data, { favorites: ['a'] });
    assert.strictEqual(result.setAside, `${file}.damaged-42`);
    assert.strictEqual(fs.readFileSync(`${file}.damaged-42`, 'utf8'), damaged, 'the damaged file is kept as it was');
    assert.ok(!fs.existsSync(file));
  });
}

test('a damaged file with no backup starts over, and keeps the damaged file', () => {
  const file = path.join(folder(), 'settings.json');
  fs.writeFileSync(file, '{oops');
  const result = readJSON(file, { now: 7 });
  assert.strictEqual(result.recovered, 'reset');
  assert.strictEqual(result.data, null);
  assert.strictEqual(fs.readFileSync(`${file}.damaged-7`, 'utf8'), '{oops');
});

test('paths with spaces and other characters work', () => {
  const file = path.join(folder(), "My Games & Stuff (2)/O'Brien's #1/settings.json");
  writeFileAtomic(file, '{"ok":true}');
  assert.deepStrictEqual(readJSON(file).data, { ok: true });
});
