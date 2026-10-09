'use strict';

/* VISUALIZER: five live views of a wave (spectrum, LED bars, waterfall, oscilloscope, phase scope), a level meter,
   a frequency balance readout and a grid of measurements. The wave passes through untouched, and three value
   outputs (loudness, pitch, brightness) let the measurements drive other blocks. */

const VIZ_MODES = ['SPECTRUM', 'BARS', 'WATERFALL', 'SCOPE', 'XY'];
const VIZ_F_MIN = 20;
const VIZ_F_MAX = 20000;
const VIZ_BASE_W = 480;
const VIZ_BASE_H = 250;
const VIZ_METER_H = 70;
const VIZ_WF_W = 512; // waterfall history, in columns
const VIZ_WF_H = 256; // waterfall frequency rows
const VIZ_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* Waterfall colours: dark, phosphor green, amber, red, then white-hot for the loudest. */
const VIZ_PALETTE = (() => {
  const stops = [[0, [1, 6, 3]], [0.25, [4, 70, 30]], [0.5, [51, 255, 102]], [0.75, [255, 176, 0]], [0.92, [255, 74, 58]], [1, [255, 240, 230]]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < stops.length - 1 && stops[k][0] < t) k++;
    const [t0, c0] = stops[k - 1];
    const [t1, c1] = stops[k];
    const f = clamp((t - t0) / (t1 - t0), 0, 1);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
  }
  return lut;
})();

