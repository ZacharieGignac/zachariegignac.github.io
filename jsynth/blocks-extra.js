'use strict';

/* Extra blocks: Filter, LFO, Delay, Spectrum, Sequencer, ADSR, Dominant Freq.
   Loaded after app.js, which provides Block, helpers and BLOCK_TYPES. */

const EXTRA_WORKLET_SRC = `
class AdsrProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stage = 0; // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
    this.level = 0;
    this.on = false;
    this.a = 0.01; this.d = 0.2; this.s = 0.6; this.r = 0.4;
    this.relStep = 0;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const inp = inputs[0][0];
    const atk = 1 / (Math.max(0.0005, this.a) * sampleRate);
    const dec = (1 - this.s) / (Math.max(0.0005, this.d) * sampleRate);
    for (let i = 0; i < out.length; i++) {
      const on = (inp ? inp[i] : 0) > 0.5;
      if (on && !this.on) {
        this.stage = 1;
      } else if (!on && this.on) {
        this.stage = 4;
        this.relStep = this.level / (Math.max(0.0005, this.r) * sampleRate);
      }
      this.on = on;
      switch (this.stage) {
        case 1:
          this.level += atk;
          if (this.level >= 1) { this.level = 1; this.stage = 2; }
          break;
        case 2:
          this.level -= dec;
          if (this.level <= this.s) { this.level = this.s; this.stage = 3; }
          break;
        case 3:
          this.level = this.s;
          break;
        case 4:
          this.level -= this.relStep;
          if (this.level <= 0) { this.level = 0; this.stage = 0; }
          break;
      }
      out[i] = this.level;
    }
    return true;
  }
}
registerProcessor('adsr-processor', AdsrProcessor);
`;

/* ---------- helpers ---------- */

function makeMinMax(min, max, onChange) {
  const state = { min, max };
  const minInput = h('input', { type: 'number', step: 'any', value: min });
  const maxInput = h('input', { type: 'number', step: 'any', value: max });
  const apply = () => {
    const lo = parseFloat(minInput.value);
    const hi = parseFloat(maxInput.value);
    if (!Number.isNaN(lo)) state.min = lo;
    if (!Number.isNaN(hi)) state.max = hi;
    minInput.value = state.min;
    maxInput.value = state.max;
    onChange(state);
  };
  minInput.addEventListener('change', apply);
  maxInput.addEventListener('change', apply);
  const el = h('div', { class: 'minmax' }, h('span', { text: 'MIN' }), minInput, h('span', { text: 'MAX' }), maxInput);
  return {
    state,
    el,
    set(lo, hi) {
      minInput.value = lo;
      maxInput.value = hi;
      apply();
    },
  };
}

/* Maps a 0..1 (or -1..1 when bipolar) signal onto min..max and exposes it as a value output node. */
function makeScaler(ctx, source, bipolar) {
  const scale = ctx.createGain();
  const offset = ctx.createConstantSource();
  const out = ctx.createGain();
  source.connect(scale);
  scale.connect(out);
  offset.connect(out);
  offset.start();
  return {
    out,
    setRange(min, max) {
      const t = ctx.currentTime;
      scale.gain.setTargetAtTime(bipolar ? (max - min) / 2 : max - min, t, 0.005);
      offset.offset.setTargetAtTime(bipolar ? (max + min) / 2 : min, t, 0.005);
    },
    destroy() {
      offset.stop();
      for (const n of [scale, offset, out]) n.disconnect();
    },
  };
}

/* ---------- Filter ---------- */

const FILTER_TYPES = [
  ['LOWPASS', 'lowpass'], ['HIGHPASS', 'highpass'], ['BANDPASS', 'bandpass'], ['NOTCH', 'notch'],
  ['PEAK', 'peaking'], ['LO SHELF', 'lowshelf'], ['HI SHELF', 'highshelf'],
];

class FilterBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'filter', title: 'FILTER', desc: 'Shapes the frequency content',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.inNode = ctx.createGain();
    this.biq = ctx.createBiquadFilter();
    this.probe = ctx.createBiquadFilter(); // never connected; used to draw the response of the displayed values
    this.inNode.connect(this.biq);
    this.inAn = makeAnalyser(app, this.inNode);
    this.outAn = makeAnalyser(app, this.biq);

    this.initModifiers([
      { id: 'cutoff', param: this.biq.frequency, label: 'CUTOFF', port: 'CUTOFF Hz', min: 20, max: 20000, value: 1000, log: true, decimals: 0 },
      { id: 'q', param: this.biq.Q, label: 'RESO', port: 'RESO 0.1-30', min: 0.1, max: 30, value: 1, log: true, decimals: 2 },
      { id: 'gain', param: this.biq.gain, label: 'GAIN dB', port: 'GAIN dB', min: -24, max: 24, value: 0, decimals: 1 },
    ]);
    this.typeBtns = FILTER_TYPES.map(([name], i) => h('button', { text: name, onclick: () => this.setType(i) }));
    this.resp = h('canvas', { class: 'scope response', width: 240, height: 100 });
    this.freqs = new Float32Array(240);
    for (let i = 0; i < 240; i++) this.freqs[i] = 20 * Math.pow(1000, i / 239);
    this.mag = new Float32Array(240);
    this.phs = new Float32Array(240);
    this.scopeIn = makeScope('INPUT');
    this.scopeOut = makeScope('OUTPUT');
    const m = this.modifiers;
    this.body.append(
      h('div', { class: 'btn-row wrap' }, this.typeBtns),
      m.cutoff.slider.el, m.q.slider.el, m.gain.slider.el,
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'FREQUENCY RESPONSE' }), this.resp),
      this.scopeIn.el, this.scopeOut.el);
    this.setType(0);
  }

  getState() { return { ...super.getState(), typeIdx: this.typeIdx }; }

  setState(s) {
    super.setState(s);
    this.setType(s.typeIdx);
  }

  setType(i) {
    this.typeIdx = i;
    this.biq.type = FILTER_TYPES[i][1];
    this.typeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.modifiers.gain.slider.setDisabled(i < 4, 'off');
  }

  audioIn(portId) { return portId === 'in' ? this.inNode : this.modifiers[portId].param; }
  audioOut() { return this.biq; }

  drawResponse() {
    const c = this.resp;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const m = this.modifiers;
    const cutoff = m.cutoff.slider.get();
    this.probe.type = FILTER_TYPES[this.typeIdx][1];
    this.probe.frequency.value = cutoff;
    this.probe.Q.value = m.q.slider.get();
    this.probe.gain.value = m.gain.slider.get();
    this.probe.getFrequencyResponse(this.freqs, this.mag, this.phs);

    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    const yOf = (db) => H * (1 - (db + 40) / 70);
    const xOf = (f) => (Math.log(f / 20) / Math.log(1000)) * (W - 1);
    g.strokeStyle = 'rgba(51,255,102,0.15)';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.moveTo(Math.round(xOf(f)) + 0.5, 0); g.lineTo(Math.round(xOf(f)) + 0.5, H); }
    for (const db of [-30, -20, -10, 10, 20]) { g.moveTo(0, Math.round(yOf(db)) + 0.5); g.lineTo(W, Math.round(yOf(db)) + 0.5); }
    g.stroke();
    g.strokeStyle = 'rgba(51,255,102,0.4)';
    g.beginPath();
    g.moveTo(0, Math.round(yOf(0)) + 0.5); g.lineTo(W, Math.round(yOf(0)) + 0.5);
    g.stroke();
    g.strokeStyle = 'rgba(255,176,0,0.6)'; // cutoff marker
    g.beginPath();
    g.moveTo(Math.round(xOf(cutoff)) + 0.5, 0); g.lineTo(Math.round(xOf(cutoff)) + 0.5, H);
    g.stroke();

    g.beginPath();
    for (let i = 0; i < 240; i++) {
      const db = 20 * Math.log10(Math.max(this.mag[i], 1e-5));
      const y = clamp(yOf(db), 0, H);
      if (i === 0) g.moveTo(i, y); else g.lineTo(i, y);
    }
    g.strokeStyle = '#33ff66';
    g.lineWidth = 2;
    g.shadowColor = '#33ff66';
    g.shadowBlur = 6;
    g.stroke();
    g.shadowBlur = 0;
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.fillStyle = 'rgba(51,255,102,0.12)';
    g.fill();
  }

  draw() {
    this.syncModifiers();
    this.drawResponse();
    drawScope(this.scopeIn.canvas, this.inAn.node, this.inAn.buf);
    drawScope(this.scopeOut.canvas, this.outAn.node, this.outAn.buf);
  }

  destroy() {
    for (const n of [this.inNode, this.biq, this.inAn.node, this.outAn.node]) n.disconnect();
  }
}

/* ---------- LFO ---------- */

class LfoBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'lfo', title: 'LFO', desc: 'Slow wave that outputs a value',
      outputs: [{ id: 'out', label: 'VALUE OUT', kind: 'value' }],
    }, x, y);
    const ctx = app.ctx;
    this.lastValue = 0;
    this.min = 0;
    this.max = 1;
    this.node = new AudioWorkletNode(ctx, 'osc-processor', { numberOfInputs: 0, outputChannelCount: [1] });
    this.scaler = makeScaler(ctx, this.node, true);
    this.an = makeAnalyser(app, this.node);

    const P = (n) => this.node.parameters.get(n);
    this.initModifiers([
      { id: 'rate', param: P('frequency'), label: 'RATE', port: 'RATE Hz', min: 0.02, max: 60, value: 2, log: true, decimals: 2 },
      { id: 'depth', param: P('amp'), label: 'DEPTH', port: 'DEPTH 0-1', min: 0, max: 1, value: 1, decimals: 2 },
      { id: 'pw', param: P('pw'), label: 'PULSE', port: 'PULSE W 0-1', min: 0.01, max: 0.99, value: 0.5, decimals: 2 },
    ]);
    const types = ['SINE', 'SAW', 'SQUARE', 'TRI', 'S&H', 'NOISE'];
    this.typeBtns = types.map((name, i) => h('button', { text: name, onclick: () => this.setType(i) }));
    const range = makeMinMax(0, 1, (s) => { this.min = s.min; this.max = s.max; this.scaler.setRange(s.min, s.max); });
    this.range = range;
    this.readout = h('div', { class: 'readout', text: '0.00' });
    this.scope = makeScope('WAVE');
    const m = this.modifiers;
    this.body.append(
      h('div', { class: 'btn-row wrap' }, this.typeBtns),
      m.rate.slider.el, m.depth.slider.el, m.pw.slider.el, range.el, this.readout, this.scope.el);
    this.scaler.setRange(0, 1);
    this.setType(0);
  }

  get value() { return this.lastValue; }

  getState() { return { ...super.getState(), waveType: this.waveType, min: this.min, max: this.max }; }

  setState(s) {
    super.setState(s);
    this.range.set(s.min, s.max);
    this.setType(s.waveType);
  }

  setType(i) {
    this.waveType = i;
    this.node.port.postMessage({ type: i });
    this.typeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.modifiers.pw.slider.setDisabled(i !== 2, 'off');
  }

  audioIn(portId) { return this.modifiers[portId].param; }
  audioOut() { return this.scaler.out; }

  draw() {
    this.syncModifiers();
    drawScope(this.scope.canvas, this.an.node, this.an.buf);
    const x = this.an.buf[this.an.buf.length - 1];
    this.lastValue = (this.max + this.min) / 2 + x * (this.max - this.min) / 2;
    this.readout.textContent = this.lastValue.toFixed(2);
  }

  destroy() {
    this.scaler.destroy();
    this.node.disconnect();
    this.an.node.disconnect();
  }
}

/* ---------- Delay ---------- */

class DelayBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'delay', title: 'ECHO DELAY', desc: 'Repeats a wave with feedback',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.inNode = ctx.createGain();
    this.delay = ctx.createDelay(2);
    this.fb = ctx.createGain();
    this.sat = ctx.createWaveShaper(); // keeps runaway feedback musical
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(2 * (i / 511.5 - 1));
    this.sat.curve = curve;
    this.damp = ctx.createBiquadFilter();
    this.damp.type = 'lowpass';
    this.wet = ctx.createGain();
    this.outNode = ctx.createGain();
    this.inNode.connect(this.outNode);
    this.inNode.connect(this.delay);
    this.delay.connect(this.wet);
    this.wet.connect(this.outNode);
    this.delay.connect(this.fb);
    this.fb.connect(this.sat);
    this.sat.connect(this.damp);
    this.damp.connect(this.delay);
    this.inAn = makeAnalyser(app, this.inNode);
    this.outAn = makeAnalyser(app, this.outNode);

    this.initModifiers([
      { id: 'time', param: this.delay.delayTime, label: 'TIME s', port: 'TIME s 0-2', min: 0.005, max: 2, value: 0.3, log: true, decimals: 3, tc: 0.05 },
      { id: 'fb', param: this.fb.gain, label: 'FDBK', port: 'FDBK 0-1.1', min: 0, max: 1.1, value: 0.4, decimals: 2 },
      { id: 'wet', param: this.wet.gain, label: 'WET', port: 'WET 0-1', min: 0, max: 1, value: 0.4, decimals: 2 },
      { id: 'damp', param: this.damp.frequency, label: 'DAMP Hz', port: 'DAMP Hz', min: 200, max: 20000, value: 6000, log: true, decimals: 0 },
    ]);
    this.scopeIn = makeScope('INPUT');
    this.scopeOut = makeScope('OUTPUT (DRY + ECHOES)');
    const m = this.modifiers;
    this.body.append(m.time.slider.el, m.fb.slider.el, m.wet.slider.el, m.damp.slider.el, this.scopeIn.el, this.scopeOut.el);
  }

  audioIn(portId) { return portId === 'in' ? this.inNode : this.modifiers[portId].param; }
  audioOut() { return this.outNode; }

  draw() {
    this.syncModifiers();
    drawScope(this.scopeIn.canvas, this.inAn.node, this.inAn.buf);
    drawScope(this.scopeOut.canvas, this.outAn.node, this.outAn.buf);
  }

  destroy() {
    for (const n of [this.inNode, this.delay, this.fb, this.sat, this.damp, this.wet, this.outNode, this.inAn.node, this.outAn.node]) n.disconnect();
  }
}

/* ---------- Spectrum analyzer ---------- */

const SPECTRUM_MAX_BANDS = 8;

class SpectrumBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'spectrum', title: 'SPECTRUM', desc: 'Shows frequencies; passes the wave through',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.node = ctx.createGain();
    this.an = ctx.createAnalyser();
    this.an.fftSize = 4096;
    this.node.connect(this.an);
    this.an.connect(app.sink);
    this.bins = new Float32Array(this.an.frequencyBinCount);
    this.bands = 60;
    this.peaks = new Float32Array(this.bands);
    this.holdOn = true;
    this.range = 90;

    this.smooth = makeSlider({
      label: 'SMOOTH', min: 0, max: 0.95, value: 0.75, decimals: 2,
      onInput: (v) => { this.an.smoothingTimeConstant = v; },
    });
    this.an.smoothingTimeConstant = 0.75;
    this.rangeSlider = makeSlider({
      label: 'RANGE', min: 30, max: 120, value: 90, decimals: 0,
      onInput: (v) => { this.range = v; },
    });
    this.holdBtn = h('button', { text: 'PEAK HOLD', class: 'active', onclick: () => this.setHold(!this.holdOn) });
    this.canvas = h('canvas', { class: 'scope spectrum', width: 240, height: 110 });
    this.readout = h('div', { class: 'readout small', text: '-' });

    // Band outputs: each watches a frequency range and outputs how loud it is.
    this.bandDefs = [];
    this.bandNodes = [];
    this.bandVals = [];
    this.bandMeter = 0; // 0 loudest bin in the band, 1 average power
    this.bandUnit = 0; // 0 = 0..1 across the RANGE window, 1 = dB
    this.bandCount = makeSlider({ label: 'BANDS', min: 0, max: SPECTRUM_MAX_BANDS, value: 0, decimals: 0, onInput: (v) => this.setBandCount(Math.round(v)) });
    this.meterBtns = ['PEAK', 'AVERAGE'].map((n, i) => h('button', { text: n, onclick: () => this.setBandMeter(i) }));
    this.unitBtns = ['0-1', 'dB'].map((n, i) => h('button', { text: n, onclick: () => this.setBandUnit(i) }));
    this.bandBox = h('div', { class: 'bands' });
    const row = (label, buttons) => h('div', { class: 'ctl names' }, h('span', { text: label }), h('div', { class: 'btn-row' }, buttons));
    this.body.append(
      this.smooth.el, this.rangeSlider.el, h('div', { class: 'btn-row' }, this.holdBtn), this.canvas, this.readout,
      this.bandCount.el, row('LEVEL', this.meterBtns), row('OUT', this.unitBtns), this.bandBox);
    this.setBandMeter(0);
    this.setBandUnit(0);
    [[20, 250], [250, 2000], [2000, 12000]].forEach(([lo, hi]) => this.addBand(lo, hi));
    this.bandCount.set(3);
  }

  setBandMeter(i) { this.bandMeter = i; this.meterBtns.forEach((b, k) => b.classList.toggle('active', k === i)); }

  setBandUnit(i) {
    this.bandUnit = i;
    this.unitBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.bandDefs.forEach((_, k) => this.relabelBand(k));
  }

  relabelBand(k) {
    const text = `BAND ${k + 1} ${this.bandUnit ? 'dB' : '0-1'}`;
    const def = this.outputs.find((p) => p.id === `b${k + 1}`);
    if (def) def.label = text;
    const row = this.portRows[`b${k + 1}`];
    if (row) row.querySelector('.name').textContent = text;
  }

  addBand(lo, hi) {
    const k = this.bandDefs.length;
    const ctx = this.app.ctx;
    const node = ctx.createConstantSource();
    node.offset.value = 0;
    node.start();
    this.bandDefs.push({ lo, hi });
    this.bandNodes.push(node);
    this.bandVals.push(0);
    this.addPort({ id: `b${k + 1}`, label: '', kind: 'value' }, true);
    this.relabelBand(k);
    const loIn = h('input', { type: 'number', step: 'any', min: 10, max: 22000, value: lo });
    const hiIn = h('input', { type: 'number', step: 'any', min: 10, max: 22000, value: hi });
    // Editing one edge past the other drags the other edge along, so typing LO then HI in either order works.
    const apply = (edited) => {
      let a = parseFloat(loIn.value);
      let b = parseFloat(hiIn.value);
      if (Number.isNaN(a)) a = this.bandDefs[k].lo;
      if (Number.isNaN(b)) b = this.bandDefs[k].hi;
      a = clamp(a, 10, 22000);
      b = clamp(b, 10, 22000);
      if (a > b) { if (edited === 'lo') b = a; else a = b; }
      this.bandDefs[k] = { lo: a, hi: b };
      loIn.value = a;
      hiIn.value = b;
    };
    loIn.addEventListener('change', () => apply('lo'));
    hiIn.addEventListener('change', () => apply('hi'));
    const row = h('div', { class: 'minmax wide' }, h('span', { text: `B${k + 1} LO` }), loIn, h('span', { text: 'HI Hz' }), hiIn);
    row.dataset.band = k;
    this.bandBox.append(row);
  }

  removeLastBand() {
    const k = this.bandDefs.length - 1;
    const id = `b${k + 1}`;
    for (const c of this.app.conns.filter((cn) => cn.from.block === this && cn.from.port === id)) this.app.disconnect(c);
    this.removePort(id, true);
    this.bandBox.lastElementChild.remove();
    const node = this.bandNodes.pop();
    node.stop();
    node.disconnect();
    this.bandDefs.pop();
    this.bandVals.pop();
  }

  setBandCount(n) {
    while (this.bandDefs.length > n) this.removeLastBand();
    while (this.bandDefs.length < n) this.addBand(20, 20000);
    this.app.renderWires();
  }

  setHold(on) {
    this.holdOn = on;
    this.holdBtn.classList.toggle('active', on);
  }

  getState() {
    return {
      smooth: this.smooth.get(), range: this.rangeSlider.get(), hold: this.holdOn,
      bands: this.bandDefs.map((b) => ({ ...b })), meter: this.bandMeter, unit: this.bandUnit,
    };
  }

  setState(s) {
    this.smooth.set(s.smooth, true);
    this.rangeSlider.set(s.range, true);
    this.setHold(s.hold);
    if (Array.isArray(s.bands)) {
      this.setBandCount(0);
      s.bands.forEach((b) => this.addBand(b.lo, b.hi));
      this.bandCount.set(s.bands.length);
    }
    this.setBandMeter(s.meter || 0);
    this.setBandUnit(s.unit || 0);
    this.app.renderWires();
  }

  getValue(portId) {
    const k = /^b(\d+)$/.test(portId) ? +portId.slice(1) - 1 : -1;
    return k >= 0 ? this.bandVals[k] : this.value;
  }

  audioIn() { return this.node; }
  audioOut(portId) { return /^b\d+$/.test(portId) ? this.bandNodes[+portId.slice(1) - 1] : this.node; }

  // Reads the spectrum and updates the band outputs; runs every frame, also while the block's tab is hidden.
  tick() {
    this.an.getFloatFrequencyData(this.bins);
    if (!this.bandDefs.length) return;
    const binHz = this.app.ctx.sampleRate / 2 / this.bins.length;
    const now = this.app.ctx.currentTime;
    this.bandDefs.forEach((b, k) => {
      const i0 = clamp(Math.floor(b.lo / binHz), 1, this.bins.length - 1);
      const i1 = clamp(Math.max(i0, Math.ceil(b.hi / binHz) - 1), i0, this.bins.length - 1);
      let db;
      if (this.bandMeter === 0) {
        db = -140;
        for (let i = i0; i <= i1; i++) if (this.bins[i] > db) db = this.bins[i];
      } else {
        let power = 0;
        for (let i = i0; i <= i1; i++) power += Math.pow(10, Math.max(this.bins[i], -140) / 10);
        db = 10 * Math.log10(power / (i1 - i0 + 1));
      }
      const v = this.bandUnit ? clamp(db, -100, 0) : clamp((db + this.range) / this.range, 0, 1);
      this.bandVals[k] = v;
      this.bandNodes[k].offset.setTargetAtTime(v, now, 0.01);
    });
  }

  draw() {
    this.tick();
    const c = this.canvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height - 12; // bottom strip is for frequency labels
    const nyq = this.app.ctx.sampleRate / 2;
    const binHz = nyq / this.bins.length;
    const fMin = 30;
    const fMax = 18000;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, c.height);
    g.strokeStyle = 'rgba(51,255,102,0.15)';
    g.lineWidth = 1;
    g.fillStyle = '#1b8a38';
    g.font = '9px monospace';
    g.beginPath();
    for (const [f, label] of [[100, '100'], [1000, '1K'], [10000, '10K']]) {
      const x = Math.round((Math.log(f / fMin) / Math.log(fMax / fMin)) * W) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, H);
      g.fillText(label, x + 2, c.height - 2);
    }
    for (let i = 1; i < 4; i++) { g.moveTo(0, Math.round((H * i) / 4) + 0.5); g.lineTo(W, Math.round((H * i) / 4) + 0.5); }
    g.stroke();

    const bw = W / this.bands;
    let best = -Infinity;
    let bestBin = 0;
    for (let b = 0; b < this.bands; b++) {
      const f0 = fMin * Math.pow(fMax / fMin, b / this.bands);
      const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / this.bands);
      const i0 = Math.max(1, Math.floor(f0 / binHz));
      const i1 = Math.max(i0, Math.ceil(f1 / binHz) - 1);
      let db = -Infinity;
      for (let i = i0; i <= i1 && i < this.bins.length; i++) {
        if (this.bins[i] > db) db = this.bins[i];
        if (this.bins[i] > best) { best = this.bins[i]; bestBin = i; }
      }
      const level = clamp((db + this.range) / this.range, 0, 1);
      this.peaks[b] = this.holdOn ? Math.max(level, this.peaks[b] - 0.008) : 0;
      const barH = level * H;
      const grad = g.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, '#33ff66');
      grad.addColorStop(0.7, '#33ff66');
      grad.addColorStop(0.88, '#ffb000');
      grad.addColorStop(1, '#ff4a3a');
      g.fillStyle = grad;
      g.fillRect(b * bw + 1, H - barH, Math.max(1, bw - 2), barH);
      if (this.holdOn && this.peaks[b] > 0.01) {
        g.fillStyle = '#fff';
        g.fillRect(b * bw + 1, H - this.peaks[b] * H - 1, Math.max(1, bw - 2), 2);
      }
    }
    // The watched frequency bands, with the level each one is currently reporting.
    this.bandDefs.forEach((b, k) => {
      const x0 = clamp((Math.log(Math.max(b.lo, fMin) / fMin) / Math.log(fMax / fMin)) * W, 0, W);
      const x1 = clamp((Math.log(Math.max(b.hi, fMin) / fMin) / Math.log(fMax / fMin)) * W, 0, W);
      if (x1 <= x0) return;
      g.fillStyle = 'rgba(255,176,0,0.13)';
      g.fillRect(x0, 0, x1 - x0, H);
      g.strokeStyle = 'rgba(255,176,0,0.7)';
      g.beginPath();
      g.moveTo(x0 + 0.5, 0); g.lineTo(x0 + 0.5, H);
      g.moveTo(x1 - 0.5, 0); g.lineTo(x1 - 0.5, H);
      g.stroke();
      const level = this.bandUnit ? (this.bandVals[k] + 100) / 100 : this.bandVals[k];
      g.fillStyle = '#ffb000';
      g.fillRect(x0, H - level * H - 1, x1 - x0, 2);
      g.font = '9px monospace';
      g.fillText(`B${k + 1}`, x0 + 2, 9);
    });
    this.readout.textContent = best > -this.range ? `PEAK ${(bestBin * binHz).toFixed(0)} HZ  ${best.toFixed(0)} DB` : '-';
  }

  destroy() {
    for (const n of this.bandNodes) { n.stop(); n.disconnect(); }
    this.node.disconnect();
    this.an.disconnect();
  }
}

/* ---------- Step sequencer ---------- */

