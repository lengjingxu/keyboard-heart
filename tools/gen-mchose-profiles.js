#!/usr/bin/env node
/**
 * gen-mchose-profiles.js — batch-extract key tables from MCHOSE's own web
 * console assets into candidate keyboard-heart profiles.
 *
 * The vendor console (www.mchose.com.cn) ships a `default-keys-<device>.js`
 * asset per board; the `index` field is the matrix/LED slot. For the 65%
 * Ace 68 family we verified this maps 1:1 to realtime LED slots (air_2).
 *
 * Usage:
 *   node tools/gen-mchose-profiles.js            # fetch manifest + generate
 *   node tools/gen-mchose-profiles.js --force    # overwrite existing candidates
 *
 * Generated profiles are `verified: false` with `"productId": null` — they
 * need a real device to confirm the PID and calibrate (docs/CONTRIBUTING-PROFILES.md).
 */
const fs = require('fs');
const path = require('path');
const { KEY_NAMES } = require('../lib/grid');

const MANIFEST_URL = 'https://www.mchose.com.cn/cizhou/CZ_SHARED_DATA/asset-manifest.json?v=1';
const ASSET_BASE = 'https://www.mchose.com.cn/cizhou/CZ_SHARED_DATA/';
const PROFILES_DIR = path.join(__dirname, '..', 'profiles');

// vendor name → canonical key name (65% layout). Multi-entry names (Shift,
// Ctrl, Alt) are split left/right by ascending matrix index — validated on
// ace68_air_2 where Shift=0→LShift, Shift=49→RShift, etc.
const ALIASES = {
  esc: 'Esc', tab: 'Tab', caps: 'CapsLock', backspace: 'Backspace', enter: 'Enter',
  delete: 'Del', insert: 'Ins', pgup: 'PgUp', pgdn: 'PgDn', space: 'Space',
  win: 'LWin', fn1: 'Fn', fn: 'Fn',
  '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right',
};
const DIGIT_SYMS = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];
const PUNCT = ['- _', '= +', '[ {', '] }', '\\ |', '; :', ', <', '. >', '/ ?', "' \"", '" \''];

function unescapeJs(s) {
  return s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
}

function parseDefaultKeys(src) {
  const entries = [];
  const re = /\{type:\d+,code1:-?\d+,code2:\d+,code:-?\d+,name:"((?:[^"\\]|\\.)*)",index:(\d+),layer:(\d+)\}/g;
  for (const m of src.matchAll(re)) {
    entries.push({ name: unescapeJs(m[1]), index: parseInt(m[2]), layer: parseInt(m[3]) });
  }
  return entries.filter(e => e.layer === 0);
}

function buildTable(entries) {
  // group duplicates (Shift/Ctrl/Alt pairs) by name
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.name)) groups.set(e.name, []);
    groups.get(e.name).push(e);
  }
  const slotOf = {};   // canonical → hw slot
  for (const [name, list] of groups) {
    const sorted = [...list].sort((a, b) => a.index - b.index);
    if (sorted.length >= 2 && /^(Shift|Ctrl|Alt)$/.test(name)) {
      slotOf['L' + name] = sorted[0].index;
      slotOf['R' + name] = sorted[1].index;
      continue;
    }
    let canonical;
    if (ALIASES[name.toLowerCase()]) canonical = ALIASES[name.toLowerCase()];
    else if (/^([0-9]) (.+)$/.test(name) && DIGIT_SYMS.includes(RegExp.$2)) canonical = RegExp.$1;
    else if (PUNCT.includes(name)) canonical = name[0];
    else if (/^[A-Z]$/.test(name)) canonical = name;
    else continue;   // FN layers, rotary 'RT', blanks…
    if (!(canonical in slotOf)) slotOf[canonical] = sorted[0].index;
  }
  return KEY_NAMES.map(k => (slotOf[k] !== undefined ? slotOf[k] : -1));
}

async function main() {
  const force = process.argv.includes('--force');
  const manifest = await (await fetch(MANIFEST_URL)).json();
  const assets = JSON.stringify(manifest);
  const wanted = [...assets.matchAll(/"(default-keys-([a-z0-9_]+))\.([a-f0-9]+)\.js"/g)]
    .map(m => ({ base: m[1], id: m[2], hash: m[3] }));

  // fetch every asset once; some are re-export stubs pointing at a shared
  // webpack module (e.g. air_iii ← air_ii, turbo_16k/gt ← turbo_8k, pro ← i)
  const files = {};   // id → source
  for (const w of wanted) {
    files[w.id] = await (await fetch(ASSET_BASE + `${w.base}.${w.hash}.js`)).text();
  }
  function entriesOf(id, seen = new Set()) {
    if (seen.has(id)) return [];
    seen.add(id);
    const src = files[id] || '';
    let entries = parseDefaultKeys(src);
    if (entries.length) return entries;
    const ref = src.match(/var s=t\((\d+)\)/);
    if (!ref) return [];
    const host = Object.keys(files).find(k => files[k].includes(`${ref[1]}:(e`) || files[k].includes(`${ref[1]}:(e,f`));
    if (!host) return [];
    return entriesOf(host, seen);
  }

  const family = wanted.filter(w => w.id.startsWith('ace68'));
  console.log(`vendor manifest: ${wanted.length} default-keys assets, ${family.length} in the ace68 (65%) family`);

  const results = [];
  for (const w of family) {
    if (w.id === 'ace68_air_2') { results.push({ id: w.id, skipped: 'hand-verified profile kept' }); continue; }
    const out = path.join(PROFILES_DIR, w.id + '.json');
    if (fs.existsSync(out) && !force) { results.push({ id: w.id, skipped: 'profile exists' }); continue; }
    const entries = entriesOf(w.id);
    if (!entries.length) { results.push({ id: w.id, skipped: 'unparsable (stub unresolved)' }); continue; }
    const table = buildTable(entries);
    const lit = table.filter(v => v >= 0).length;
    fs.writeFileSync(out, JSON.stringify({
      id: w.id,
      name: 'MCHOSE ' + w.id.replace(/_/g, ' ').replace('ace68 ', 'Ace 68 '),
      vendorId: '0x3837',
      productId: null,
      interface: 1,
      layout: '65',
      table,
      verified: false,
      source: `vendor console asset default-keys-${w.id} (auto-extracted ${new Date().toISOString().slice(0, 10)}; stubs resolved to their shared table module)`,
      quirks: ['candidate: confirm PID on a real device and calibrate with `node heart.js rainbow`', `${lit}/68 keys matched the vendor table`],
    }, null, 2) + '\n');
    results.push({ id: w.id, keys: `${lit}/68`, out });
  }
  for (const r of results) console.log(JSON.stringify(r));
  const nonFamily = wanted.filter(w => !w.id.startsWith('ace68')).map(w => w.id);
  console.log(`\nnon-65% assets (need their own layouts before extraction): ${nonFamily.join(', ') || 'none'}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
