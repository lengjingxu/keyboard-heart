'use strict';
/**
 * HID transport for MCHOSE 65% boards (protocol reverse-engineered 2026-10).
 *
 * Two channels on HID interface 1 (reportId 0, i.e. node-hid buffer
 * prefixed with 0x00):
 *
 * 1) Realtime per-key RGB — 7 output reports of 65 bytes:
 *      [0]=0x00 [1]=0x55 [2]=0xDD [3]=0x00 [4]=sum(bytes[5..64])&0xFF
 *      [5]=chunkLen(56) [6..8]=chunk byte-offset LE24 [9..64]=56 bytes RGB
 *    7 chunks x 56 = 392 bytes = TOTAL_SLOTS x RGB.
 *    The onboard effect engine repaints continuously, so the frame must be
 *    streamed (~20fps) to keep a custom picture stable.
 *
 * 2) Light config (side-bar color + brightness) — a pair of 64-byte frames
 *    (cmd 0x06), checksum = sum(bytes[4..63])&0xFF (note: covers the length
 *    byte, unlike channel 1). Single shot; the firmware latches it.
 */
const HID = require('node-hid');
const { PROFILES, FRAME_BYTES } = require('./grid');

const SCAN_INTERVAL_MS = 2000;

// Base light-config pair as captured from the vendor console in the
// "side=red, brightness=100" state. Patches happen at:
//   frame A: color [37..39], brightness [33]
//   frame B: color [29..31], brightness [25]
// 64 bytes each: [1]=cmd(0x06) [3]=checksum [4]=len(0x38) [5]=part(0/8)
const LIGHT_CFG_BASE = [
  [0x55, 0x06, 0x00, 0x00, 0x38, 0x00, 0x00, 0x00,           // header + part 0
   0x50, 0x00, 0xaa, 0xbb, 0x01, 0x01, 0x00, 0x06,           // magic block
   0x00, 0x64, 0x02, 0x00, 0x00, 0x00, 0x00, 0xff,
   0xff, 0x00, 0x00, 0x00, 0x05, 0x01, 0x00, 0x00,
   0x03, 0x64, 0x02, 0x00, 0x01, 0xff, 0x00, 0x00,           // [33]=brightness
   0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,           // [37..39]=side RGB
   0xff, 0xff, 0xff, 0x10, 0x10, 0x10, 0x10, 0x10,
   0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10],
  [0x55, 0x06, 0x00, 0x00, 0x38, 0x08, 0x00, 0x00,           // header + part 8
   0x00, 0x64, 0x02, 0x00, 0x00, 0x00, 0x00, 0xff,           // [25]=brightness
   0xff, 0x00, 0x00, 0x00, 0x05, 0x01, 0x00, 0x00,           // [29..31]=side RGB
   0x03, 0x64, 0x02, 0x00, 0x01, 0xff, 0x00, 0x00,
   0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
   0xff, 0xff, 0xff, 0x10, 0x10, 0x10, 0x10, 0x10,
   0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
   0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10],
];

/** checksum for 0xDD realtime packets: sum of bytes [5..end] */
function ddChecksum(frame) {
  let s = 0;
  for (let c = 5; c < frame.length; c++) s += frame[c];
  return s & 0xff;
}

/** checksum for cmd=06 config frames: sum of bytes [4..end] (includes length byte) */
function cfgChecksum(frame) {
  let s = 0;
  for (let c = 4; c < frame.length; c++) s += frame[c];
  return s & 0xff;
}

/** split the 392-byte color buffer into the 7-packet 0xDD realtime frame set */
function keyFramePackets(buf) {
  if (buf.length !== FRAME_BYTES) throw new Error(`color buffer must be ${FRAME_BYTES} bytes`);
  const packets = [];
  for (let i = 0; i < 7; i++) {
    const offset = i * 56;
    const chunk = buf.slice(offset, offset + 56);
    const p = new Array(65).fill(0);
    p[1] = 0x55; p[2] = 0xdd; p[5] = chunk.length;
    p[6] = offset & 0xff; p[7] = (offset >> 8) & 0xff; p[8] = (offset >> 16) & 0xff;
    chunk.forEach((b, j) => { p[9 + j] = b; });
    p[4] = ddChecksum(p);
    packets.push(Buffer.from(p));
  }
  return packets;
}

