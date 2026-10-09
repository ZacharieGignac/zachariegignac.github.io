'use strict';

/* SEQUENCER PRO: up to 64 steps. Every step has a pitch (or rest), a velocity, its own delay before the next step
   (a multiple of the base step time) and four trigger flags. The trigger outputs (TRIG 1-4) and DONE can fire,
   step or chain other sequencers, and sequencer-to-sequencer triggers are passed directly so they stay sample-accurate.
   Needs SEQ_SCALES, NOTE_NAMES and noteName from blocks-extra.js. */

const SP_STEPS = 64;
const SP_PAGE = 16;
const SP_DELAYS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
const SP_LANES = ['t1', 't2', 't3', 't4', 'done'];
const SP_DIRS = ['FWD', 'REV', 'PING', 'RAND'];

// Editor canvas layout, in canvas pixels
const SP_W = 288;
const SP_H = 248;
const SP_LX = 30;
const SP_PITCH_H = 100;
const SP_VEL_Y = 102;
const SP_VEL_H = 22;
const SP_DLY_Y = 126;
const SP_DLY_H = 30;
const SP_TRIG_Y = 158;
const SP_TRIG_H = 16;
const SP_RULER_Y = 224;

const spNearestDelay = (m) => {
  let best = 0;
  for (let i = 1; i < SP_DELAYS.length; i++) if (Math.abs(Math.log(SP_DELAYS[i] / m)) < Math.abs(Math.log(SP_DELAYS[best] / m))) best = i;
  return best;
};

class SeqProBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'seqpro', title: 'SEQUENCER PRO', desc: 'Up to 64 steps, per-step delay, drives other sequencers',
      inputs: [
        { id: 'trig', label: 'TRIG IN', kind: 'value' },
        { id: 'reset', label: 'RESET IN', kind: 'value' },
        { id: 'bpm', label: 'BPM IN', kind: 'value' },
      ],
      outputs: [
        { id: 'pitch', label: 'PITCH Hz', kind: 'value' },
        { id: 'gate', label: 'GATE 0/1', kind: 'value' },
        { id: 'vel', label: 'VELOCITY', kind: 'value' },
        { id: 'step', label: 'STEP #', kind: 'value' },
        { id: 't1', label: 'TRIG 1 0/1', kind: 'value' },
        { id: 't2', label: 'TRIG 2 0/1', kind: 'value' },
        { id: 't3', label: 'TRIG 3 0/1', kind: 'value' },
        { id: 't4', label: 'TRIG 4 0/1', kind: 'value' },
        { id: 'done', label: 'DONE 0/1', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;

    this.out = {};
    const initial = { pitch: 110, vel: 1, step: 1 };
    for (const p of this.outputs) {
      const n = ctx.createConstantSource();
      n.offset.value = initial[p.id] || 0;
      n.start();
      this.out[p.id] = n;
    }
    this.trigDet = this.makeDetector();
    this.resetDet = this.makeDetector();
    this.bpmIn = ctx.createGain(); // BPM is read from the wired value; this only gives the wire something to plug into

    this.pat = new Array(SP_STEPS).fill(0);
    [0, 2, 4, 2, 3, 2, 5, 7].forEach((d, i) => { this.pat[i] = d; });
    this.rest = new Array(SP_STEPS).fill(false);
    this.rest[3] = true;
    this.vel = new Array(SP_STEPS).fill(1);
    this.mult = new Array(SP_STEPS).fill(1);
    this.trig = new Array(SP_STEPS).fill(0);
    this.scaleIdx = 0;
    this.root = 45;
    this.mode = 0; // 0 loops, 1 waits for triggers
    this.dir = 0;
    this.page = 0;
    this.follow = true;
    this.sel = 0;
    this.activeStep = -1;
    this.queue = [];
    this.pulses = [];
    this.pend = [];
    this.curFreq = 110;
    this.curGate = 0;
    this.curVel = 1;
    this.curStepNum = 1;
    this.curLane = [0, 0, 0, 0, 0];
    this.playing = false;
    this.timer = null;
    this.nextTime = 0;
    this.runLeft = 0;
    this.queued = [];
    this.pingDir = 1;
    this.cycleCount = 0;
    this.pos = 0;

    this.playBtn = h('button', { text: 'PLAY', onclick: () => (this.playing ? this.stop() : this.start()) });
    this.trigBtn = h('button', { text: 'TRIGGER', onclick: () => this.onTrigger(this.app.ctx.currentTime + 0.005) });
    this.randBtn = h('button', { text: 'RANDOM', onclick: () => this.randomize() });
    this.clearBtn = h('button', { text: 'CLEAR', onclick: () => this.clear() });
    this.modeBtns = ['LOOP', 'TRIGGERED'].map((name, i) => h('button', { text: name, onclick: () => this.setMode(i) }));
    this.dirBtns = SP_DIRS.map((name, i) => h('button', { text: name, onclick: () => this.setDir(i) }));
    this.bpmSlider = makeSlider({ label: 'BPM', min: 20, max: 600, value: 110, decimals: 0 });
    this.stepsSlider = makeSlider({ label: 'STEPS', min: 1, max: SP_STEPS, value: 8, decimals: 0, onInput: () => this.onStepsChange() });
    this.gateSlider = makeSlider({ label: 'GATE %', min: 5, max: 95, value: 60, decimals: 0 });
    this.glideSlider = makeSlider({ label: 'GLIDE', min: 0, max: 300, value: 0, decimals: 0 });
    this.perSlider = makeSlider({ label: 'N/TRIG', min: 0, max: SP_STEPS, value: 0, decimals: 0 });
    this.pulseSlider = makeSlider({ label: 'PULSE', min: 5, max: 500, value: 30, log: true, decimals: 0 });
    this.rootSelect = h('select', { onchange: () => { this.root = +this.rootSelect.value; this.rebuildNotes(); } },
      Array.from({ length: 60 }, (_, i) => h('option', { value: 24 + i, text: noteName(24 + i) })));
    this.rootSelect.value = this.root;
    this.scaleSelect = h('select', { onchange: () => this.setScale(+this.scaleSelect.value) },
      SEQ_SCALES.map(([name], i) => h('option', { value: i, text: name })));
    this.pageBtns = [0, 1, 2, 3].map((p) => h('button', { text: `${p * SP_PAGE + 1}-${(p + 1) * SP_PAGE}`, onclick: () => { this.follow = false; this.setPage(p); } }));
    this.followBtn = h('button', { text: 'FOLLOW', onclick: () => { this.follow = !this.follow; this.refreshButtons(); } });
    this.canvas = h('canvas', { class: 'scope sp-grid', width: SP_W, height: SP_H });

    this.stepInput = h('input', { type: 'number', min: 1, max: SP_STEPS, step: 1, value: 1 });
    this.delayInput = h('input', { type: 'number', min: 0.05, max: 32, step: 0.05, value: 1 });
    this.noteSelect = h('select', { onchange: () => this.onNotePicked() });
    this.velInput = h('input', { type: 'number', min: 0, max: 1, step: 0.05, value: 1 });
    this.stepInput.addEventListener('change', () => { this.selectStep(parseInt(this.stepInput.value, 10) - 1 || 0, true); });
    this.delayInput.addEventListener('change', () => {
      const v = parseFloat(this.delayInput.value);
      if (!Number.isNaN(v)) this.mult[this.sel] = clamp(v, 0.05, 32);
      this.refreshPanel();
    });
    this.velInput.addEventListener('change', () => {
      const v = parseFloat(this.velInput.value);
      if (!Number.isNaN(v)) this.vel[this.sel] = clamp(v, 0, 1);
      this.refreshPanel();
    });
    this.readout = h('div', { class: 'readout small', text: '-' });
    this.bindEditor();

    this.body.append(
      h('div', { class: 'btn-row' }, this.playBtn, this.trigBtn, this.randBtn, this.clearBtn),
      h('div', { class: 'btn-row' }, this.modeBtns),
      h('div', { class: 'btn-row' }, this.dirBtns),
      this.bpmSlider.el, this.stepsSlider.el, this.gateSlider.el, this.glideSlider.el, this.perSlider.el, this.pulseSlider.el,
      h('div', { class: 'minmax wide' }, h('span', { text: 'ROOT' }), this.rootSelect, h('span', { text: 'SCALE' }), this.scaleSelect),
      h('div', { class: 'btn-row' }, this.pageBtns, this.followBtn),
      this.canvas,
      h('div', { class: 'minmax wide' }, h('span', { text: 'STEP' }), this.stepInput, h('span', { text: 'DLY \u00d7' }), this.delayInput),
      h('div', { class: 'minmax wide' }, h('span', { text: 'NOTE' }), this.noteSelect, h('span', { text: 'VEL' }), this.velInput),
      this.readout);
    this.rebuildNotes();
    this.setMode(0);
    this.setDir(0);
    this.setPage(0);
    this.refreshPanel();
    this.start();
  }

  /* ---------- helpers ---------- */

  makeDetector() {
    const ctx = this.app.ctx;
    const input = ctx.createGain();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    input.connect(an);
    an.connect(this.app.sink);
    return { input, an, buf: new Float32Array(2048), high: false };
  }

  get scale() { return SEQ_SCALES[this.scaleIdx][1]; }
  get levels() { return this.scale.length * 2 + 1; }
  stepCount() { return Math.round(this.stepsSlider.get()); }
  perTrig() { return Math.round(this.perSlider.get()); }
  startPos() { return this.dir === 1 ? this.stepCount() - 1 : 0; }
  cycleLen() { return this.dir === 2 ? Math.max(1, 2 * this.stepCount() - 2) : this.stepCount(); }

  degreeMidi(d) {
    const len = this.scale.length;
    return this.root + Math.floor(d / len) * 12 + this.scale[d % len];
  }

  degreeFreq(d) { return 440 * Math.pow(2, (this.degreeMidi(d) - 69) / 12); }

  curBpm() {
    const wired = this.app.valueFor(this, 'bpm');
    return clamp(wired !== undefined ? wired : this.bpmSlider.get(), 10, 1500);
  }

  baseStep() { return 60 / this.curBpm() / 4; }

  getValue(portId) {
    switch (portId) {
      case 'pitch': return this.curFreq;
      case 'gate': return this.curGate;
      case 'vel': return this.curVel;
      case 'step': return this.curStepNum;
      case 'done': return this.curLane[4];
      default: return this.curLane[SP_LANES.indexOf(portId)] || 0;
    }
  }

  onPortChange(portId, connected) {
    if (portId === 'bpm') this.bpmSlider.setDisabled(connected);
  }

  audioIn(portId) { return portId === 'trig' ? this.trigDet.input : portId === 'reset' ? this.resetDet.input : this.bpmIn; }
  audioOut(portId) { return this.out[portId]; }

  /* ---------- state ---------- */

  getState() {
    return {
      pat: [...this.pat], rest: [...this.rest], vel: [...this.vel], mult: [...this.mult], trig: [...this.trig],
      scaleIdx: this.scaleIdx, root: this.root, steps: this.stepsSlider.get(), bpm: this.bpmSlider.get(),
      gate: this.gateSlider.get(), glide: this.glideSlider.get(), per: this.perSlider.get(), pulse: this.pulseSlider.get(),
      mode: this.mode, dir: this.dir, follow: this.follow, sel: this.sel, playing: this.playing,
    };
  }

  setState(s) {
    const fill = (dst, src) => { if (Array.isArray(src)) src.slice(0, SP_STEPS).forEach((v, i) => { dst[i] = v; }); };
    fill(this.pat, s.pat); fill(this.rest, s.rest); fill(this.vel, s.vel); fill(this.mult, s.mult); fill(this.trig, s.trig);
    this.scaleIdx = s.scaleIdx || 0;
    this.scaleSelect.value = this.scaleIdx;
    this.root = s.root || 45;
    this.rootSelect.value = this.root;
    this.stepsSlider.set(s.steps || 8, true);
    this.bpmSlider.set(s.bpm || 110, true);
    this.gateSlider.set(s.gate || 60, true);
    this.glideSlider.set(s.glide || 0, true);
    this.perSlider.set(s.per || 0, true);
    this.pulseSlider.set(s.pulse || 30, true);
    this.follow = s.follow !== false;
    this.sel = clamp(s.sel || 0, 0, SP_STEPS - 1);
    this.setMode(s.mode || 0);
    this.setDir(s.dir || 0);
    this.rebuildNotes();
    this.rewind();
    this.refreshPanel();
    if (s.playing === false) this.stop();
  }

  /* ---------- editing ---------- */

  setScale(i) {
    this.scaleIdx = i;
    this.pat = this.pat.map((d) => Math.min(d, this.levels - 1));
    this.rebuildNotes();
  }

  rebuildNotes() {
    const opts = [h('option', { value: -1, text: 'REST' })];
    for (let d = 0; d < this.levels; d++) opts.push(h('option', { value: d, text: noteName(this.degreeMidi(d)) }));
    this.noteSelect.replaceChildren(...opts);
    this.refreshPanel();
  }

  onNotePicked() {
    const d = +this.noteSelect.value;
    if (d < 0) this.rest[this.sel] = true;
    else { this.pat[this.sel] = d; this.rest[this.sel] = false; }
  }

  onStepsChange() {
    if (this.sel >= this.stepCount()) this.refreshPanel();
  }

  selectStep(i, jumpPage) {
    this.sel = clamp(i, 0, SP_STEPS - 1);
    if (jumpPage) { this.follow = false; this.setPage(Math.floor(this.sel / SP_PAGE)); }
    this.refreshPanel();
  }

  refreshPanel() {
    const i = this.sel;
    this.stepInput.value = i + 1;
    this.delayInput.value = +this.mult[i].toFixed(2);
    this.velInput.value = +this.vel[i].toFixed(2);
    this.noteSelect.value = this.rest[i] ? -1 : Math.min(this.pat[i], this.levels - 1);
  }

  setPage(p) {
    this.page = clamp(p, 0, SP_STEPS / SP_PAGE - 1);
    this.refreshButtons();
  }

  refreshButtons() {
    this.pageBtns.forEach((b, i) => b.classList.toggle('active', i === this.page));
    this.followBtn.classList.toggle('active', this.follow);
  }

  setMode(i) {
    this.mode = i;
    this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.perSlider.setDisabled(i !== 1, 'off');
    this.runLeft = 0;
    this.queued = [];
    this.nextTime = this.app.ctx.currentTime + 0.06;
  }

  setDir(i) {
    this.dir = i;
    this.dirBtns.forEach((b, k) => b.classList.toggle('active', k === i));
    this.rewind();
  }

  randomize() {
    this.pat = this.pat.map(() => Math.floor(Math.random() * this.levels));
    this.rest = this.rest.map(() => Math.random() < 0.2);
    this.refreshPanel();
  }

  clear() {
    this.pat.fill(0); this.rest.fill(false); this.vel.fill(1); this.mult.fill(1); this.trig.fill(0);
    this.refreshPanel();
  }

  bindEditor() {
    const cv = this.canvas;
    let region = null;
    let paint = false;
    const where = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * SP_W, y: ((e.clientY - r.top) / r.height) * SP_H };
    };
    const regionAt = (y) => {
      if (y < SP_PITCH_H) return 'pitch';
      if (y < SP_DLY_Y - 2) return 'vel';
      if (y < SP_TRIG_Y - 2) return 'delay';
      if (y < SP_TRIG_Y + 4 * SP_TRIG_H) return `trig${clamp(Math.floor((y - SP_TRIG_Y) / SP_TRIG_H), 0, 3)}`;
      return 'ruler';
    };
    const edit = (e, first) => {
      const { x, y } = where(e);
      if (first) region = regionAt(y);
      const col = clamp(Math.floor((x - SP_LX) / ((SP_W - SP_LX) / SP_PAGE)), 0, SP_PAGE - 1);
      const i = this.page * SP_PAGE + col;
      if (x < SP_LX && first) { region = 'none'; return; }
      if (region === 'none') return;
      if (first) this.follow = false;
      this.sel = i;
      if (region === 'pitch') {
        if (first && (e.shiftKey || e.button === 2)) this.rest[i] = !this.rest[i];
        else if (e.buttons === 1) {
          this.pat[i] = clamp(Math.round((1 - y / SP_PITCH_H) * (this.levels - 1)), 0, this.levels - 1);
          this.rest[i] = false;
        }
      } else if (region === 'vel') {
        if (e.buttons === 1) this.vel[i] = clamp(Math.round((1 - (y - SP_VEL_Y) / SP_VEL_H) * 20) / 20, 0, 1);
      } else if (region === 'delay') {
        if (e.buttons === 1) this.mult[i] = SP_DELAYS[clamp(Math.round((1 - (y - SP_DLY_Y) / SP_DLY_H) * (SP_DELAYS.length - 1)), 0, SP_DELAYS.length - 1)];
      } else if (region.startsWith('trig')) {
        const bit = 1 << +region.slice(4);
        if (first) paint = !(this.trig[i] & bit);
        if (e.buttons === 1 || first) this.trig[i] = paint ? this.trig[i] | bit : this.trig[i] & ~bit;
      }
      this.refreshPanel();
    };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      edit(e, true);
    });
    cv.addEventListener('pointermove', (e) => { if (e.buttons === 1) edit(e, false); });
  }

  /* ---------- playing ---------- */

  start(at) {
    if (this.playing) return;
    this.playing = true;
    this.rewind();
    this.runLeft = 0;
    this.queued = [];
    this.nextTime = at !== undefined ? at : this.app.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.schedule(), 25);
    this.playBtn.textContent = 'STOP';
    this.playBtn.classList.add('active');
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    const t = this.app.ctx.currentTime;
    this.out.gate.offset.cancelScheduledValues(t);
    this.out.gate.offset.setValueAtTime(0, t);
    this.queue = [];
    this.pend = [];
    this.queued = [];
    this.runLeft = 0;
    this.curGate = 0;
    this.activeStep = -1;
    this.playBtn.textContent = 'PLAY';
    this.playBtn.classList.remove('active');
  }

  rewind() {
    this.pos = this.startPos();
    this.pingDir = 1;
    this.cycleCount = 0;
  }

  // A trigger from another sequencer, with the exact audio time it was scheduled for.
  trigger(t) { this.pend.push({ t, reset: false }); }
  resetAt(t) { this.pend.push({ t, reset: true }); }

  onTrigger(t) {
    if (!this.playing) return;
    const now = this.app.ctx.currentTime;
    t = Math.max(t, now);
    if (this.mode === 0) { // looping: a trigger re-syncs to step 1
      this.rewind();
      this.cutAfter(t);
      this.nextTime = t;
      return;
    }
    if (this.runLeft > 0) {
      if (this.perTrig() === 0) this.beginRun(t);
      else if (this.queued.length < 32) this.queued.push(t); // plays when the current run ends, but not before its own time
      return;
    }
    this.beginRun(t);
  }

  onReset(t) {
    t = Math.max(t, this.app.ctx.currentTime);
    this.rewind();
    this.runLeft = 0;
    this.queued = [];
    this.cutAfter(t);
    if (this.mode === 0) this.nextTime = t;
  }

  beginRun(t) {
    const all = this.perTrig() === 0;
    if (all) this.rewind();
    this.runLeft = all ? this.cycleLen() : this.perTrig();
    this.cutAfter(t);
    this.nextTime = t;
  }

  // Forgets steps that were scheduled to start after t, because a restart replaces them.
  cutAfter(t) {
    this.queue = this.queue.filter((q) => q.t <= t);
  }

  schedule() {
    const ctx = this.app.ctx;
    const now = ctx.currentTime;
    this.pend.sort((a, b) => a.t - b.t);
    while (this.pend.length && this.pend[0].t <= now + 0.12) {
      const p = this.pend.shift();
      if (p.reset) this.onReset(p.t); else this.onTrigger(p.t);
    }
    if (this.nextTime < now - 0.2) this.nextTime = now; // tab was throttled
    for (let guard = 0; this.nextTime < now + 0.12 && guard < 64; guard++) {
      if (this.mode === 1 && this.runLeft <= 0) {
        if (!this.queued.length) break;
        const start = Math.max(this.queued[0], this.nextTime);
        if (start >= now + 0.12) break;
        this.queued.shift();
        this.beginRun(start);
      }
      this.playStep(this.nextTime);
    }
  }

  nextIndex(i) {
    const n = this.stepCount();
    if (this.dir === 0) return (i + 1) % n;
    if (this.dir === 1) return (i - 1 + n) % n;
    if (this.dir === 3) return Math.floor(Math.random() * n);
    if (n === 1) return 0;
    let nx = i + this.pingDir;
    if (nx >= n) { this.pingDir = -1; nx = n - 2; } else if (nx < 0) { this.pingDir = 1; nx = 1; }
    return nx;
  }

  playStep(t) {
    if (this.pos >= this.stepCount()) this.rewind();
    const i = this.pos;
    const dur = this.baseStep() * this.mult[i];
    const rest = this.rest[i];
    const freq = this.degreeFreq(this.pat[i]);
    const gateOff = Math.max(t + 0.003, t + dur * (this.gateSlider.get() / 100));

    const gate = this.out.gate.offset;
    gate.cancelScheduledValues(t);
    gate.setValueAtTime(0, t);
    if (!rest) {
      const glide = this.glideSlider.get();
      if (glide > 0) this.out.pitch.offset.setTargetAtTime(freq, t, glide / 3000);
      else this.out.pitch.offset.setValueAtTime(freq, t);
      this.out.vel.offset.setValueAtTime(this.vel[i], t);
      gate.setValueAtTime(1, t + 0.001);
      gate.setValueAtTime(0, gateOff);
    }
    this.out.step.offset.setValueAtTime(i + 1, t);
    for (let k = 0; k < 4; k++) if (this.trig[i] & (1 << k)) this.pulseLane(k, t);

    this.queue.push({ t, step: i, rest, freq, vel: this.vel[i], dur, gateEnd: gateOff });
    if (this.queue.length > 96) this.queue.shift();

    this.cycleCount++;
    const finished = this.cycleCount >= this.cycleLen();
    if (finished) this.cycleCount = 0;
    this.pos = this.nextIndex(i);
    this.nextTime = t + dur;
    if (this.mode === 1) this.runLeft--;
    if (finished) this.pulseLane(4, t + dur);
  }

  // Raises a trigger lane for a moment, and tells any sequencers wired to it directly (even through packs).
  pulseLane(k, t) {
    const len = this.pulseSlider.get() / 1000;
    const node = this.out[SP_LANES[k]].offset;
    node.setValueAtTime(1, t);
    node.setValueAtTime(0, t + len);
    this.pulses.push({ k, t, end: t + len });
    for (const target of this.traceTargets(SP_LANES[k])) {
      if (!(target.block instanceof SeqProBlock)) continue;
      if (target.port === 'trig') target.block.trigger(t);
      else if (target.port === 'reset') target.block.resetAt(t);
    }
  }

  // Follows wires from one of this block's outputs to the blocks they finally reach, passing through pack boundaries.
  traceTargets(portId) {
    const conns = this.app.conns;
    const found = [];
    const visit = (block, port, depth) => {
      if (depth > 8) return;
      if (block.isPack) {
        const inlet = block.inBlocks[port];
        if (inlet) for (const c of conns) if (c.from.block === inlet) visit(c.to.block, c.to.port, depth + 1);
      } else if (block.type === 'packout') {
        for (const c of conns) if (c.from.block === block.pack && c.from.port === block.portId) visit(c.to.block, c.to.port, depth + 1);
      } else {
        found.push({ block, port });
      }
    };
    for (const c of conns) if (c.from.block === this && c.from.port === portId) visit(c.to.block, c.to.port, 0);
    return found;
  }

  // The block and port that finally feed one of this block's inputs, looking back through pack boundaries.
  traceSource(portId) {
    const conns = this.app.conns;
    let block = this;
    let port = portId;
    for (let depth = 0; depth < 8; depth++) {
      const c = conns.find((cn) => cn.to.block === block && cn.to.port === port);
      if (!c) return null;
      const src = c.from.block;
      if (src.type === 'packin') { block = src.pack; port = src.portId; } else if (src.isPack) { block = src.outBlocks[c.from.port]; port = 'in'; if (!block) return null; } else return { block: src, port: c.from.port };
    }
    return null;
  }

  // True when a sequencer's lane is wired in, so its direct (sample-accurate) trigger replaces edge detection.
  isDirect(portId) {
    const s = this.traceSource(portId);
    return !!s && s.block instanceof SeqProBlock && SP_LANES.includes(s.port);
  }

  rising(det) {
    det.an.getFloatTimeDomainData(det.buf);
    let high = false;
    for (let i = 0; i < det.buf.length; i++) if (det.buf[i] > 0.5) { high = true; break; }
    const edge = high && !det.high;
    det.high = high;
    return edge;
  }

  // Runs every frame, also while the block's tab is hidden: trigger inputs, playhead and output values.
  tick() {
    const now = this.app.ctx.currentTime;
    if (this.rising(this.trigDet) && !this.isDirect('trig')) this.onTrigger(now + 0.005);
    if (this.rising(this.resetDet) && !this.isDirect('reset')) this.onReset(now + 0.005);
    while (this.queue.length > 1 && this.queue[1].t <= now) this.queue.shift();
    const cur = this.queue[0];
    if (cur && cur.t <= now) {
      this.activeStep = now < cur.t + cur.dur ? cur.step : -1;
      this.curGate = !cur.rest && now < cur.gateEnd ? 1 : 0;
      this.curStepNum = cur.step + 1;
      if (!cur.rest) { this.curFreq = cur.freq; this.curVel = cur.vel; }
    }
    this.pulses = this.pulses.filter((p) => p.end > now - 0.5);
    this.curLane = [0, 0, 0, 0, 0];
    for (const p of this.pulses) if (p.t <= now && now < p.end) this.curLane[p.k] = 1;
  }

  /* ---------- drawing ---------- */

  draw() {
    this.tick();
    if (this.follow && this.activeStep >= 0) {
      const p = Math.floor(this.activeStep / SP_PAGE);
      if (p !== this.page) this.setPage(p);
    }
    const wired = this.app.valueFor(this, 'bpm');
    if (wired !== undefined) this.bpmSlider.set(clamp(wired, 20, 600));
    const noteText = this.rest[this.sel] ? 'REST' : noteName(this.degreeMidi(this.pat[this.sel]));
    this.readout.textContent = this.activeStep >= 0 || this.playing
      ? `STEP ${this.curStepNum}/${this.stepCount()}  ${this.curGate ? noteName(Math.round(69 + 12 * Math.log2(this.curFreq / 440))) : '-'}  ${this.curBpm().toFixed(0)} BPM`
      : `STOPPED  (EDITING STEP ${this.sel + 1}: ${noteText})`;
    this.drawEditor();
  }

  drawEditor() {
    const g = this.canvas.getContext('2d');
    const cw = (SP_W - SP_LX) / SP_PAGE;
    const base = this.page * SP_PAGE;
    const n = this.stepCount();
    const levels = this.levels;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, SP_W, SP_H);

    g.font = '8px monospace';
    g.fillStyle = '#1b8a38';
    g.fillText('PITCH', 1, 10);
    g.fillText('VEL', 1, SP_VEL_Y + 14);
    g.fillText('DLY', 1, SP_DLY_Y + 18);
    for (let k = 0; k < 4; k++) g.fillText(`T${k + 1}`, 1, SP_TRIG_Y + k * SP_TRIG_H + 11);
    g.strokeStyle = 'rgba(51,255,102,0.12)';
    g.beginPath();
    for (let i = 1; i < levels; i++) { const yy = Math.round((SP_PITCH_H * i) / levels) + 0.5; g.moveTo(SP_LX, yy); g.lineTo(SP_W, yy); }
    for (const yy of [SP_VEL_Y - 1, SP_DLY_Y - 1, SP_TRIG_Y - 1, SP_RULER_Y - 1]) { g.moveTo(0, yy + 0.5); g.lineTo(SP_W, yy + 0.5); }
    g.stroke();
    // the 1x line of the delay row
    const unity = SP_DELAYS.indexOf(1);
    const unityY = SP_DLY_Y + SP_DLY_H - 2 - (unity / (SP_DELAYS.length - 1)) * (SP_DLY_H - 4);
    g.strokeStyle = 'rgba(255,224,74,0.3)';
    g.beginPath(); g.moveTo(SP_LX, unityY + 0.5); g.lineTo(SP_W, unityY + 0.5); g.stroke();

    for (let c = 0; c < SP_PAGE; c++) {
      const i = base + c;
      const x = SP_LX + c * cw;
      const live = i < n;
      if (i === this.activeStep) {
        g.fillStyle = 'rgba(255,176,0,0.18)';
        g.fillRect(x, 0, cw, SP_TRIG_Y + 4 * SP_TRIG_H);
      }
      g.globalAlpha = live ? 1 : 0.22;
      const playing = i === this.activeStep;
      const bh = ((this.pat[i] + 1) / levels) * (SP_PITCH_H - 2);
      if (this.rest[i]) {
        g.strokeStyle = 'rgba(51,255,102,0.5)';
        g.strokeRect(x + 2.5, SP_PITCH_H - bh + 0.5, cw - 5, bh - 1);
      } else {
        g.fillStyle = playing ? '#ffb000' : '#33ff66';
        g.fillRect(x + 2, SP_PITCH_H - bh, cw - 4, bh);
      }
      g.fillStyle = '#b87a00';
      g.fillRect(x + 2, SP_VEL_Y + SP_VEL_H - this.vel[i] * (SP_VEL_H - 2) - 1, cw - 4, this.vel[i] * (SP_VEL_H - 2) + 1);
      const frac = spNearestDelay(this.mult[i]) / (SP_DELAYS.length - 1);
      const dh = 3 + frac * (SP_DLY_H - 6);
      g.fillStyle = '#ffe04a';
      g.fillRect(x + 2, SP_DLY_Y + SP_DLY_H - 2 - dh, cw - 4, dh);
      for (let k = 0; k < 4; k++) {
        const yy = SP_TRIG_Y + k * SP_TRIG_H + 2;
        if (this.trig[i] & (1 << k)) { g.fillStyle = '#ff9a1f'; g.fillRect(x + 2, yy, cw - 4, SP_TRIG_H - 4); }
        else { g.strokeStyle = 'rgba(255,154,31,0.25)'; g.strokeRect(x + 2.5, yy + 0.5, cw - 5, SP_TRIG_H - 5); }
      }
      g.fillStyle = i === this.sel ? '#ffb000' : '#1b8a38';
      g.fillText(String(i + 1), x + 1, SP_RULER_Y + 10);
      g.globalAlpha = 1;
      if (i === this.sel) {
        g.strokeStyle = '#ffb000';
        g.strokeRect(x + 0.5, 0.5, cw - 1, SP_H - 2);
      }
    }
  }

  destroy() {
    this.stop();
    for (const n of Object.values(this.out)) { n.stop(); n.disconnect(); }
    for (const d of [this.trigDet, this.resetDet]) { d.input.disconnect(); d.an.disconnect(); }
    this.bpmIn.disconnect();
  }
}

Object.assign(BLOCK_TYPES, { seqpro: SeqProBlock });
