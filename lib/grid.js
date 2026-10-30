'use strict';
/**
 * Device profiles + visual grid geometry for supported keyboards.
 *
 * Profiles are data-driven: profiles/<id>.json maps each physical key of a
 * board (keys of its layout, row-major) to a hardware LED slot. Slot indexing
 * differs between firmware variants even within one board family — community
 * contribution flow is documented in docs/CONTRIBUTING-PROFILES.md.
 *
 * Layouts live in profiles/layouts/<id>.json (key names + grid positions).
 * Profiles with a numeric productId are auto-detectable; candidates with
 * `"productId": null` are extracted tables that still need a real device to
 * confirm the PID and calibrate (they are listed by `kbctl doctor` but not
 * used for detection).
 */
const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'profiles');
const TOTAL_SLOTS = 130;   // LED slots addressable by the realtime frame
const FRAME_BYTES = 392;   // realtime color buffer = 7 chunks x 56 bytes
const GRID_W = 16;
const GRID_H = 5;

function num(v) {
  if (typeof v === 'number') return v;
  return parseInt(String(v), v.startsWith('0x') ? 16 : 10);
}

function loadLayouts() {
  const dir = path.join(PROFILES_DIR, 'layouts');
  const layouts = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const l = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    layouts[l.id] = l;
  }
  return layouts;
}

function loadProfiles(layouts) {
  const detectable = {};
  const candidates = {};
  for (const f of fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'))) {
    const raw = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
    const layout = layouts[raw.layout];
    if (!layout) throw new Error(`profile ${raw.id}: unknown layout ${raw.layout}`);
    if (!Array.isArray(raw.table) || raw.table.length !== layout.keys.length) {
      throw new Error(`profile ${raw.id}: table size ${raw.table?.length} != layout ${layout.keys.length}`);
    }
    const profile = {
      id: raw.id,
      name: raw.name,
      vendorId: num(raw.vendorId),
      productId: raw.productId === null ? null : num(raw.productId),
      interface: raw.interface ?? 1,
      layout: raw.layout,
      hwIds: raw.table,
      verified: !!raw.verified,
      source: raw.source || '',
      quirks: raw.quirks || [],
    };
    if (profile.productId === null) candidates[raw.id] = profile;
    else detectable[raw.id] = profile;
  }
  // guard: two detectable profiles must not share a USB address
  const seenAddr = new Set();
  for (const p of Object.values(detectable)) {
    const addr = `${p.vendorId}:${p.productId}`;
    if (seenAddr.has(addr)) throw new Error(`duplicate USB address ${addr} among detectable profiles`);
    seenAddr.add(addr);
  }
  return { detectable, candidates };
}

const LAYOUTS = loadLayouts();
const { detectable: PROFILES, candidates: PROFILE_CANDIDATES } = loadProfiles(LAYOUTS);

// active layout (65% family for now; per-profile layouts arrive with non-68-key boards)
const LAYOUT = LAYOUTS['65'];
const KEY_NAMES = LAYOUT.keys;
const KEY_POSITIONS = LAYOUT.positions;

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
  KEY_NAMES, KEY_POSITIONS, PROFILES, PROFILE_CANDIDATES, LAYOUTS, TOTAL_SLOTS, FRAME_BYTES, GRID_W, GRID_H,
  keyIndexByName, makeGrid,
};