const SEQ_SCALES = [
  ['PENTATONIC', [0, 3, 5, 7, 10]],
  ['MINOR', [0, 2, 3, 5, 7, 8, 10]],
  ['MAJOR', [0, 2, 4, 5, 7, 9, 11]],
  ['DORIAN', [0, 2, 3, 5, 7, 9, 10]],
  ['HARM MINOR', [0, 2, 3, 5, 7, 8, 11]],
  ['BLUES', [0, 3, 5, 6, 7, 10]],
  ['WHOLE TONE', [0, 2, 4, 6, 8, 10]],
  ['CHROMATIC', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
const SEQ_COLS = 16;

class SequencerBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'seq', title: 'STEP SEQUENCER', desc: 'Plays a pattern of pitches',
      inputs: [{ id: 'trig', label: 'TRIG IN', kind: 'value' }],
      outputs: [
        { id: 'pitch', label: 'PITCH Hz', kind: 'value' },
        { id: 'gate', label: 'GATE 0/1', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;
    this.pitchNode = ctx.createConstantSource();
    this.gateNode = ctx.createConstantSource();
    this.pitchNode.offset.value = 110;
    this.gateNode.offset.value = 0;
    this.pitchNode.start();
    this.gateNode.start();
    this.trigIn = ctx.createGain();
    this.trigAn = ctx.createAnalyser();
    this.trigAn.fftSize = 2048;
    this.trigIn.connect(this.trigAn);
    this.trigAn.connect(app.sink);
    this.trigBuf = new Float32Array(this.trigAn.fftSize);
    this.trigHigh = false;
    this.mode = 0; // 0 loops forever, 1 plays the pattern once per trigger
    this.shotLeft = 0;
    this.scaleIdx = 0;
    this.root = 45;
    this.steps = 8;
    this.bpm = 110;
    this.gateLen = 0.6;
    this.glide = 0;
    this.pattern = [0, 2, 4, 2, 3, 2, 5, 7, 0, 0, 0, 0, 0, 0, 0, 0];
    this.rests = new Array(SEQ_COLS).fill(false);
    this.rests[3] = true;
    this.queue = [];
    this.curStep = -1;
    this.curFreq = 110;
    this.curGate = 0;
    this.timer = null;

    this.playBtn = h('button', { text: 'PLAY', onclick: () => (this.playing ? this.stop() : this.start()) });
    this.randBtn = h('button', { text: 'RANDOM', onclick: () => this.randomize() });
    this.clearBtn = h('button', { text: 'CLEAR', onclick: () => this.clear() });
    this.modeBtns = ['LOOP', 'ONE-SHOT'].map((name, i) => h('button', { text: name, onclick: () => this.setMode(i) }));
    this.bpmSlider = makeSlider({ label: 'BPM', min: 40, max: 600, value: 110, decimals: 0, onInput: (v) => { this.bpm = v; } });
    this.stepsSlider = makeSlider({ label: 'STEPS', min: 2, max: SEQ_COLS, value: 8, decimals: 0, onInput: (v) => { this.steps = Math.round(v); } });
    this.gateSlider = makeSlider({ label: 'GATE %', min: 5, max: 95, value: 60, decimals: 0, onInput: (v) => { this.gateLen = v / 100; } });
    this.glideSlider = makeSlider({ label: 'GLIDE', min: 0, max: 300, value: 0, decimals: 0, onInput: (v) => { this.glide = v; } });
    this.rootSelect = h('select', { onchange: () => { this.root = +this.rootSelect.value; } },
      Array.from({ length: 60 }, (_, i) => h('option', { value: 24 + i, text: noteName(24 + i) })));
    this.rootSelect.value = this.root;
    this.scaleSelect = h('select', { onchange: () => this.setScale(+this.scaleSelect.value) },
      SEQ_SCALES.map(([name], i) => h('option', { value: i, text: name })));
    this.canvas = h('canvas', { class: 'scope steps', width: 240, height: 120 });
    this.readout = h('div', { class: 'readout small', text: '-' });
    this.bindEditor();

    this.body.append(
      h('div', { class: 'btn-row' }, this.playBtn, this.randBtn, this.clearBtn),
      h('div', { class: 'btn-row' }, this.modeBtns),
      this.bpmSlider.el, this.stepsSlider.el, this.gateSlider.el, this.glideSlider.el,
      h('div', { class: 'minmax wide' }, h('span', { text: 'ROOT' }), this.rootSelect, h('span', { text: 'SCALE' }), this.scaleSelect),
      this.canvas, this.readout,
      h('div', { class: 'cap hint', text: 'DRAG BARS TO EDIT - SHIFT/RIGHT CLICK = REST' }));
    this.setMode(0);
    this.start();
  }

  setMode(i) {
    this.mode = i;
    this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
  }

  // Sets the whole pattern at once (used by the pack library).
  configure(o) {
    if (o.scale !== undefined) {
      this.scaleIdx = Math.max(0, SEQ_SCALES.findIndex(([name]) => name === o.scale));
      this.scaleSelect.value = this.scaleIdx;
    }
    if (o.root !== undefined) { this.root = o.root; this.rootSelect.value = o.root; }
    if (o.pattern) {
      this.pattern = Array.from({ length: SEQ_COLS }, (_, i) => Math.min(o.pattern[i] || 0, this.levels - 1));
      this.rests = Array.from({ length: SEQ_COLS }, (_, i) => (o.rests || []).includes(i));
      this.stepsSlider.set(o.steps || o.pattern.length, true);
    }
    if (o.bpm !== undefined) this.bpmSlider.set(o.bpm, true);
    if (o.gate !== undefined) this.gateSlider.set(o.gate * 100, true);
    if (o.glide !== undefined) this.glideSlider.set(o.glide, true);
    if (o.mode !== undefined) this.setMode(o.mode);
    this.curFreq = this.degreeFreq(this.pattern[0]);
    this.pitchNode.offset.value = this.curFreq;
  }

  // One-shot mode: restart the pattern from step 1 right now.
  getState() {
    return {
      scaleIdx: this.scaleIdx, root: this.root, pattern: [...this.pattern], rests: [...this.rests], steps: this.steps,
      bpm: this.bpmSlider.get(), gate: this.gateSlider.get(), glide: this.glideSlider.get(), mode: this.mode,
      playing: !!this.playing,
    };
  }

  setState(s) {
    this.scaleIdx = s.scaleIdx;
    this.scaleSelect.value = s.scaleIdx;
    this.root = s.root;
    this.rootSelect.value = s.root;
    this.pattern = [...s.pattern];
    this.rests = [...s.rests];
    this.stepsSlider.set(s.steps, true);
    this.bpmSlider.set(s.bpm, true);
    this.gateSlider.set(s.gate, true);
    this.glideSlider.set(s.glide, true);
    this.setMode(s.mode);
    this.curFreq = this.degreeFreq(this.pattern[0]);
    this.pitchNode.offset.value = this.curFreq;
    if (s.playing === false) this.stop();
  }
  // One-shot mode: restart the pattern from step 1 right now.
  fire() {
    const ctx = this.app.ctx;
    const now = ctx.currentTime;
    this.pitchNode.offset.cancelScheduledValues(now);
    this.gateNode.offset.cancelScheduledValues(now);
    this.gateNode.offset.setValueAtTime(0, now);
    this.queue = [];
    this.step = 0;
    this.shotLeft = this.steps;
    this.nextTime = now + 0.005;
  }

  get scale() { return SEQ_SCALES[this.scaleIdx][1]; }
  get levels() { return this.scale.length * 2 + 1; }

  degreeFreq(d) {
    const len = this.scale.length;
    const semis = Math.floor(d / len) * 12 + this.scale[d % len];
    return 440 * Math.pow(2, (this.root + semis - 69) / 12);
  }

  getValue(portId) { return portId === 'gate' ? this.curGate : this.curFreq; }

  setScale(i) {
    this.scaleIdx = i;
    this.pattern = this.pattern.map((d) => Math.min(d, this.levels - 1));
  }

  randomize() {
    this.pattern = this.pattern.map(() => Math.floor(Math.random() * this.levels));
    this.rests = this.rests.map(() => Math.random() < 0.2);
  }

  clear() {
    this.pattern.fill(0);
    this.rests.fill(false);
  }

  bindEditor() {
    const edit = (e, first) => {
      const r = this.canvas.getBoundingClientRect();
      const col = clamp(Math.floor(((e.clientX - r.left) / r.width) * SEQ_COLS), 0, SEQ_COLS - 1);
      if (first && (e.shiftKey || e.button === 2)) {
        this.rests[col] = !this.rests[col];
        return;
      }
      if (e.buttons !== 1) return;
      const f = 1 - (e.clientY - r.top) / r.height;
      this.pattern[col] = clamp(Math.round(f * (this.levels - 1)), 0, this.levels - 1);
      this.rests[col] = false;
    };
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      edit(e, true);
    });
    this.canvas.addEventListener('pointermove', (e) => edit(e, false));
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = this.app.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.schedule(), 25);
    this.playBtn.textContent = 'STOP';
    this.playBtn.classList.add('active');
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    const t = this.app.ctx.currentTime;
    this.gateNode.offset.cancelScheduledValues(t);
    this.gateNode.offset.setValueAtTime(0, t);
    this.queue = [];
    this.curGate = 0;
    this.curStep = -1;
    this.playBtn.textContent = 'PLAY';
    this.playBtn.classList.remove('active');
  }

  schedule() {
    const ctx = this.app.ctx;
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime; // tab was throttled
    while ((this.mode === 0 || this.shotLeft > 0) && this.nextTime < ctx.currentTime + 0.12) {
      const t = this.nextTime;
      const dur = 60 / this.bpm / 4;
      const i = this.step;
      const rest = this.rests[i];
      const freq = this.degreeFreq(this.pattern[i]);
      if (!rest) {
        if (this.glide > 0) this.pitchNode.offset.setTargetAtTime(freq, t, this.glide / 3000);
        else this.pitchNode.offset.setValueAtTime(freq, t);
        this.gateNode.offset.setValueAtTime(1, t);
        this.gateNode.offset.setValueAtTime(0, t + dur * this.gateLen);
      }
      this.queue.push({ t, step: i, rest, freq, gateEnd: t + dur * this.gateLen });
      if (this.queue.length > 64) this.queue.shift();
      this.nextTime += dur;
      this.step = (this.step + 1) % this.steps;
      if (this.mode === 1) this.shotLeft--;
    }
  }

  // Keeps the playhead and output values current; also runs while the block's tab is hidden.
  tick() {
    const now = this.app.ctx.currentTime;
    this.trigAn.getFloatTimeDomainData(this.trigBuf);
    let high = false;
    for (let i = 0; i < this.trigBuf.length; i++) if (this.trigBuf[i] > 0.5) { high = true; break; }
    if (high && !this.trigHigh && this.mode === 1 && this.playing) this.fire();
    this.trigHigh = high;
    while (this.queue.length > 1 && this.queue[1].t <= now) this.queue.shift();
    const cur = this.queue[0];
    if (cur && cur.t <= now) {
      this.curStep = cur.step;
      this.curGate = !cur.rest && now < cur.gateEnd ? 1 : 0;
      if (!cur.rest) this.curFreq = cur.freq;
      this.curRest = cur.rest;
    }
  }

  draw() {
    this.tick();
    if (this.queue.length) {
      const cur = this.queue[0];
      this.readout.textContent = this.curRest ? 'REST' : `${noteName(this.noteOf(cur.freq))}  ${cur.freq.toFixed(1)} HZ`;
    }
    this.drawSteps();
  }

  noteOf(freq) { return Math.round(69 + 12 * Math.log2(freq / 440)); }

  drawSteps() {
    const c = this.canvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const cw = W / SEQ_COLS;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(51,255,102,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < this.levels; i++) { const y = Math.round((H * i) / this.levels) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    for (let i = 0; i < SEQ_COLS; i++) {
      const active = i < this.steps;
      if (i === this.curStep && this.playing) {
        g.fillStyle = 'rgba(255,176,0,0.18)';
        g.fillRect(i * cw, 0, cw, H);
      }
      const bh = ((this.pattern[i] + 1) / this.levels) * H;
      if (this.rests[i]) {
        g.strokeStyle = active ? 'rgba(51,255,102,0.4)' : 'rgba(51,255,102,0.12)';
        g.strokeRect(i * cw + 2.5, H - bh + 0.5, cw - 5, bh - 1);
      } else {
        g.fillStyle = i === this.curStep && this.playing ? '#ffb000' : '#33ff66';
        g.globalAlpha = active ? 1 : 0.2;
        g.fillRect(i * cw + 2, H - bh, cw - 4, bh);
        g.globalAlpha = 1;
      }
    }
  }

  audioIn() { return this.trigIn; }
  audioOut(portId) { return portId === 'gate' ? this.gateNode : this.pitchNode; }

  destroy() {
    this.stop();
    for (const n of [this.pitchNode, this.gateNode]) { n.stop(); n.disconnect(); }
    this.trigIn.disconnect();
    this.trigAn.disconnect();
  }
}

