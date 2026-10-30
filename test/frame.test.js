'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { KEY_NAMES, PROFILES, makeGrid, TOTAL_SLOTS, FRAME_BYTES } = require('../lib/grid');
const { keyFramePackets, lightConfigFrames, ddChecksum, cfgChecksum, normalizeColor } = require('../lib/device');

test('key frame packets: structure and checksum', () => {
  const buf = new Array(FRAME_BYTES).fill(0);
  buf[3 * 50] = 200; // light slot 50 red-ish
  const packets = keyFramePackets(buf);
  assert.strictEqual(packets.length, 7);
  for (const [i, p] of packets.entries()) {
    assert.strictEqual(p.length, 65);
    assert.strictEqual(p[0], 0);
    assert.strictEqual(p[1], 0x55);
    assert.strictEqual(p[2], 0xdd);
    assert.strictEqual(p[4], ddChecksum(p), `packet ${i} checksum`);
    assert.strictEqual(p[5], 56);
    assert.strictEqual(p[6] | (p[7] << 8) | (p[8] << 16), i * 56, `packet ${i} offset`);
  }
  // slot 50 (byte offset 150) lives in chunk 2 (offset 112)
  const p2 = packets[2];
  assert.strictEqual(p2[9 + (150 - 112)], 200);
});

test('light config frames match captured templates byte-for-byte', () => {
  // state_red = side red, brightness 100 — the captured ground truth
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates.json'), 'utf8'))['state_red'];
  const built = lightConfigFrames({ color: [0xff, 0x00, 0x00], brightness: 100 });
  for (const [fi, f] of built.entries()) {
    const expected = Buffer.from([0x00, ...tpl[fi]]);
    assert.deepStrictEqual([...f], [...expected], `frame ${fi}`);
  }
});

test('light config checksum covers bytes 4..end of the unprefixed frame', () => {
  const [a] = lightConfigFrames({ color: [0x12, 0x34, 0x56], brightness: 42 });
  const stored = a[4]; // prefixed buffer: frame byte 3 (chk) sits at index 4
  let s = 0;
  for (let c = 5; c < a.length; c++) s += a[c]; // frame bytes [4..63] = prefixed [5..64]
  assert.strictEqual(stored, s & 0xff);
  assert.notStrictEqual(stored, 0); // the NaN→0 bug must stay dead
});

test('light config brightness clamps to 0-100', () => {
  const [a, b] = lightConfigFrames({ brightness: 250 });
  assert.strictEqual(a[34], 100); // prefixed: frame A[33]
  assert.strictEqual(b[26], 100); // prefixed: frame B[25]
  const [c, d] = lightConfigFrames({ brightness: -5 });
  assert.strictEqual(c[34], 0);
  assert.strictEqual(d[26], 0);
});

test('profiles: every key maps to a valid LED slot (or -1 if none)', () => {
  for (const profile of Object.values(PROFILES)) {
    const grid = makeGrid(profile);
    assert.strictEqual(grid.keys.length, 68, profile.name);
    for (const k of grid.keys) {
      assert.ok(k.hwSlot === -1 || (k.hwSlot >= 0 && k.hwSlot < TOTAL_SLOTS), `${profile.name} ${k.name} slot ${k.hwSlot}`);
      assert.ok(k.x >= 0 && k.x <= 15 && k.y >= 0 && k.y <= 4);
    }
    // no duplicate slots within a profile
    const lit = grid.keys.filter(k => k.hwSlot >= 0).map(k => k.hwSlot);
    assert.strictEqual(new Set(lit).size, lit.length, `${profile.name} duplicate slots`);
  }
  // air_2: quote has no dedicated slot — it must not borrow another key's LED
  const air2 = makeGrid(PROFILES.ace68_air_2);
  assert.strictEqual(air2.key("'").hwSlot, -1);
});

test('grid helpers', () => {
  const grid = makeGrid(PROFILES.ace68_air_2);
  assert.strictEqual(grid.key('q').hwSlot, 2);
  assert.strictEqual(grid.key('SPACE').hwSlot, 70);
  assert.strictEqual(grid.key('nope'), undefined);
  assert.ok(grid.maxDist(0, 4) > 15); // bottom-left → far corner distance
});

test('normalizeColor', () => {
  assert.deepStrictEqual(normalizeColor('#ff0000'), [255, 0, 0]);
  assert.deepStrictEqual(normalizeColor('00ff88'), [0, 255, 136]);
  assert.deepStrictEqual(normalizeColor([1, 2, 3]), [1, 2, 3]);
  assert.throws(() => normalizeColor('red'));
});

test('key names sanity: animation anchors exist', () => {
  for (const n of ['LCtrl', 'Del', 'Space', 'Backspace', 'Esc']) {
    assert.ok(KEY_NAMES.some(k => k.toLowerCase() === n.toLowerCase()), n);
  }
});