function vizFreq(f) { return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(f < 100 ? 1 : 0)} Hz`; }

function vizNote(f) {
  const midi = 69 + 12 * Math.log2(f / 440);
  const n = Math.round(midi);
  const cents = Math.round((midi - n) * 100);
  return { name: `${VIZ_NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`, cents };
}

function vizDb(lin) { return lin > 1e-5 ? 20 * Math.log10(lin) : -100; }

class VisualizerBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'viz', title: 'VISUALIZER', desc: 'Spectrum, waterfall, scope and meters; passes the wave through',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [
        { id: 'out', label: 'WAVE OUT', kind: 'wave' },
        { id: 'level', label: 'LEVEL 0-1', kind: 'value' },
        { id: 'pitch', label: 'PITCH Hz', kind: 'value' },
        { id: 'bright', label: 'BRIGHT Hz', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;
    this.node = ctx.createGain();
    this.an = ctx.createAnalyser();
    this.an.fftSize = 8192;
    this.an.smoothingTimeConstant = 0.7;
    this.node.connect(this.an);
    this.an.connect(app.sink);
    this.bins = new Float32Array(this.an.frequencyBinCount);
    this.wave = new Float32Array(this.an.fftSize);
    this.hps = new Float32Array(this.an.frequencyBinCount >> 2);
    this.outNodes = {};
    this.outVals = { level: 0, pitch: 0, bright: 0 };
    for (const id of Object.keys(this.outVals)) {
      const n = ctx.createConstantSource();
      n.offset.value = 0;
      n.start();
      this.outNodes[id] = n;
    }

    this.mode = 0;
    this.range = 90;
    this.holdOn = true;
    this.frozen = false;
    this.dirty = true;
    this.clearNext = true;
    this.scale = 1;
    this.zoomY = 1;
    this.caps = new Float32Array(256).fill(-160);
    this.barCaps = new Float32Array(48).fill(-160);
    this.band256 = new Float32Array(256);
    this.band48 = new Float32Array(48);
    this.holdDb = -100;
    this.holdTimer = 0;
    this.clipFlash = 0;
    this.clips = 0;
    this.wfAcc = 0;
    this.lastTick = performance.now();
    this.st = {
      active: false, pkDb: -100, rmsDb: -100, dc: 0, pitch: 0, peakHz: 0, centroid: 0, rolloff: 0, flat: 0, low: 0, mid: 0, high: 0,
    };

    this.wf = document.createElement('canvas');
    this.wf.width = VIZ_WF_W;
    this.wf.height = VIZ_WF_H;
    this.wfCtx = this.wf.getContext('2d');
    this.wfCtx.fillStyle = '#010603';
    this.wfCtx.fillRect(0, 0, VIZ_WF_W, VIZ_WF_H);
    this.wfCol = this.wfCtx.createImageData(1, VIZ_WF_H);

    this.canvas = h('canvas', { class: 'viz-canvas' });
    this.meter = h('canvas', { class: 'viz-meter' });
    this.modeBtns = VIZ_MODES.map((n, i) => h('button', { text: n, onclick: () => this.setMode(i) }));
    this.smooth = makeSlider({ label: 'SMOOTH', min: 0, max: 0.95, value: 0.7, decimals: 2, onInput: (v) => { this.an.smoothingTimeConstant = v; } });
    this.rangeSlider = makeSlider({ label: 'RANGE', min: 40, max: 120, value: 90, decimals: 0, onInput: (v) => { this.range = v; this.dirty = true; } });
    this.holdBtn = h('button', { text: 'PEAK HOLD', class: 'active', onclick: () => this.setHold(!this.holdOn) });
    this.freezeBtn = h('button', { text: 'FREEZE', onclick: () => this.setFrozen(!this.frozen) });
    this.expandBtn = h('button', { text: 'EXPAND', onclick: () => this.setExpanded(!this.overlay) });
    this.resetBtn = h('button', { text: 'RESET PEAKS', onclick: () => this.resetPeaks() });

    const cell = (key, label) => {
      const val = h('b', { text: '-' });
      const el = h('div', { class: 'viz-cell' }, h('span', { class: 'cap', text: label }), val);
      el.dataset.tipkey = key;
      return { el, val, key };
    };
    this.cells = Object.fromEntries([
      ['peak', 'PEAK'], ['rms', 'RMS'], ['crest', 'CREST'],
      ['pitch', 'PITCH'], ['note', 'NOTE'], ['peakHz', 'LOUDEST'],
      ['centroid', 'CENTROID'], ['rolloff', 'ROLLOFF 85%'], ['noise', 'NOISINESS'],
      ['dc', 'DC OFFSET'], ['clips', 'CLIPS'], ['res', 'RESOLUTION'],
    ].map(([k, l]) => [k, cell(k, l)]));
    this.cells.clips.el.addEventListener('click', () => { this.clips = 0; });
    this.info = h('div', { class: 'viz-info' }, Object.values(this.cells).map((c) => c.el));

    this.view = h('div', { class: 'viz-view' },
      h('div', { class: 'viz-modes' }, this.modeBtns), this.canvas, this.meter, this.info,
      this.smooth.el, this.rangeSlider.el,
      h('div', { class: 'btn-row' }, this.holdBtn, this.freezeBtn, this.expandBtn, this.resetBtn));
    this.body.append(this.view);
    this.setMode(0);
    this.applyScale(1);
  }

  /* ---------- controls ---------- */

  setMode(i) {
    this.mode = i;
    this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.clearNext = true;
    this.dirty = true;
  }

  setHold(on) {
    this.holdOn = on;
    this.holdBtn.classList.toggle('active', on);
    this.dirty = true;
  }

  setFrozen(on) {
    this.frozen = on;
    this.freezeBtn.classList.toggle('active', on);
  }

  resetPeaks() {
    this.caps.fill(-160);
    this.barCaps.fill(-160);
    this.holdDb = -100;
    this.clips = 0;
    this.clipFlash = 0;
    this.dirty = true;
  }

  // The drawing is resolution independent, so the expanded view just renders at a larger scale.
  applyScale(k) {
    this.scale = k;
    this.canvas.width = Math.round(VIZ_BASE_W * k);
    this.canvas.height = Math.round(VIZ_BASE_H * k);
    this.meter.width = Math.round(VIZ_BASE_W * k);
    this.meter.height = Math.round(VIZ_METER_H * k);
    this.clearNext = true;
    this.dirty = true;
  }

  setExpanded(on) {
    if (on === !!this.overlay) return;
    this.expandBtn.classList.toggle('active', on);
    if (on) {
      const close = h('button', { text: 'CLOSE (ESC)', onclick: () => this.setExpanded(false) });
      this.overlay = h('div', { class: 'viz-overlay' },
        h('div', { class: 'viz-panel' }, h('div', { class: 'viz-bar' }, h('span', { text: 'VISUALIZER' }), close), this.view));
      this.escHandler = (e) => { if (e.key === 'Escape') this.setExpanded(false); };
      document.addEventListener('keydown', this.escHandler);
      document.body.append(this.overlay);
      this.applyScale(1.5);
    } else {
      document.removeEventListener('keydown', this.escHandler);
      this.body.append(this.view);
      this.overlay.remove();
      this.overlay = null;
      this.applyScale(1);
    }
  }

  getState() {
    return { mode: this.mode, smooth: this.smooth.get(), range: this.rangeSlider.get(), hold: this.holdOn };
  }

  setState(s) {
    this.setMode(clamp(s.mode | 0, 0, VIZ_MODES.length - 1));
    this.smooth.set(s.smooth ?? 0.7, true);
    this.rangeSlider.set(s.range ?? 90, true);
    this.setHold(s.hold !== false);
  }

  getValue(portId) { return this.outVals[portId]; }
  audioIn() { return this.node; }
  audioOut(portId) { return this.outNodes[portId] || this.node; }

  /* ---------- analysis (runs every frame, also while the block's tab is hidden) ---------- */

  tick() {
    const now = performance.now();
    const dt = Math.min(0.2, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const sr = this.app.ctx.sampleRate;
    const bins = this.bins;
    const w = this.wave;
    this.an.getFloatFrequencyData(bins);
    this.an.getFloatTimeDomainData(w);
    for (let i = 0; i < bins.length; i++) if (!(bins[i] > -160)) bins[i] = -160;

    // levels over the newest 4096 samples; clipping only over the samples that arrived since the last frame
    const n = w.length;
    const m = 4096;
    let pk = 0;
    let sum = 0;
    let sq = 0;
    for (let i = n - m; i < n; i++) {
      const x = w[i];
      const a = Math.abs(x);
      if (a > pk) pk = a;
      sum += x;
      sq += x * x;
    }
    const fresh = Math.min(m, Math.max(1, Math.round(dt * sr)));
    let clipped = 0;
    for (let i = n - fresh; i < n; i++) if (Math.abs(w[i]) >= 0.999) clipped++;
    if (clipped) { this.clips += clipped; this.clipFlash = 90; } else if (this.clipFlash > 0) this.clipFlash--;
    const rms = Math.sqrt(sq / m);
    const st = this.st;
    st.pkDb = vizDb(pk);
    st.rmsDb = vizDb(rms);
    st.dc = sum / m;
    st.active = pk > 1e-4;
    if (st.pkDb >= this.holdDb) { this.holdDb = st.pkDb; this.holdTimer = 45; } else if (this.holdTimer > 0) this.holdTimer--; else this.holdDb = Math.max(st.pkDb, this.holdDb - 0.6);

    // spectral measurements over 20 Hz .. 20 kHz
    const binHz = sr / 2 / bins.length;
    const i0 = Math.max(1, Math.ceil(VIZ_F_MIN / binHz));
    const i1 = Math.min(bins.length - 1, Math.floor(VIZ_F_MAX / binHz));
    let total = 0;
    let weighted = 0;
    let lnSum = 0;
    let best = -Infinity;
    let bestI = i0;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let i = i0; i <= i1; i++) {
      const db = bins[i];
      const p = Math.exp(db * 0.23025851);
      const f = i * binHz;
      total += p;
      weighted += p * f;
      lnSum += db * 0.23025851;
      if (db > best) { best = db; bestI = i; }
      if (f < 250) low += p; else if (f < 4000) mid += p; else high += p;
    }
    const count = i1 - i0 + 1;
    if (st.active && total > 0) {
      st.centroid = weighted / total;
      st.flat = clamp(Math.exp(lnSum / count) / (total / count), 0, 1);
      st.low = low / total;
      st.mid = mid / total;
      st.high = high / total;
      let acc = 0;
      let r = i1;
      for (let i = i0; i <= i1; i++) {
        acc += Math.exp(bins[i] * 0.23025851);
        if (acc >= total * 0.85) { r = i; break; }
      }
      st.rolloff = r * binHz;
      st.peakHz = best > -90 ? this.refine(bestI) * binHz : 0;
    } else {
      st.centroid = st.rolloff = st.peakHz = st.flat = st.low = st.mid = st.high = 0;
    }
    st.pitch = st.active ? this.findPitch(binHz) : 0;

    const at = this.app.ctx.currentTime;
    const next = { level: clamp(rms * Math.SQRT2, 0, 1), pitch: st.pitch, bright: st.centroid };
    for (const id of Object.keys(next)) {
      this.outVals[id] = next[id];
      this.outNodes[id].offset.setTargetAtTime(next[id], at, 0.015);
    }
  }

  // Sub-bin position of a spectral peak, from a parabola through the bin and its neighbours.
  refine(i) {
    const b = this.bins;
    if (i <= 0 || i >= b.length - 1) return i;
    const a = b[i - 1];
    const c = b[i + 1];
    const d = a - 2 * b[i] + c;
    return d < 0 ? i + clamp(0.5 * (a - c) / d, -0.5, 0.5) : i;
  }

  // Harmonic product spectrum: the fundamental is where the first three harmonics all line up.
  findPitch(binHz) {
    const b = this.bins;
    const lo = Math.max(2, Math.ceil(30 / binHz));
    const hi = Math.min(this.hps.length - 1, Math.floor(3000 / binHz));
    let best = -Infinity;
    let bestI = 0;
    let mean = 0;
    for (let i = lo; i <= hi; i++) {
      const v = b[i] + b[2 * i] + b[3 * i];
      this.hps[i] = v;
      mean += v;
      if (v > best) { best = v; bestI = i; }
    }
    mean /= hi - lo + 1;
    if (best - mean < 24 || b[bestI] < -85) return 0;
    // an octave too high is the usual mistake: prefer the half frequency when it is nearly as strong
    const half = Math.round(bestI / 2);
    if (half >= lo && this.hps[half] > best - 6 && b[half] > b[bestI] - 12) bestI = half;
    return this.refine(bestI) * binHz;
  }

  // dB of `n` log-spaced bands between 20 Hz and 20 kHz; narrow bands interpolate between bins.
  bandLevels(n, out) {
    const b = this.bins;
    const L = b.length;
    const binHz = this.app.ctx.sampleRate / 2 / L;
    const ratio = Math.pow(VIZ_F_MAX / VIZ_F_MIN, 1 / n);
    let f0 = VIZ_F_MIN;
    for (let k = 0; k < n; k++) {
      const f1 = f0 * ratio;
      const lo = f0 / binHz;
      const hi = f1 / binHz;
      let db;
      if (hi - lo < 1) {
        const pos = (lo + hi) / 2;
        const i = clamp(Math.floor(pos), 0, L - 2);
        db = b[i] + (b[i + 1] - b[i]) * clamp(pos - i, 0, 1);
      } else {
        db = -160;
        const e = Math.min(L - 1, Math.floor(hi));
        for (let i = Math.max(1, Math.ceil(lo)); i <= e; i++) if (b[i] > db) db = b[i];
      }
      out[k] = db;
      f0 = f1;
    }
  }

  /* ---------- drawing ---------- */

  draw() {
    this.tick();
    if (this.frozen && !this.dirty) return;
    this.dirty = false;
    const g = this.canvas.getContext('2d');
    [() => this.drawSpectrum(g), () => this.drawBars(g), () => this.drawWaterfall(g), () => this.drawScope(g), () => this.drawXY(g)][this.mode]();
    this.drawMeter();
    this.updateCells();
  }

  fx(f, W) { return (Math.log(f / VIZ_F_MIN) / Math.log(VIZ_F_MAX / VIZ_F_MIN)) * W; }

  background(g, W, H) {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#04140a');
    bg.addColorStop(1, '#010603');
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
  }

  label(g, text, x, y, color, s, align = 'left') {
    g.font = `${Math.round(9 * s)}px monospace`;
    g.textAlign = align;
    g.lineWidth = 3 * s;
    g.strokeStyle = 'rgba(1,6,3,0.85)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.textAlign = 'left';
  }

  // Log frequency grid (vertical lines, along the bottom) and, when asked, dB lines.
  freqGrid(g, W, plotH, s, withDb) {
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(51,255,102,0.10)';
    g.beginPath();
    for (const f of [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000]) {
      const x = Math.round(this.fx(f, W)) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, plotH);
    }
    g.stroke();
    g.strokeStyle = 'rgba(51,255,102,0.22)';
    g.beginPath();
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(this.fx(f, W)) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, plotH + 3 * s);
    }
    g.stroke();
    for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k'], [20000, '20k']]) {
      this.label(g, t, this.fx(f, W), plotH + 12 * s, '#1b8a38', s, 'center');
    }
    if (!withDb) return;
    g.strokeStyle = 'rgba(51,255,102,0.10)';
    g.beginPath();
    for (let db = 0; db > -this.range; db -= 20) {
      const y = Math.round(plotH * (-db / this.range)) + 0.5;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();
    for (let db = -20; db > -this.range; db -= 20) this.label(g, `${db}`, 3 * s, plotH * (-db / this.range) - 2 * s, '#1b8a38', s);
  }

  drawSpectrum(g) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.scale;
    const plotH = H - 16 * s;
    this.background(g, W, H);
    this.freqGrid(g, W, plotH, s, true);

    const N = 256;
    this.bandLevels(N, this.band256);
    const xs = new Float32Array(N);
    const ys = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const db = this.band256[i];
      this.caps[i] = Math.max(db, this.caps[i] - 0.45);
      xs[i] = ((i + 0.5) / N) * W;
      ys[i] = plotH * (1 - clamp((db + this.range) / this.range, 0, 1));
    }
    const trace = () => {
      g.moveTo(0, ys[0]);
      for (let i = 0; i < N - 1; i++) g.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
      g.lineTo(W, ys[N - 1]);
    };
    const fill = g.createLinearGradient(0, 0, 0, plotH);
    fill.addColorStop(0, 'rgba(255,74,58,0.6)');
    fill.addColorStop(0.28, 'rgba(255,176,0,0.45)');
    fill.addColorStop(0.6, 'rgba(51,255,102,0.34)');
    fill.addColorStop(1, 'rgba(51,255,102,0.03)');
    g.beginPath();
    trace();
    g.lineTo(W, plotH);
    g.lineTo(0, plotH);
    g.closePath();
    g.fillStyle = fill;
    g.fill();

    const stroke = g.createLinearGradient(0, 0, 0, plotH);
    stroke.addColorStop(0, '#ff8a70');
    stroke.addColorStop(0.3, '#ffd060');
    stroke.addColorStop(0.65, '#8dffb0');
    stroke.addColorStop(1, '#33ff66');
    g.strokeStyle = stroke;
    g.lineWidth = 1.6 * s;
    g.lineJoin = 'round';
    g.shadowColor = '#33ff66';
    g.shadowBlur = 8 * s;
    g.beginPath();
    trace();
    g.stroke();
    g.shadowBlur = 0;

    if (this.holdOn) {
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i < N; i++) {
        const y = plotH * (1 - clamp((this.caps[i] + this.range) / this.range, 0, 1));
        g.fillRect(xs[i] - W / N / 2, y - s, Math.max(1, W / N - 0.5), Math.max(1, 1.5 * s));
      }
    }
    this.markers(g, W, plotH, s);
  }

  // Dashed lines for the pitch and the spectral centroid ("centre of mass" of the spectrum).
  markers(g, W, plotH, s) {
    const st = this.st;
    g.setLineDash([4 * s, 3 * s]);
    g.lineWidth = Math.max(1, s);
    if (st.centroid > VIZ_F_MIN) {
      const x = this.fx(st.centroid, W);
      g.strokeStyle = 'rgba(255,176,0,0.75)';
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, plotH);
      g.stroke();
      this.label(g, 'C', x + 3 * s, plotH - 4 * s, '#ffb000', s);
    }
    if (st.pitch > VIZ_F_MIN) {
      const x = this.fx(st.pitch, W);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, plotH);
      g.stroke();
      const note = vizNote(st.pitch);
      const text = `${note.name} ${vizFreq(st.pitch)}`;
      const right = x > W * 0.7;
      this.label(g, text, right ? x - 4 * s : x + 4 * s, 11 * s, '#ffffff', s, right ? 'right' : 'left');
    }
    g.setLineDash([]);
  }

  drawBars(g) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.scale;
    const plotH = H - 16 * s;
    this.background(g, W, H);
    this.freqGrid(g, W, plotH, s, false);
    const N = 48;
    this.bandLevels(N, this.band48);
    const segs = 26;
    const segH = plotH / segs;
    const bw = W / N;
    for (let i = 0; i < N; i++) {
      const db = this.band48[i];
      this.barCaps[i] = Math.max(db, this.barCaps[i] - 0.5);
      const lit = Math.round(clamp((db + this.range) / this.range, 0, 1) * segs);
      const cap = Math.round(clamp((this.barCaps[i] + this.range) / this.range, 0, 1) * segs);
      for (let k = 0; k < segs; k++) {
        const frac = k / segs;
        const x = i * bw + Math.max(1, s);
        const y = plotH - (k + 1) * segH + Math.max(1, 0.6 * s);
        const w = Math.max(1, bw - 2 * Math.max(1, s));
        const hh = Math.max(1, segH - 1.4 * s);
        if (k < lit) {
          g.fillStyle = frac > 0.86 ? '#ff4a3a' : frac > 0.66 ? '#ffb000' : '#33ff66';
          g.shadowColor = g.fillStyle;
          g.shadowBlur = 5 * s;
        } else if (this.holdOn && k === cap - 1 && cap > 0) {
          g.fillStyle = '#ffffff';
          g.shadowBlur = 0;
        } else {
          g.fillStyle = 'rgba(51,255,102,0.06)';
          g.shadowBlur = 0;
        }
        g.fillRect(x, y, w, hh);
      }
    }
    g.shadowBlur = 0;
    this.markers(g, W, plotH, s);
  }

  drawWaterfall(g) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.scale;
    const plotH = H - 16 * s;
    const now = performance.now();
    this.wfAcc = Math.min(8, this.wfAcc + ((now - (this.wfLast || now)) / 1000) * 60);
    this.wfLast = now;
    const cols = Math.floor(this.wfAcc);
    if (cols > 0 && !this.frozen) {
      this.wfAcc -= cols;
      this.bandLevels(VIZ_WF_H, this.band256);
      const d = this.wfCol.data;
      for (let r = 0; r < VIZ_WF_H; r++) {
        const v = clamp((this.band256[VIZ_WF_H - 1 - r] + this.range) / this.range, 0, 1);
        const p = Math.round(Math.pow(v, 1.25) * 255) * 3;
        d[r * 4] = VIZ_PALETTE[p];
        d[r * 4 + 1] = VIZ_PALETTE[p + 1];
        d[r * 4 + 2] = VIZ_PALETTE[p + 2];
        d[r * 4 + 3] = 255;
      }
      this.wfCtx.drawImage(this.wf, -cols, 0);
      for (let k = 0; k < cols; k++) this.wfCtx.putImageData(this.wfCol, VIZ_WF_W - cols + k, 0);
    }
    g.fillStyle = '#010603';
    g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.wf, 0, 0, W, plotH);
    // horizontal frequency lines with labels
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
      const y = Math.round(plotH * (1 - this.fx(f, 1))) + 0.5;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();
    for (const [f, t] of [[50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']]) {
      this.label(g, t, 3 * s, plotH * (1 - this.fx(f, 1)) - 2 * s, 'rgba(220,255,230,0.85)', s);
    }
    if (this.st.pitch > VIZ_F_MIN) {
      const y = plotH * (1 - this.fx(this.st.pitch, 1));
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(W, y);
      g.lineTo(W - 7 * s, y - 4 * s);
      g.lineTo(W - 7 * s, y + 4 * s);
      g.fill();
      const note = vizNote(this.st.pitch);
      this.label(g, `${note.name} ${vizFreq(this.st.pitch)}`, W - 10 * s, clamp(y + 3 * s, 10 * s, plotH - 2 * s), '#ffffff', s, 'right');
    }
    const secs = VIZ_WF_W / 60;
    this.label(g, `-${secs.toFixed(1)} s`, 3 * s, H - 4 * s, '#1b8a38', s);
    this.label(g, 'NOW', W - 3 * s, H - 4 * s, '#1b8a38', s, 'right');
    this.label(g, 'TIME  >', W / 2, H - 4 * s, '#1b8a38', s, 'center');
  }

  // Auto gain for the scope views: loud signals stay inside the frame, quiet ones are enlarged.
  autoZoom(maxZoom) {
    const pk = Math.pow(10, this.st.pkDb / 20);
    const target = pk > 0.002 ? clamp(0.92 / pk, 1, maxZoom) : 1;
    this.zoomY = target < this.zoomY ? target : this.zoomY + (target - this.zoomY) * 0.06;
    return this.zoomY;
  }

  // Phosphor effect: the previous frame fades instead of being erased.
  fade(g, W, H, alpha) {
    g.globalCompositeOperation = 'source-over';
    if (this.clearNext) { g.fillStyle = '#010603'; this.clearNext = false; g.fillRect(0, 0, W, H); return; }
    g.fillStyle = `rgba(1,6,3,${alpha})`;
    g.fillRect(0, 0, W, H);
  }

  drawScope(g) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.scale;
    const plotH = H - 16 * s;
    const sr = this.app.ctx.sampleRate;
    const w = this.wave;
    const n = w.length;
    this.fade(g, W, H, 0.3);
    g.fillStyle = '#010603';
    g.fillRect(0, plotH, W, H - plotH);

    const zoom = this.autoZoom(32);
    const mid = plotH / 2;
    const amp = mid - 8 * s;
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(51,255,102,0.12)';
    g.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round((W * i) / 10) + 0.5; g.moveTo(x, 0); g.lineTo(x, plotH); }
    for (const v of [-1, -0.5, 0.5, 1]) {
      const y = Math.round(mid - v * zoom * amp) + 0.5;
      if (y > 0 && y < plotH) { g.moveTo(0, y); g.lineTo(W, y); }
    }
    g.stroke();
    g.strokeStyle = 'rgba(51,255,102,0.4)';
    g.beginPath();
    g.moveTo(0, Math.round(mid) + 0.5);
    g.lineTo(W, Math.round(mid) + 0.5);
    g.stroke();
    for (const v of [-1, -0.5, 0.5, 1]) {
      const y = mid - v * zoom * amp;
      if (y > 8 * s && y < plotH - 2 * s) this.label(g, v > 0 ? `+${v}` : `${v}`, 3 * s, y - 2 * s, '#1b8a38', s);
    }

    const period = this.st.pitch > 0 ? sr / this.st.pitch : 0;
    const len = clamp(Math.round(period ? period * 3 : 1024), 96, 2048);
    let start = 0;
    for (let i = 1; i < n - len; i++) if (w[i - 1] < 0 && w[i] >= 0) { start = i; break; }
    const trace = () => {
      g.beginPath();
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * W;
        const y = clamp(mid - w[start + i] * zoom * amp, 1, plotH - 1);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(51,255,102,0.35)';
    g.lineWidth = 5 * s;
    g.shadowColor = '#33ff66';
    g.shadowBlur = 14 * s;
    trace();
    g.shadowBlur = 0;
    g.strokeStyle = '#b8ffcc';
    g.lineWidth = 1.5 * s;
    trace();

    this.label(g, `${(len / sr * 1000).toFixed(1)} ms`, 3 * s, H - 4 * s, '#1b8a38', s);
    this.label(g, `GAIN x${zoom.toFixed(1)}`, W - 3 * s, H - 4 * s, '#1b8a38', s, 'right');
    if (period) this.label(g, `${vizFreq(this.st.pitch)}  |  PERIOD ${(period / sr * 1000).toFixed(2)} ms`, W / 2, H - 4 * s, '#1b8a38', s, 'center');
  }

  // Phase scope: the wave against a slightly delayed copy of itself. A pure tone draws a circle or ellipse, harmonics tie it in knots.
  drawXY(g) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.scale;
    const plotH = H - 16 * s;
    const sr = this.app.ctx.sampleRate;
    const w = this.wave;
    const n = w.length;
    this.fade(g, W, H, 0.16);
    g.fillStyle = '#010603';
    g.fillRect(0, plotH, W, H - plotH);

    const zoom = this.autoZoom(8);
    const cx = W / 2;
    const cy = plotH / 2;
    const R = Math.min(W / 2, plotH / 2) - 8 * s;
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(51,255,102,0.14)';
    g.beginPath();
    g.moveTo(cx, 0); g.lineTo(cx, plotH);
    g.moveTo(0, cy); g.lineTo(W, cy);
    g.moveTo(cx - R, cy + R); g.lineTo(cx + R, cy - R);
    g.stroke();
    for (const k of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); }

    const delay = this.st.pitch > 0 ? clamp(Math.round(sr / this.st.pitch / 4), 1, 1200) : 24;
    const count = 1536;
    const first = n - count - delay - 1;
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    const parts = [['rgba(20,140,60,0.4)', 1.2], ['rgba(51,255,102,0.35)', 1.4], ['rgba(170,255,200,0.5)', 1.6]];
    parts.forEach(([color, lw], p) => {
      const a = Math.floor((count * p) / parts.length);
      const b = Math.floor((count * (p + 1)) / parts.length) + 1;
      g.strokeStyle = color;
      g.lineWidth = lw * s;
      g.shadowColor = '#33ff66';
      g.shadowBlur = p === 2 ? 8 * s : 0;
      g.beginPath();
      for (let i = a; i < b; i++) {
        const j = first + i;
        const x = cx + w[j] * zoom * R;
        const y = cy - w[j + delay] * zoom * R;
        if (i === a) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    });
    g.shadowBlur = 0;
    g.globalCompositeOperation = 'source-over';
    this.label(g, `x(t) vs x(t+${delay})  |  DELAY ${(delay / sr * 1e6).toFixed(0)} us`, 3 * s, H - 4 * s, '#1b8a38', s);
    this.label(g, `GAIN x${zoom.toFixed(1)}`, W - 3 * s, H - 4 * s, '#1b8a38', s, 'right');
  }

  drawMeter() {
    const c = this.meter;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const s = W / VIZ_BASE_W;
    const st = this.st;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);

    // level bar: RMS filled, instantaneous peak as a line, held peak as a white tick
    const bw = W - 46 * s;
    const bh = 15 * s;
    const px = (db) => clamp((db + 60) / 60, 0, 1) * bw;
    g.fillStyle = '#04140a';
    g.fillRect(0, 0, bw, bh);
    const bar = g.createLinearGradient(0, 0, bw, 0);
    bar.addColorStop(0, '#1fb84a');
    bar.addColorStop(0.7, '#33ff66');
    bar.addColorStop(0.85, '#ffb000');
    bar.addColorStop(1, '#ff4a3a');
    g.fillStyle = bar;
    g.fillRect(0, 2 * s, px(st.rmsDb), bh - 4 * s);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(Math.max(0, px(st.pkDb) - s), 0, Math.max(1, 2 * s), bh);
    g.fillStyle = '#ffffff';
    g.fillRect(Math.max(0, px(this.holdDb) - s), 0, Math.max(1, 2.5 * s), bh);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    for (let db = -60; db <= 0; db += 12) {
      const x = Math.round(px(db)) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, bh);
    }
    g.stroke();
    for (let db = -60; db <= 0; db += 12) this.label(g, `${db}`, clamp(px(db), 8 * s, bw - 6 * s), bh + 10 * s, '#1b8a38', s, 'center');
    const flash = this.clipFlash > 0;
    g.fillStyle = flash ? '#ff4a3a' : '#1a0a08';
    g.shadowColor = '#ff4a3a';
    g.shadowBlur = flash ? 10 * s : 0;
    g.fillRect(bw + 6 * s, 0, 38 * s, bh);
    g.shadowBlur = 0;
    this.label(g, 'CLIP', bw + 25 * s, bh - 4 * s, flash ? '#ffffff' : '#7a2a22', s, 'center');

    // frequency balance
    const rows = [['LOW', st.low, '#33ff66', '<250'], ['MID', st.mid, '#ffb000', '250-4k'], ['HIGH', st.high, '#ff6a3a', '>4k']];
    rows.forEach(([name, v, color, range], i) => {
      const y = 28 * s + i * 14 * s;
      const x0 = 30 * s;
      const w = W - x0 - 78 * s;
      this.label(g, name, 0, y + 7 * s, '#1b8a38', s);
      g.fillStyle = '#04140a';
      g.fillRect(x0, y, w, 9 * s);
      g.fillStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 4 * s;
      g.fillRect(x0, y, Math.sqrt(v) * w, 9 * s);
      g.shadowBlur = 0;
      this.label(g, `${Math.round(v * 100)}%  ${range}`, W - 2 * s, y + 7 * s, '#1b8a38', s, 'right');
    });
  }

  updateCells() {
    const st = this.st;
    const c = this.cells;
    const on = st.active;
    const set = (key, text, cls = '') => {
      const cell = c[key];
      if (cell.val.textContent !== text) cell.val.textContent = text;
      cell.el.classList.toggle('warn', cls === 'warn');
      cell.el.classList.toggle('dim', cls === 'dim');
    };
    const dbText = (db) => (db <= -99 ? '-inf' : `${db.toFixed(1)} dB`);
    set('peak', dbText(st.pkDb), st.pkDb > -0.5 ? 'warn' : on ? '' : 'dim');
    set('rms', dbText(st.rmsDb), on ? '' : 'dim');
    set('crest', on ? `${(st.pkDb - st.rmsDb).toFixed(1)} dB` : '-', on ? '' : 'dim');
    set('pitch', st.pitch ? vizFreq(st.pitch) : '-', st.pitch ? '' : 'dim');
    if (st.pitch) {
      const note = vizNote(st.pitch);
      set('note', `${note.name} ${note.cents >= 0 ? '+' : ''}${note.cents}c`);
    } else set('note', '-', 'dim');
    set('peakHz', st.peakHz ? vizFreq(st.peakHz) : '-', st.peakHz ? '' : 'dim');
    set('centroid', st.centroid ? vizFreq(st.centroid) : '-', st.centroid ? '' : 'dim');
    set('rolloff', st.rolloff ? vizFreq(st.rolloff) : '-', st.rolloff ? '' : 'dim');
    set('noise', on ? `${Math.round(st.flat * 100)} %` : '-', on ? '' : 'dim');
    set('dc', `${st.dc >= 0 ? '+' : ''}${st.dc.toFixed(4)}`, Math.abs(st.dc) > 0.05 ? 'warn' : '');
    set('clips', `${this.clips}`, this.clips ? 'warn' : 'dim');
    set('res', `${(this.app.ctx.sampleRate / this.an.fftSize).toFixed(1)} Hz`, 'dim');
  }

  destroy() {
    this.setExpanded(false);
    for (const n of Object.values(this.outNodes)) { n.stop(); n.disconnect(); }
    this.node.disconnect();
    this.an.disconnect();
  }
}

Object.assign(BLOCK_TYPES, { viz: VisualizerBlock });
