'use strict';
/**
 * Preset animations. Each preset is a factory returning:
 *   { name, priority, sticky?, duration, frameAt(tMs) -> 392-byte buffer }
 * frameAt builds on a snapshot of the current static buffer so animations
 * overlay (max-blend) whatever was on the keys before.
 */
const { makeGrid, FRAME_BYTES } = require('./grid');

const PRIORITY = { ambient: 1, event: 2, critical: 3 };

const HEART_KEYS = [
  // compact centered heart (22 keys): bumps on the number row, widest on QWERTY
  '4', '5', '7', '8',
  'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P',
  'F', 'G', 'H', 'J', 'K', 'L',
  'V', 'B', 'N', 'M',
];

// perimeter walk for the processing comet, clockwise from bottom-left
const PERIMETER = (() => {
  const pts = [];
  for (let y = 4; y >= 0; y--) pts.push([0, y]);
  for (let x = 1; x <= 15; x++) pts.push([x, 0]);
  for (let y = 1; y <= 4; y++) pts.push([15, y]);
  for (let x = 14; x >= 1; x--) pts.push([x, 4]);
  return pts;
})();

const clamp01 = v => Math.max(0, Math.min(1, v));
const gauss = (d, sigma) => Math.exp(-(d * d) / (2 * sigma * sigma));

