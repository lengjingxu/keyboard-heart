#!/usr/bin/env node
/**
 * MCHOSE 65% keyboard direct RGB control CLI.
 * Protocol lives in lib/device.js; key tables in lib/grid.js.
 *
 * Usage: node heart.js <heart|pulse|loop|all|off|demo|rainbow|maptest|slots|lightcfg|tpl> [args]
 *   KBMAP=A|B|C  override device profile (default C = Ace 68 Air 2)
 */
const { PROFILES, makeGrid, FRAME_BYTES } = require('./lib/grid');
const { Keyboard } = require('./lib/device');

const MAP_TO_PROFILE = { A: 'ace68_wired', B: 'ace68_seq', C: 'ace68_air_2' };
const profile = PROFILES[process.env.KBMAP && MAP_TO_PROFILE[process.env.KBMAP] || 'ace68_air_2'];
const grid = makeGrid(profile);

const HEART_KEYS = [
  '2', '3', '0', '-',
  'Q', 'W', 'E', 'R', 'O', 'P', '[', ']',
  'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';',
  'C', 'V', 'B', 'N', 'M', ',',
];
const RED = [255, 0, 0];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = new Keyboard();

function blankBuffer() { return new Array(FRAME_BYTES).fill(0); }

function put(buf, name, rgb) {
  const k = grid.key(name);
  if (!k) throw new Error(`unknown key: ${name}`);
  buf[k.hwSlot * 3] = rgb[0]; buf[k.hwSlot * 3 + 1] = rgb[1]; buf[k.hwSlot * 3 + 2] = rgb[2];
}

function buildBuffer(pattern, overrides) {
  const buf = blankBuffer();
  if (pattern === 'all') grid.keys.forEach(k => put(buf, k.name, RED));
  else if (pattern === 'heart') HEART_KEYS.forEach(n => put(buf, n, RED));
  else if (pattern !== 'off' && pattern !== undefined) throw new Error(`unknown pattern: ${pattern}`);
  for (const [k, v] of Object.entries(overrides || {})) put(buf, k, v);
  return buf;
}

// heartbeat: two quick thumps then rest, like a real pulse
function heartbeatWave(t) {
  const period = 1.5, x = (t % period) / period;
  const thump = u => Math.exp(-((u - 0.12) ** 2) / 0.0016) + 0.75 * Math.exp(-((u - 0.32) ** 2) / 0.0025);
  return Math.min(1, Math.max(0.12, thump(x)));
}

function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(m[0] * 255), Math.round(m[1] * 255), Math.round(m[2] * 255)];
}

async function runLoop(bufFn, fps = 20, seconds = Infinity) {
  if (!kb.connect()) throw new Error(`keyboard not found (${profile.name} expected on HID interface ${profile.interface})`);
  const frameMs = 1000 / fps;
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < seconds * 1000) {
      await kb.sendKeyBuffer(bufFn());
      await sleep(frameMs);
    }
  } finally {
    kb.disconnect();
  }
}

async function main() {
  const [cmd, ...kv] = process.argv.slice(2);
  const overrides = {};
  for (const pair of kv) {
    if (!pair.includes('=')) continue;
    const [k, hex] = pair.split('=');
    overrides[k] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  if (!cmd || cmd === 'heart') {
    if (!kb.connect()) throw new Error('keyboard not found');
    await kb.sendKeyBuffer(buildBuffer('heart', overrides));
    kb.disconnect();
    console.log('❤️  heart sent');
  } else if (cmd === 'all' || cmd === 'off') {
    if (!kb.connect()) throw new Error('keyboard not found');
    await kb.sendKeyBuffer(buildBuffer(cmd === 'off' ? 'off' : 'all', overrides));
    kb.disconnect();
    console.log(cmd === 'off' ? 'lights off' : 'all keys red');
  } else if (cmd === 'demo') {
    await runLoop(() => {
      const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
      const c = colors[Math.floor(Date.now() / 700) % 3];
      const buf = blankBuffer();
      grid.keys.forEach(k => put(buf, k.name, c));
      return buf;
    }, 20, 2.2);
    console.log('demo done');
  } else if (cmd === 'pulse') {
    const secs = Number(kv[0]) || Infinity;
    await runLoop(() => {
      const k = heartbeatWave(Date.now() / 1000);
      const buf = buildBuffer('heart');
      for (let i = 0; i < buf.length; i += 3) buf[i] = Math.round(255 * k);
      return buf;
    }, 30, secs);
    console.log('pulse done');
  } else if (cmd === 'loop') {
    const secs = Number(kv[0]) || 15;
    await runLoop(() => buildBuffer('heart'), 20, secs);
    console.log(`loop done (${secs}s)`);
  } else if (cmd === 'rainbow') {
    const secs = Number(kv[0]) || 45;
    await runLoop(() => {
      const buf = blankBuffer();
      for (let i = 0; i < 130; i++) {
        const [r, g, b] = hsv2rgb((i / 130) * 0.75, 1, 1);
        buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
      }
      return buf;
    }, 15, secs);
    console.log(`rainbow done (${secs}s)`);
  } else if (cmd === 'maptest') {
    const secs = Number(kv[0]) || 10;
    const rowColor = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
    await runLoop(() => {
      const buf = blankBuffer();
      grid.keys.forEach(k => put(buf, k.name, rowColor[k.y]));
      return buf;
    }, 20, secs);
    console.log(`maptest done (${profile.name})`);
  } else if (cmd === 'slots') {
    const from = parseInt(kv[0]) || 0, to = parseInt(kv[1]) || 129;
    const secs = Number(kv[2]) || 10;
    const rgb = kv[3]
      ? [parseInt(kv[3].slice(0, 2), 16), parseInt(kv[3].slice(2, 4), 16), parseInt(kv[3].slice(4, 6), 16)]
      : RED;
    await runLoop(() => {
      const buf = blankBuffer();
      for (let i = from; i <= to && i < 130; i++) { buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2]; }
      return buf;
    }, 20, secs);
    console.log(`slots ${from}-${to} done`);
  } else if (cmd === 'lightcfg') {
    const get = k => kv.find(x => x.startsWith(k + '='));
    if (!kb.connect()) throw new Error('keyboard not found');
    const side = get('side');
    const bright = get('bright');
    await kb.sendLightConfig({
      color: side ? side.slice(5) : undefined,
      brightness: bright ? parseInt(bright.slice(7)) : undefined,
    });
    kb.disconnect();
    console.log(`lightcfg sent side=${side || 'keep'} bright=${bright || 'keep'}`);
  } else if (cmd === 'tpl') {
    const fs = require('fs');
    const name = kv[0] || 'state_red';
    const tpl = JSON.parse(fs.readFileSync(__dirname + '/templates.json', 'utf8'))[name];
    if (!tpl) throw new Error(`template ${name} not found`);
    if (!kb.connect()) throw new Error('keyboard not found');
    const HID = require('node-hid');
    const devs = require('node-hid').devices().filter(d => d.vendorId === profile.vendorId && d.productId === profile.productId && d.interface === profile.interface);
    const dev = new HID.HID(devs[0].path);
    for (const frameBytes of tpl) {
      dev.write(Buffer.from([0x00, ...frameBytes]));
      await sleep(3);
    }
    dev.close();
    console.log(`replayed ${name} (${tpl.length} frames)`);
  } else {
    console.error('usage: node heart.js <heart|pulse|loop|all|off|demo|rainbow|maptest|slots <a> <b> [secs] [hex]|lightcfg side=RRGGBB bright=N|tpl <name>>');
    process.exit(1);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
