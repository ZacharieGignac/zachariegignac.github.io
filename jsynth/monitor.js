'use strict';

/* Live signal display. Every port shows its current value, and every wire shows the signal passing through it.
   Wires never move; each signal type has its own look:
     WAVE     a green ribbon whose thickness and brightness follow the level, turning red when it clips
     CONTROL  amber beads whose length follows the value within its recent range, flowing faster as it changes
     PITCH    gold dots whose spacing follows the pitch: the higher the note, the denser the dots
     GATE     a dotted line while low, a solid white-hot line while high, and a flash travelling along on each rise
   Wave levels come from small analyser taps that are created on demand and only read for the open tab. */

const MON_TAP_SIZE = 1024;
const MON_BEAD_GAP = 12;

const monTaps = new Map(); // "blockId:portId" -> { an, buf, peak, frame }
let monFrame = 0;
let monLast = performance.now();

function monFmt(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '\u2014';
  const a = Math.abs(v);
  if (a >= 10000) return `${(v / 1000).toFixed(1)}k`;
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function monTap(block, portId) {
  const key = `${block.id}:${portId}`;
  let t = monTaps.get(key);
  if (t) return t;
  let node = null;
  try { node = block.audioOut(portId); } catch (_) { /* block has no such output */ }
  if (!node || typeof node.connect !== 'function') return null;
  const an = app.ctx.createAnalyser();
  an.fftSize = MON_TAP_SIZE;
  an.smoothingTimeConstant = 0;
  node.connect(an);
  an.connect(app.sink);
  t = { an, node, buf: new Float32Array(MON_TAP_SIZE), peak: 0, level: 0, frame: -1 };
  monTaps.set(key, t);
  return t;
}

// Reads a tap once per animation frame; `level` is a peak that falls away smoothly.
function monRead(block, portId) {
  const t = monTap(block, portId);
  if (!t) return null;
  if (t.frame !== monFrame) {
    t.frame = monFrame;
    t.an.getFloatTimeDomainData(t.buf);
    let pk = 0;
    for (let i = 0; i < t.buf.length; i++) { const a = Math.abs(t.buf[i]); if (a > pk) pk = a; }
    t.peak = pk;
    t.level = Math.max(pk, t.level * 0.9);
  }
  return t;
}

function monPrune() {
  for (const [key, t] of monTaps) {
    const id = +key.split(':')[0];
    if (app.blocks.has(id)) continue;
    try { t.node.disconnect(t.an); } catch (_) { /* already gone */ }
    t.an.disconnect();
    monTaps.delete(key);
  }
}

/* ---------- port value chips ---------- */

function monChip(block, p, isOut) {
  const row = block.portRows[p.id];
  if (!row) return null;
  block.pv = block.pv || {};
  let chip = block.pv[p.id];
  if (!chip || !chip.isConnected) {
    chip = h('span', { class: `pv ${p.kind}`, text: '\u2014' });
    if (isOut) row.insertBefore(chip, row.querySelector('.name')); else row.append(chip);
    chip.shown = '';
    block.pv[p.id] = chip;
  }
  return chip;
}

// Value shown on a value input: the wired value, or the setting that is in effect when nothing is wired.
function monInputValue(block, p) {
  const wired = app.valueFor(block, p.id);
  if (wired !== undefined) return wired;
  const m = block.modifiers && block.modifiers[p.id];
  if (m) return m.slider.get();
  if (block.manual && p.id === 'gate') return block.manual.offset.value;
  return 0;
}

function monUpdateChips(block, wiresByTarget) {
  const paint = (chip, text, level) => {
    if (chip.shown !== text) { chip.textContent = text; chip.shown = text; }
    if (level !== undefined) {
      const lv = `${Math.round(clamp(level, 0, 1) * 100)}%`;
      if (chip.lv !== lv) { chip.style.setProperty('--lv', lv); chip.lv = lv; }
      chip.classList.toggle('idle', level < 0.004);
    }
  };
  const wave = (src, port) => {
    const t = monRead(src, port);
    return t ? t.level : null;
  };
  for (const p of block.outputs) {
    const chip = monChip(block, p, true);
    if (!chip) continue;
    if (p.kind === 'wave') {
      const lvl = wave(block, p.id);
      paint(chip, lvl === null ? '\u2014' : lvl.toFixed(lvl >= 10 ? 1 : 2), lvl === null ? 0 : lvl);
    } else {
      paint(chip, monFmt(block.getValue(p.id)));
    }
  }
  for (const p of block.inputs) {
    const chip = monChip(block, p, false);
    if (!chip) continue;
    const conn = wiresByTarget.get(`${block.id}:${p.id}`);
    if (p.kind === 'wave') {
      const lvl = conn ? wave(conn.from.block, conn.from.port) : null;
      paint(chip, lvl === null ? '\u2014' : lvl.toFixed(lvl >= 10 ? 1 : 2), lvl === null ? 0 : lvl);
    } else {
      paint(chip, monFmt(monInputValue(block, p)));
    }
  }
}

/* ---------- wires ---------- */

// Green at normal levels, shifting to red as a wave nears clipping.
function monHeat(level) {
  const k = clamp((level - 0.85) / 0.15, 0, 1);
  return `rgb(${Math.round(51 + 204 * k)},${Math.round(255 - 181 * k)},${Math.round(102 - 44 * k)})`;
}

function monWireType(c) {
  if (c.g.classList.contains('wave')) return 'wave';
  const def = c.from.block.outputs.find((p) => p.id === c.from.port);
  const label = def ? def.label : '';
  if (/0\/1/.test(label) || c.from.port === 'gate') return 'gate';
  if (/hz/i.test(label)) return 'pitch';
  return 'control';
}

function monEnsureLayers(c) {
  if (c.flow) return;
  const make = (cls) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('class', cls);
    return p;
  };
  c.glow = make('glow');
  c.core = make('core');
  c.flow = make('flow');
  c.title = document.createElementNS(SVG_NS, 'title');
  c.g.prepend(c.title, c.glow);
  c.vis.after(c.core);
  c.core.after(c.flow);
  c.kind = monWireType(c);
  c.g.classList.add(`t-${c.kind}`);
  c.st = { lo: 0, hi: 0, v: null, n: 0.5, act: 0, lvl: 0, on: 0, wasOn: false, pkt: -1, offset: 0, stamp: -1, len: 0 };
}

