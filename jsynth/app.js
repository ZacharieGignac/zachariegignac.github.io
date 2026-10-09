'use strict';

/* ---------- Audio worklet (inlined so the app needs no backend) ---------- */

const WORKLET_SRC = `
// Band-limited step correction, so saw and pulse waves do not alias into inharmonic whistles.
function polyBlep(t, dt) {
  if (dt <= 0) return 0;
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

class OscProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 220, minValue: 0, maxValue: 24000, automationRate: 'a-rate' },
      { name: 'phase', defaultValue: 0, minValue: -100000, maxValue: 100000, automationRate: 'a-rate' },
      { name: 'detune', defaultValue: 0, minValue: -4800, maxValue: 4800, automationRate: 'a-rate' },
      { name: 'pw', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'amp', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'a-rate' }
    ];
  }
  constructor() {
    super();
    this.type = 0;
    this.acc = 0;
    this.held = 0;
    this.port.onmessage = (e) => { this.type = e.data.type; };
  }
  process(inputs, outputs, params) {
    const out = outputs[0][0];
    const freq = params.frequency, phase = params.phase, detune = params.detune, pwp = params.pw, ampp = params.amp;
    const type = this.type;
    const inv = 1 / sampleRate;
    for (let i = 0; i < out.length; i++) {
      const f = freq.length > 1 ? freq[i] : freq[0];
      const p = phase.length > 1 ? phase[i] : phase[0];
      const dt = detune.length > 1 ? detune[i] : detune[0];
      const pw = Math.min(0.99, Math.max(0.01, pwp.length > 1 ? pwp[i] : pwp[0]));
      const amp = ampp.length > 1 ? ampp[i] : ampp[0];
      const inc = f * (dt === 0 ? 1 : Math.pow(2, dt / 1200)) * inv;
      this.acc += inc;
      if (this.acc >= 1) {
        this.acc -= Math.floor(this.acc);
        this.held = Math.random() * 2 - 1;
      }
      let t = this.acc + p / 360;
      t -= Math.floor(t);
      const w = inc > 0.45 ? 0.45 : inc;
      let v;
      switch (type) {
        case 0: v = Math.sin(6.283185307179586 * t); break;
        case 1: v = 2 * t - 1 - polyBlep(t, w); break;
        case 2: {
          let u = t - pw;
          if (u < 0) u += 1;
          v = (t < pw ? 1 : -1) + polyBlep(t, w) - polyBlep(u, w);
          break;
        }
        case 3: v = t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4; break;
        case 4: v = this.held; break;
        default: v = Math.random() * 2 - 1;
      }
      out[i] = v * amp;
    }
    return true;
  }
}
registerProcessor('osc-processor', OscProcessor);

${shapeSample.toString()}
${crushSample.toString()}

class DistortionProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 4, minValue: 0, maxValue: 100, automationRate: 'a-rate' },
      { name: 'bias', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'bits', defaultValue: 16, minValue: 0, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 1, minValue: 0, maxValue: 64, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.mode = 0;
    this.count = 0;
    this.held = 0;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }
  process(inputs, outputs, params) {
    const out = outputs[0][0];
    const inp = inputs[0][0];
    const drive = params.drive, bias = params.bias, mix = params.mix;
    const mode = this.mode;
    const bits = Math.min(16, Math.max(1, Math.round(params.bits[0])));
    const rate = Math.max(1, Math.round(params.rate[0]));
    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;
      const d = drive.length > 1 ? drive[i] : drive[0];
      const b = bias.length > 1 ? bias[i] : bias[0];
      const m = mix.length > 1 ? mix[i] : mix[0];
      let y = shapeSample(mode, d * x + b) - shapeSample(mode, b);
      if (rate > 1) {
        if (this.count <= 0) { this.held = y; this.count = rate; }
        this.count--;
        y = this.held;
      } else {
        this.count = 0;
      }
      if (bits < 16) y = crushSample(y, bits);
      out[i] = x * (1 - m) + y * m;
    }
    return true;
  }
}
registerProcessor('distortion-processor', DistortionProcessor);

class ValueProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = 0;
    this.env = 0;
    this.attack = 0.005;
    this.release = 0.1;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const inp = inputs[0][0];
    const ca = Math.exp(-1 / (Math.max(0.0001, this.attack) * sampleRate));
    const cr = Math.exp(-1 / (Math.max(0.0001, this.release) * sampleRate));
    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;
      if (this.mode === 0) {
        out[i] = Math.min(1, Math.max(0, (x + 1) * 0.5));
      } else {
        const v = Math.abs(x);
        const c = v > this.env ? ca : cr;
        this.env = v + c * (this.env - v);
        out[i] = Math.min(1, this.env);
      }
    }
    return true;
  }
}
registerProcessor('value-processor', ValueProcessor);
`;

/* Waveshapers shared by the audio worklet (via toString) and the transfer-curve display. */
function shapeSample(mode, x) {
  switch (mode) {
    case 0: return Math.tanh(x);
    case 1: return x > 1 ? 1 : x < -1 ? -1 : x;
    case 2: return Math.asin(Math.sin(x * 1.5707963267948966)) * 0.6366197723675814;
    case 3: return x >= 0 ? 1 - Math.exp(-x) : Math.exp(2 * x) - 1;
    case 4: return Math.abs(Math.tanh(x));
    case 5: return Math.sin(x);
    case 6: {
      const c = x > 1 ? 1 : x < -1 ? -1 : x;
      const c2 = c * c;
      return c * (5 + c2 * (-20 + 16 * c2));
    }
    default: return x - 2 * Math.floor((x + 1) / 2);
  }
}

function crushSample(y, bits) {
  const levels = Math.pow(2, bits - 1);
  return Math.round(y * levels) / levels;
}

/* ---------- helpers ---------- */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const SVG_NS = 'http://www.w3.org/2000/svg';

function makeSlider({ label, min, max, value, log = false, decimals = 2, unit = '', onInput }) {
  const range = h('input', { type: 'range', min: 0, max: 1000, step: 1 });
  const num = h('input', { type: 'number', step: 'any' });
  const toPos = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min)) * 1000;
  const fromPos = (p) => (log ? min * Math.pow(max / min, p / 1000) : min + ((max - min) * p) / 1000);
  let current = value;

  const set = (v, notify = false) => {
    current = clamp(v, min, max);
    range.value = toPos(current);
    num.value = current.toFixed(decimals);
    if (notify && onInput) onInput(current);
  };
  range.addEventListener('input', () => set(fromPos(+range.value), true));
  num.addEventListener('change', () => {
    const v = parseFloat(num.value);
    set(Number.isNaN(v) ? current : v, true);
  });
  set(value);

  const el = h('div', { class: 'ctl' }, h('span', { text: label }), range, h('span', {}, num));
  return {
    el,
    set,
    get: () => current,
    setDisabled(d, cls = 'disabled') {
      range.disabled = num.disabled = d;
      el.classList.toggle(cls, d);
    },
  };
}

/* Draws a triggered oscilloscope trace of an AnalyserNode. */
function drawScope(canvas, analyser, buf, phaseDeg = 0, unipolar = false) {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  g.fillStyle = '#031006';
  g.fillRect(0, 0, W, H);

  g.strokeStyle = 'rgba(51,255,102,0.15)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 8; i++) { g.moveTo(Math.round((W * i) / 8) + 0.5, 0); g.lineTo(Math.round((W * i) / 8) + 0.5, H); }
  for (let i = 1; i < 4; i++) { g.moveTo(0, Math.round((H * i) / 4) + 0.5); g.lineTo(W, Math.round((H * i) / 4) + 0.5); }
  g.stroke();
  g.strokeStyle = 'rgba(51,255,102,0.35)';
  g.beginPath();
  g.moveTo(0, H / 2 + 0.5);
  g.lineTo(W, H / 2 + 0.5);
  g.stroke();

  analyser.getFloatTimeDomainData(buf);
  // A 0..1 signal is remapped in place to -1..1 (callers may read the remapped buffer).
  if (unipolar) for (let i = 0; i < buf.length; i++) buf[i] = buf[i] * 2 - 1;

  // Trigger on rising zero crossings; show >= 2 periods and >= 160 samples when possible.
  const cross = [];
  for (let i = 1; i < buf.length; i++) if (buf[i - 1] < 0 && buf[i] >= 0) cross.push(i);
  let start = 0;
  let end = buf.length;
  if (cross.length >= 2) {
    start = cross[0];
    let j = 2;
    while (j < cross.length - 1 && cross[j] - start < 160) j++;
    end = cross[Math.min(j, cross.length - 1)];
  } else if (cross.length === 1) {
    start = cross[0];
  }
  const n = Math.max(2, end - start);

  // The wave's own zero crossing hides its phase offset, so re-anchor the trigger to
  // the 0-degree reference point: a positive phase makes the wave start further into its cycle.
  if (cross.length >= 2 && phaseDeg) {
    const period = (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
    start += (((phaseDeg % 360) + 360) % 360 / 360) * period;
    if (start + n > buf.length) start -= period;
    if (start < 0) start += period;
  }

  g.strokeStyle = '#33ff66';
  g.lineWidth = 2;
  g.shadowColor = '#33ff66';
  g.shadowBlur = 6;
  g.beginPath();
  const first = Math.round(start);
  for (let i = 0; i < n && first + i < buf.length; i++) {
    const x = (i / (n - 1)) * W;
    const y = clamp(H / 2 - buf[first + i] * (H / 2 - 4), 0, H);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.shadowBlur = 0;
}

function makeScope(caption) {
  const canvas = h('canvas', { class: 'scope', width: 240, height: 80 });
  return { canvas, el: h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: caption }), canvas) };
}

function makeAnalyser(app, source) {
  const an = app.ctx.createAnalyser();
  an.fftSize = 4096;
  an.smoothingTimeConstant = 0;
  source.connect(an);
  an.connect(app.sink);
  return { node: an, buf: new Float32Array(an.fftSize) };
}

/* ---------- blocks ---------- */

