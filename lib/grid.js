'use strict';
/**
 * Device profiles + 16x5 visual grid geometry for supported keyboards.
 *
 * A profile maps each of the board's physical keys (listed in KEY_NAMES,
 * row-major) to its hardware LED slot. Slot indexing differs between
 * firmware variants even for the same board family, hence the table.
 */

// Row-major physical key names (65% / 68-key layout, 15+15+14+14+10 keys).
const KEY_NAMES = [
  'Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace', 'Ins',
  'Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\', 'PgUp',
  'CapsLock', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter', 'PgDn',
  'LShift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'RShift', 'Up', 'Del',
  'LCtrl', 'LWin', 'LAlt', 'Space', 'RAlt', 'Fn', 'RCtrl', 'Left', 'Down', 'Right',
];

// Visual 16x5 grid positions (x = column 0..15, y = row 0 top .. 4 bottom),
// following the physical layout of a 65% board. Used for animation geometry.
const KEY_POSITIONS = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [11, 0], [12, 0], [13, 0], [15, 0],
  [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1], [12, 1], [13, 1], [15, 1],
  [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2], [11, 2], [12, 2], [15, 2],
  [0, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3], [10, 3], [11, 3], [12, 3], [14, 3], [15, 3],
  [0, 4], [1, 4], [2, 4], [6, 4], [10, 4], [11, 4], [12, 4], [13, 4], [14, 4], [15, 4],
];

// Ace 68 wired (PID 0x2116): scrambled LED table, reverse-engineered by the
// SignalRGB community plugin (github.com/Luk-Krn/mchose_ace68).
const HW_IDS_ACE68_WIRED = [
  50, 30, 51, 41, 31, 52, 72, 32, 53, 73, 33, 3, 54, 44, 34,
  70, 0, 71, 1, 21, 42, 2, 63, 43, 13, 23, 64, 74, 14, 4,
  60, 10, 61, 11, 62, 12, 22, 46, 26, 47, 67, 77, 48, 24,
  40, 20, 25, 15, 5, 35, 66, 56, 16, 6, 57, 27, 68, 28,
  45, 75, 55, 76, 36, 7, 37, 58, 78, 18,
];

// Ace 68 Air 2 (PID 0x300A): official matrix table extracted from the
// vendor console asset default-keys-ace68_air_2 (index = matrix/LED slot).
// Verified key-by-key against a real device. The quote key has no slot of
// its own in the vendor table (-1 = not directly lightable).
const HW_IDS_ACE68_AIR2 = [
  18, 56, 22, 4, 60, 26, 62, 55, 21, 57, 59, 5, 46, 7, 53,
  54, 2, 74, 6, 42, 8, 1, 39, 3, 23, 41, 61, 43, 27, 9,
  36, 72, 73, 75, 44, 19, 37, 16, 50, 11, 47, -1, 31, 45,
  0, 38, 48, 30, 12, 66, 52, 34, 32, 14, 29, 49, 51, 63,
  10, 64, 28, 70, 68, 13, 67, 33, 69, 15,
];

// Ace 68 variant (PID 0x2114): sequential row-major numbering.
const HW_IDS_ACE68_SEQ = Array.from({ length: 68 }, (_, i) => i);

const PROFILES = {
  ace68_air_2: { name: 'MCHOSE Ace 68 Air 2', vendorId: 0x3837, productId: 0x300a, interface: 1, hwIds: HW_IDS_ACE68_AIR2 },
  ace68_wired: { name: 'MCHOSE Ace 68', vendorId: 0x41e4, productId: 0x2116, interface: 1, hwIds: HW_IDS_ACE68_WIRED },
  ace68_seq: { name: 'MCHOSE Ace 68 (sequential LED)', vendorId: 0x41e4, productId: 0x2114, interface: 1, hwIds: HW_IDS_ACE68_SEQ },
};

const TOTAL_SLOTS = 130;   // LED slots addressable by the realtime frame
const FRAME_BYTES = 392;   // realtime color buffer = 7 chunks x 56 bytes
const GRID_W = 16;
const GRID_H = 5;

/** case-insensitive key-name lookup → key index, or -1 */
function keyIndexByName(name) {
  const n = String(name).trim().toLowerCase();
  return KEY_NAMES.findIndex(k => k.toLowerCase() === n);
}

/**
 * Build a profile runtime: per key index { name, hwSlot, x, y } plus helpers.
 */
function makeGrid(profile) {
  const hwIds = profile.hwIds;
  if (hwIds.length !== KEY_NAMES.length) throw new Error(`profile ${profile.name}: table size mismatch`);
  const keys = KEY_NAMES.map((name, i) => ({
    name, index: i, hwSlot: hwIds[i], x: KEY_POSITIONS[i][0], y: KEY_POSITIONS[i][1],
  }));
  const byName = new Map(keys.map(k => [k.name.toLowerCase(), k]));
  return {
    profile,
    keys,
    byName,
    key(name) { return byName.get(String(name).trim().toLowerCase()); },
    // distance helpers for animation geometry
    dist(i, x0, y0) { const k = keys[i]; return Math.hypot(k.x - x0, k.y - y0); },
    maxDist(x0, y0) { return Math.max(...keys.map(k => Math.hypot(k.x - x0, k.y - y0))); },
  };
}

module.exports = {
  KEY_NAMES, KEY_POSITIONS, PROFILES, TOTAL_SLOTS, FRAME_BYTES, GRID_W, GRID_H,
  keyIndexByName, makeGrid,
};