// The extra layers reuse the wire's own curve; it only changes when wires are re-rendered.
function monSyncPaths(c) {
  const stamp = app.wireStamp || 0;
  if (c.st.stamp === stamp) return;
  const d = c.vis.getAttribute('d');
  if (!d) return;
  c.st.stamp = stamp;
  for (const p of [c.glow, c.core, c.flow]) p.setAttribute('d', d);
  c.st.len = c.vis.getTotalLength();
}

function monVars(c, vars) {
  for (const k in vars) c.g.style.setProperty(`--${k}`, vars[k]);
}

const monPx = (v) => `${v.toFixed(2)}px`;
const monAlpha = (v) => clamp(v, 0, 1).toFixed(2);

function monDrawWave(c, dt) {
  const st = c.st;
  const t = monRead(c.from.block, c.from.port);
  st.lvl += ((t ? t.peak : 0) - st.lvl) * 0.4;
  const l = Math.min(st.lvl, 1.2);
  const live = l > 0.004;
  const u = Math.min(l, 1);
  st.offset -= dt * 55;
  c.flow.setAttribute('stroke-dasharray', '26 110');
  c.flow.setAttribute('stroke-dashoffset', st.offset.toFixed(1));
  monVars(c, {
    w: monPx(live ? 2.6 + 5.4 * u : 2.6),
    o: monAlpha(live ? 0.75 + 0.25 * u : 0.7),
    c: live ? monHeat(l) : '',
    g: monAlpha(live ? 0.1 + 0.28 * u : 0.08),
    k: monAlpha(live ? 0.2 + 0.65 * u : 0),
    f: monAlpha(live ? 0.45 * u : 0),
    fw: monPx(live ? 1 + 2.4 * u : 0),
    d: 'none',
  });
}

// Tracks where a value sits in its recent range, and how fast it is changing.
function monTrack(c) {
  const st = c.st;
  let v = c.from.block.getValue(c.from.port);
  if (typeof v !== 'number' || !Number.isFinite(v)) v = st.v === null ? 0 : st.v;
  if (st.v === null) { st.lo = v; st.hi = v; st.v = v; }
  st.lo = v < st.lo ? v : st.lo + (v - st.lo) * 0.004;
  st.hi = v > st.hi ? v : st.hi + (v - st.hi) * 0.004;
  const range = st.hi - st.lo;
  const meaningful = range > 1e-9 && range > 1e-5 * Math.max(1, Math.abs(v));
  st.n += ((meaningful ? (v - st.lo) / range : 0.5) - st.n) * 0.3;
  const rel = meaningful ? Math.abs(v - st.v) / range : 0;
  st.act = Math.max(st.act * 0.93, Math.min(1, rel * 6));
  st.v = v;
  return v;
}