class Block {
  constructor(app, { type, title, desc, inputs = [], outputs = [] }, x, y) {
    this.app = app;
    this.id = ++app.seq;
    this.type = type;
    this.title = title;
    this.inputs = [];
    this.outputs = [];
    this.portEls = {};
    this.portRows = {};
    this.inCol = h('div', { class: 'col' });
    this.outCol = h('div', { class: 'col' });
    inputs.forEach((p) => this.addPort(p, false));
    outputs.forEach((p) => this.addPort(p, true));

    this.closeBtn = h('button', { class: 'close', title: 'Delete block', text: 'X' });
    this.titleEl = h('div', { class: 'title' }, h('span', { text: title }), this.closeBtn);
    this.body = h('div', { class: 'body' });
    this.el = h('div', { class: `block ${type}` },
      this.titleEl,
      h('div', { class: 'desc', text: desc }),
      h('div', { class: 'io' }, this.inCol, this.outCol),
      this.body);
    this.moveTo(x, y);

    this.closeBtn.addEventListener('click', () => app.requestRemove([this]));
    this.titleEl.addEventListener('pointerdown', (e) => {
      if (e.target === this.closeBtn) return;
      app.startBlockDrag(this, e);
    });
    this.el.addEventListener('pointerdown', () => app.bringToFront(this));
  }

  addPort(p, isOut) {
    const port = h('span', { class: `port ${p.kind} ${isOut ? 'out' : 'in'}`, 'data-block': this.id, 'data-port': p.id });
    const row = h('div', { class: `port-row ${isOut ? 'out' : 'in'}` }, port, h('span', { class: `name ${p.kind}`, text: p.label }));
    (isOut ? this.outputs : this.inputs).push(p);
    (isOut ? this.outCol : this.inCol).append(row);
    this.portEls[p.id] = port;
    this.portRows[p.id] = row;
  }

  removePort(id, isOut) {
    const list = isOut ? this.outputs : this.inputs;
    list.splice(list.findIndex((p) => p.id === id), 1);
    this.portRows[id].remove();
    delete this.portRows[id];
    delete this.portEls[id];
  }

  moveTo(x, y) {
    this.x = Math.max(0, x);
    this.y = Math.max(0, y);
    this.el.style.left = `${this.x}px`;
    this.el.style.top = `${this.y}px`;
  }

  audioIn() { return null; }
  audioOut() { return null; }
  getValue() { return this.value; }
  isWired(id) { return !!this.app.sourceOf(this, id); }

  /* Parameter controls: a slider, plus (optionally) a value input port that can drive the parameter. */
  initModifiers(defs) {
    const ctx = this.app.ctx;
    this.modifiers = this.modifiers || {};
    for (const d of defs) {
      const slider = makeSlider({
        ...d, onInput: (v) => d.param.setTargetAtTime(v, ctx.currentTime, d.tc || 0.01),
      });
      d.param.value = d.value;
      this.modifiers[d.id] = { param: d.param, slider };
      if (d.port) this.addPort({ id: d.id, label: d.port, kind: 'value' }, false);
    }
  }

  onPortChange(portId, connected) {
    const m = this.modifiers && this.modifiers[portId];
    if (!m) return;
    // While wired, the external value fully drives the parameter.
    m.param.cancelScheduledValues(0);
    m.param.value = connected ? 0 : m.slider.get();
    m.slider.setDisabled(connected);
  }

  syncModifiers() {
    for (const [id, m] of Object.entries(this.modifiers || {})) {
      const v = this.app.valueFor(this, id);
      if (v !== undefined) m.slider.set(v);
    }
  }

  /* Settings snapshot, used to copy packs. Subclasses add their own fields. */
  getState() {
    const mods = {};
    for (const [id, m] of Object.entries(this.modifiers || {})) mods[id] = m.slider.get();
    return { mods };
  }

  setState(s) {
    for (const [id, v] of Object.entries(s.mods || {})) {
      const m = this.modifiers && this.modifiers[id];
      if (!m) continue;
      m.slider.set(v, true);
      m.param.cancelScheduledValues(0);
      m.param.value = m.slider.get();
    }
  }

  draw() {}
  tick() {} // called instead of draw() while the block's tab is hidden
  destroy() {}
}

class WaveGenBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'osc', title: 'WAVE GENERATOR', desc: 'Generates waves',
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.node = new AudioWorkletNode(ctx, 'osc-processor', { numberOfInputs: 0, outputChannelCount: [1] });
    this.scopeAn = makeAnalyser(app, this.node);
    const P = (n) => this.node.parameters.get(n);
    this.initModifiers([
      { id: 'freq', param: P('frequency'), label: 'FREQ', port: 'FREQ Hz', min: 0.1, max: 10000, value: 220, log: true, decimals: 1 },
      { id: 'phase', param: P('phase'), label: 'PHASE', port: 'PHASE 0-360', min: 0, max: 360, value: 0, decimals: 1 },
      { id: 'detune', param: P('detune'), label: 'DETUNE', port: 'DETUNE cents', min: -2400, max: 2400, value: 0, decimals: 0 },
      { id: 'pw', param: P('pw'), label: 'PULSE', port: 'PULSE W 0-1', min: 0.01, max: 0.99, value: 0.5, decimals: 2 },
      { id: 'amp', param: P('amp'), label: 'AMP', port: 'AMP 0-4', min: 0, max: 2, value: 1, decimals: 2 },
    ]);

    const types = ['SINE', 'SAW', 'SQUARE', 'TRI', 'S&H', 'NOISE'];
    this.typeBtns = types.map((name, i) => h('button', { text: name, onclick: () => this.setType(i) }));
    this.scope = makeScope('WAVE');
    const m = this.modifiers;
    this.body.append(
      h('div', { class: 'btn-row wrap' }, this.typeBtns),
      m.freq.slider.el, m.phase.slider.el, m.detune.slider.el, m.pw.slider.el, m.amp.slider.el, this.scope.el);
    this.setType(0);
  }

  setType(i) {
    this.waveType = i;
    this.node.port.postMessage({ type: i });
    this.typeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.modifiers.pw.slider.setDisabled(i !== 2, 'off');
    this.modifiers.phase.slider.setDisabled(i > 3, 'off');
  }

  audioIn(portId) { return this.modifiers[portId].param; }
  audioOut() { return this.node; }

  getState() { return { ...super.getState(), waveType: this.waveType }; }

  setState(s) {
    super.setState(s);
    this.setType(s.waveType);
  }

  draw() {
    this.syncModifiers();
    drawScope(this.scope.canvas, this.scopeAn.node, this.scopeAn.buf, this.modifiers.phase.slider.get());
  }

  destroy() {
    this.node.disconnect();
    this.scopeAn.node.disconnect();
  }
}

class GainBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'gain', title: 'GAIN', desc: 'Modifies a wave gain',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.inNode = ctx.createGain();
    this.flipNode = ctx.createGain();
    this.gainNode = ctx.createGain();
    this.inNode.connect(this.flipNode);
    this.flipNode.connect(this.gainNode);
    this.inAn = makeAnalyser(app, this.inNode);
    this.outAn = makeAnalyser(app, this.gainNode);

    this.initModifiers([
      { id: 'gain', param: this.gainNode.gain, label: 'GAIN', port: 'GAIN 0-4', min: 0, max: 4, value: 0.5, decimals: 2 },
    ]);
    this.invertBtn = h('button', { text: 'INVERT PHASE', onclick: () => this.setInvert(!this.inverted) });
    this.scopeIn = makeScope('INPUT');
    this.scopeOut = makeScope('OUTPUT');
    this.body.append(this.modifiers.gain.slider.el, h('div', { class: 'btn-row' }, this.invertBtn), this.scopeIn.el, this.scopeOut.el);
  }

  setInvert(on) {
    this.inverted = on;
    this.flipNode.gain.setTargetAtTime(on ? -1 : 1, this.app.ctx.currentTime, 0.005);
    this.invertBtn.classList.toggle('active', on);
  }

  getState() { return { ...super.getState(), inverted: !!this.inverted }; }

  setState(s) {
    super.setState(s);
    this.setInvert(!!s.inverted);
  }

  audioIn(portId) { return portId === 'in' ? this.inNode : this.modifiers[portId].param; }
  audioOut() { return this.gainNode; }

  draw() {
    this.syncModifiers();
    drawScope(this.scopeIn.canvas, this.inAn.node, this.inAn.buf);
    drawScope(this.scopeOut.canvas, this.outAn.node, this.outAn.buf);
  }

  destroy() {
    for (const n of [this.inNode, this.flipNode, this.gainNode, this.inAn.node, this.outAn.node]) n.disconnect();
  }
}

const DISTORTION_PRESETS = [
  { name: 'INIT (CLEAN)',     mode: 0, drive: 1,   bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 20000, level: 1 },
  { name: 'WARM TUBE',        mode: 0, drive: 3,   bias: 0.1, mix: 1, bits: 16, rate: 1,  tone: 6000,  level: 0.9 },
  { name: 'OVERDRIVE',        mode: 0, drive: 12,  bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 5000,  level: 0.8 },
  { name: 'HARD CLIP',        mode: 1, drive: 15,  bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 8000,  level: 0.7 },
  { name: 'FUZZ BOX',         mode: 3, drive: 30,  bias: 0.15, mix: 1, bits: 16, rate: 1, tone: 4000,  level: 0.7 },
  { name: 'OCTAVE FUZZ',      mode: 4, drive: 10,  bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 6000,  level: 0.8 },
  { name: 'WAVEFOLDER',       mode: 2, drive: 8,   bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 20000, level: 0.9 },
  { name: 'METAL FOLD',       mode: 2, drive: 40,  bias: 0.2, mix: 1, bits: 16, rate: 1,  tone: 9000,  level: 0.7 },
  { name: 'CHEBY HARMONICS',  mode: 6, drive: 2,   bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 12000, level: 0.9 },
  { name: 'SINE MELT',        mode: 5, drive: 60,  bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 10000, level: 0.7 },
  { name: 'DIGITAL WRAP',     mode: 7, drive: 6,   bias: 0,   mix: 1, bits: 16, rate: 1,  tone: 12000, level: 0.7 },
  { name: 'LO-FI TAPE',       mode: 0, drive: 4,   bias: 0.05, mix: 1, bits: 6, rate: 6,  tone: 3500,  level: 0.9 },
  { name: '8-BIT CONSOLE',    mode: 1, drive: 3,   bias: 0,   mix: 1, bits: 8,  rate: 4,  tone: 9000,  level: 0.8 },
  { name: 'BROKEN RADIO',     mode: 1, drive: 40,  bias: 0.1, mix: 1, bits: 5,  rate: 8,  tone: 2500,  level: 0.7 },
  { name: 'DESTROYER',        mode: 7, drive: 40,  bias: 0,   mix: 1, bits: 4,  rate: 3,  tone: 12000, level: 0.6 },
  { name: 'MELTDOWN',         mode: 5, drive: 100, bias: 0.3, mix: 1, bits: 3,  rate: 2,  tone: 8000,  level: 0.5 },
  { name: 'NUCLEAR',          mode: 7, drive: 100, bias: 0.3, mix: 1, bits: 2,  rate: 1,  tone: 14000, level: 0.5 },
];

class DistortionBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'dist', title: 'DISTORTION', desc: 'Shapes and crushes a wave',
      inputs: [
        { id: 'in', label: 'WAVE IN', kind: 'wave' },
        { id: 'drive', label: 'DRIVE 0-100', kind: 'value' },
        { id: 'bias', label: 'BIAS -1..1', kind: 'value' },
        { id: 'mix', label: 'MIX 0-1', kind: 'value' },
        { id: 'bits', label: 'BITS 1-16', kind: 'value' },
        { id: 'rate', label: 'RATE/ 1-64', kind: 'value' },
        { id: 'tone', label: 'TONE Hz', kind: 'value' },
        { id: 'level', label: 'LEVEL 0-1.5', kind: 'value' },
      ],
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.node = new AudioWorkletNode(ctx, 'distortion-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    this.inNode = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 20000;
    this.tone.Q.value = 0.7;
    this.dcBlock = ctx.createBiquadFilter(); // rectifying modes create DC offset
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 8;
    this.levelNode = ctx.createGain();
    this.inNode.connect(this.node);
    this.node.connect(this.tone);
    this.tone.connect(this.dcBlock);
    this.dcBlock.connect(this.levelNode);
    this.inAn = makeAnalyser(app, this.inNode);
    this.outAn = makeAnalyser(app, this.levelNode);

    const P = (name) => this.node.parameters.get(name);
    this.initModifiers([
      { id: 'drive', param: P('drive'), label: 'DRIVE', min: 1, max: 100, value: 4, log: true, decimals: 1 },
      { id: 'bias', param: P('bias'), label: 'BIAS', min: -1, max: 1, value: 0, decimals: 2 },
      { id: 'mix', param: P('mix'), label: 'MIX', min: 0, max: 1, value: 1, decimals: 2 },
      { id: 'bits', param: P('bits'), label: 'BITS', min: 1, max: 16, value: 16, decimals: 0 },
      { id: 'rate', param: P('rate'), label: 'RATE/', min: 1, max: 64, value: 1, decimals: 0 },
      { id: 'tone', param: this.tone.frequency, label: 'TONE', min: 200, max: 20000, value: 20000, log: true, decimals: 0 },
      { id: 'level', param: this.levelNode.gain, label: 'LEVEL', min: 0, max: 1.5, value: 1, decimals: 2 },
    ]);
    const modes = ['SOFT', 'HARD', 'FOLD', 'FUZZ', 'RECT', 'SINE', 'CHEBY', 'WRAP'];
    this.modeBtns = modes.map((name, i) => h('button', { text: name, onclick: () => this.setMode(i) }));
    this.presetSelect = h('select', { onchange: () => this.applyPreset(this.presetSelect.value) },
      h('option', { value: '', text: '- PRESET -' }),
      DISTORTION_PRESETS.map((p, i) => h('option', { value: i, text: p.name })));
    this.curve = makeScope('TRANSFER CURVE');
    this.scopeIn = makeScope('INPUT');
    this.scopeOut = makeScope('OUTPUT');
    this.body.append(
      this.presetSelect,
      h('div', { class: 'btn-row wrap' }, this.modeBtns),
      ...Object.values(this.modifiers).map((m) => m.slider.el),
      this.curve.el, this.scopeIn.el, this.scopeOut.el);
    this.setMode(0);
  }

  setMode(i) {
    this.mode = i;
    this.node.port.postMessage({ mode: i });
    this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
  }

  getState() { return { ...super.getState(), mode: this.mode }; }

  setState(s) {
    super.setState(s);
    this.setMode(s.mode);
  }

  applyPreset(index) {
    if (index === '') return;
    const { name, mode, ...values } = DISTORTION_PRESETS[+index];
    this.setMode(mode);
    for (const [id, v] of Object.entries(values)) {
      // Wired parameters keep following their source; only unwired ones are written.
      this.modifiers[id].slider.set(v, !this.isWired(id));
    }
  }

  audioIn(portId) { return portId === 'in' ? this.inNode : this.modifiers[portId].param; }
  audioOut() { return this.levelNode; }

  drawCurve() {
    const c = this.curve.canvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const drive = this.modifiers.drive.slider.get();
    const bias = this.modifiers.bias.slider.get();
    const bits = Math.round(this.modifiers.bits.slider.get());
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(51,255,102,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, H / 2 + 0.5); g.lineTo(W, H / 2 + 0.5);
    g.moveTo(W / 2 + 0.5, 0); g.lineTo(W / 2 + 0.5, H);
    g.stroke();
    g.strokeStyle = 'rgba(51,255,102,0.25)'; // clean (unity) reference
    g.beginPath();
    g.moveTo(0, H); g.lineTo(W, 0);
    g.stroke();

    g.strokeStyle = '#33ff66';
    g.lineWidth = 2;
    g.shadowColor = '#33ff66';
    g.shadowBlur = 6;
    g.beginPath();
    const ref = shapeSample(this.mode, bias);
    for (let px = 0; px < W; px++) {
      const x = (px / (W - 1)) * 2 - 1;
      let y = shapeSample(this.mode, drive * x + bias) - ref;
      if (bits < 16) y = crushSample(y, bits);
      const py = clamp(H / 2 - y * (H / 2 - 4), 0, H);
      if (px === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.stroke();
    g.shadowBlur = 0;
  }

  draw() {
    this.syncModifiers();
    this.drawCurve();
    drawScope(this.scopeIn.canvas, this.inAn.node, this.inAn.buf);
    drawScope(this.scopeOut.canvas, this.outAn.node, this.outAn.buf);
  }

  destroy() {
    for (const n of [this.node, this.inNode, this.tone, this.dcBlock, this.levelNode, this.inAn.node, this.outAn.node]) n.disconnect();
  }
}

class MixerBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'mix', title: 'MIXER', desc: 'Mixes any number of waves into one',
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.nextId = 1;
    this.lanes = new Map(); // input id -> { gain, level }
    this.sum = ctx.createGain();
    this.avg = ctx.createGain(); // averages connected inputs so adding waves doesn't clip
    this.sum.connect(this.avg);
    this.master = ctx.createGain();
    this.avg.connect(this.master);
    this.anOut = makeAnalyser(app, this.master);

    this.initModifiers([
      { id: 'level', param: this.master.gain, label: 'MASTER', port: 'MASTER 0-2', min: 0, max: 2, value: 1, decimals: 2 },
    ]);
    this.levels = h('div', { class: 'levels' });
    this.scopeOut = makeScope('MIXED');
    this.body.append(this.modifiers.level.slider.el, this.levels, this.scopeOut.el);
    this.addLane();
    this.addLane();
    this.updateAverage();
  }

  addLane(fixedId) {
    const id = fixedId || `in${this.nextId++}`;
    if (fixedId) this.nextId = Math.max(this.nextId, parseInt(fixedId.slice(2), 10) + 1);
    const label = `WAVE ${this.lanes.size + 1}`;
    const ctx = this.app.ctx;
    const gain = ctx.createGain();
    gain.connect(this.sum);
    const level = makeSlider({
      label: label.replace('WAVE', 'LVL'), min: 0, max: 1, value: 1, decimals: 2,
      onInput: (v) => gain.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
    });
    this.addPort({ id, label, kind: 'wave' }, false);
    this.levels.append(level.el);
    const lane = { gain, level };
    this.lanes.set(id, lane);
    return lane;
  }

  removeLane(id) {
    const lane = this.lanes.get(id);
    lane.gain.disconnect();
    lane.level.el.remove();
    this.lanes.delete(id);
    this.removePort(id, false);
  }

  updateAverage() {
    const wired = [...this.lanes.keys()].filter((id) => this.isWired(id)).length;
    this.avg.gain.setTargetAtTime(1 / Math.max(1, wired), this.app.ctx.currentTime, 0.01);
  }

  getState() {
    return { ...super.getState(), lanes: [...this.lanes].map(([id, l]) => ({ id, level: l.level.get() })) };
  }

  // Recreates the same input ports (ids included), so copied wires can attach to them.
  setState(s) {
    super.setState(s);
    for (const id of [...this.lanes.keys()]) this.removeLane(id);
    for (const l of s.lanes || []) this.addLane(l.id).level.set(l.level, true);
    while (this.lanes.size < 2) this.addLane();
    this.updateAverage();
    this.holdTrim = true; // keep every restored port until the copied wires are attached
  }

  settle() {
    this.holdTrim = false;
    this.onPortChange();
  }

  // Always keep exactly one spare input (and at least two inputs) at the end.
  onPortChange(portId, connected) {
    if (this.modifiers[portId]) {
      super.onPortChange(portId, connected);
      return;
    }
    if (this.holdTrim) {
      this.updateAverage();
      return;
    }
    const ids = [...this.lanes.keys()];
    if (this.isWired(ids[ids.length - 1])) this.addLane();
    for (;;) {
      const last = [...this.lanes.keys()];
      if (last.length <= 2 || this.isWired(last[last.length - 1]) || this.isWired(last[last.length - 2])) break;
      this.removeLane(last[last.length - 1]);
    }
    this.updateAverage();
  }

  audioIn(portId) { return this.modifiers[portId] ? this.modifiers[portId].param : this.lanes.get(portId).gain; }
  audioOut() { return this.master; }

  draw() {
    this.syncModifiers();
    drawScope(this.scopeOut.canvas, this.anOut.node, this.anOut.buf);
  }

  destroy() {
    for (const { gain } of this.lanes.values()) gain.disconnect();
    for (const n of [this.sum, this.avg, this.master, this.anOut.node]) n.disconnect();
  }
}

class OutputBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'out', title: 'SOUND OUTPUT', desc: 'Sends sound to the soundcard',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.vol = ctx.createGain();
    this.post = ctx.createGain(); // also used for mute
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.pan = ctx.createStereoPanner();
    this.vol.connect(this.post);
    this.post.connect(this.pan);
    this.pan.connect(ctx.destination);
    this.an = makeAnalyser(app, this.vol);

    this.initModifiers([
      { id: 'vol', param: this.vol.gain, label: 'VOL', port: 'VOL 0-1', min: 0, max: 1, value: 0.5, decimals: 2 },
      { id: 'pan', param: this.pan.pan, label: 'PAN', port: 'PAN -1..1', min: -1, max: 1, value: 0, decimals: 2 },
    ]);
    this.muteBtn = h('button', { text: 'MUTE', onclick: () => this.setMute(!this.muted) });
    this.limitBtn = h('button', { text: 'LIMITER', onclick: () => this.setLimiter(!this.limited) });
    this.meter = h('canvas', { class: 'meter', width: 240, height: 14 });
    this.peak = 0;
    this.hold = 0;
    this.scope = makeScope('OUTPUT WAVE');
    this.body.append(
      this.modifiers.vol.slider.el, this.modifiers.pan.slider.el,
      h('div', { class: 'btn-row' }, this.muteBtn, this.limitBtn),
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'LEVEL' }), this.meter),
      this.scope.el);
  }

  setMute(on) {
    this.muted = on;
    this.post.gain.setTargetAtTime(on ? 0 : 1, this.app.ctx.currentTime, 0.01);
    this.muteBtn.classList.toggle('active', on);
  }

  setLimiter(on) {
    this.limited = on;
    const safe = (f) => { try { f(); } catch (_) { /* not connected */ } };
    safe(() => this.vol.disconnect(this.post));
    safe(() => this.vol.disconnect(this.limiter));
    safe(() => this.limiter.disconnect());
    if (on) {
      this.vol.connect(this.limiter);
      this.limiter.connect(this.post);
    } else {
      this.vol.connect(this.post);
    }
    this.limitBtn.classList.toggle('active', on);
  }

  audioIn(portId) { return portId === 'in' ? this.vol : this.modifiers[portId].param; }

  getState() { return { ...super.getState(), muted: !!this.muted, limited: !!this.limited }; }

  setState(s) {
    super.setState(s);
    if (s.muted) this.setMute(true);
    if (s.limited) this.setLimiter(true);
  }

  drawMeter() {
    const buf = this.an.buf;
    let pk = 0;
    for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
    this.peak = Math.max(pk, this.peak * 0.92);
    this.hold = Math.max(pk, this.hold - 0.004);
    const c = this.meter;
    const g = c.getContext('2d');
    g.fillStyle = '#031006';
    g.fillRect(0, 0, c.width, c.height);
    const segs = 30;
    const lit = Math.round(clamp(this.peak, 0, 1.2) / 1.2 * segs);
    for (let i = 0; i < segs; i++) {
      const f = i / segs;
      g.fillStyle = f > 0.83 ? '#ff4a3a' : f > 0.62 ? '#ffb000' : '#33ff66';
      g.globalAlpha = i < lit ? 1 : 0.12;
      g.fillRect(i * 8 + 1, 2, 6, c.height - 4);
    }
    g.globalAlpha = 1;
    const hx = Math.round(clamp(this.hold, 0, 1.2) / 1.2 * segs) * 8;
    g.fillStyle = '#fff';
    g.fillRect(Math.min(hx, c.width - 3), 0, 2, c.height);
  }

  draw() {
    this.syncModifiers();
    drawScope(this.scope.canvas, this.an.node, this.an.buf);
    this.drawMeter(); // reuses the buffer just filled by the scope
  }

  destroy() {
    for (const n of [this.vol, this.post, this.limiter, this.pan, this.an.node]) n.disconnect();
  }
}

class KnobBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'knob', title: 'KNOB', desc: 'Outputs a value',
      outputs: [{ id: 'out', label: 'VALUE', kind: 'value' }],
    }, x, y);
    this.el.classList.add('knob');
    const ctx = app.ctx;
    this.min = 0;
    this.max = 360;
    this.t = 0;
    this.node = ctx.createConstantSource();
    this.node.offset.value = 0;
    this.node.start();

    this.dial = h('canvas', { class: 'dial', width: 96, height: 96 });
    this.readout = h('input', { class: 'readout value-entry', type: 'text', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off' });
    this.readout.addEventListener('change', () => this.setValue(parseFloat(this.readout.value)));
    this.readout.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.readout.blur();
      if (e.key === 'Escape') { this.readout.value = this.value.toFixed(2); this.readout.blur(); }
    });
    this.readout.addEventListener('blur', () => { this.readout.value = this.value.toFixed(2); });
    this.minInput = h('input', { type: 'number', step: 'any', value: this.min });
    this.maxInput = h('input', { type: 'number', step: 'any', value: this.max });
    const onRange = () => {
      const lo = parseFloat(this.minInput.value);
      const hi = parseFloat(this.maxInput.value);
      if (!Number.isNaN(lo)) this.min = lo;
      if (!Number.isNaN(hi)) this.max = hi;
      this.minInput.value = this.min;
      this.maxInput.value = this.max;
      this.update();
    };
    this.minInput.addEventListener('change', onRange);
    this.maxInput.addEventListener('change', onRange);
    this.curve = 0;
    this.steps = 0;
    this.glide = 0;
    this.curveBtns = ['LIN', 'EXP', 'LOG'].map((name, i) => h('button', { text: name, onclick: () => this.setCurve(i) }));
    this.stepsInput = h('input', { type: 'number', step: 1, min: 0, max: 128, value: 0 });
    this.stepsInput.addEventListener('change', () => {
      this.steps = clamp(Math.round(parseFloat(this.stepsInput.value) || 0), 0, 128);
      this.stepsInput.value = this.steps;
      this.update();
    });
    this.glideSlider = makeSlider({
      label: 'GLIDE', min: 0, max: 2000, value: 0, decimals: 0,
      onInput: (v) => { this.glide = v; },
    });
    this.body.classList.add('knob-body');
    this.body.append(this.dial, this.readout,
      h('div', { class: 'minmax' }, h('span', { text: 'MIN' }), this.minInput, h('span', { text: 'MAX' }), this.maxInput),
      h('div', { class: 'btn-row' }, this.curveBtns),
      h('div', { class: 'minmax' }, h('span', { text: 'STEP' }), this.stepsInput, h('span', { text: '(0=OFF)' })),
      this.glideSlider.el);

    this.dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.dial.setPointerCapture(e.pointerId);
      const y0 = e.clientY;
      const t0 = this.t;
      const move = (ev) => this.setT(t0 + (y0 - ev.clientY) / (ev.shiftKey ? 600 : 150));
      const up = () => {
        this.dial.removeEventListener('pointermove', move);
        this.dial.removeEventListener('pointerup', up);
        this.dial.removeEventListener('pointercancel', up);
      };
      this.dial.addEventListener('pointermove', move);
      this.dial.addEventListener('pointerup', up);
      this.dial.addEventListener('pointercancel', up);
    });
    this.dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setT(this.t - Math.sign(e.deltaY) * (e.shiftKey ? 0.002 : 0.02));
    }, { passive: false });
    this.update();
    this.setCurve(0);
  }

  // The dial position (0..1) is quantised and curved before being mapped onto min..max.
  get value() {
    let t = this.t;
    if (this.steps >= 2) t = Math.round(t * (this.steps - 1)) / (this.steps - 1);
    if (this.curve === 1) t = t * t * t;
    else if (this.curve === 2) t = 1 - Math.pow(1 - t, 3);
    return this.min + t * (this.max - this.min);
  }

  getState() {
    return {
      ...super.getState(), min: this.min, max: this.max, t: this.t, curve: this.curve, steps: this.steps, glide: this.glide,
    };
  }

  setState(s) {
    this.min = s.min;
    this.max = s.max;
    this.minInput.value = s.min;
    this.maxInput.value = s.max;
    this.t = s.t;
    this.steps = s.steps;
    this.stepsInput.value = s.steps;
    this.glideSlider.set(s.glide, true);
    this.setCurve(s.curve);
  }

  setCurve(i) {
    this.curve = i;
    this.curveBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.update();
  }

  setT(t) {
    this.t = clamp(t, 0, 1);
    this.update();
  }

  // Sets the dial so the output is as close as possible to a typed value, undoing the curve; out-of-range values are clamped.
  setValue(v) {
    if (!Number.isFinite(v)) { this.update(); return; }
    const span = this.max - this.min;
    const u = span === 0 ? 0 : clamp((v - this.min) / span, 0, 1);
    this.setT(this.curve === 1 ? Math.cbrt(u) : this.curve === 2 ? 1 - Math.cbrt(1 - u) : u);
  }

  update() {
    const tc = Math.max(0.005, this.glide / 3000);
    this.node.offset.setTargetAtTime(this.value, this.app.ctx.currentTime, tc);
    if (document.activeElement !== this.readout) this.readout.value = this.value.toFixed(2);
    this.drawDial();
  }

  drawDial() {
    const g = this.dial.getContext('2d');
    const c = 48;
    const r = 34;
    g.clearRect(0, 0, 96, 96);
    g.strokeStyle = '#1b8a38';
    g.lineWidth = 2;
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI * (0.75 + 1.5 * (i / 10));
      g.beginPath();
      g.moveTo(c + Math.cos(a) * (r + 4), c + Math.sin(a) * (r + 4));
      g.lineTo(c + Math.cos(a) * (r + 9), c + Math.sin(a) * (r + 9));
      g.stroke();
    }
    g.fillStyle = '#020602';
    g.strokeStyle = '#ffb000';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    const a = Math.PI * (0.75 + 1.5 * this.t);
    g.shadowColor = '#ffb000';
    g.shadowBlur = 6;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * 8, c + Math.sin(a) * 8);
    g.lineTo(c + Math.cos(a) * (r - 3), c + Math.sin(a) * (r - 3));
    g.stroke();
    g.shadowBlur = 0;
  }

  audioOut() { return this.node; }

  destroy() {
    this.node.stop();
    this.node.disconnect();
  }
}

class WaveToValueBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'w2v', title: 'WAVE TO VALUE', desc: 'Turns a wave into a control value',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [{ id: 'out', label: 'VALUE OUT', kind: 'value' }],
    }, x, y);
    const ctx = app.ctx;
    this.min = 0;
    this.max = 1;
    this.lastValue = 0.5;
    this.inNode = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'value-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    this.scale = ctx.createGain();
    this.offset = ctx.createConstantSource();
    this.outNode = ctx.createGain();
    this.inNode.connect(this.node);
    this.node.connect(this.scale);
    this.scale.connect(this.outNode);
    this.offset.connect(this.outNode);
    this.offset.start();
    this.inAn = makeAnalyser(app, this.inNode);
    this.uAn = makeAnalyser(app, this.node);

    const modes = ['DIRECT', 'ENVELOPE'];
    this.modeBtns = modes.map((name, i) => h('button', { text: name, onclick: () => this.setMode(i) }));
    this.minInput = h('input', { type: 'number', step: 'any', value: this.min });
    this.maxInput = h('input', { type: 'number', step: 'any', value: this.max });
    const onRange = () => {
      const lo = parseFloat(this.minInput.value);
      const hi = parseFloat(this.maxInput.value);
      if (!Number.isNaN(lo)) this.min = lo;
      if (!Number.isNaN(hi)) this.max = hi;
      this.minInput.value = this.min;
      this.maxInput.value = this.max;
      this.applyRange();
    };
    this.minInput.addEventListener('change', onRange);
    this.maxInput.addEventListener('change', onRange);
    this.attack = makeSlider({
      label: 'ATTACK', min: 0.1, max: 500, value: 5, log: true, decimals: 1,
      onInput: (v) => this.node.port.postMessage({ attack: v / 1000 }),
    });
    this.release = makeSlider({
      label: 'RELEAS', min: 1, max: 2000, value: 100, log: true, decimals: 0,
      onInput: (v) => this.node.port.postMessage({ release: v / 1000 }),
    });
    this.readout = h('div', { class: 'readout', text: '0.00' });
    this.scopeIn = makeScope('INPUT');
    this.scopeOut = makeScope('VALUE (MIN..MAX)');
    this.body.append(
      h('div', { class: 'btn-row' }, this.modeBtns),
      h('div', { class: 'minmax' }, h('span', { text: 'MIN' }), this.minInput, h('span', { text: 'MAX' }), this.maxInput),
      this.attack.el, this.release.el, this.readout, this.scopeIn.el, this.scopeOut.el);
    this.node.port.postMessage({ attack: 0.005, release: 0.1 });
    this.applyRange();
    this.setMode(0);
  }

  get value() { return this.lastValue; }

  setRange(min, max) {
    this.min = min;
    this.max = max;
    this.minInput.value = min;
    this.maxInput.value = max;
    this.applyRange();
  }

  applyRange() {
    const t = this.app.ctx.currentTime;
    this.scale.gain.setTargetAtTime(this.max - this.min, t, 0.005);
    this.offset.offset.setTargetAtTime(this.min, t, 0.005);
  }

  setMode(i) {
    this.mode = i;
    this.node.port.postMessage({ mode: i });
    this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.attack.setDisabled(i !== 1, 'off');
    this.release.setDisabled(i !== 1, 'off');
  }

  audioIn() { return this.inNode; }
  audioOut() { return this.outNode; }

  getState() {
    return { mode: this.mode, min: this.min, max: this.max, attack: this.attack.get(), release: this.release.get() };
  }

  setState(s) {
    this.attack.set(s.attack, true);
    this.release.set(s.release, true);
    this.setRange(s.min, s.max);
    this.setMode(s.mode);
  }

  draw() {
    drawScope(this.scopeIn.canvas, this.inAn.node, this.inAn.buf);
    drawScope(this.scopeOut.canvas, this.uAn.node, this.uAn.buf, 0, true);
    const u = (this.uAn.buf[this.uAn.buf.length - 1] + 1) / 2; // buffer was remapped to -1..1
    this.lastValue = this.min + u * (this.max - this.min);
    this.readout.textContent = this.lastValue.toFixed(2);
  }

  destroy() {
    this.offset.stop();
    for (const n of [this.inNode, this.node, this.scale, this.offset, this.outNode, this.inAn.node, this.uAn.node]) n.disconnect();
  }
}

const BLOCK_TYPES = { osc: WaveGenBlock, gain: GainBlock, dist: DistortionBlock, mix: MixerBlock, knob: KnobBlock, w2v: WaveToValueBlock, out: OutputBlock };

/* ---------- application ---------- */

const BLOCK_CATALOG = [
  ['SOURCES', [
    ['osc', 'WAVE GENERATOR', 'Sine, saw, square, triangle, noise'],
    ['lfo', 'LFO', 'Slow wave that outputs a value'],
    ['knob', 'KNOB', 'A dial that outputs a value'],
    ['seq', 'STEP SEQUENCER', 'Pattern of pitches, with a gate'],
    ['seqpro', 'SEQUENCER PRO', '64 steps, per-step delay, drives other sequencers'],
    ['adsr', 'ADSR ENVELOPE', 'Gate in, envelope value out'],
    ['trigger', 'TRIGGER BUTTON', 'Click or press SPACE for a gate'],
    ['keyboard', 'KEYBOARD', 'Play notes with the keys'],
    ['audioin', 'AUDIO INPUT', 'Any audio input'],
  ]],
  ['PROCESS', [
    ['gain', 'GAIN', 'Louder, quieter, or inverted'],
    ['filter', 'FILTER', 'Low-pass, high-pass, band, notch...'],
    ['dist', 'DISTORTION', 'Soft, hard, fold, fuzz, bit crush'],
    ['fx', 'EFFECTS', 'Chorus, reverb, pitch shift, glitch: 60+ presets'],
    ['delay', 'ECHO DELAY', 'Repeats a wave with feedback'],
    ['mix', 'MIXER', 'Mixes any number of waves'],
    ['w2v', 'WAVE TO VALUE', 'Turns a wave into a control value'],
    ['detector', 'DETECTOR', 'Counts down while a level matches, then fires'],
    ['script', 'SCRIPT', 'Your own JavaScript between values'],
    ['domfreq', 'DOMINANT FREQ', 'Wave in, loudest Hz value(s) out'],
  ]],
  ['OUTPUT', [
    ['spectrum', 'SPECTRUM', 'Frequency display, passes the wave'],
    ['out', 'SOUND OUTPUT', 'Plays to the soundcard'],
  ]],
];
const PACK_IO_CATALOG = [
  ['in:wave', 'PACK IN (WAVE)', 'A wave input for this pack'],
  ['in:value', 'PACK IN (VALUE)', 'A control input for this pack'],
  ['out:wave', 'PACK OUT (WAVE)', 'A wave output for this pack'],
  ['out:value', 'PACK OUT (VALUE)', 'A control output for this pack'],
];

class App {
  constructor() {
    this.seq = 0;
    this.zTop = 10;
    this.blocks = new Map();
    this.conns = [];
    this.selected = null; // selected wire
    this.selection = new Set(); // selected blocks
    this.spawnCount = 0;
    this.zoom = 1;
    this.tabSeq = 0;
    this.tabs = new Map();
    this.folderSeq = 0;
    this.folders = new Map(); // organisational folders in the sidebar: id -> { id, name, parent, open }
    this.stage = document.getElementById('stage');
    this.sidebar = document.getElementById('sidebar');
    this.tabBar = document.getElementById('tabs');
    this.statusEl = document.getElementById('status');
    this.powerBtn = document.getElementById('power');
    this.activeTab = this.createTab('MAIN', null);
    this.mainTab = this.activeTab;
    this.stage.append(this.activeTab.sizer);
    this.renderTabs();
    this.buildBlockPane();
    this.applyPaneState();
  }

  get ws() { return this.activeTab.ws; }
  get svg() { return this.activeTab.svg; }

  /* tabs: MAIN plus one tab per pack. Blocks only ever connect to blocks in the same tab. */