/* ---------- ADSR envelope ---------- */

class AdsrBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'adsr', title: 'ADSR ENVELOPE', desc: 'Gate in, envelope value out',
      inputs: [{ id: 'gate', label: 'GATE IN', kind: 'value' }],
      outputs: [{ id: 'out', label: 'ENV OUT', kind: 'value' }],
    }, x, y);
    const ctx = app.ctx;
    this.min = 0;
    this.max = 1;
    this.lastValue = 0;
    this.history = new Float32Array(240);
    this.inNode = ctx.createGain();
    this.manual = ctx.createConstantSource();
    this.manual.offset.value = 0;
    this.manual.connect(this.inNode);
    this.manual.start();
    this.node = new AudioWorkletNode(ctx, 'adsr-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    this.inNode.connect(this.node);
    this.scaler = makeScaler(ctx, this.node, false);
    this.an = makeAnalyser(app, this.node);

    this.params = { a: 0.01, d: 0.25, s: 0.6, r: 0.5 };
    const send = (key, scale) => (v) => {
      this.params[key] = v / scale;
      this.node.port.postMessage({ [key]: v / scale });
    };
    this.attack = makeSlider({ label: 'ATTACK', min: 1, max: 5000, value: 10, log: true, decimals: 0, onInput: send('a', 1000) });
    this.decay = makeSlider({ label: 'DECAY', min: 1, max: 5000, value: 250, log: true, decimals: 0, onInput: send('d', 1000) });
    this.sustain = makeSlider({ label: 'SUSTAIN', min: 0, max: 1, value: 0.6, decimals: 2, onInput: send('s', 1) });
    this.release = makeSlider({ label: 'RELEAS', min: 1, max: 8000, value: 500, log: true, decimals: 0, onInput: send('r', 1000) });
    this.node.port.postMessage(this.params);
    const range = makeMinMax(0, 1, (s) => { this.min = s.min; this.max = s.max; this.scaler.setRange(s.min, s.max); });
    this.range = range;
    this.trigBtn = h('button', { text: 'HOLD TO TRIGGER' });
    const gate = (on) => () => this.manual.offset.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.002);
    this.trigBtn.addEventListener('pointerdown', gate(true));
    this.trigBtn.addEventListener('pointerup', gate(false));
    this.trigBtn.addEventListener('pointerleave', gate(false));
    this.readout = h('div', { class: 'readout', text: '0.00' });
    this.shape = h('canvas', { class: 'scope', width: 240, height: 80 });
    this.live = h('canvas', { class: 'scope', width: 240, height: 80 });
    this.body.append(
      this.attack.el, this.decay.el, this.sustain.el, this.release.el, range.el,
      h('div', { class: 'btn-row' }, this.trigBtn), this.readout,
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'SHAPE' }), this.shape),
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'LIVE (LAST 4 SEC)' }), this.live));
    this.scaler.setRange(0, 1);
  }

  get value() { return this.lastValue; }

  getState() {
    return {
      a: this.attack.get(), d: this.decay.get(), s: this.sustain.get(), r: this.release.get(), min: this.min, max: this.max,
    };
  }

  setState(s) {
    this.attack.set(s.a, true);
    this.decay.set(s.d, true);
    this.sustain.set(s.s, true);
    this.release.set(s.r, true);
    this.range.set(s.min, s.max);
  }

  audioIn() { return this.inNode; }
  audioOut() { return this.scaler.out; }

  drawShape() {
    const g = this.shape.getContext('2d');
    const W = this.shape.width;
    const H = this.shape.height;
    const { a, d, s, r } = this.params;
    const hold = (a + d + r) * 0.4;
    const total = a + d + hold + r;
    const x1 = (a / total) * W;
    const x2 = x1 + (d / total) * W;
    const x3 = x2 + (hold / total) * W;
    const y = (v) => H - 6 - v * (H - 12);
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    g.beginPath();
    g.moveTo(0, y(0));
    g.lineTo(x1, y(1));
    g.lineTo(x2, y(s));
    g.lineTo(x3, y(s));
    g.lineTo(W, y(0));
    g.strokeStyle = '#ffb000';
    g.lineWidth = 2;
    g.shadowColor = '#ffb000';
    g.shadowBlur = 6;
    g.stroke();
    g.shadowBlur = 0;
    g.lineTo(0, y(0));
    g.fillStyle = 'rgba(255,176,0,0.12)';
    g.fill();
  }

  drawLive() {
    const g = this.live.getContext('2d');
    const W = this.live.width;
    const H = this.live.height;
    this.history.copyWithin(0, 1);
    this.history[this.history.length - 1] = this.an.buf[this.an.buf.length - 1];
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    g.beginPath();
    for (let i = 0; i < this.history.length; i++) {
      const px = (i / (this.history.length - 1)) * W;
      const py = H - 6 - clamp(this.history[i], 0, 1) * (H - 12);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokeStyle = '#33ff66';
    g.lineWidth = 2;
    g.shadowColor = '#33ff66';
    g.shadowBlur = 6;
    g.stroke();
    g.shadowBlur = 0;
  }

  draw() {
    this.an.node.getFloatTimeDomainData(this.an.buf);
    const level = this.an.buf[this.an.buf.length - 1];
    this.lastValue = this.min + level * (this.max - this.min);
    this.readout.textContent = this.lastValue.toFixed(2);
    this.drawShape();
    this.drawLive();
  }

  destroy() {
    this.manual.stop();
    this.scaler.destroy();
    for (const n of [this.manual, this.inNode, this.node, this.an.node]) n.disconnect();
  }
}

/* ---------- Trigger button ---------- */

const isTyping = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);

class TriggerBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'trigger', title: 'TRIGGER BUTTON', desc: 'Sends a gate: click, or press SPACE',
      outputs: [{ id: 'out', label: 'GATE 0/1', kind: 'value' }],
    }, x, y);
    const ctx = app.ctx;
    this.node = ctx.createConstantSource();
    this.node.offset.value = 0;
    this.node.start();
    this.state = 0;
    this.mode = 0;
    this.repeatTimer = null;
    this.offTimer = null;

    this.modeBtns = ['PULSE', 'HOLD', 'TOGGLE', 'REPEAT'].map((name, i) => h('button', { text: name, onclick: () => this.setMode(i) }));
    this.bigBtn = h('button', { class: 'bigbtn', text: 'TRIGGER' });
    this.len = makeSlider({ label: 'LENGTH', min: 10, max: 2000, value: 150, log: true, decimals: 0 });
    this.rate = makeSlider({ label: 'RATE Hz', min: 0.2, max: 20, value: 3, log: true, decimals: 1, onInput: () => this.restartRepeat() });
    this.body.append(h('div', { class: 'btn-row wrap' }, this.modeBtns), this.len.el, this.rate.el, this.bigBtn,
      h('div', { class: 'cap hint', text: 'SPACE BAR ALSO TRIGGERS BLOCKS IN THE OPEN TAB' }));

    this.bigBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); this.press(); });
    this.bigBtn.addEventListener('pointerup', () => this.release());
    this.bigBtn.addEventListener('pointerleave', () => this.release());
    this.onKeyDown = (e) => {
      if (e.code !== 'Space' || e.repeat || isTyping() || this.tab !== this.app.activeTab) return;
      e.preventDefault();
      this.press();
    };
    this.onKeyUp = (e) => {
      if (e.code !== 'Space') return;
      if (!isTyping()) e.preventDefault();
      this.release();
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.setMode(0);
  }

  get value() { return this.state; }

  getState() { return { mode: this.mode, len: this.len.get(), rate: this.rate.get() }; }

  setState(s) {
    this.len.set(s.len, true);
    this.rate.set(s.rate, true);
    this.setMode(s.mode);
  }

  setMode(i) {
    if (this.mode === 3 && i !== 3) this.stopRepeat();
    this.mode = i;
    this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.len.setDisabled(i !== 0 && i !== 3, 'off');
    this.rate.setDisabled(i !== 3, 'off');
  }

  set(on) {
    this.state = on ? 1 : 0;
    const p = this.node.offset;
    p.cancelScheduledValues(this.app.ctx.currentTime);
    p.setValueAtTime(this.state, this.app.ctx.currentTime);
    this.bigBtn.classList.toggle('lit', !!on);
  }

  pulse(ms) {
    this.set(true);
    clearTimeout(this.offTimer);
    this.offTimer = setTimeout(() => this.set(false), ms);
  }

  press() {
    if (this.mode === 0) this.pulse(this.len.get());
    else if (this.mode === 1) this.set(true);
    else if (this.mode === 2) this.set(!this.state);
    else if (this.repeatTimer) this.stopRepeat(); else this.startRepeat();
  }

  release() {
    if (this.mode === 1 && this.state) this.set(false);
  }

  startRepeat() {
    const period = 1000 / this.rate.get();
    const fire = () => this.pulse(Math.min(this.len.get(), period * 0.6));
    fire();
    this.repeatTimer = setInterval(fire, period);
    this.bigBtn.textContent = 'STOP REPEAT';
  }

  stopRepeat() {
    clearInterval(this.repeatTimer);
    this.repeatTimer = null;
    this.bigBtn.textContent = 'TRIGGER';
  }

  restartRepeat() {
    if (!this.repeatTimer) return;
    this.stopRepeat();
    this.startRepeat();
  }

  audioOut() { return this.node; }

  destroy() {
    this.stopRepeat();
    clearTimeout(this.offTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.node.stop();
    this.node.disconnect();
  }
}

/* ---------- Keyboard ---------- */

// Semitone offsets from the keyboard's base note, on the computer's home row.
const KEYBOARD_KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
const KB_WHITE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16];
const KB_BLACK = [1, 3, 6, 8, 10, 13, 15];

class KeyboardBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'keyboard', title: 'KEYBOARD', desc: 'Play notes: click, or use A W S E D F T G Y H U J K',
      outputs: [
        { id: 'pitch', label: 'PITCH Hz', kind: 'value' },
        { id: 'gate', label: 'GATE 0/1', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;
    this.pitchNode = ctx.createConstantSource();
    this.gateNode = ctx.createConstantSource();
    this.pitchNode.offset.value = 261.63;
    this.gateNode.offset.value = 0;
    this.pitchNode.start();
    this.gateNode.start();
    this.held = [];
    this.curFreq = 261.63;

    this.octave = makeSlider({ label: 'OCTAVE', min: -2, max: 3, value: 0, decimals: 0 });
    this.glide = makeSlider({ label: 'GLIDE', min: 0, max: 500, value: 0, decimals: 0 });
    this.canvas = h('canvas', { class: 'scope keys', width: 240, height: 80 });
    this.body.append(this.octave.el, this.glide.el, this.canvas);

    this.bindMouse();
    this.onKeyDown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping() || this.tab !== this.app.activeTab) return;
      const semi = KEYBOARD_KEYS[e.key.toLowerCase()];
      if (semi === undefined) return;
      e.preventDefault();
      this.noteOn(semi);
    };
    this.onKeyUp = (e) => {
      const semi = KEYBOARD_KEYS[e.key.toLowerCase()];
      if (semi !== undefined) this.noteOff(semi);
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  getValue(portId) { return portId === 'gate' ? (this.held.length ? 1 : 0) : this.curFreq; }

  getState() { return { octave: this.octave.get(), glide: this.glide.get() }; }

  setState(s) {
    this.octave.set(s.octave, true);
    this.glide.set(s.glide, true);
  }

  freqOf(semi) { return 440 * Math.pow(2, (48 + 12 * Math.round(this.octave.get()) + semi - 69) / 12); }

  noteOn(semi) {
    if (this.held.includes(semi)) return;
    const retrigger = this.held.length > 0;
    this.held.push(semi);
    this.update(retrigger);
  }

  noteOff(semi) {
    const i = this.held.indexOf(semi);
    if (i < 0) return;
    this.held.splice(i, 1);
    this.update(false);
  }

  update(retrigger) {
    const now = this.app.ctx.currentTime;
    const g = this.gateNode.offset;
    g.cancelScheduledValues(now);
    if (!this.held.length) {
      g.setValueAtTime(0, now);
      return;
    }
    this.curFreq = this.freqOf(this.held[this.held.length - 1]);
    const p = this.pitchNode.offset;
    p.cancelScheduledValues(now);
    if (this.glide.get() > 0) p.setTargetAtTime(this.curFreq, now, this.glide.get() / 3000);
    else p.setValueAtTime(this.curFreq, now);
    if (retrigger) {
      g.setValueAtTime(0, now);
      g.setValueAtTime(1, now + 0.004);
    } else {
      g.setValueAtTime(1, now);
    }
  }

  keyAt(px, py) {
    const W = this.canvas.width;
    const kw = W / KB_WHITE.length;
    if (py < this.canvas.height * 0.6) {
      for (const s of KB_BLACK) {
        const wi = KB_WHITE.findIndex((w) => w > s);
        const x = wi * kw;
        if (px > x - kw * 0.3 && px < x + kw * 0.3) return s;
      }
    }
    return KB_WHITE[clamp(Math.floor(px / kw), 0, KB_WHITE.length - 1)];
  }

  bindMouse() {
    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return this.keyAt(((e.clientX - r.left) / r.width) * this.canvas.width, ((e.clientY - r.top) / r.height) * this.canvas.height);
    };
    let down = null;
    const change = (semi) => {
      if (semi === down) return;
      if (down !== null) this.noteOff(down);
      down = semi;
      if (semi !== null) this.noteOn(semi);
    };
    this.canvas.addEventListener('pointerdown', (e) => { this.canvas.setPointerCapture(e.pointerId); change(pos(e)); });
    this.canvas.addEventListener('pointermove', (e) => { if (down !== null) change(pos(e)); });
    this.canvas.addEventListener('pointerup', () => change(null));
    this.canvas.addEventListener('pointercancel', () => change(null));
  }

  tick() {
    if (this.held.length && this.tab !== this.app.activeTab) {
      for (const s of [...this.held]) this.noteOff(s);
    }
  }

  draw() {
    this.tick();
    const g = this.canvas.getContext('2d');
    const W = this.canvas.width;
    const H = this.canvas.height;
    const kw = W / KB_WHITE.length;
    const letters = Object.fromEntries(Object.entries(KEYBOARD_KEYS).map(([k, s]) => [s, k.toUpperCase()]));
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    KB_WHITE.forEach((s, i) => {
      g.fillStyle = this.held.includes(s) ? '#ffb000' : '#33ff66';
      g.fillRect(i * kw + 1, 0, kw - 2, H);
      g.fillStyle = '#031006';
      g.font = '10px monospace';
      g.fillText(letters[s], i * kw + kw / 2 - 3, H - 6);
    });
    for (const s of KB_BLACK) {
      const wi = KB_WHITE.findIndex((w) => w > s);
      g.fillStyle = this.held.includes(s) ? '#ffb000' : '#052a10';
      g.fillRect(wi * kw - kw * 0.28, 0, kw * 0.56, H * 0.6);
      g.strokeStyle = '#33ff66';
      g.strokeRect(wi * kw - kw * 0.28 + 0.5, 0.5, kw * 0.56 - 1, H * 0.6);
      g.fillStyle = '#33ff66';
      g.font = '9px monospace';
      g.fillText(letters[s], wi * kw - 3, H * 0.6 - 5);
    }
  }

  audioOut(portId) { return portId === 'gate' ? this.gateNode : this.pitchNode; }

  destroy() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    for (const n of [this.pitchNode, this.gateNode]) { n.stop(); n.disconnect(); }
  }
}

