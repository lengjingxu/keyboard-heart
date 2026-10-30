'use strict';
/**
 * VIA (QMK) backend — raw HID channel 0xFF60:0x61, 32-byte reports.
 *
 * Stock QMK/VIA firmware exposes GLOBAL RGB Matrix controls only:
 *   brightness (value 1), effect (2), effect speed (3), color hue/sat (4)
 * on the RGB Matrix channel (0x03) via custom set/get (0x07/0x08).
 * Per-key color is NOT part of the standard protocol, so this backend drives
 * ambient state (static color / brightness / effect) instead of per-key
 * animations — attempts at per-key frames degrade to their average color.
 */
const HID = require('node-hid');

const CHANNEL_RGB_MATRIX = 0x03;
const CMD_GET_PROTOCOL = 0x01;
const CMD_CUSTOM_SET = 0x07;
const VAL_BRIGHTNESS = 1;
const VAL_EFFECT = 2;
const VAL_COLOR = 4;

function viaPacket(commandId, payload = []) {
  const p = Buffer.alloc(32);
  p[0] = commandId;
  payload.forEach((b, i) => { p[1 + i] = b & 0xff; });
  return p;
}

/** custom set value packet: [0x07, channel, value_id, ...data] */
function rgbMatrixSet(valueId, data) {
  return viaPacket(CMD_CUSTOM_SET, [CHANNEL_RGB_MATRIX, valueId, ...data]);
}

/** 0-100 → qmk brightness byte */
function brightnessByte(v) { return Math.max(0, Math.min(255, Math.round((v / 100) * 255))); }

function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h: Math.round(h / 360 * 255), s: Math.round((max ? d / max : 0) * 255), v: Math.round(max * 255) };
}

class ViaBackend {
  constructor() {
    this.dev = null;
    this.lastColor = null;
  }

  get connected() { return !!this.dev; }

  connect() {
    if (this.dev) return true;
    const hit = HID.devices().find(d => d.usagePage === 0xff60 && d.usage === 0x61);
    if (!hit) return false;
    try {
      this.dev = new HID.HID(hit.path);
      this.info = hit;
      return true;
    } catch {
      this.dev = null;
      return false;
    }
  }

  _write(packet) {
    if (!this.dev) return false;
    try {
      // hidapi: leading report id 0 for unnumbered reports
      this.dev.write(Buffer.from([0x00, ...packet]));
      return true;
    } catch {
      try { this.dev.close(); } catch { /* ignore */ }
      this.dev = null;
      return false;
    }
  }

  getProtocolVersion() {
    if (!this._write(viaPacket(CMD_GET_PROTOCOL))) return null;
    try {
      const res = this.dev.readSync();   // 32 bytes, data[1..2] = version BE
      return (res[1] << 8) | res[2];
    } catch { return null; }
  }

  setBrightness(percent) {
    return this._write(rgbMatrixSet(VAL_BRIGHTNESS, [brightnessByte(percent)]));
  }

  /** set global static color (switches nothing else; firmware applies to active mode) */
  setColor(rgb) {
    const { h, s } = rgbToHsv(rgb);
    const ok = this._write(rgbMatrixSet(VAL_COLOR, [h, s]));
    if (ok) this.lastColor = rgb;
    return ok;
  }

  setEffect(index) { return this._write(rgbMatrixSet(VAL_EFFECT, [index & 0xff])); }

  /** per-key frames degrade to the average color of lit keys (stock VIA limits) */
  async sendKeyBuffer(buf) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < buf.length; i += 3) {
      if (buf[i] || buf[i + 1] || buf[i + 2]) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++; }
    }
    if (!n) return true;
    const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    if (!this.lastColor || avg.some((v, i) => Math.abs(v - this.lastColor[i]) > 24)) {
      return this.setColor(avg);
    }
    return true;
  }

  sendLightConfig({ brightness } = {}) {
    if (brightness !== undefined && brightness !== null) return this.setBrightness(brightness);
    return false;
  }

  disconnect() {
    if (this.dev) { try { this.dev.close(); } catch { /* ignore */ } this.dev = null; }
  }

  health() {
    if (!this.dev) return null;
    return {
      backend: 'via',
      name: `${this.info.product || 'QMK/VIA keyboard'} (global lighting only)`,
      path: this.info.path,
      capabilities: ['brightness', 'global-color', 'effect'],
    };
  }
}

module.exports = { ViaBackend, viaPacket, rgbMatrixSet, brightnessByte, rgbToHsv };