  createTab(name, packBlock) {
    const ws = h('div', { class: 'workspace' });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'wires');
    ws.append(svg);
    // The sizer gives the scaled workspace real scrollable dimensions.
    const sizer = h('div', { class: 'sizer' }, ws);
    const tab = { id: ++this.tabSeq, name, ws, svg, sizer, pack: packBlock, folder: null, scroll: { x: 0, y: 0 } };
    this.tabs.set(tab.id, tab);
    this.applyZoom(tab);
    this.bindTabEvents(tab);
    return tab;
  }

  tabPath(tab) {
    const names = [];
    for (let t = tab; t; t = t.pack ? t.pack.tab : null) names.unshift(t.name);
    return names.join(' / ');
  }

  /* sidebar: MAIN on top, then folders (which can nest) and pack tabs */

  folderWithin(folder, ancestor) {
    for (let f = folder; f; f = f.parent === null ? null : this.folders.get(f.parent)) if (f === ancestor) return true;
    return false;
  }

  renderTabs() {
    const rows = [this.tabRow(this.tabs.values().next().value, 0)];
    const addRows = (parent, depth) => {
      for (const f of this.folders.values()) {
        if (f.parent !== parent) continue;
        rows.push(this.folderRow(f, depth));
        if (f.open) addRows(f.id, depth + 1);
      }
      for (const t of this.tabs.values()) if (t.pack && t.folder === parent) rows.push(this.tabRow(t, depth));
    };
    addRows(null, 0);
    this.tabBar.replaceChildren(...rows);
    document.querySelectorAll('[data-io]').forEach((b) => (b.disabled = !this.activeTab.pack || !this.ready));
  }

  tabRow(t, depth) {
    const row = h('button', { class: `row tab${t === this.activeTab ? ' active' : ''}`, title: this.tabPath(t), text: `${t.pack ? '\u25A3' : '\u25A0'} ${t.name}` });
    row.dataset.tab = t.id;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.addEventListener('click', () => { if (!this.suppressRowClick) this.switchTab(t); });
    if (t.pack) {
      row.title = `${this.tabPath(t)} - DRAG ONTO THE WORKSPACE TO ADD A COPY`;
      row.addEventListener('dblclick', () => this.renamePack(t.pack));
      row.addEventListener('pointerdown', (e) => this.startRowDrag('tab', t, e));
    }
    return row;
  }

  folderRow(f, depth) {
    const row = h('button', { class: 'row folder', title: 'DRAG TABS OR FOLDERS HERE - RIGHT-CLICK FOR OPTIONS', text: `${f.open ? '\u25BE' : '\u25B8'} ${f.name}` });
    row.dataset.folder = f.id;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.addEventListener('click', () => {
      if (this.suppressRowClick) return;
      f.open = !f.open;
      this.renderTabs();
    });
    row.addEventListener('dblclick', () => this.renameFolder(f));
    row.addEventListener('pointerdown', (e) => this.startRowDrag('folder', f, e));
    return row;
  }

  async newFolder(parent = null) {
    const name = await this.askText('FOLDER NAME', 'NEW FOLDER');
    if (!name || !name.trim()) return;
    const f = { id: ++this.folderSeq, name: name.trim().toUpperCase(), parent, open: true };
    this.folders.set(f.id, f);
    if (parent !== null) this.folders.get(parent).open = true;
    this.renderTabs();
  }

  async renameFolder(f) {
    const name = await this.askText('FOLDER NAME', f.name);
    if (!name || !name.trim()) return;
    f.name = name.trim().toUpperCase();
    this.renderTabs();
  }

  // Deleting a folder keeps what is inside it: the contents move up one level.
  deleteFolder(f) {
    for (const t of this.tabs.values()) if (t.folder === f.id) t.folder = f.parent;
    for (const g of this.folders.values()) if (g.parent === f.id) g.parent = f.parent;
    this.folders.delete(f.id);
    this.renderTabs();
  }

  moveToFolder(kind, item, folder) {
    if (kind === 'tab') item.folder = folder ? folder.id : null;
    else item.parent = folder ? folder.id : null;
    if (folder) folder.open = true;
    this.renderTabs();
  }

  openSidebarMenu(x, y, row) {
    const items = [];
    if (row && row.dataset.tab) {
      const t = this.tabs.get(+row.dataset.tab);
      items.push(['OPEN TAB', () => this.switchTab(t)]);
      if (t.pack) {
        items.push(['RENAME PACK', () => this.renamePack(t.pack)]);
        items.push(['ADD A COPY TO THE OPEN TAB', () => {
          const spot = this.findFreeSpot(this.activeTab, 300, 360);
          this.dropTab(t, this.activeTab, spot.x, spot.y);
        }]);
        if (t.folder !== null) items.push(['MOVE OUT OF FOLDER', () => this.moveToFolder('tab', t, null)]);
        for (const f of this.folders.values()) if (f.id !== t.folder) items.push([`MOVE TO FOLDER: ${f.name}`, () => this.moveToFolder('tab', t, f)]);
      }
    } else if (row && row.dataset.folder) {
      const f = this.folders.get(+row.dataset.folder);
      items.push(['NEW SUBFOLDER', () => this.newFolder(f.id)]);
      items.push(['RENAME FOLDER', () => this.renameFolder(f)]);
      if (f.parent !== null) items.push(['MOVE OUT OF FOLDER', () => this.moveToFolder('folder', f, null)]);
      items.push(['DELETE FOLDER (KEEPS CONTENTS)', () => this.deleteFolder(f)]);
    }
    items.push(['NEW FOLDER', () => this.newFolder(null)]);
    this.showMenu(x, y, items);
  }

  // Drag a pack tab or a folder. Over a folder or the sidebar it moves; over the workspace
  // or another tab, a pack tab drops a copy of that pack.
  startRowDrag(kind, item, e) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost = null;
    let hover = null;
    const targetOf = (el) => {
      if (!el) return null;
      const row = el.closest('.row');
      if (row && this.tabBar.contains(row)) {
        if (row.dataset.folder) {
          const f = this.folders.get(+row.dataset.folder);
          return f && !(kind === 'folder' && this.folderWithin(f, item)) ? { type: 'folder', f, el: row } : null;
        }
        const t = this.tabs.get(+row.dataset.tab);
        return kind === 'tab' && t && t !== item ? { type: 'tab', t, el: row } : null;
      }
      if (this.sidebar.contains(el)) return { type: 'root', el: this.tabBar };
      if (kind === 'tab' && this.stage.contains(el)) return { type: 'stage', el: this.stage };
      return null;
    };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) {
        ghost = h('div', { class: 'tab-ghost' });
        document.body.append(ghost);
        document.body.classList.add('tab-dragging');
      }
      if (!ghost) return;
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
      const target = targetOf(document.elementFromPoint(ev.clientX, ev.clientY));
      if (hover) hover.classList.remove('drop-target');
      hover = target ? target.el : null;
      if (hover) hover.classList.add('drop-target');
      const copies = target && (target.type === 'stage' || target.type === 'tab');
      ghost.textContent = `${copies ? 'COPY' : 'MOVE'}: ${item.name}`;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (hover) hover.classList.remove('drop-target');
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove('tab-dragging');
      this.suppressRowClick = true; // the click that follows a drag must not switch tabs or toggle folders
      setTimeout(() => { this.suppressRowClick = false; }, 0);
      const target = targetOf(document.elementFromPoint(ev.clientX, ev.clientY));
      if (!target) return;
      if (target.type === 'folder') this.moveToFolder(kind, item, target.f);
      else if (target.type === 'root') this.moveToFolder(kind, item, null);
      else if (target.type === 'tab') this.dropTab(item, target.t);
      else {
        const p = this.wsPoint(ev.clientX, ev.clientY);
        this.dropTab(item, this.activeTab, p.x - 132, p.y - 16);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  switchTab(tab) {
    if (tab === this.activeTab) return;
    this.measureBlocks(this.activeTab);
    this.activeTab.scroll = { x: this.stage.scrollLeft / this.zoom, y: this.stage.scrollTop / this.zoom };
    this.clearSelection();
    this.select(null);
    this.activeTab = tab;
    this.stage.replaceChildren(tab.sizer);
    this.stage.scrollTo(tab.scroll.x * this.zoom, tab.scroll.y * this.zoom);
    this.markActiveTab();
    this.renderWires();
  }

  // Only restyles the tab buttons, so a double-click on a tab still lands on the same element.
  markActiveTab() {
    this.tabBar.querySelectorAll('.row.tab').forEach((b) => b.classList.toggle('active', +b.dataset.tab === this.activeTab.id));
    document.querySelectorAll('[data-io]').forEach((b) => (b.disabled = !this.activeTab.pack || !this.ready));
  }

  // Detached tabs have no layout, so remember block sizes (used by pack previews) while visible.
  measureBlocks(tab) {
    for (const b of this.blocks.values()) {
      if (b.tab === tab) { b.w = b.el.offsetWidth; b.h = b.el.offsetHeight; }
    }
  }

  /* zoom: the workspace is scaled with a CSS transform, so every pointer position inside it
     has to be divided by the zoom level (see wsPoint). */

  applyZoom(tab) {
    tab.ws.style.transform = `scale(${this.zoom})`;
    tab.sizer.style.width = `${3000 * this.zoom}px`;
    tab.sizer.style.height = `${4000 * this.zoom}px`;
  }

  // Client coordinates -> workspace coordinates of the open tab.
  wsPoint(clientX, clientY) {
    const r = this.ws.getBoundingClientRect();
    return { x: (clientX - r.left) / this.zoom, y: (clientY - r.top) / this.zoom };
  }

  // The part of the workspace currently on screen, in workspace coordinates.
  viewRect() {
    const st = this.stage;
    return { x: st.scrollLeft / this.zoom, y: st.scrollTop / this.zoom, w: st.clientWidth / this.zoom, h: st.clientHeight / this.zoom };
  }

  scrollToWs(x, y) {
    this.stage.scrollTo(Math.max(0, x * this.zoom), Math.max(0, y * this.zoom));
  }

  // Zooms around a screen point (default: the middle of the view) so that point stays put.
  setZoom(z, clientX, clientY) {
    const next = clamp(Math.round(z * 1000) / 1000, 0.25, 2);
    if (next === this.zoom) return;
    const st = this.stage;
    const r = st.getBoundingClientRect();
    const px = (clientX ?? r.left + r.width / 2) - r.left;
    const py = (clientY ?? r.top + r.height / 2) - r.top;
    const wx = (st.scrollLeft + px) / this.zoom;
    const wy = (st.scrollTop + py) / this.zoom;
    this.commitZoom(next);
    st.scrollTo(wx * next - px, wy * next - py);
    this.renderWires();
  }

  commitZoom(z) {
    this.zoom = z;
    for (const t of this.tabs.values()) this.applyZoom(t);
    document.getElementById('zoomReset').textContent = `${Math.round(z * 100)}%`;
  }

  zoomBy(factor, clientX, clientY) { this.setZoom(this.zoom * factor, clientX, clientY); }

  // Chooses the zoom that fits every block of the open tab on screen.
  zoomToFit() {
    this.measureBlocks(this.activeTab);
    const blocks = [...this.blocks.values()].filter((b) => b.tab === this.activeTab);
    if (!blocks.length) { this.setZoom(1); return; }
    const x0 = Math.min(...blocks.map((b) => b.x)) - 30;
    const y0 = Math.min(...blocks.map((b) => b.y)) - 30;
    const x1 = Math.max(...blocks.map((b) => b.x + (b.w || 264))) + 30;
    const y1 = Math.max(...blocks.map((b) => b.y + (b.h || 400))) + 30;
    const z = clamp(Math.min(this.stage.clientWidth / (x1 - x0), this.stage.clientHeight / (y1 - y0)), 0.25, 1);
    this.commitZoom(Math.round(z * 1000) / 1000);
    this.stage.scrollTo(Math.max(0, x0 * this.zoom), Math.max(0, y0 * this.zoom));
    this.renderWires();
  }

  /* selection */

  setSelected(block, on) {
    if (on) this.selection.add(block); else this.selection.delete(block);
    block.el.classList.toggle('selected', on);
  }

  clearSelection() {
    for (const b of [...this.selection]) this.setSelected(b, false);
  }

  bindTabEvents(tab) {
    tab.ws.addEventListener('pointerdown', (e) => {
      const port = e.target.closest('.port');
      if (port) { this.startWireDrag(port, e); return; }
      if (e.target === tab.ws && e.button === 0) this.startMarquee(e);
    });
    tab.ws.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const blockEl = e.target.closest('.block');
      const block = blockEl && [...this.blocks.values()].find((b) => b.el === blockEl);
      this.openContextMenu(e.clientX, e.clientY, block || null);
    });
  }

  startMarquee(e) {
    const rect = this.ws.getBoundingClientRect();
    const x0 = (e.clientX - rect.left) / this.zoom;
    const y0 = (e.clientY - rect.top) / this.zoom;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(this.selection) : new Set();
    const box = h('div', { class: 'marquee' });
    this.ws.append(box);
    let moved = false;
    const move = (ev) => {
      const x1 = (ev.clientX - rect.left) / this.zoom;
      const y1 = (ev.clientY - rect.top) / this.zoom;
      const l = Math.min(x0, x1);
      const t = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const hh = Math.abs(y1 - y0);
      if (w > 3 || hh > 3) moved = true;
      Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${hh}px` });
      for (const b of this.blocks.values()) {
        if (b.tab !== this.activeTab) continue;
        const hit = b.x < l + w && b.x + b.el.offsetWidth > l && b.y < t + hh && b.y + b.el.offsetHeight > t;
        this.setSelected(b, hit || base.has(b));
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();
      if (!moved && !additive) { this.clearSelection(); this.select(null); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* context menu */

  openContextMenu(x, y, block) {
    this.closeContextMenu();
    if (block && !this.selection.has(block)) {
      this.clearSelection();
      this.setSelected(block, true);
    }
    const sel = [...this.selection];
    const items = [];
    if (sel.length === 1 && sel[0].isPack) {
      items.push(['OPEN PACK', () => this.switchTab(sel[0].packTab)]);
      items.push(['DUPLICATE PACK', () => {
        const spot = this.findFreeSpot(this.activeTab, 300, 360);
        this.dropTab(sel[0].packTab, this.activeTab, spot.x, spot.y);
      }]);
      items.push(['UNPACK', () => this.unpack(sel[0])]);
      items.push(['EXPORT PACK AS JSON', () => this.exportPack(sel[0])]);
      items.push(['RENAME PACK', () => this.renamePack(sel[0])]);
    }
    const packable = sel.filter((b) => !b.isPackIO);
    if (packable.length) items.push([`PACK ${packable.length} BLOCK${packable.length > 1 ? 'S' : ''}`, () => this.packSelection(packable)]);
    if (sel.length) items.push([`DELETE ${sel.length} BLOCK${sel.length > 1 ? 'S' : ''}`, () => this.deleteSelection()]);
    items.push(['SELECT ALL', () => {
      for (const b of this.blocks.values()) if (b.tab === this.activeTab) this.setSelected(b, true);
    }]);
    this.showMenu(x, y, items);
  }

  showMenu(x, y, items) {
    this.closeContextMenu();
    const menu = h('div', { class: 'ctxmenu' },
      items.map(([label, action]) => h('button', {
        text: label,
        onclick: () => { this.closeContextMenu(); action(); },
      })));
    document.body.append(menu);
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
    this.menu = menu;
    const away = (ev) => {
      if (menu.contains(ev.target)) return;
      this.closeContextMenu();
    };
    this.menuAway = away;
    setTimeout(() => window.addEventListener('pointerdown', away, true), 0);
  }

  closeContextMenu() {
    if (this.menu) this.menu.remove();
    if (this.menuAway) window.removeEventListener('pointerdown', this.menuAway, true);
    this.menu = null;
    this.menuAway = null;
  }

  // User-initiated deletion: asks first when a pack with blocks inside would be lost.
  async requestRemove(blocks) {
    const packs = blocks.filter((b) => b.isPack && b.innerBlocks().length);
    if (packs.length) {
      const inside = packs.reduce((n, p) => n + p.innerBlocks().length, 0);
      const ok = await this.askConfirm(`DELETE ${packs.map((p) => p.name).join(', ')} AND THE ${inside} BLOCKS INSIDE?`);
      if (!ok) return;
    }
    for (const b of blocks) if (this.blocks.has(b.id)) this.removeBlock(b);
  }

  deleteSelection() {
    return this.requestRemove([...this.selection]);
  }

  /* In-app dialogs (window.prompt/confirm are unavailable in some embedded browsers). */

  openDialog(message, { input = null, okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      const field = input === null ? null : h('input', { type: 'text', value: input });
      const close = (value) => {
        overlay.remove();
        window.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const ok = () => close(field ? field.value : true);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(field ? null : false); }
        if (e.key === 'Enter') { e.stopPropagation(); ok(); }
      };
      const overlay = h('div', { class: 'dialog-overlay' },
        h('div', { class: 'dialog' },
          h('div', { class: 'dialog-msg', text: message }),
          field,
          h('div', { class: 'btn-row' },
            h('button', { text: okText, onclick: ok }),
            h('button', { text: 'CANCEL', onclick: () => close(field ? null : false) }))));
      document.body.append(overlay);
      window.addEventListener('keydown', onKey, true);
      if (field) { field.focus(); field.select(); } else overlay.querySelector('button').focus();
    });
  }

  askText(message, value) { return this.openDialog(message, { input: value }); }
  askConfirm(message, okText = 'DELETE') { return this.openDialog(message, { okText }); }

  setStatus(text, error = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', error);
  }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.sink = this.ctx.createGain(); // silent sink keeps analysers pulled
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);

    this.bindUI();
    try {
      const src = WORKLET_SRC + (typeof EXTRA_WORKLET_SRC === 'string' ? EXTRA_WORKLET_SRC : '')
        + (typeof FX_WORKLET_SRC === 'string' ? FX_WORKLET_SRC : '');
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
    } catch (err) {
      this.setStatus('AUDIO ENGINE FAILED: ' + err.message + ' (TRY SERVING OVER HTTP/LOCALHOST)', true);
      return;
    }
    document.querySelectorAll('[data-add]').forEach((b) => (b.disabled = false));
    this.powerBtn.disabled = false;
    this.ready = true;
    const libraryBtn = document.getElementById('library');
    libraryBtn.disabled = false;
    libraryBtn.addEventListener('click', () => this.openLibrary());
    this.renderTabs();
    this.updatePower();
    this.buildDemo();
    requestAnimationFrame(() => this.frame());
  }

  bindUI() {
    document.querySelectorAll('[data-add]').forEach((b) => { b.disabled = true; });
    this.powerBtn.addEventListener('click', async () => {
      if (this.ctx.state === 'running') await this.ctx.suspend();
      else await this.ctx.resume();
      this.updatePower();
    });
    this.ctx.addEventListener('statechange', () => this.updatePower());

    document.getElementById('newFolder').addEventListener('click', () => this.newFolder(null));
    this.sidebar.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openSidebarMenu(e.clientX, e.clientY, e.target.closest('.row'));
    });

    document.getElementById('toggleTabs').addEventListener('click', () => this.togglePane('tabs'));
    document.getElementById('toggleBlocks').addEventListener('click', () => this.togglePane('blocks'));
    document.getElementById('hideTabs').addEventListener('click', () => this.togglePane('tabs', false));
    document.getElementById('hideBlocks').addEventListener('click', () => this.togglePane('blocks', false));
    document.getElementById('zoomIn').addEventListener('click', () => this.zoomBy(1.2));
    document.getElementById('zoomOut').addEventListener('click', () => this.zoomBy(1 / 1.2));
    document.getElementById('zoomReset').addEventListener('click', () => this.setZoom(1));
    document.getElementById('zoomFit').addEventListener('click', () => this.zoomToFit());
    this.stage.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); this.zoomBy(1.2); return; }
        if (e.key === '-') { e.preventDefault(); this.zoomBy(1 / 1.2); return; }
        if (e.key === '0') { e.preventDefault(); this.setZoom(1); return; }
      }
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (e.key === 'Escape') this.closeContextMenu();
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selected) this.disconnect(this.selected);
        else if (this.selection.size) this.deleteSelection();
        else return;
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        for (const b of this.blocks.values()) if (b.tab === this.activeTab) this.setSelected(b, true);
        e.preventDefault();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        const sel = [...this.selection].filter((b) => !b.isPackIO);
        if (e.shiftKey && this.selection.size === 1 && [...this.selection][0].isPack) this.unpack([...this.selection][0]);
        else if (sel.length) this.packSelection(sel);
        e.preventDefault();
      }
    });
    window.addEventListener('resize', () => this.renderWires());
    this.stage.addEventListener('scroll', () => this.renderWires());
  }

  /* block library pane (right) and pane visibility */

  buildBlockPane() {
    const list = document.getElementById('blocklist');
    const sections = [];
    const make = (name, desc) => {
      const b = h('button', { class: 'item', title: desc }, h('b', { text: name }), h('small', { text: desc }));
      b.dataset.search = `${name} ${desc}`.toLowerCase();
      return b;
    };
    const blockItem = ([type, name, desc]) => {
      const b = make(name, desc);
      b.dataset.add = type;
      b.disabled = true; // enabled once the audio engine is ready
      b.addEventListener('click', () => { if (!this.suppressRowClick) this.addFromPane({ type }); });
      b.addEventListener('pointerdown', (e) => this.startPaneDrag({ type }, name, e));
      return b;
    };
    const ioItem = ([spec, name, desc]) => {
      const b = make(name, desc);
      b.dataset.io = spec;
      b.disabled = true; // only usable while a pack tab is open
      b.addEventListener('click', () => { if (!this.suppressRowClick) this.addFromPane({ io: spec }); });
      b.addEventListener('pointerdown', (e) => this.startPaneDrag({ io: spec }, name, e));
      return b;
    };
    const premade = make('PREMADE PACKS', 'Game sounds and classic synth voices');
    premade.id = 'library';
    premade.classList.add('premade');
    premade.disabled = true;
    sections.push(['PACKS', [premade, blockItem(['pack', 'EMPTY PACK', 'A blank pack to build in'])]]);
    for (const [title, blocks] of BLOCK_CATALOG) sections.push([title, blocks.map(blockItem)]);
    sections.push(['INSIDE A PACK', PACK_IO_CATALOG.map(ioItem)]);

    this.paneSections = sections.map(([title, items]) => ({ head: h('h3', { text: title }), items }));
    for (const s of this.paneSections) list.append(s.head, ...s.items);

    document.getElementById('blockFilter').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      for (const s of this.paneSections) {
        let shown = 0;
        for (const b of s.items) {
          const match = !q || b.dataset.search.includes(q);
          b.hidden = !match;
          if (match) shown++;
        }
        s.head.hidden = shown === 0;
      }
    });
  }

  // Adds a block from the library pane: at a free spot in view, or where it was dropped.
  addFromPane(entry, x, y) {
    if (x === undefined) {
      const spot = this.findFreeSpot(this.activeTab, 290, 440);
      x = spot.x;
      y = spot.y;
      if (!spot.visible) this.scrollToWs(x - 20, y - 20);
    }
    if (entry.io) {
      const [dir, kind] = entry.io.split(':');
      return this.addPackIO(dir === 'in', kind, x, y);
    }
    const block = this.addBlock(entry.type, x, y);
    this.clearSelection();
    this.setSelected(block, true);
    return block;
  }

  // Drag a library entry onto the workspace to drop the block where you want it.
  startPaneDrag(entry, name, e) {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let ghost = null;
    const overStage = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      return !!el && this.stage.contains(el);
    };
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) {
        ghost = h('div', { class: 'tab-ghost', text: `ADD: ${name}` });
        document.body.append(ghost);
        document.body.classList.add('tab-dragging');
      }
      if (!ghost) return;
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
      this.stage.classList.toggle('drop-target', overStage(ev));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.stage.classList.remove('drop-target');
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove('tab-dragging');
      this.suppressRowClick = true; // the click that follows a drag must not add a second block
      setTimeout(() => { this.suppressRowClick = false; }, 0);
      if (overStage(ev)) {
        const p = this.wsPoint(ev.clientX, ev.clientY);
        this.addFromPane(entry, Math.max(0, p.x - 130), Math.max(0, p.y - 14));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  applyPaneState() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('jsynth.panes') || '{}'); } catch (_) { /* storage unavailable */ }
    this.paneVisible = { tabs: saved.tabs !== false, blocks: saved.blocks !== false };
    this.refreshPanes();
  }

  togglePane(name, on) {
    this.paneVisible[name] = on === undefined ? !this.paneVisible[name] : on;
    try { localStorage.setItem('jsynth.panes', JSON.stringify(this.paneVisible)); } catch (_) { /* storage unavailable */ }
    this.refreshPanes();
    this.renderWires();
  }

  refreshPanes() {
    this.sidebar.classList.toggle('hidden', !this.paneVisible.tabs);
    document.getElementById('blockpane').classList.toggle('hidden', !this.paneVisible.blocks);
    document.getElementById('toggleTabs').classList.toggle('active', this.paneVisible.tabs);
    document.getElementById('toggleBlocks').classList.toggle('active', this.paneVisible.blocks);
  }

  updatePower() {
    const on = this.ctx.state === 'running';
    this.powerBtn.textContent = `POWER: ${on ? 'ON' : 'OFF'}`;
    this.powerBtn.classList.toggle('on', on);
    this.setStatus(on ? `AUDIO RUNNING @ ${this.ctx.sampleRate} HZ` : 'AUDIO OFF - PRESS POWER TO START');
  }

  frame() {
    for (const b of this.blocks.values()) {
      if (b.tab === this.activeTab) b.draw(); else b.tick();
    }
    requestAnimationFrame(() => this.frame());
  }

  /* blocks */

  addBlock(type, x, y, tab = this.activeTab, ...args) {
    const block = new BLOCK_TYPES[type](this, x, y, ...args);
    block.tab = tab;
    this.blocks.set(block.id, block);
    tab.ws.append(block.el);
    this.bringToFront(block);
    if (block.isPack) this.renderTabs();
    if (tab === this.activeTab) this.renderWires();
    return block;
  }

  removeBlock(block) {
    for (const c of this.conns.filter((c) => c.from.block === block || c.to.block === block)) this.disconnect(c);
    this.setSelected(block, false);
    block.destroy();
    block.el.remove();
    this.blocks.delete(block.id);
  }

  bringToFront(block) {
    block.el.style.zIndex = ++this.zTop;
  }

  startBlockDrag(block, e) {
    e.preventDefault();
    this.closeContextMenu();
    this.select(null);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      this.setSelected(block, !this.selection.has(block));
      return;
    }
    if (!this.selection.has(block)) {
      this.clearSelection();
      this.setSelected(block, true);
    }
    const group = [...this.selection].map((b) => ({ b, x: b.x, y: b.y }));
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev) => {
      for (const g of group) g.b.moveTo(g.x + (ev.clientX - sx) / this.zoom, g.y + (ev.clientY - sy) / this.zoom);
      this.renderWires();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* connections */

  sourceOf(block, portId) {
    const c = this.conns.find((c) => c.to.block === block && c.to.port === portId);
    return c ? c.from.block : null;
  }

  // Current numeric value feeding a value input, or undefined when unwired.
  valueFor(block, portId) {
    const c = this.conns.find((c) => c.to.block === block && c.to.port === portId);
    return c ? c.from.block.getValue(c.from.port) : undefined;
  }

  portDef(block, portId, isOut) {
    return (isOut ? block.outputs : block.inputs).find((p) => p.id === portId);
  }

  /* Cycle detection works on ports of pack blocks (not whole blocks): a pack's input only
     leads to the blocks fed by its inner "pack in" blocks, and its outputs come from the "pack out" blocks. */
  nodeOut(block, port) { return block.isPack ? `p${block.id}:out:${port}` : `b${block.id}`; }
  nodeIn(block, port) { return block.isPack ? `p${block.id}:in:${port}` : `b${block.id}`; }

  reaches(start, target) {
    const adj = new Map();
    const add = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    for (const c of this.conns) add(this.nodeOut(c.from.block, c.from.port), this.nodeIn(c.to.block, c.to.port));
    for (const b of this.blocks.values()) {
      if (!b.isPack) continue;
      for (const [pid, inner] of Object.entries(b.inBlocks)) add(`p${b.id}:in:${pid}`, `b${inner.id}`);
      for (const [pid, inner] of Object.entries(b.outBlocks)) add(`b${inner.id}`, `p${b.id}:out:${pid}`);
    }
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      if (n === target) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const next of adj.get(n) || []) stack.push(next);
    }
    return false;
  }

  canConnect(fromBlock, fromPort, toBlock, toPort) {
    const o = this.portDef(fromBlock, fromPort, true);
    const i = this.portDef(toBlock, toPort, false);
    if (!o || !i || o.kind !== i.kind || fromBlock === toBlock || fromBlock.tab !== toBlock.tab) return false;
    return !this.reaches(this.nodeIn(toBlock, toPort), this.nodeOut(fromBlock, fromPort));
  }

  connect(fromBlock, fromPort, toBlock, toPort) {
    if (!this.canConnect(fromBlock, fromPort, toBlock, toPort)) return null;
    const existing = this.conns.find((c) => c.to.block === toBlock && c.to.port === toPort);
    if (existing) {
      if (existing.from.block === fromBlock && existing.from.port === fromPort) return existing;
      this.disconnect(existing, true); // replaced right away, so the block is not told the input went empty
    }
    fromBlock.audioOut(fromPort).connect(toBlock.audioIn(toPort));

    const kind = this.portDef(fromBlock, fromPort, true).kind;
    const vis = document.createElementNS(SVG_NS, 'path');
    vis.setAttribute('class', 'vis');
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('class', 'hit');
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `wire ${kind}`);
    g.append(vis, hit);
    fromBlock.tab.svg.append(g);

    const conn = { from: { block: fromBlock, port: fromPort }, to: { block: toBlock, port: toPort }, tab: fromBlock.tab, g, vis, hit };
    hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.select(conn); });
    hit.addEventListener('dblclick', () => this.disconnect(conn));
    this.conns.push(conn);
    toBlock.onPortChange(toPort, true);
    this.refreshPortStates();
    this.renderWires();
    return conn;
  }

  disconnect(conn, silent = false) {
    const i = this.conns.indexOf(conn);
    if (i < 0) return;
    this.conns.splice(i, 1);
    try {
      conn.from.block.audioOut(conn.from.port).disconnect(conn.to.block.audioIn(conn.to.port));
    } catch (_) { /* already disconnected */ }
    conn.g.remove();
    if (this.selected === conn) this.selected = null;
    if (!silent) conn.to.block.onPortChange(conn.to.port, false);
    this.refreshPortStates();
  }

  select(conn) {
    if (this.selected) this.selected.g.classList.remove('selected');
    this.selected = conn;
    if (conn) conn.g.classList.add('selected');
  }

  refreshPortStates() {
    for (const b of this.blocks.values()) for (const el of Object.values(b.portEls)) el.classList.remove('connected');
    for (const c of this.conns) {
      c.from.block.portEls[c.from.port].classList.add('connected');
      c.to.block.portEls[c.to.port].classList.add('connected');
    }
  }

  /* wire drawing */

  portCenter(el, wsRect) {
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - wsRect.left) / this.zoom, y: (r.top + r.height / 2 - wsRect.top) / this.zoom };
  }

  wirePath(a, b) {
    const dx = Math.max(50, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
  }

  renderWires() {
    const rect = this.ws.getBoundingClientRect();
    for (const c of this.conns) {
      if (c.tab !== this.activeTab) continue;
      const a = this.portCenter(c.from.block.portEls[c.from.port], rect);
      const b = this.portCenter(c.to.block.portEls[c.to.port], rect);
      const d = this.wirePath(a, b);
      c.vis.setAttribute('d', d);
      c.hit.setAttribute('d', d);
    }
  }

  startWireDrag(portEl, e) {
    e.preventDefault();
    e.stopPropagation();
    let block = this.blocks.get(+portEl.dataset.block);
    let portId = portEl.dataset.port;
    let isOut = portEl.classList.contains('out');

    // Grabbing a wired input unplugs it and continues dragging from its source.
    if (!isOut) {
      const existing = this.conns.find((c) => c.to.block === block && c.to.port === portId);
      if (existing) {
        ({ block, port: portId } = existing.from);
        isOut = true;
        this.disconnect(existing);
      }
    }
    const anchorBlock = block;
    const anchorPort = portId;
    const anchorIsOut = isOut;
    const kind = this.portDef(block, portId, isOut).kind;

    const valid = (b, p, pOut) => (pOut === anchorIsOut ? false
      : anchorIsOut ? this.canConnect(anchorBlock, anchorPort, b, p)
        : this.canConnect(b, p, anchorBlock, anchorPort));
    for (const b of this.blocks.values()) {
      for (const [id, el] of Object.entries(b.portEls)) {
        if (valid(b, id, el.classList.contains('out'))) el.classList.add('ok');
      }
    }
    this.ws.classList.add('dragging-wire');

    const vis = document.createElementNS(SVG_NS, 'path');
    vis.setAttribute('class', 'vis');
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `wire temp ${kind}`);
    g.append(vis);
    this.svg.append(g);

    const draw = (ev) => {
      const rect = this.ws.getBoundingClientRect();
      const a = this.portCenter(anchorBlock.portEls[anchorPort], rect);
      const p = { x: (ev.clientX - rect.left) / this.zoom, y: (ev.clientY - rect.top) / this.zoom };
      vis.setAttribute('d', anchorIsOut ? this.wirePath(a, p) : this.wirePath(p, a));
    };
    draw(e);

    const move = (ev) => draw(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      g.remove();
      this.ws.classList.remove('dragging-wire');
      document.querySelectorAll('.port.ok').forEach((el) => el.classList.remove('ok'));
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const t = target && (target.closest('.port') || (target.closest('.port-row') || document.createElement('i')).querySelector('.port'));
      if (t) {
        const tb = this.blocks.get(+t.dataset.block);
        const tp = t.dataset.port;
        const tOut = t.classList.contains('out');
        if (tb && valid(tb, tp, tOut)) {
          if (anchorIsOut) this.connect(anchorBlock, anchorPort, tb, tp);
          else this.connect(tb, tp, anchorBlock, anchorPort);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

const app = new App();
window.jsynth = app;
// Run after every script (including the extra blocks) has registered itself.
window.addEventListener('DOMContentLoaded', () => app.init());
