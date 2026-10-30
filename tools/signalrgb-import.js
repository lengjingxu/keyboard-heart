#!/usr/bin/env node
/**
 * signalrgb-import.js — convert a SignalRGB community plugin into a
 * keyboard-heart profile. SignalRGB plugins are plain JS driving the same
 * kind of 65-byte HID reports, so their VendorId/ProductId + key tables
 * translate directly.
 *
 * Usage:
 *   node tools/signalrgb-import.js <plugin-file-or-URL> [--out profiles/]
 *
 * Example (from this project's origins):
 *   node tools/signalrgb-import.js \
 *     https://raw.githubusercontent.com/Luk-Krn/mchose_ace68/HEAD/hid/MCHOSE_Ace68.js
 *
 * Output profile is `verified: false` — calibrate on a real device first
 * (docs/CONTRIBUTING-PROFILES.md).
 */
const fs = require('fs');
const path = require('path');
const { KEY_NAMES, KEY_POSITIONS } = require('../lib/grid');

const num = v => parseInt(v, 16);

function parsePlugin(src) {
  const vendorId = src.match(/VendorId\(\)\s*{\s*return\s*(0x[0-9a-f]+)/i);
  const productId = src.match(/ProductId\(\)\s*{\s*return\s*(0x[0-9a-f]+)/i);
  const name = src.match(/device\.setName\("([^"]+)"\)/) || src.match(/export function Name\(\)\s*{\s*return "([^"]+)"/);
  // vKeyNames/vKeys/vKeyPositions arrays
  const arr = (name_) => {
    const m = src.match(new RegExp(`const ${name_}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    if (!m) return null;
    if (name_ === 'vKeyNames') return m[1].match(/"((?:[^"\\]|\\.)*)"/g).map(s => JSON.parse(s));
    return m[1].match(/-?\d+/g).map(Number);
  };
  const keyNames = arr('vKeyNames');
  const keys = arr('vKeys');
  const positions = arr('vKeyPositions');
  if (!vendorId || !productId || !keyNames || !keys) {
    throw new Error('not a recognizable SignalRGB plugin (need VendorId/ProductId/vKeyNames/vKeys)');
  }
  return {
    vendorId: num(vendorId[1]),
    productId: num(productId[1]),
    name: name ? name[1] : `SignalRGB ${num(vendorId[1]).toString(16)}:${num(productId[1]).toString(16)}`,
    keyNames, keys, positions,
  };
}

function pluginTableToProfile(parsed) {
  // Prefer PHYSICAL alignment: SignalRGB plugins carry vKeyPositions on the
  // same 16x5 grid we use, so map each plugin key's slot onto the canonical
  // key that occupies the same (x,y). This is immune to naming differences
  // between boards (e.g. wired right column ~ / Del / PgUp / PgDn vs air_2's
  // Ins / Del / PgUp / PgDn).
  if (parsed.positions && parsed.positions.length === parsed.keyNames.length * 2) {
    const posToCanonical = new Map(KEY_POSITIONS.map(([x, y], i) => [`${x},${y}`, i]));
    const table = new Array(KEY_NAMES.length).fill(-1);
    const used = new Set();
    parsed.keyNames.forEach((rawName, i) => {
      const x = parsed.positions[i * 2], y = parsed.positions[i * 2 + 1];
      const ci = posToCanonical.get(`${x},${y}`);
      if (ci !== undefined && !used.has(ci)) { table[ci] = parsed.keys[i]; used.add(ci); }
    });
    return table;
  }
  // Fallback: name-based alignment with limited aliasing.
  const alias = {
    'left shift': 'LShift', 'right shift': 'RShift', 'left ctrl': 'LCtrl', 'right ctrl': 'RCtrl',
    'left alt': 'LAlt', 'right alt': 'RAlt', 'left win': 'LWin', 'right win': 'LWin',
    'up arrow': 'Up', 'down arrow': 'Down', 'left arrow': 'Left', 'right arrow': 'Right',
    capslock: 'CapsLock', backspace: 'Backspace', enter: 'Enter', del: 'Del', delete: 'Del',
    pgup: 'PgUp', pgdn: 'PgDn', ins: 'Ins', insert: 'Ins', esc: 'Esc', tab: 'Tab',
    '-_': '-', '=+': '=', '~': 'Ins',
  };
  const hwOf = {};   // canonical → first hw slot seen
  parsed.keyNames.forEach((rawName, i) => {
    const n = alias[rawName.toLowerCase()] ?? (alias[rawName] ?? rawName);
    const canonical = KEY_NAMES.find(k => k.toLowerCase() === n.toLowerCase());
    if (canonical && !(canonical in hwOf)) hwOf[canonical] = parsed.keys[i];
  });
  return KEY_NAMES.map(k => (hwOf[k] !== undefined ? hwOf[k] : -1));
}

async function main() {
  const srcPath = process.argv[2];
  if (!srcPath) throw new Error('usage: node tools/signalrgb-import.js <plugin-file-or-URL> [--out profiles/]');
  const outDirIdx = process.argv.indexOf('--out');
  const outDir = outDirIdx > -1 ? path.resolve(process.argv[outDirIdx + 1]) : path.join(__dirname, '..', 'profiles');

  const src = srcPath.startsWith('http')
    ? await (await fetch(srcPath)).text()
    : fs.readFileSync(srcPath, 'utf8');
  const parsed = parsePlugin(src);
  const table = pluginTableToProfile(parsed);
  const matched = table.filter(v => v >= 0).length;
  const posCount = parsed.positions ? parsed.positions.length / 2 : 0;
  // only accept layouts that look like our 65% board (68 keys)
  if (parsed.keyNames.length !== KEY_NAMES.length) {
    throw new Error(`plugin has ${parsed.keyNames.length} keys; only 68-key (65%) layouts are supported for auto-import — contribute manually (docs/CONTRIBUTING-PROFILES.md)`);
  }
  const gridCompat = posCount === KEY_NAMES.length;
  const id = `sig-${parsed.vendorId.toString(16)}-${parsed.productId.toString(16)}`;
  const profile = {
    id,
    name: parsed.name,
    vendorId: '0x' + parsed.vendorId.toString(16),
    productId: '0x' + parsed.productId.toString(16),
    interface: 1,
    layout: '65',
    table,
    verified: false,
    source: `SignalRGB plugin import from ${srcPath.startsWith('http') ? srcPath : path.basename(srcPath)} (${new Date().toISOString().slice(0, 10)})`,
    quirks: [
      `candidate: calibrate with rainbow/gridtest on a real device (${matched}/68 canonical keys matched, grid ${gridCompat ? 'compatible' : 'rebuilt'})`,
      'rename the id to the board\'s community name before submitting a PR',
    ],
  };
  const out = path.join(outDir, id + '.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');
  console.log(`profile written: ${out}`);
  console.log(`  ${parsed.name}  ${profile.vendorId}:${profile.productId}  matched ${matched}/68`);
  console.log('  NEXT: flash a rainbow (node heart.js rainbow) and eyeball whether colors land on the right keys.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