/** build the cmd=06 pair with patched side color (RGB array) and brightness 0-100 */
function lightConfigFrames({ color, brightness } = {}) {
  const frames = LIGHT_CFG_BASE.map(f => [...f]);
  for (const [fi, f] of frames.entries()) {
    const colorAt = fi === 0 ? 37 : 29;
    const brightAt = fi === 0 ? 33 : 25;
    if (color) { f[colorAt] = color[0]; f[colorAt + 1] = color[1]; f[colorAt + 2] = color[2]; }
    if (brightness !== undefined && brightness !== null) f[brightAt] = Math.max(0, Math.min(100, brightness | 0));
    f[3] = cfgChecksum(f);
  }
  return frames.map(f => Buffer.from([0x00, ...f])); // prepend reportId 0x00
}

/** scan for a supported keyboard; returns { profile, path } or null */
function detect() {
  try {
    const list = HID.devices();
    for (const profile of Object.values(PROFILES)) {
      const hit = list.find(d =>
        d.vendorId === profile.vendorId && d.productId === profile.productId &&
        d.interface === profile.interface);
      if (hit) return { profile, path: hit.path };
    }
  } catch { /* hid unavailable */ }
  return null;
}

/**
 * Owns the HID handle; tolerates unplug/replug by rescanning in the
 * background. All writes are no-ops while disconnected.
 */
class Keyboard {
  constructor({ onConnect, onDisconnect } = {}) {
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.dev = null;
    this.profile = null;
    this.scanTimer = null;
  }

  get connected() { return !!this.dev; }

  connect() {
    if (this.dev) return true;
    const found = detect();
    if (!found) return false;
    try {
      this.dev = new HID.HID(found.path);
      this.profile = found.profile;
      this.startScan();
      if (this.onConnect) this.onConnect(this.profile);
      return true;
    } catch {
      this.dev = null;
      this.profile = null;
      return false;
    }
  }

  startScan() {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      if (!this.dev) this.connect();
    }, SCAN_INTERVAL_MS);
    if (this.scanTimer.unref) this.scanTimer.unref();
  }

  disconnect() {
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.dev) { try { this.dev.close(); } catch {} this.dev = null; }
    if (this.onDisconnect && this.profile) this.onDisconnect(this.profile);
    this.profile = null;
  }

  /** stream one full key frame; safe to call while disconnected (no-op) */
  async sendKeyBuffer(buf) {
    if (!this.dev) return false;
    try {
      for (const p of keyFramePackets(buf)) {
        this.dev.write(p);
        await new Promise(r => setTimeout(r, 3)); // pacing: prevents dropped/garbled packets
      }
      return true;
    } catch {
      try { this.dev.close(); } catch {}
      this.dev = null;
      if (this.onDisconnect) this.onDisconnect(this.profile);
      this.profile = null;
      return false;
    }
  }

  /** push side-bar color (#rrggbb or [r,g,b]) and/or brightness (0-100) */
  sendLightConfig({ color, brightness } = {}) {
    if (!this.dev) return false;
    const rgb = normalizeColor(color);
    try {
      for (const p of lightConfigFrames({ color: rgb, brightness })) {
        this.dev.write(p);
      }
      return true;
    } catch {
      try { this.dev.close(); } catch {}
      this.dev = null;
      if (this.onDisconnect) this.onDisconnect(this.profile);
      this.profile = null;
      return false;
    }
  }
}

function normalizeColor(c) {
  if (c === undefined || c === null) return null;
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0];
  const m = /^#?([0-9a-f]{6})$/i.test(c) && c.match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`bad color: ${c}`);
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

module.exports = { Keyboard, detect, keyFramePackets, lightConfigFrames, ddChecksum, cfgChecksum, normalizeColor };