// Beads grow into a solid line as the value rises within its range, and flow faster while it changes.
function monDrawControl(c, dt) {
  const st = c.st;
  monTrack(c);
  st.offset -= dt * (16 + 130 * st.act);
  c.flow.setAttribute('stroke-dasharray', `${(0.1 + 9 * st.n).toFixed(2)} ${MON_BEAD_GAP}`);
  c.flow.setAttribute('stroke-dashoffset', st.offset.toFixed(1));
  monVars(c, {
    w: monPx(2.2), o: monAlpha(0.6 + 0.3 * st.n), c: '', d: 'none',
    g: monAlpha(0.08 + 0.17 * st.n + 0.1 * st.act), k: '0',
    f: monAlpha(0.75 + 0.25 * Math.max(st.n, st.act)), fw: monPx(3.8),
  });
}

// Dots get denser as the pitch climbs (20 Hz widest, 20 kHz tightest).
function monDrawPitch(c, dt) {
  const st = c.st;
  const v = monTrack(c);
  const pos = clamp(Math.log2(Math.max(v, 20) / 20) / 10, 0, 1);
  st.offset -= dt * (20 + 120 * st.act);
  c.flow.setAttribute('stroke-dasharray', `0.1 ${(22 - 17 * pos).toFixed(1)}`);
  c.flow.setAttribute('stroke-dashoffset', st.offset.toFixed(1));
  monVars(c, {
    w: monPx(2.2), o: monAlpha(0.6 + 0.25 * st.n), c: '', d: 'none',
    g: monAlpha(0.08 + 0.1 * st.n + 0.1 * st.act), k: '0',
    f: monAlpha(0.85 + 0.15 * st.n), fw: monPx(3.6),
  });
}

// Dotted while low, solid and white-hot while high; each rising edge sends a flash down the wire.
function monDrawGate(c, dt) {
  const st = c.st;
  const on = monTrack(c) > 0.5;
  st.on += ((on ? 1 : 0) - st.on) * 0.5;
  if (on && !st.wasOn) st.pkt = 0;
  st.wasOn = on;
  const D = 24;
  if (st.pkt >= 0) {
    st.pkt += dt / 0.4;
    if (st.pkt > 1) st.pkt = -1;
  }
  const flashing = st.pkt >= 0;
  c.flow.setAttribute('stroke-dasharray', `${D} ${(st.len + D + 20).toFixed(0)}`);
  c.flow.setAttribute('stroke-dashoffset', (flashing ? D - st.pkt * (st.len + D) : D).toFixed(1));
  monVars(c, {
    w: monPx(2.4 + 1.8 * st.on), o: monAlpha(0.7 + 0.3 * st.on), c: '', d: st.on < 0.5 ? '2 6' : 'none',
    g: monAlpha(0.08 + 0.32 * st.on), k: monAlpha(0.9 * st.on),
    f: flashing ? '1' : '0', fw: monPx(4.5),
  });
}

function monWireTitle(c) {
  const st = c.st;
  const cut = ' Click it and press Delete to cut it, or double-click to disconnect.';
  if (c.kind === 'wave') return `Wave, level ${st.lvl.toFixed(2)}.${cut}`;
  if (c.kind === 'gate') return `Gate, ${st.wasOn ? 'high' : 'low'}.${cut}`;
  if (c.kind === 'pitch') return `Pitch, ${monFmt(st.v)} Hz.${cut}`;
  return `Control value, ${monFmt(st.v)}.${cut}`;
}

const MON_DRAW = { wave: monDrawWave, control: monDrawControl, pitch: monDrawPitch, gate: monDrawGate };

function monUpdateWires(dt) {
  for (const c of app.conns) {
    if (c.tab !== app.activeTab) continue;
    monEnsureLayers(c);
    c.g.classList.add('live');
    monSyncPaths(c);
    MON_DRAW[c.kind](c, dt);
    if (monFrame % 10 === 0) c.title.textContent = monWireTitle(c);
  }
}

/* ---------- hooks ---------- */

const monOriginalFrame = App.prototype.frame;
App.prototype.frame = function frame() {
  monOriginalFrame.call(this);
  if (!this.ready) return;
  monFrame++;
  const now = performance.now();
  const dt = Math.min(0.1, (now - monLast) / 1000);
  monLast = now;
  const wiresByTarget = new Map();
  for (const c of this.conns) wiresByTarget.set(`${c.to.block.id}:${c.to.port}`, c);
  for (const b of this.blocks.values()) if (b.tab === this.activeTab) monUpdateChips(b, wiresByTarget);
  monUpdateWires(dt);
  if (monFrame % 120 === 0) monPrune();
};

// Wire geometry only changes when wires are re-rendered, so the cached curve is keyed on that.
const monOriginalRender = App.prototype.renderWires;
App.prototype.renderWires = function renderWires() {
  this.wireStamp = (this.wireStamp || 0) + 1;
  monOriginalRender.call(this);
};
