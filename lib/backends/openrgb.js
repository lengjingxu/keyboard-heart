'use strict';
/**
 * OpenRGB SDK backend — universal per-key control for every device OpenRGB
 * supports (hundreds: keyboards, mice, mats, strips…).
 *
 * Requires OpenRGB running with the SDK server enabled (default 127.0.0.1:6742).
 *
 * Protocol (verified against OpenRGB NetworkProtocol.h and the reference
 * openrgb-python client):
 *   header (16 bytes, little-endian): magic "ORGB" + device_id i32 +
 *   packet_id u32 + packet_size u32; payload follows for size > 0.
 *   RGBCONTROLLER_UPDATELEDS = 1050: payload = u32(size incl. itself) +
 *   u16 ledCount + per-LED "BBBx" (r,g,b,pad).
 */
const net = require('net');
const { KEY_NAMES, FRAME_BYTES } = require('../grid');

const PACKET = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  RGBCONTROLLER_UPDATELEDS: 1050,
};
const DEVICE_TYPE_KEYBOARD = 5;

function header(deviceId, packetId, size) {
  const h = Buffer.alloc(16);
  h.write('ORGB', 0, 'ascii');
  h.writeInt32LE(deviceId, 4);
  h.writeUInt32LE(packetId, 8);
  h.writeUInt32LE(size, 12);
  return h;
}

/** payload for UPDATELEDS: u32(size incl. itself) + u16(count) + count*4 bytes */
function updateLedsPayload(colors) {
  const body = Buffer.alloc(2 + colors.length * 4);
  body.writeUInt16LE(colors.length, 0);
  colors.forEach((c, i) => { body[2 + i * 4] = c[0]; body[2 + i * 4 + 1] = c[1]; body[2 + i * 4 + 2] = c[2]; });
  const sizePrefix = Buffer.alloc(4);
  sizePrefix.writeUInt32LE(body.length + 4, 0);
  return Buffer.concat([sizePrefix, body]);
}

/** normalize an OpenRGB LED name to a canonical key name, or null */
function ledNameToKey(name) {
  if (!name) return null;
  const n = String(name).trim().toUpperCase().replace(/\s*(LED|LIGHT|KEY)\s*\d*$/g, '').trim();
  if (/^[A-Z]$/.test(n)) return n;
  if (/^[0-9]$/.test(n)) return n;
  const map = {
    ESC: 'Esc', SPACE: 'Space', SPACEBAR: 'Space', BACKSPACE: 'Backspace',
    TAB: 'Tab', CAPS: 'CapsLock', CAPSLOCK: 'CapsLock', ENTER: 'Enter',
    DEL: 'Del', DELETE: 'Del', INS: 'Ins', INSERT: 'Ins', PGUP: 'PgUp', PGDN: 'PgDn',
    LEFT: 'Left', RIGHT: 'Right', UP: 'Up', DOWN: 'Down',
    LSHIFT: 'LShift', SHIFT: 'LShift', RSHIFT: 'RShift',
    LCTRL: 'LCtrl', CTRL: 'LCtrl', CONTROL: 'LCtrl', RCTRL: 'RCtrl',
    LALT: 'LAlt', ALT: 'LAlt', RALT: 'RAlt', LWIN: 'LWin', WIN: 'LWin', RWIN: 'LWin',
    FN: 'Fn',
  };
  return map[n] || null;
}

/** map device LEDs onto our layout slots by name; unmatched LEDs fall back to
 *  their own index so whole-board patterns still light every LED */
function buildLedMap(ledNames, grid) {
  const slotByKey = new Map(grid.keys.map(k => [k.name.toUpperCase(), k.hwSlot]));
  const taken = new Set();
  return ledNames.map(name => {
    const key = ledNameToKey(name);
    const slot = key && slotByKey.get(key);
    if (slot !== undefined && slot >= 0 && !taken.has(slot)) { taken.add(slot); return slot; }
    return null;
  });
}

class OpenRgbBackend {
  constructor({ host = '127.0.0.1', port = 6742, deviceHint } = {}) {
    this.host = host;
    this.port = port;
    this.deviceHint = deviceHint ?? process.env.KB_OPENRGB_DEVICE;
    this.sock = null;
    this.buffer = Buffer.alloc(0);
    this.packets = [];      // { packetId, data }
    this.device = null;     // { index, name, ledCount, ledNames, ledMap }
  }

  get connected() { return !!this.sock && !!this.device; }

