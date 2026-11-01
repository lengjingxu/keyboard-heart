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
const FPS = 30;
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

  /* soundtrack: 96bpm — kick every beat, hats on 8ths, bass per bar, riser into the love act */
  const DUR = 31.25, BPM = 96, BEAT = 60/BPM;
  const kicks = [];
  for (let b = 4; b*BEAT < DUR - 0.3; b++) kicks.push(b*BEAT);
  const kickTerms = kicks.map(Tk =>
    `0.42*exp(-26*gt(t-${Tk.toFixed(4)},0))*sin(2*PI*50*gt(t-${Tk.toFixed(4)},0))*gte(t-${Tk.toFixed(4)},0)*lt(t-${Tk.toFixed(4)},0.32)`
  ).join('+');
  const hats = [];
  for (let b = 8; b*BEAT/2 < DUR - 0.3; b++) hats.push(b*BEAT/2 + BEAT/4);
  const hatTerms = hats.map(Tk =>
    `0.05*exp(-150*gt(t-${Tk.toFixed(4)},0))*sin(2*PI*1800*gt(t-${Tk.toFixed(4)},0))*gte(t-${Tk.toFixed(4)},0)*lt(t-${Tk.toFixed(4)},0.04)`
  ).join('+');
  const clicks = `0.12*exp(-160*mod(t-2.5,0.085))*sin(2*PI*2300*mod(t-2.5,0.085))*gte(t-2.5,0)*lt(t-2.5,0.8)+0.10*exp(-160*mod(t-5.0,0.11))*sin(2*PI*2100*mod(t-5.0,0.11))*gte(t-5.0,0)*lt(t-5.0,0.7)`;
  const riser = `0.10*sin(2*PI*(280+900*min(gt(t-21.25,0)/1.25,1))*gt(t-21.25,0))*lt(t-21.25,1.25)*gte(t-21.25,0)*exp(-1.5*gt(t-21.25,0))`;
  const padExpr = `0.045*sin(2*PI*55*t)*sin(2*PI*0.05*t)+0.03*sin(2*PI*82.41*t)*sin(2*PI*0.033*t)+0.018*sin(2*PI*110*t)*sin(2*PI*0.021*t)`;
  const wav = path.join(OUT, 'sound.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc='${padExpr}+${kickTerms}+${hatTerms}+${riser}':d=${DUR}:s=44100`,
    '-af', 'afade=t=in:d=0.8,afade=t=out:st=30.3:d=0.95', '-ac', '2', wav]);

  const final = path.join(OUT, 'keyboard-heart-3d.mp4.tmp.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', wav,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', final]);
  fs.renameSync(final, mp4);
  console.log('mp4 (with 96bpm soundtrack):', mp4);

  const gif = path.join(OUT, 'hero.gif');
  const palette = path.join(OUT, 'palette.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(FRAME_DIR, 'f_%05d.jpg'), '-frames:v', '120',
    '-vf', 'fps=10,scale=520:-1:flags=lanczos,palettegen=stats_mode=diff', palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(FRAME_DIR, 'f_%05d.jpg'), '-i', palette,
    '-filter_complex', '[0:v]trim=start_frame=570:end_frame=690,fps=10,scale=520:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', gif]);
  console.log('gif:', gif);

  const og = path.join(OUT, 'og.png');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(FRAME_DIR, stillFrame('done', 2000)),
    '-vf', 'scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630', og]);
  console.log('og:', og);

  ws.close(); chrome.kill();
  console.log('ALL DONE');
}

function locateFrame(preset, intoMs) { return { preset, intoMs }; }

/* full 24fps timeline over all segments */
function fullTimeline() {
  // mirror of the page's SEG durations
  const SEG = [['intro', 2500], ['task', 2500], ['working', 2500], ['success', 3750], ['done', 3750], ['failure', 3750], ['needInput', 3750], ['love', 5000], ['outro', 3750]];
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
  const SEG = [['intro', 2500], ['task', 2500], ['working', 2500], ['success', 3750], ['done', 3750], ['failure', 3750], ['needInput', 3750], ['love', 5000], ['outro', 3750]];
  const frames = [];
  let acc = 0;
  for (const [preset, dur] of SEG) {
    for (const frac of [0.25, 0.5, 0.75]) frames.push({ t: acc + dur * frac, name: `f_${String(frames.length).padStart(5, '0')}.jpg` });
    acc += dur;
  }
  return frames;
}

function stillFrame(preset, intoMs) {
  // find the frame FILENAME whose segment+time matches
  const SEG = [['intro', 2500], ['task', 2500], ['working', 2500], ['success', 3750], ['done', 3750], ['failure', 3750], ['needInput', 3750], ['love', 5000], ['outro', 3750]];
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
