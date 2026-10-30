'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { header, updateLedsPayload, ledNameToKey, buildLedMap, parseControllerData } = require('../lib/backends/openrgb');
const { viaPacket, rgbMatrixSet, brightnessByte, rgbToHsv } = require('../lib/backends/via');
const { makeGrid, PROFILES, KEY_POSITIONS } = require('../lib/grid');

test('openrgb header framing', () => {
  const h = header(3, 1050, 20);
  assert.strictEqual(h.length, 16);
  assert.strictEqual(h.toString('ascii', 0, 4), 'ORGB');
  assert.strictEqual(h.readInt32LE(4), 3);
  assert.strictEqual(h.readUInt32LE(8), 1050);
  assert.strictEqual(h.readUInt32LE(12), 20);
});

test('openrgb updateLeds payload matches reference client layout', () => {
  const p = updateLedsPayload([[255, 0, 0], [0, 255, 0]]);
  // u32 sizePrefix (includes itself) + u16 count + 2 * 4-byte colors
  assert.strictEqual(p.length, 4 + 2 + 8);
  assert.strictEqual(p.readUInt32LE(0), 2 + 8 + 4);
  assert.strictEqual(p.readUInt16LE(4), 2);
  assert.deepStrictEqual([...p.slice(6, 10)], [255, 0, 0, 0]);   // r,g,b,pad
  assert.deepStrictEqual([...p.slice(10, 14)], [0, 255, 0, 0]);
});

test('openrgb LED name → canonical key', () => {
  assert.strictEqual(ledNameToKey('Q'), 'Q');
  assert.strictEqual(ledNameToKey('q led'), 'Q');
  assert.strictEqual(ledNameToKey('SPACE'), 'Space');
  assert.strictEqual(ledNameToKey('Backspace'), 'Backspace');
  assert.strictEqual(ledNameToKey('Left Shift'), null);  // multi-word handled by map only for exact matches
  assert.strictEqual(ledNameToKey('SHIFT'), 'LShift');
  assert.strictEqual(ledNameToKey('PgUp'), 'PgUp');
  assert.strictEqual(ledNameToKey('Unknown Zone 7'), null);
});

test('openrgb led map: named LEDs take key slots, unmatched stay null (identity at render)', () => {
  const grid = makeGrid(PROFILES.ace68_air_2);
  const map = buildLedMap(['Q', 'W', 'LED 200'], grid);
  assert.strictEqual(map[0], grid.key('Q').hwSlot);
  assert.strictEqual(map[1], grid.key('W').hwSlot);
  assert.strictEqual(map[2], null); // sendKeyBuffer renders null as identity slot
});

test('openrgb controller data parse (leading fields)', () => {
  const name = (s) => { const b = Buffer.alloc(2 + s.length); b.writeUInt16LE(s.length, 0); b.write(s, 2); return b; };
  const type = Buffer.alloc(4);
  type.writeUInt32LE(5, 0);
  const parts = [type];
  for (const s of ['Test K65', 'ACME', 'a keyboard', 'v1', 'SER123', 'usb:0']) parts.push(name(s));
  const leds = Buffer.alloc(4); leds.writeUInt32LE(1, 0);
  parts.push(leds, name('A'));
  const parsed = parseControllerData(Buffer.concat(parts));
  assert.strictEqual(parsed.type, 5);
  assert.strictEqual(parsed.name, 'Test K65');
  assert.deepStrictEqual(parsed.ledNames, ['A']);
});

test('via packet framing', () => {
  const p = viaPacket(0x01);
  assert.strictEqual(p.length, 32);
  assert.strictEqual(p[0], 0x01);
  const set = rgbMatrixSet(1, [128]);
  assert.strictEqual(set[0], 0x07);
  assert.strictEqual(set[1], 0x03);   // RGB Matrix channel
  assert.strictEqual(set[2], 1);      // brightness value id
  assert.strictEqual(set[3], 128);
});

test('via brightness byte clamps', () => {
  assert.strictEqual(brightnessByte(0), 0);
  assert.strictEqual(brightnessByte(100), 255);
  assert.strictEqual(brightnessByte(50), 128);
});

test('via rgb→hsv known colors', () => {
  assert.deepStrictEqual(rgbToHsv([255, 0, 0]), { h: 0, s: 255, v: 255 });
  assert.strictEqual(rgbToHsv([0, 255, 0]).h, 85);   // 120° ≈ 85/255
  assert.strictEqual(rgbToHsv([0, 0, 255]).h, 170);  // 240° ≈ 170/255
  assert.deepStrictEqual(rgbToHsv([0, 0, 0]), { h: 0, s: 0, v: 0 });
});