  async connect() {
    if (this.sock) return true;
    await new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host, () => resolve());
      this.sock.on('data', d => this._onData(d));
      this.sock.on('error', e => { this.sock = null; reject(new Error(`OpenRGB not reachable at ${this.host}:${this.port} (${e.message})`)); });
      this.sock.on('close', () => { this.sock = null; this.device = null; });
    });
    const clientName = Buffer.from('keyboard-heart\0', 'ascii');
    this.sock.write(Buffer.concat([header(0, PACKET.SET_CLIENT_NAME, clientName.length), clientName]));
    this.sock.write(Buffer.concat([header(0, PACKET.REQUEST_PROTOCOL_VERSION, 4), Buffer.alloc(4)]));
    await this._waitFor(PACKET.REQUEST_PROTOCOL_VERSION, 2000);

    await this._send(0, PACKET.REQUEST_CONTROLLER_COUNT, Buffer.alloc(0));
    const countPkt = await this._waitFor(PACKET.REQUEST_CONTROLLER_COUNT, 2000);
    const count = countPkt.data.readUInt32LE(0);

    for (let i = 0; i < count; i++) {
      const dev = await this._readController(i);
      const isKeyboard = dev.type === DEVICE_TYPE_KEYBOARD || /keyboard/i.test(dev.name);
      const hinted = this.deviceHint != null && (i === Number(this.deviceHint) || dev.name.toLowerCase().includes(String(this.deviceHint).toLowerCase()));
      if (isKeyboard || hinted) {
        this.device = { index: i, name: dev.name, ledNames: dev.ledNames, ledCount: dev.ledNames.length };
        return true;
      }
    }
    this.disconnect();
    throw new Error(`no keyboard controller found on the OpenRGB server (${count} devices; set KB_OPENRGB_DEVICE=<index|name> to override)`);
  }

  /** map LEDs onto the grid once we know which board we drive */
  attachGrid(grid) {
    if (!this.device) return;
    this.device.ledMap = buildLedMap(this.device.ledNames, grid);
    this.device.matchedLeds = this.device.ledMap.filter(s => s !== null).length;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 16) {
      if (this.buffer.toString('ascii', 0, 4) !== 'ORGB') { this.buffer = this.buffer.slice(1); continue; }
      const size = this.buffer.readUInt32LE(12);
      if (this.buffer.length < 16 + size) break;
      const packetId = this.buffer.readUInt32LE(8);
      const data = Buffer.from(this.buffer.slice(16, 16 + size));
      this.buffer = this.buffer.slice(16 + size);
      this.packets.push({ packetId, data });
      if (this.packets.length > 64) this.packets.shift();
    }
  }

  _waitFor(packetId, timeoutMs) {
    const hit = this.packets.find(p => p.packetId === packetId);
    if (hit) return Promise.resolve(hit);
    if (!this.sock) return Promise.reject(new Error('OpenRGB disconnected'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        clearInterval(iv);
        reject(new Error(`OpenRGB timeout waiting for packet ${packetId}`));
      }, timeoutMs);
      const iv = setInterval(() => {
        const hit = this.packets.find(p => p.packetId === packetId);
        if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit); }
      }, 20);
    });
  }

  _send(deviceId, packetId, payload) {
    this.sock.write(Buffer.concat([header(deviceId, packetId, payload.length), payload]));
  }

  _readController(index) {
    this.packets = this.packets.filter(p => p.packetId !== PACKET.REQUEST_CONTROLLER_DATA);
    this._send(index, PACKET.REQUEST_CONTROLLER_DATA, Buffer.alloc(0));
    return this._waitFor(PACKET.REQUEST_CONTROLLER_DATA, 3000).then(p => parseControllerData(p.data));
  }

  /** push one 392-byte color frame through the LED map */
  async sendKeyBuffer(buf, grid) {
    if (!this.connected) return false;
    if (!this.device.ledMap) this.attachGrid(grid);
    const ledCount = this.device.ledCount;
    const colors = new Array(ledCount);
    for (let i = 0; i < ledCount; i++) {
      const slot = this.device.ledMap[i];
      const base = (slot === null ? i * 3 : slot * 3);
      colors[i] = [buf[base] || 0, buf[base + 1] || 0, buf[base + 2] || 0];
    }
    this._send(this.device.index, PACKET.RGBCONTROLLER_UPDATELEDS, updateLedsPayload(colors));
    return true;
  }

  /** side-bar has no OpenRGB equivalent — ignore gracefully */
  sendLightConfig() { return false; }

  disconnect() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } }
    this.sock = null;
    this.device = null;
  }

  health() {
    return this.device ? {
      backend: 'openrgb',
      name: this.device.name,
      leds: this.device.ledCount,
      mappedLeds: this.device.matchedLeds,
      address: `${this.host}:${this.port}`,
    } : null;
  }
}

/** parse a REQUEST_CONTROLLER_DATA blob (leading fields only; we stop after LEDs) */
function parseControllerData(data) {
  let off = 0;
  const u32 = () => data.readUInt32LE((off += 4) - 4);
  const str = () => {
    const len = data.readUInt16LE(off); off += 2;
    const s = data.toString('utf8', off, off + len); off += len;
    return s;
  };
  const type = u32();
  const name = str();
  str(); str(); str(); str(); str();   // vendor, description, version, serial, location
  const ledCount = u32();
  const ledNames = [];
  for (let i = 0; i < ledCount; i++) ledNames.push(str());
  return { type, name, ledCount, ledNames };
}

module.exports = { OpenRgbBackend, header, updateLedsPayload, buildLedMap, ledNameToKey, parseControllerData, PACKET };