/* ---------- Audio input ---------- */

class AudioInputBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'audioin', title: 'AUDIO INPUT', desc: 'Any audio input, as a wave',
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.node = ctx.createGain();
    this.an = makeAnalyser(app, this.node);
    this.stream = null;
    this.source = null;
    this.startToken = 0;
    this.deviceId = '';
    this.opts = { echo: false, noise: false, auto: false };
    this.peak = 0;

    this.initModifiers([
      { id: 'gain', param: this.node.gain, label: 'GAIN', port: 'GAIN 0-4', min: 0, max: 4, value: 1, decimals: 2 },
    ]);
    this.micBtn = h('button', { text: 'INPUT OFF', onclick: () => (this.stream ? this.stop() : this.start()) });
    this.deviceSelect = h('select', { onchange: () => { this.deviceId = this.deviceSelect.value; if (this.stream) this.start(); } },
      h('option', { value: '', text: 'DEFAULT AUDIO INPUT' }));
    this.optBtns = [['echo', 'ECHO CANCEL'], ['noise', 'NOISE SUPPRESS'], ['auto', 'AUTO GAIN']].map(([key, label]) => {
      const b = h('button', { text: label });
      b.dataset.opt = key;
      b.addEventListener('click', () => {
        this.opts[key] = !this.opts[key];
        this.refreshOptButtons();
        if (this.stream) this.start(); // constraints only apply to a new stream
      });
      return b;
    });
    this.statusEl = h('div', { class: 'readout small', text: 'INPUT OFF - CLICK TO START' });
    this.meter = h('canvas', { class: 'meter', width: 240, height: 14 });
    this.scope = makeScope('INPUT WAVE');
    this.body.append(
      h('div', { class: 'btn-row' }, this.micBtn),
      this.deviceSelect,
      this.modifiers.gain.slider.el,
      h('div', { class: 'btn-row wrap' }, this.optBtns),
      this.statusEl,
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'LEVEL' }), this.meter),
      this.scope.el,
      h('div', { class: 'cap hint', text: 'USE HEADPHONES: AN INPUT HEARD BY THE SPEAKERS GIVES FEEDBACK' }));
    this.refreshOptButtons();
    this.onDevices = () => this.refreshDevices();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.onDevices);
    }
  }

  setStatus(text, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.style.color = error ? '#ff4a3a' : '';
  }

  refreshOptButtons() {
    this.optBtns.forEach((b) => b.classList.toggle('active', this.opts[b.dataset.opt]));
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.setStatus('AUDIO INPUT NEEDS HTTPS OR LOCALHOST', true);
      return;
    }
    this.release();
    const token = ++this.startToken;
    this.setStatus('WAITING FOR PERMISSION...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
          echoCancellation: this.opts.echo,
          noiseSuppression: this.opts.noise,
          autoGainControl: this.opts.auto,
        },
      });
      if (token !== this.startToken || this.destroyed) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.source = this.app.ctx.createMediaStreamSource(stream);
      this.source.connect(this.node);
      const track = stream.getAudioTracks()[0];
      track.addEventListener('ended', () => { if (this.stream === stream) this.stop(); });
      this.micBtn.textContent = 'INPUT ON';
      this.micBtn.classList.add('active');
      this.setStatus(`LISTENING: ${track.label || 'AUDIO INPUT'}`);
      await this.refreshDevices();
    } catch (err) {
      if (token !== this.startToken) return;
      this.release();
      const messages = {
        NotAllowedError: 'AUDIO INPUT BLOCKED - ALLOW IT IN THE BROWSER',
        NotFoundError: 'NO AUDIO INPUT FOUND',
        NotReadableError: 'AUDIO INPUT IS BUSY OR UNAVAILABLE',
        OverconstrainedError: 'THAT AUDIO INPUT IS NOT AVAILABLE',
      };
      this.setStatus(messages[err.name] || `AUDIO INPUT ERROR: ${err.message}`, true);
    }
  }

  release() {
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
    this.micBtn.textContent = 'INPUT OFF';
    this.micBtn.classList.remove('active');
  }

  stop() {
    this.startToken++;
    this.release();
    this.setStatus('INPUT OFF - CLICK TO START');
  }

  // Device names are only available once the user has granted access.
  async refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId);
    const options = [h('option', { value: '', text: 'DEFAULT AUDIO INPUT' }),
      ...inputs.map((d, i) => h('option', { value: d.deviceId, text: d.label || `AUDIO INPUT ${i + 1}` }))];
    this.deviceSelect.replaceChildren(...options);
    this.deviceSelect.value = inputs.some((d) => d.deviceId === this.deviceId) ? this.deviceId : '';
  }

  getState() { return { ...super.getState(), opts: { ...this.opts }, deviceId: this.deviceId }; }

  // The audio input is never switched on by loading a project: the browser needs a click for that.
  setState(s) {
    super.setState(s);
    this.opts = { ...this.opts, ...s.opts };
    this.deviceId = s.deviceId || '';
    this.refreshOptButtons();
  }

  audioIn(portId) { return this.modifiers[portId].param; }
  audioOut() { return this.node; }

  draw() {
    this.syncModifiers();
    drawScope(this.scope.canvas, this.an.node, this.an.buf);
    let pk = 0;
    for (let i = 0; i < this.an.buf.length; i++) pk = Math.max(pk, Math.abs(this.an.buf[i]));
    this.peak = Math.max(pk, this.peak * 0.92);
    const g = this.meter.getContext('2d');
    const W = this.meter.width;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, this.meter.height);
    const w = clamp(this.peak, 0, 1) * W;
    g.fillStyle = this.peak > 0.9 ? '#ff4a3a' : this.peak > 0.6 ? '#ffb000' : '#33ff66';
    g.fillRect(0, 2, w, this.meter.height - 4);
  }

  destroy() {
    this.destroyed = true;
    this.startToken++;
    this.release();
    if (navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onDevices);
    }
    this.node.disconnect();
    this.an.node.disconnect();
  }
}

/* ---------- Dominant frequency ---------- */

const DOM_SLOTS = 4;
const DOM_FFT_SIZES = [4096, 8192, 16384, 32768];
const DOM_ORDERS = ['LOUDEST', 'LOW > HIGH', 'HIGH > LOW'];

class DominantFreqBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'domfreq', title: 'DOMINANT FREQ', desc: 'Finds the loudest frequencies of a wave',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [
        ...Array.from({ length: DOM_SLOTS }, (_, i) => ({ id: `f${i + 1}`, label: `FREQ ${i + 1} Hz`, kind: 'value' })),
        { id: 'gate', label: 'FOUND 0/1', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;
    this.inNode = ctx.createGain();
    this.an = ctx.createAnalyser();
    this.an.fftSize = DOM_FFT_SIZES[1];
    this.an.smoothingTimeConstant = 0.5;
    this.inNode.connect(this.an);
    this.an.connect(app.sink);
    this.bins = new Float32Array(this.an.frequencyBinCount);

    this.outNodes = {};
    this.cur = {};
    for (const p of this.outputs) {
      const n = ctx.createConstantSource();
      n.offset.value = 0;
      n.start();
      this.outNodes[p.id] = n;
      this.cur[p.id] = 0;
    }
    this.found = [];
    this.opts = { fft: 1, order: 0, fundamental: false, snap: false, hold: true };

    this.countSlider = makeSlider({ label: 'VALUES', min: 1, max: DOM_SLOTS, value: 1, decimals: 0, onInput: () => this.refreshSlots() });
    this.threshold = makeSlider({ label: 'THRESH', min: -100, max: -10, value: -60, decimals: 0 });
    this.spacing = makeSlider({ label: 'SPACING', min: 0.5, max: 12, value: 1, decimals: 1 });
    this.average = makeSlider({
      label: 'AVERAGE', min: 0, max: 0.95, value: 0.5, decimals: 2,
      onInput: (v) => { this.an.smoothingTimeConstant = v; },
    });
    this.glide = makeSlider({ label: 'GLIDE', min: 0, max: 1000, value: 30, decimals: 0 });
    this.range = makeMinMax(40, 4000, () => {});
    this.fftBtns = DOM_FFT_SIZES.map((n, i) => h('button', { text: `${n / 1024}K`, onclick: () => this.setOpt('fft', i) }));
    this.orderBtns = DOM_ORDERS.map((name, i) => h('button', { text: name, onclick: () => this.setOpt('order', i) }));
    this.fundBtn = h('button', { text: 'FUNDAMENTAL', onclick: () => this.setOpt('fundamental', !this.opts.fundamental) });
    this.snapBtn = h('button', { text: 'SNAP NOTE', onclick: () => this.setOpt('snap', !this.opts.snap) });
    this.holdBtn = h('button', { text: 'HOLD LAST', onclick: () => this.setOpt('hold', !this.opts.hold) });
    this.canvas = h('canvas', { class: 'scope spectrum', width: 240, height: 110 });
    this.readout = h('div', { class: 'readout small multi', text: '-' });

    this.body.append(
      this.countSlider.el, this.threshold.el, this.spacing.el, this.average.el, this.glide.el, this.range.el,
      h('div', { class: 'ctl names' }, h('span', { text: 'FFT' }), h('div', { class: 'btn-row' }, this.fftBtns)),
      h('div', { class: 'btn-row' }, this.orderBtns),
      h('div', { class: 'btn-row' }, this.fundBtn, this.snapBtn, this.holdBtn),
      this.canvas, this.readout);
    this.refreshOptButtons();
    this.refreshSlots();
  }

  setOpt(key, value) {
    this.opts[key] = value;
    if (key === 'fft') {
      this.an.fftSize = DOM_FFT_SIZES[value];
      this.bins = new Float32Array(this.an.frequencyBinCount);
    }
    this.refreshOptButtons();
  }

  refreshOptButtons() {
    const o = this.opts;
    this.fftBtns.forEach((b, i) => b.classList.toggle('active', i === o.fft));
    this.orderBtns.forEach((b, i) => b.classList.toggle('active', i === o.order));
    this.fundBtn.classList.toggle('active', o.fundamental);
    this.snapBtn.classList.toggle('active', o.snap);
    this.holdBtn.classList.toggle('active', o.hold);
  }

  get count() { return Math.round(this.countSlider.get()); }

  // Ports past the VALUES count stay at 0 and are dimmed.
  refreshSlots() {
    for (let i = 0; i < DOM_SLOTS; i++) this.portRows[`f${i + 1}`].style.opacity = i < this.count ? '' : '0.35';
  }

  getValue(portId) { return this.cur[portId]; }

  getState() {
    return {
      opts: { ...this.opts }, count: this.countSlider.get(), threshold: this.threshold.get(), spacing: this.spacing.get(),
      average: this.average.get(), glide: this.glide.get(), min: this.range.state.min, max: this.range.state.max,
    };
  }

  setState(s) {
    const o = { ...this.opts, ...s.opts };
    this.countSlider.set(s.count ?? 1, true);
    this.threshold.set(s.threshold ?? -60, true);
    this.spacing.set(s.spacing ?? 1, true);
    this.average.set(s.average ?? 0.5, true);
    this.glide.set(s.glide ?? 30, true);
    this.range.set(s.min ?? 40, s.max ?? 4000);
    for (const k of Object.keys(o)) this.setOpt(k, o[k]);
  }

  audioIn() { return this.inNode; }
  audioOut(portId) { return this.outNodes[portId]; }

  /* Local maxima of the spectrum inside the range, refined to sub-bin precision by a parabola through the three bins around each. */
  findPeaks(lo, hi, thr) {
    const bins = this.bins;
    const binHz = this.app.ctx.sampleRate / 2 / bins.length;
    const db = (i) => Math.max(bins[i], -200); // silence is reported as -Infinity
    const i0 = Math.max(1, Math.ceil(lo / binHz));
    const i1 = Math.min(bins.length - 2, Math.floor(hi / binHz));
    const peaks = [];
    for (let i = i0; i <= i1; i++) {
      const b = db(i);
      if (b <= thr) continue;
      const a = db(i - 1);
      const c = db(i + 1);
      if (b <= a || b < c) continue;
      const denom = a - 2 * b + c;
      const d = denom < 0 ? clamp((0.5 * (a - c)) / denom, -0.5, 0.5) : 0;
      peaks.push({ freq: (i + d) * binHz, level: b - 0.25 * (a - c) * d });
    }
    return peaks.sort((p, q) => q.level - p.level);
  }

  // Drops peaks that are harmonics of a lower peak which is not much quieter, so a note reports its fundamental.
  removeHarmonics(peaks) {
    const cand = peaks.slice(0, 32);
    return cand.filter((q) => !cand.some((p) => {
      if (p === q || p.freq >= q.freq || p.level < q.level - 24) return false;
      const k = Math.round(q.freq / p.freq);
      return k >= 2 && k <= 8 && Math.abs(q.freq / (p.freq * k) - 1) < 0.03;
    }));
  }

  analyse() {
    this.an.getFloatFrequencyData(this.bins);
    const nyq = this.app.ctx.sampleRate / 2;
    const lo = Math.max(20, this.range.state.min);
    const hi = Math.min(nyq, this.range.state.max);
    let peaks = hi > lo ? this.findPeaks(lo, hi, this.threshold.get()) : [];
    if (this.opts.fundamental) peaks = this.removeHarmonics(peaks);

    const ratio = Math.pow(2, this.spacing.get() / 12);
    const found = [];
    for (const p of peaks) {
      if (found.length >= this.count) break;
      if (found.every((f) => Math.max(f.freq, p.freq) / Math.min(f.freq, p.freq) >= ratio)) found.push(p);
    }
    if (this.opts.order === 1) found.sort((p, q) => p.freq - q.freq);
    else if (this.opts.order === 2) found.sort((p, q) => q.freq - p.freq);
    if (this.opts.snap) for (const f of found) f.freq = 440 * Math.pow(2, Math.round(12 * Math.log2(f.freq / 440)) / 12);
    this.found = found;
  }

  setOutput(id, v) {
    if (Math.abs(this.cur[id] - v) < 1e-4) return;
    this.cur[id] = v;
    const p = this.outNodes[id].offset;
    const now = this.app.ctx.currentTime;
    const glide = id === 'gate' ? 0 : this.glide.get();
    if (glide > 0 && v > 0) p.setTargetAtTime(v, now, glide / 3000);
    else p.setValueAtTime(v, now);
  }

  // Runs while the block's tab is hidden too, so wired blocks keep following the wave.
  tick() {
    this.analyse();
    for (let i = 0; i < DOM_SLOTS; i++) {
      const id = `f${i + 1}`;
      if (i >= this.count) this.setOutput(id, 0);
      else if (this.found[i]) this.setOutput(id, this.found[i].freq);
      else if (!this.opts.hold) this.setOutput(id, 0);
    }
    this.setOutput('gate', this.found.length ? 1 : 0);
  }

  draw() {
    this.tick();
    const c = this.canvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height - 12;
    const nyq = this.app.ctx.sampleRate / 2;
    const binHz = nyq / this.bins.length;
    const fMin = Math.max(20, this.range.state.min);
    const fMax = Math.min(nyq, this.range.state.max);
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, c.height);
    if (!(fMax > fMin)) return;
    const xOf = (f) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * W;
    const dbTop = 0;
    const dbSpan = 100;

    g.fillStyle = '#1b8a38';
    g.font = '9px monospace';
    g.strokeStyle = 'rgba(51,255,102,0.15)';
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      if (f <= fMin || f >= fMax) continue;
      const x = Math.round(xOf(f)) + 0.5;
      g.moveTo(x, 0); g.lineTo(x, H);
      g.fillText(f >= 1000 ? `${f / 1000}K` : `${f}`, x + 2, c.height - 2);
    }
    g.stroke();

    g.fillStyle = '#33ff66';
    for (let px = 0; px < W; px++) {
      const f0 = fMin * Math.pow(fMax / fMin, px / W);
      const f1 = fMin * Math.pow(fMax / fMin, (px + 1) / W);
      const i0 = clamp(Math.floor(f0 / binHz), 0, this.bins.length - 1);
      const i1 = clamp(Math.max(i0, Math.ceil(f1 / binHz) - 1), 0, this.bins.length - 1);
      let db = -200;
      for (let i = i0; i <= i1; i++) if (this.bins[i] > db) db = this.bins[i];
      const barH = clamp((db - dbTop + dbSpan) / dbSpan, 0, 1) * H;
      g.fillRect(px, H - barH, 1, barH);
    }

    const ty = H - clamp((this.threshold.get() + dbSpan) / dbSpan, 0, 1) * H;
    g.strokeStyle = 'rgba(255,74,58,0.7)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, ty + 0.5); g.lineTo(W, ty + 0.5);
    g.stroke();
    g.setLineDash([]);

    g.strokeStyle = '#ffb000';
    g.fillStyle = '#ffb000';
    this.found.forEach((p, i) => {
      const x = Math.round(xOf(p.freq)) + 0.5;
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x, H);
      g.stroke();
      g.fillText(`${i + 1}`, clamp(x + 3, 0, W - 8), 10);
    });

    const lines = this.found.map((p, i) => {
      const midi = 69 + 12 * Math.log2(p.freq / 440);
      const near = Math.round(midi);
      const cents = Math.round((midi - near) * 100);
      return `${i + 1}: ${p.freq.toFixed(1)} HZ  ${noteName(near)} ${cents >= 0 ? '+' : ''}${cents}c`;
    });
    this.readout.textContent = lines.length ? lines.join('\n') : 'NO SIGNAL';
  }

  destroy() {
    for (const n of Object.values(this.outNodes)) { n.stop(); n.disconnect(); }
    this.inNode.disconnect();
    this.an.disconnect();
  }
}

Object.assign(BLOCK_TYPES, {
  filter: FilterBlock, lfo: LfoBlock, delay: DelayBlock, spectrum: SpectrumBlock, seq: SequencerBlock, adsr: AdsrBlock,
  trigger: TriggerBlock, keyboard: KeyboardBlock, audioin: AudioInputBlock, domfreq: DominantFreqBlock,
});
