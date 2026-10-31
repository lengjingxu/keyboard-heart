#!/usr/bin/env node
/**
 * render.js — deterministic offline renderer for the 3D promo.
 * Launches an isolated Chrome over CDP, steps promo/scene3d.html frame by
 * frame (renderFrame(t)), captures each frame, then assembles:
 *   promo/out/keyboard-heart-3d.mp4   (1080p24)
 *   promo/out/hero.gif                (640px loop)
 *   promo/out/og.png                  (1200×630 social card)
 *   promo/out/preset-<name>.png       (1080p stills at each preset's peak)
 *
 * Usage: node promo/render.js [--frames-only] [--sample N]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 9344;
const FPS = 24;
const OUT = path.join(__dirname, 'out');
const FRAME_DIR = path.join(OUT, 'frames');
const PAGE = 'file://' + path.join(__dirname, 'scene3d.html');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(reqPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: reqPath, method }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function launchChrome() {
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/kh-promo-profile`,
    '--headless=new', '--no-first-run', '--hide-scrollbars',
    '--window-size=1920,1080', '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(500); try { ver = await httpJson('/json/version'); } catch {} }
  if (!ver) throw new Error('chrome did not start');
  const target = await httpJson('/json/new?about:blank', 'PUT');
  return { chrome, wsUrl: target.webSocketDebuggerUrl };
}

async function main() {
  const sample = process.argv.includes('--sample');
  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAME_DIR, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  const { chrome, wsUrl } = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let mid = 0; const pending = new Map();
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++mid; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: PAGE });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await sleep(500); try { ready = await evaluate('window.__ready === true'); } catch {} }
  if (!ready) throw new Error('scene failed to load (CDN?)');
  const total = await evaluate('window.__total');
  console.log(`scene ready, total ${total}ms`);

  const frames = sample ? sampleFrames() : fullTimeline();
  console.log(`rendering ${frames.length} frames at ${FPS}fps → ${FRAME_DIR}`);
  let i = 0;
  for (const { t, name } of frames) {
    await evaluate(`window.renderFrame(${t})`);
    const shot = await call('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
    fs.writeFileSync(path.join(FRAME_DIR, name), Buffer.from(shot.data, 'base64'));
    i++;
    if (i % 60 === 0) console.log(`  ${i}/${frames.length}`);
  }
  console.log('frames done');
  if (sample) { console.log('sample mode: skipping encode'); ws.close(); chrome.kill(); return; }

  // assemble
  const mp4 = path.join(OUT, 'keyboard-heart-3d.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
    '-i', path.join(FRAME_DIR, 'f_%05d.jpg'), '-c:v', 'libx264', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  console.log('mp4 (silent):', mp4);

  /* soundtrack: dark ambient pad + heartbeat kicks aligned to the
     heartbeat segment (starts 17.8s, cycle 1.5s, thumps at +0.18s/+0.38s) */
  const DUR = 25.8;
  const HB_START = 17.8;
  const kicks = [];
  for (let c = 0; c < 3; c++) kicks.push(HB_START + 1.5 * c + 0.18, HB_START + 1.5 * c + 0.38);
  const kickTerms = kicks.map(Tk =>
    `0.5*exp(-24*gt(t-${Tk.toFixed(3)},0))*sin(2*PI*52*gt(t-${Tk.toFixed(3)},0))*gte(t-${Tk.toFixed(3)},0)*lt(t-${Tk.toFixed(3)},0.4)`
  ).join('+');
  const padExpr = `0.05*sin(2*PI*55*t)*sin(2*PI*0.05*t)+0.035*sin(2*PI*82.41*t)*sin(2*PI*0.033*t)+0.02*sin(2*PI*110*t)*sin(2*PI*0.021*t)`;
  const wav = path.join(OUT, 'sound.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='${padExpr}+${kickTerms}':d=${DUR}:s=44100`,
    '-af', 'afade=t=in:d=1.2,afade=t=out:st=24.8:d=1', '-ac', '2', wav]);

  const final = path.join(OUT, 'keyboard-heart-3d.mp4.tmp.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', wav,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', final]);
  fs.renameSync(final, mp4);
  console.log('mp4 (with soundtrack):', mp4);

  const gif = path.join(OUT, 'hero.gif');
  const palette = path.join(OUT, 'palette.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAME_DIR, 'f_%05d.jpg'),
    '-vf', 'fps=12,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff', palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAME_DIR, 'f_%05d.jpg'),
    '-i', palette, '-lavfi', 'fps=12,scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3', gif]);
  console.log('gif:', gif);

  const og = path.join(OUT, 'og.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(FRAME_DIR, stillFrame(locateFrame('heartbeat', 180))),
    '-vf', 'scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630', og]);
  console.log('og:', og);

  ws.close(); chrome.kill();
  console.log('ALL DONE');
}

function locateFrame(preset, intoMs) { return { preset, intoMs }; }

/* full 24fps timeline over all segments */
function fullTimeline() {
  // mirror of the page's SEG durations
  const SEG = [['success', 3200], ['failure', 3200], ['notify', 2400], ['processing', 5000], ['needInput', 4000], ['heartbeat', 4500], ['outro', 3500]];
  const frames = [];
  let acc = 0;
  for (const [, dur] of SEG) {
    for (let t = 0; t < dur; t += 1000 / FPS) frames.push({ t: acc + t, name: `f_${String(frames.length).padStart(5, '0')}.jpg` });
    acc += dur;
  }
  return frames;
}

/* sparse sampling across segments for look review */
function sampleFrames() {
  const SEG = [['success', 3200], ['failure', 3200], ['notify', 2400], ['processing', 5000], ['needInput', 4000], ['heartbeat', 4500], ['outro', 3500]];
  const frames = [];
  let acc = 0;
  for (const [preset, dur] of SEG) {
    for (const frac of [0.25, 0.5, 0.75]) frames.push({ t: acc + dur * frac, name: `f_${String(frames.length).padStart(5, '0')}.jpg` });
    acc += dur;
  }
  return frames;
}

function stillFrame({ preset, intoMs }) {
  // find the frame FILENAME whose segment+time matches
  const SEG = [['success', 3200], ['failure', 3200], ['notify', 2400], ['processing', 5000], ['needInput', 4000], ['heartbeat', 4500], ['outro', 3500]];
  let idx = 0;
  for (const [p, dur] of SEG) {
    for (let t = 0; t < dur; t += 1000 / FPS) {
      if (p === preset && Math.abs(t - intoMs) < 1000 / FPS) return `f_${String(idx).padStart(5, '0')}.jpg`;
      idx++;
    }
  }
  return 'f_00000.jpg';
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