function makeAnimations(profile) {
  const grid = makeGrid(profile);
  const { keys, maxDist } = grid;

  function base(fixed = {}) {
    const buf = new Array(FRAME_BYTES).fill(0);
    for (const [name, rgb] of Object.entries(fixed)) {
      const k = grid.key(name);
      if (k) { buf[k.hwSlot * 3] = rgb[0]; buf[k.hwSlot * 3 + 1] = rgb[1]; buf[k.hwSlot * 3 + 2] = rgb[2]; }
    }
    return buf;
  }

  /** paint color onto buf with max-blend per channel; skips slot-less keys */
  function paint(buf, key, rgb, intensity = 1) {
    if (key.hwSlot < 0) return;
    const i = key.hwSlot * 3;
    for (let c = 0; c < 3; c++) buf[i + c] = Math.max(buf[i + c], Math.round(rgb[c] * intensity));
  }

  /** radial ripple ring expanding from (x0,y0), gaussian band */
  function ripple(buf, x0, y0, t01, rgb, { sigma = 1.1, speed = 1.25, glow = 0.25 } = {}) {
    const radius = t01 * maxDist(x0, y0) * speed;
    for (const k of keys) {
      const d = grid.dist(k.index, x0, y0);
      const band = gauss(d - radius, sigma);
      const trail = d < radius ? glow * gauss(d - radius * 0.4, radius / 2 + 0.001) : 0;
      paint(buf, k, rgb, Math.min(1, band + trail));
    }
  }

  const presets = {
    /** green shockwave from bottom-left (LCtrl): success — clean ring over black, no trail */
    success: {
      priority: PRIORITY.event, duration: 2000,
      frameAt(tMs) {
        const buf = new Array(FRAME_BYTES).fill(0); // black base: passed keys go fully dark
        ripple(buf, 0, 4, clamp01(tMs / 1200), [0, 255, 60], { sigma: 0.55, glow: 0 });
        return buf;
      },
    },

    /** red burst pulsing from the top-right corner (Del): expand ~4 rows,
     *  retract, three times — failure */
    failure: {
      priority: PRIORITY.critical, duration: 2800,
      frameAt(tMs) {
        const buf = new Array(FRAME_BYTES).fill(0);
        const PULSE = 850, GAP = 80, CYCLE = PULSE + GAP;
        const EXPAND = 320, HOLD = 180, MAX_R = 4.2, PULSES = 3;
        const pulse = Math.floor(tMs / CYCLE);
        if (pulse >= PULSES) return buf;      // settle to black between bursts
        const t = tMs % CYCLE;
        let radius;
        if (t < EXPAND) radius = (t / EXPAND) * MAX_R;
        else if (t < EXPAND + HOLD) radius = MAX_R;
        else radius = Math.max(0, (1 - (t - EXPAND - HOLD) / (PULSE - EXPAND - HOLD)) * MAX_R);
        for (const k of keys) {
          if (k.hwSlot < 0) continue;
          const d = grid.dist(k.index, 15, 0);
          if (d <= radius) {
            const edge = clamp01((radius - d) / 1.1);          // soft boundary
            const fall = 0.9 - 0.45 * Math.min(1, d / 6);      // corner brightest
            paint(buf, k, [255, 30, 20], fall * edge);
          }
        }
        return buf;
      },
    },

    /** amber rows light one-by-one up from the bottom, then retract row-by-row
     *  back down, then the bottom row breathes — needs your input (sticky) */
    needInput: {
      priority: PRIORITY.event, sticky: true, duration: Infinity,
      frameAt(tMs) {
        const buf = new Array(FRAME_BYTES).fill(0);
        const AMBER = [255, 170, 0];
        const STEP = 100;                       // ms per row, discrete snap
        const GROW = STEP * 4, HOLD = 180, RETRACT = STEP * 4;
        const CYCLE = GROW + HOLD + RETRACT + 700;
        const t = tMs % CYCLE;
        const rowKeys = y => keys.filter(k => k.y === y);
        const paintRow = (y, v) => { for (const k of rowKeys(y)) paint(buf, k, AMBER, v); };
        const growSteps = Math.floor(t / STEP);                     // rows lit: 4,3,2,1
        const retractStart = GROW + HOLD;
        const retractSteps = t >= retractStart ? Math.floor((t - retractStart) / STEP) : -1;
        const litRows = new Set();
        if (t < retractStart) {
          // grow upward: row4 -> row1, one row per step
          for (let s = 0; s <= Math.min(growSteps, 3); s++) litRows.add(4 - s);
        } else if (t < retractStart + RETRACT) {
          // hold all, then extinguish top-down: row1 -> row4
          for (let y = 1; y <= 4; y++) litRows.add(y);
          for (let s = 0; s <= Math.min(retractSteps, 3); s++) litRows.delete(1 + s);
        } else {
          // settle: bottom row breathing until the next cycle
          const phase = (t - retractStart - RETRACT) / (CYCLE - retractStart - RETRACT);
          const breath = 0.15 + 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
          paintRow(4, breath);
        }
        for (const y of litRows) paintRow(y, 0.55);
        return buf;
      },
    },

    /** white ripple from board center: generic notification */
    notify: {
      priority: PRIORITY.event, duration: 1000,
      frameAt(tMs) {
        const buf = new Array(FRAME_BYTES).fill(0);
        ripple(buf, 7.5, 2, clamp01(tMs / 900), [255, 255, 255], { sigma: 0.8, glow: 0 });
        return buf;
      },
    },

    /** cyan comet looping the perimeter: working on it (sticky) */
    processing: {
      priority: PRIORITY.ambient, sticky: true, duration: Infinity,
      frameAt(tMs, staticBuf) {
        const buf = staticBuf.slice();
        const lap = 1100;
        const head = ((tMs % lap) / lap) * PERIMETER.length;
        for (let tail = 0; tail < 6; tail++) {
          const idx = Math.floor(head - tail + PERIMETER.length) % PERIMETER.length;
          const [x, y] = PERIMETER[idx];
          const intensity = (1 - tail / 6) * 0.95;
          for (const k of keys) if (k.x === x && k.y === y) paint(buf, k, [0, 220, 255], intensity);
        }
        return buf;
      },
    },

    /** red heart double-thump (compact centered heart) */
    heartbeat: {
      priority: PRIORITY.ambient, duration: 3200,
      frameAt(tMs) {
        const buf = new Array(FRAME_BYTES).fill(0);
        const period = 1500, x = (tMs % period) / period;
        const thump = u => Math.exp(-((u - 0.12) ** 2) / 0.0016) + 0.75 * Math.exp(-((u - 0.32) ** 2) / 0.0025);
        const k = Math.min(1, Math.max(0.15, thump(x))) * 0.85;
        for (const name of HEART_KEYS) paint(buf, grid.key(name), [255, 0, 0], k);
        return buf;
      },
    },
  };

  // attach names so error messages / health report show the preset
  for (const [k, v] of Object.entries(presets)) v.name = k;

  // validate anchors exist in this profile
  for (const name of [...HEART_KEYS, 'Space']) {
    if (!grid.key(name)) throw new Error(`profile ${profile.name}: missing animation anchor key ${name}`);
  }

  return { presets, grid, base };
}

module.exports = { makeAnimations, PRIORITY, HEART_KEYS };
