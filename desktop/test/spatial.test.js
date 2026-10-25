// D-pad movement between buttons: the nearest in that direction, preferring the same row or column.
const test = require('node:test');
const assert = require('node:assert');
const { nextInDirection } = require('../src/renderer/spatial');

const box = (left, top, width = 100, height = 30) => ({ left, top, right: left + width, bottom: top + height });

// A Setup-like page: a row of three segmented buttons, a wide button below, and a lone button
// further down on the right.
//   [0][1][2]
//   [   3   ]
//          [4]
const page = [box(0, 0), box(110, 0), box(220, 0), box(0, 60, 320), box(300, 140)];

test('left and right stay in the row', () => {
  assert.strictEqual(nextInDirection(page, 0, 'right'), 1);
  assert.strictEqual(nextInDirection(page, 1, 'right'), 2);
  assert.strictEqual(nextInDirection(page, 1, 'left'), 0);
});

test('nothing that way is -1, so the caller can leave the page (to the sidebar, say)', () => {
  assert.strictEqual(nextInDirection(page, 0, 'left'), -1);
  assert.strictEqual(nextInDirection(page, 0, 'up'), -1);
  assert.strictEqual(nextInDirection(page, 4, 'down'), -1);
});

test('up and down go to the row above or below, the one in line first', () => {
  assert.strictEqual(nextInDirection(page, 1, 'down'), 3);
  assert.strictEqual(nextInDirection(page, 3, 'down'), 4);
  assert.strictEqual(nextInDirection(page, 4, 'up'), 3);
  // From the wide button, up goes to the button above its centre.
  assert.strictEqual(nextInDirection(page, 3, 'up'), 1);
});

test('a button in line but further away beats a closer one out of line', () => {
  const rects = [box(0, 0), box(400, 0), box(120, 40)];
  assert.strictEqual(nextInDirection(rects, 0, 'right'), 1);
});

test('no rects or an unknown start is -1', () => {
  assert.strictEqual(nextInDirection([], 0, 'down'), -1);
  assert.strictEqual(nextInDirection(page, 9, 'down'), -1);
});
