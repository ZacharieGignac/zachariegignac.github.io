'use strict';

/* DETECTOR: listens to a wave (optionally only inside a frequency band), and counts down while its level matches a
   condition. When the countdown finishes it fires, and reports a set of useful values: a FIRE pulse, a HELD latch,
   MATCH, PROGRESS, time LEFT, the LEVEL and a COUNT of how many times it fired. */

const DET_CONDS = ['ABOVE', 'BELOW', 'BETWEEN', 'OUTSIDE'];
const DET_METERS = ['PEAK', 'RMS'];
const DET_AFTER = ['ONCE', 'REPEAT', 'MANUAL'];
const DET_BREAK = ['RESTART', 'PAUSE', 'DRAIN'];
const DET_HIST = 240;
const DET_FIRE_MS = 60;

class DetectorBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'detector', title: 'DETECTOR', desc: 'Counts down while a wave matches a level, then fires',
      inputs: [
        { id: 'in', label: 'WAVE IN', kind: 'wave' },
        { id: 'thr', label: 'LEVEL dB', kind: 'value' },
        { id: 'time', label: 'TIME s', kind: 'value' },
        { id: 'reset', label: 'RESET IN', kind: 'value' },
      ],
      outputs: [
        { id: 'fire', label: 'FIRE 0/1', kind: 'value' },
        { id: 'held', label: 'HELD 0/1', kind: 'value' },
        { id: 'match', label: 'MATCH 0/1', kind: 'value' },
        { id: 'prog', label: 'PROG 0-1', kind: 'value' },
        { id: 'left', label: 'LEFT s', kind: 'value' },
        { id: 'lvl', label: 'LEVEL 0-1', kind: 'value' },
        { id: 'count', label: 'COUNT', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;

    this.inNode = ctx.createGain();
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 20;
    this.hp.Q.value = -3.0103; // Q of a high-pass/low-pass is in dB: -3.01 dB is a flat (Butterworth) response
    this.lpf = ctx.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 20000;
    this.lpf.Q.value = -3.0103;
    this.an = ctx.createAnalyser();
    this.an.fftSize = 2048;
    this.an.smoothingTimeConstant = 0;
    this.inNode.connect(this.hp);
    this.hp.connect(this.lpf);
    this.lpf.connect(this.an);
    this.an.connect(app.sink);
    this.buf = new Float32Array(2048);

    this.resetIn = ctx.createGain();
    this.resetAn = ctx.createAnalyser();
    this.resetAn.fftSize = 2048;
    this.resetIn.connect(this.resetAn);
    this.resetAn.connect(app.sink);
    this.resetBuf = new Float32Array(2048);
    this.resetHigh = false;
    this.thrIn = ctx.createGain(); // plug-in points: the wired values are read directly
    this.timeIn = ctx.createGain();

    this.out = {};
    this.v = { fire: 0, held: 0, match: 0, prog: 0, left: 0, lvl: 0, count: 0 };
    this.sent = {};
    for (const p of this.outputs) {
      const n = ctx.createConstantSource();
      n.offset.value = 0;
      n.start();
      this.out[p.id] = n;
      this.sent[p.id] = 0;
    }

    this.cond = 0;
    this.meter = 0;
    this.after = 0;
    this.brk = 0;
    this.lvl = 0;
    this.db = -100;
    this.elapsed = 0;
    this.latched = false;
    this.repeated = false;
    this.count = 0;
    this.fireUntil = 0;
    this.last = performance.now();
    this.histAt = 0;
    this.hist = [];

    this.condBtns = DET_CONDS.map((n, i) => h('button', { text: n, onclick: () => this.setCond(i) }));
    this.meterBtns = DET_METERS.map((n, i) => h('button', { text: n, onclick: () => this.setMeter(i) }));
    this.afterBtns = DET_AFTER.map((n, i) => h('button', { text: n, onclick: () => this.setAfter(i) }));
    this.breakBtns = DET_BREAK.map((n, i) => h('button', { text: n, onclick: () => this.setBreak(i) }));
    this.levelSlider = makeSlider({ label: 'LEVEL', min: -100, max: 0, value: -30, decimals: 0 });
    this.toSlider = makeSlider({ label: 'TO', min: -100, max: 0, value: -10, decimals: 0 });
    this.timeSlider = makeSlider({ label: 'TIME', min: 0.01, max: 600, value: 2, log: true, decimals: 2 });
    this.smoothSlider = makeSlider({ label: 'SMOOTH', min: 0, max: 2000, value: 50, decimals: 0 });
    this.lowSlider = makeSlider({
      label: 'LO Hz', min: 20, max: 20000, value: 20, log: true, decimals: 0,
      onInput: (v) => this.hp.frequency.setTargetAtTime(v, ctx.currentTime, 0.01),
    });
    this.highSlider = makeSlider({
      label: 'HI Hz', min: 20, max: 20000, value: 20000, log: true, decimals: 0,
      onInput: (v) => this.lpf.frequency.setTargetAtTime(v, ctx.currentTime, 0.01),
    });
    this.resetBtn = h('button', { text: 'RESET', onclick: () => this.reset() });
    this.fireBtn = h('button', { text: 'FIRE NOW', onclick: () => this.fire() });
    this.graph = h('canvas', { class: 'scope', width: DET_HIST, height: 90 });
    this.bar = h('canvas', { class: 'meter', width: 240, height: 14 });
    this.readout = h('div', { class: 'readout small multi', text: '-' });
    const row = (label, buttons) => h('div', { class: 'ctl names' }, h('span', { text: label }), h('div', { class: 'btn-row' }, buttons));
    this.body.append(
      row('WHEN', this.condBtns), row('METER', this.meterBtns), row('AFTER', this.afterBtns), row('BREAK', this.breakBtns),
      this.levelSlider.el, this.toSlider.el, this.timeSlider.el, this.smoothSlider.el, this.lowSlider.el, this.highSlider.el,
      h('div', { class: 'btn-row' }, this.resetBtn, this.fireBtn),
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'LEVEL HISTORY' }), this.graph),
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'COUNTDOWN' }), this.bar),
      this.readout);
    this.setCond(0);
    this.setMeter(0);
    this.setAfter(0);
    this.setBreak(0);
  }

  /* ---------- settings ---------- */

  setCond(i) {
    this.cond = i;
    this.condBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.toSlider.setDisabled(i < 2, 'off');
  }

  setMeter(i) { this.meter = i; this.meterBtns.forEach((b, k) => b.classList.toggle('active', k === i)); }
  setAfter(i) { this.after = i; this.afterBtns.forEach((b, k) => b.classList.toggle('active', k === i)); }
  setBreak(i) { this.brk = i; this.breakBtns.forEach((b, k) => b.classList.toggle('active', k === i)); }

  getState() {
    return {
      cond: this.cond, meter: this.meter, after: this.after, brk: this.brk, level: this.levelSlider.get(), to: this.toSlider.get(),
      time: this.timeSlider.get(), smooth: this.smoothSlider.get(), low: this.lowSlider.get(), high: this.highSlider.get(),
    };
  }

  setState(s) {
    this.setCond(s.cond || 0);
    this.setMeter(s.meter || 0);
    this.setAfter(s.after || 0);
    this.setBreak(s.brk || 0);
    this.levelSlider.set(s.level ?? -30, true);
    this.toSlider.set(s.to ?? -10, true);
    this.timeSlider.set(s.time ?? 2, true);
    this.smoothSlider.set(s.smooth ?? 50, true);
    this.lowSlider.set(s.low ?? 20, true);
    this.highSlider.set(s.high ?? 20000, true);
  }

  onPortChange(portId, connected) {
    if (portId === 'thr') this.levelSlider.setDisabled(connected);
    if (portId === 'time') this.timeSlider.setDisabled(connected);
  }

  getValue(portId) { return this.v[portId]; }
  audioIn(portId) {
    return { in: this.inNode, thr: this.thrIn, time: this.timeIn, reset: this.resetIn }[portId];
  }
  audioOut(portId) { return this.out[portId]; }

  /* ---------- logic ---------- */

  reset() {
    this.elapsed = 0;
    this.latched = false;
    this.repeated = false;
    this.count = 0;
    this.v.held = 0;
  }

  fire() {
    this.count++;
    this.fireUntil = performance.now() + DET_FIRE_MS;
    const t = this.app.ctx.currentTime;
    this.out.fire.offset.cancelScheduledValues(t);
    this.out.fire.offset.setValueAtTime(1, t);
    this.out.fire.offset.setValueAtTime(0, t + DET_FIRE_MS / 1000);
    this.hist.push({ fired: true });
  }

  param(id, slider) {
    const wired = this.app.valueFor(this, id);
    return wired !== undefined ? wired : slider.get();
  }

  matches(db, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    switch (this.cond) {
      case 0: return db > a;
      case 1: return db < a;
      case 2: return db >= lo && db <= hi;
      default: return db < lo || db > hi;
    }
  }

  measure(dt) {
    this.an.getFloatTimeDomainData(this.buf);
    let m = 0;
    if (this.meter === 0) {
      for (let i = 0; i < this.buf.length; i++) { const a = Math.abs(this.buf[i]); if (a > m) m = a; }
    } else {
      let s = 0;
      for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
      m = Math.sqrt(s / this.buf.length);
    }
    const tau = this.smoothSlider.get() / 1000;
    this.lvl += (m - this.lvl) * (tau > 0 ? 1 - Math.exp(-dt / tau) : 1);
    this.db = 20 * Math.log10(Math.max(this.lvl, 1e-5));
  }

  // Runs every frame, also while the block's tab is hidden, so the countdown keeps going.
  tick() {
    const nowMs = performance.now();
    const dt = Math.min(1, (nowMs - this.last) / 1000);
    this.last = nowMs;
    this.measure(dt);

    this.resetAn.getFloatTimeDomainData(this.resetBuf);
    const high = this.resetBuf.some((x) => x > 0.5);
    if (high && !this.resetHigh) this.reset();
    this.resetHigh = high;

    const thr = this.param('thr', this.levelSlider);
    const total = Math.max(0.01, this.param('time', this.timeSlider));
    const match = this.matches(this.db, thr, this.toSlider.get());

    if (match) {
      if (!this.latched) this.elapsed += dt;
    } else {
      if (this.latched && this.after === 0) { this.latched = false; this.elapsed = 0; } // ONCE re-arms when the condition ends
      if (!this.latched) {
        if (this.brk === 0) this.elapsed = 0;
        else if (this.brk === 2) this.elapsed = Math.max(0, this.elapsed - dt);
      }
      this.repeated = false;
    }

    if (!this.latched && this.elapsed >= total) {
      this.fire();
      if (this.after === 1) { this.elapsed -= total; this.repeated = true; } else { this.latched = true; this.elapsed = total; }
    }

    const prog = clamp(this.elapsed / total, 0, 1);
    const v = this.v;
    v.fire = nowMs < this.fireUntil ? 1 : 0;
    v.held = this.latched || this.repeated ? 1 : 0;
    v.match = match ? 1 : 0;
    v.prog = prog;
    v.left = Math.max(0, total - this.elapsed);
    v.lvl = clamp(this.lvl, 0, 1);
    v.count = this.count;
    this.sendOutputs();

    if (nowMs - this.histAt > 33) {
      this.histAt = nowMs;
      this.hist.push({ db: this.db, match });
      if (this.hist.length > DET_HIST) this.hist.splice(0, this.hist.length - DET_HIST);
    }
  }

  sendOutputs() {
    const t = this.app.ctx.currentTime;
    for (const id of ['held', 'match', 'count']) {
      if (this.sent[id] !== this.v[id]) { this.out[id].offset.setValueAtTime(this.v[id], t); this.sent[id] = this.v[id]; }
    }
    for (const id of ['prog', 'left', 'lvl']) {
      if (Math.abs(this.sent[id] - this.v[id]) > 1e-4) { this.out[id].offset.setTargetAtTime(this.v[id], t, 0.01); this.sent[id] = this.v[id]; }
    }
  }

  /* ---------- drawing ---------- */

  draw() {
    this.tick();
    const wiredThr = this.app.valueFor(this, 'thr');
    if (wiredThr !== undefined) this.levelSlider.set(clamp(wiredThr, -100, 0));
    const wiredTime = this.app.valueFor(this, 'time');
    if (wiredTime !== undefined) this.timeSlider.set(clamp(wiredTime, 0.01, 600));
    this.drawGraph();
    this.drawBar();
    const total = Math.max(0.01, this.param('time', this.timeSlider));
    this.readout.textContent = [
      `LEVEL ${this.db <= -99 ? '-INF' : this.db.toFixed(1)} dB (${DET_METERS[this.meter]})  ${this.v.match ? 'MATCH' : 'no match'}`,
      `COUNTDOWN ${this.elapsed.toFixed(2)} / ${total.toFixed(2)} s`,
      `FIRED ${this.count}x  ${this.v.held ? 'HELD' : ''}`,
    ].join('\n');
  }

  drawGraph() {
    const c = this.graph;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const yOf = (db) => H - ((clamp(db, -100, 0) + 100) / 100) * H;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(51,255,102,0.12)';
    g.beginPath();
    for (let db = -80; db < 0; db += 20) { g.moveTo(0, yOf(db) + 0.5); g.lineTo(W, yOf(db) + 0.5); }
    g.stroke();

    const a = this.param('thr', this.levelSlider);
    const b = this.toSlider.get();
    if (this.cond >= 2) {
      g.fillStyle = this.cond === 2 ? 'rgba(255,176,0,0.14)' : 'rgba(255,74,58,0.12)';
      const y1 = yOf(Math.max(a, b));
      const y2 = yOf(Math.min(a, b));
      if (this.cond === 2) g.fillRect(0, y1, W, y2 - y1);
      else { g.fillRect(0, 0, W, y1); g.fillRect(0, y2, W, H - y2); }
    } else {
      g.fillStyle = 'rgba(255,176,0,0.14)';
      if (this.cond === 0) g.fillRect(0, 0, W, yOf(a)); else g.fillRect(0, yOf(a), W, H - yOf(a));
    }
    g.strokeStyle = '#ffb000';
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(0, yOf(a) + 0.5); g.lineTo(W, yOf(a) + 0.5);
    if (this.cond >= 2) { g.moveTo(0, yOf(b) + 0.5); g.lineTo(W, yOf(b) + 0.5); }
    g.stroke();
    g.setLineDash([]);

    const off = W - this.hist.length;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    let prevPoint = null;
    this.hist.forEach((p, i) => {
      const x = off + i;
      if (p.fired) {
        g.fillStyle = '#fff';
        g.fillRect(x, 0, 2, H);
        return;
      }
      const y = yOf(p.db);
      if (prevPoint) {
        g.strokeStyle = p.match ? '#ffb000' : '#33ff66';
        g.beginPath();
        g.moveTo(prevPoint.x, prevPoint.y);
        g.lineTo(x, y);
        g.stroke();
      }
      prevPoint = { x, y };
    });
    g.lineWidth = 1;
    g.fillStyle = '#1b8a38';
    g.font = '8px monospace';
    g.fillText('0 dB', 2, 9);
    g.fillText('-100', 2, H - 2);
  }

  drawBar() {
    const c = this.bar;
    const g = c.getContext('2d');
    g.fillStyle = '#031006';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = this.latched ? '#ffffff' : '#ffb000';
    g.fillRect(1, 2, (c.width - 2) * this.v.prog, c.height - 4);
  }

  destroy() {
    for (const n of Object.values(this.out)) { n.stop(); n.disconnect(); }
    for (const n of [this.inNode, this.hp, this.lpf, this.an, this.resetIn, this.resetAn, this.thrIn, this.timeIn]) n.disconnect();
  }
}

Object.assign(BLOCK_TYPES, { detector: DetectorBlock });
