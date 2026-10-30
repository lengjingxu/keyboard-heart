'use strict';
/**
 * Single-writer frame scheduler: owns the HID device and streams it at ~20fps.
 *
 * - static buffer: what shows when no animation runs (also the WS raw-frame target)
 * - animations: one active at a time; higher priority preempts lower;
 *   sticky ones run until cleared or preempted; on end the static buffer resumes
 * - side-bar color/brightness go through the cmd=06 channel (latched by firmware)
 */
const { Keyboard, normalizeColor } = require('./device');
const { makeGrid, KEY_NAMES, FRAME_BYTES } = require('./grid');
const { makeAnimations } = require('./animations');
const { OpenRgbBackend } = require('./backends/openrgb');
const { ViaBackend } = require('./backends/via');

const FPS = 20;
const FRAME_MS = 1000 / FPS;

/** pick transport: KB_BACKEND=hid (default) | openrgb | via */
function makeBackend(onConnect, onDisconnect) {
  const choice = (process.env.KB_BACKEND || 'hid').toLowerCase();
  if (choice === 'openrgb') return new OpenRgbBackend();
  if (choice === 'via') return new ViaBackend();
  return new Keyboard({ onConnect, onDisconnect });
}

/** generic 65% identity profile for backends without vendor tables */
function genericGrid() {
  return makeGrid({ name: 'generic', hwIds: KEY_NAMES.map((_, i) => i) });
}

class Scheduler {
  constructor({ onStateChange } = {}) {
    this.backendChoice = (process.env.KB_BACKEND || 'hid').toLowerCase();
    this.kb = makeBackend(
      profile => this._onConnect(profile),
      () => this._onDisconnect(),
    );
    this.grid = null;
    this.anim = null;          // active animation instance
    this.animStart = 0;
    this.staticBuf = new Array(FRAME_BYTES).fill(0);
    this.side = { color: null, brightness: null };
    this.timer = null;
    this.busy = false;
    this.onStateChange = onStateChange;
    this.stats = { framesSent: 0, startedAt: Date.now() };
  }

  _onConnect(profile) {
    this.grid = makeGrid(profile);
    this.anim = makeAnimations(profile);
    this.connectedProfile = profile;
    // re-latch side config and resume streaming ASAP
    if (this.side.color || this.side.brightness !== null) {
      this.kb.sendLightConfig(this.side);
    }
    if (this.onStateChange) this.onStateChange('connected', profile);
  }

  _onDisconnect() {
    this.connectedProfile = null;
    if (this.onStateChange) this.onStateChange('disconnected');
  }

  start() {
    this.kb.connect(); // may fail initially; backends keep retrying in _tick
    this.timer = setInterval(() => this._tick(), FRAME_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.kb.disconnect();
  }

  async _tick() {
    if (this.busy) return;
    if (!this.kb.connected) {
      // non-HID backends (openrgb/via) have no internal rescan — retry here,
      // throttled by a cheap timestamp guard
      if (Date.now() - (this._lastTry || 0) < 2000) return;
      this._lastTry = Date.now();
      try { this.kb.connect(); } catch { return; }
      if (!this.kb.connected) return;
      if (!this.grid) { this.grid = genericGrid(); this.anim = makeAnimations(this.grid.profile); this.connectedProfile = this.grid.profile; if (this.onStateChange) this.onStateChange('connected', this.grid.profile); }
    }
    this.busy = true;
    try {
      let frame = null;
      if (this.active) {
        const t = Date.now() - this.animStart;
        const expired = (!this.active.sticky && t >= this.active.duration) ||
          (this.active.stickyTimeoutMs && t >= this.active.stickyTimeoutMs);
        if (expired) {
          this.active = null; // sticky signals fade back to the static frame
        } else {
          frame = this.active.frameAt(t, this.staticBuf);
        }
      }
      if (frame === null) frame = this.staticBuf;
      await this.kb.sendKeyBuffer(frame, this.grid);
      this.stats.framesSent++;
    } finally {
      this.busy = false;
    }
  }

  get active() { return this._active; }
  set active(a) { this._active = a; this.animStart = Date.now(); }

  /** play a preset by name. Preemption rules:
   *  - force=true always wins (interactive clients like kbctl)
   *  - otherwise: equal-or-higher priority replaces; a sticky animation
   *    blocks lower-priority ones (protect deliberate signals from ambience) */
  play(name, { force = false } = {}) {
    if (!this.anim) return { ok: false, error: 'device not connected' };
    const preset = this.anim.presets[name];
    if (!preset) return { ok: false, error: `unknown preset: ${name} (have: ${Object.keys(this.anim.presets).join(', ')})` };
    const cur = this._active;
    if (cur && !force && preset.priority < cur.priority && cur.sticky) {
      return { ok: false, error: `busy with sticky ${cur.name} — pass force:true or kbctl fx first clears it` };
    }
    this.active = preset;
    return { ok: true, name, duration: preset.sticky ? null : preset.duration };
  }

  stopAnimation() { this.active = null; }

  /** set static key colors: {keys:{name:hex}} | {all:hex} | {grid:[[hex,...],...]} */
  setKeys({ keys, all, grid: gridColors } = {}) {
    if (all !== undefined) {
      const rgb = normalizeColor(all);
      for (let i = 0; i < FRAME_BYTES; i += 3) {
        this.staticBuf[i] = rgb[0]; this.staticBuf[i + 1] = rgb[1]; this.staticBuf[i + 2] = rgb[2];
      }
    }
    if (keys) {
      const skipped = [];
      for (const [name, hex] of Object.entries(keys)) {
        const k = this.grid && this.grid.key(name);
        if (!k) return { ok: false, error: `unknown key: ${name}` };
        if (k.hwSlot < 0) { skipped.push(k.name); continue; }
        const rgb = normalizeColor(hex);
        this.staticBuf[k.hwSlot * 3] = rgb[0];
        this.staticBuf[k.hwSlot * 3 + 1] = rgb[1];
        this.staticBuf[k.hwSlot * 3 + 2] = rgb[2];
      }
      if (skipped.length) return { ok: true, skipped, note: 'keys without a dedicated LED in this profile' };
    }
    if (gridColors) {
      for (const k of this.grid.keys) {
        const row = gridColors[k.y];
        const hex = Array.isArray(row) ? row[k.x] : undefined;
        if (hex !== undefined && hex !== null) {
          const rgb = normalizeColor(hex);
          this.staticBuf[k.hwSlot * 3] = rgb[0];
          this.staticBuf[k.hwSlot * 3 + 1] = rgb[1];
          this.staticBuf[k.hwSlot * 3 + 2] = rgb[2];
        }
      }
    }
    return { ok: true };
  }

  clearKeys() { this.staticBuf.fill(0); return { ok: true }; }

  /** side-bar color/brightness; latched by firmware, survives streaming */
  setSide({ color, brightness } = {}) {
    const rgb = color !== undefined && color !== null ? normalizeColor(color) : this.side.color;
    const bright = brightness !== undefined && brightness !== null
      ? Math.max(0, Math.min(100, brightness | 0))
      : this.side.brightness;
    const ok = this.kb.sendLightConfig({ color: rgb, brightness: bright });
    if (ok) {
      this.side = { color: rgb, brightness: bright };
      return { ok: true, side: { color: rgb && '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join(''), brightness: bright } };
    }
    return { ok: false, error: 'device not connected' };
  }

  health() {
    const device = typeof this.kb.health === 'function'
      ? this.kb.health()
      : (this.kb.connected ? {
          backend: 'hid',
          name: this.connectedProfile && this.connectedProfile.name,
          vendorId: this.connectedProfile && this.connectedProfile.vendorId,
          productId: this.connectedProfile && this.connectedProfile.productId,
        } : null);
    return {
      ok: true,
      backend: this.backendChoice,
      device,
      activeAnimation: this._active ? { name: this._active.name, sticky: !!this._active.sticky } : null,
      side: this.side.color ? {
        color: '#' + this.side.color.map(v => v.toString(16).padStart(2, '0')).join(''),
        brightness: this.side.brightness,
      } : null,
      uptimeMs: Date.now() - this.stats.startedAt,
      framesSent: this.stats.framesSent,
    };
  }
}

module.exports = { Scheduler, FPS };
