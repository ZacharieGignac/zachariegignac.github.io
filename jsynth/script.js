'use strict';

/* SCRIPT: your own JavaScript between inputs and outputs.
   Add as many named inputs and outputs as you like. Inputs arrive as variables, outputs are variables you assign.
   The script runs several times per second (RATE). Everything is plain JavaScript, so Math, conditions, loops and the
   persistent `state` object are all available. */

const SCRIPT_HELPERS = {
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  map: (v, a, b, c, d) => (b === a ? c : c + ((v - a) / (b - a)) * (d - c)),
  mtof: (m) => 440 * Math.pow(2, (m - 69) / 12),
  ftom: (f) => 69 + 12 * Math.log2(Math.max(f, 1e-9) / 440),
  rand: (lo = 0, hi = 1) => lo + Math.random() * (hi - lo),
};
const SCRIPT_HELPER_NAMES = Object.keys(SCRIPT_HELPERS);
const SCRIPT_RESERVED = new Set([
  'state', 't', 'dt', 'frame', 'log', '__out', ...SCRIPT_HELPER_NAMES,
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'await', 'async', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'Math',
]);

const SCRIPT_DEFAULT = `// Inputs: a, b    Outputs: x, y
// t = seconds, dt = time since the last run, state = memory that lasts
x = a * 2 + b;
y = Math.sin(t * 2) * 0.5 + 0.5;
`;

const SCRIPT_EXAMPLES = [
  {
    name: 'SCALE A 0-1 VALUE', ins: [['a', 0.5]], outs: ['x'],
    code: '// Turn a 0..1 value into a frequency range (Hz)\nx = map(a, 0, 1, 200, 2000);\n',
  },
  {
    name: 'SMOOTH (LAG)', ins: [['a', 0]], outs: ['x'],
    code: '// Glide towards the input. Make 0.2 bigger for a slower glide.\nconst k = 1 - Math.exp(-dt / 0.2);\nstate.v = (state.v ?? a) + (a - (state.v ?? a)) * k;\nx = state.v;\n',
  },
  {
    name: 'SNAP PITCH TO NOTES', ins: [['hz', 440]], outs: ['snapped'],
    code: '// Round a frequency to the nearest semitone\nsnapped = hz > 0 ? mtof(Math.round(ftom(hz))) : 0;\n',
  },
  {
    name: 'THRESHOLD GATE', ins: [['level', 0], ['limit', 0.5]], outs: ['gate'],
    code: '// 1 while the level is above the limit\ngate = level > limit ? 1 : 0;\n',
  },
  {
    name: 'SAMPLE AND HOLD', ins: [['signal', 0], ['trig', 0]], outs: ['held'],
    code: '// Grab the signal on each rising edge of trig\nconst high = trig > 0.5;\nif (high && !state.was) held = signal;\nstate.was = high;\n',
  },
  {
    name: 'COUNT TRIGGERS', ins: [['trig', 0]], outs: ['count', 'step8'],
    code: '// Count rising edges. step8 cycles 0..1 in eighths.\nconst high = trig > 0.5;\nif (high && !state.was) state.n = (state.n || 0) + 1;\nstate.was = high;\ncount = state.n || 0;\nstep8 = (count % 8) / 8;\n',
  },
  {
    name: 'SINE LFO', ins: [['rate', 0.5]], outs: ['x'],
    code: '// A sine between 0 and 1. rate is in Hz.\nstate.p = ((state.p || 0) + dt * rate) % 1;\nx = Math.sin(state.p * 2 * Math.PI) * 0.5 + 0.5;\n',
  },
  {
    name: 'RANDOM WALK', ins: [['step', 0.05]], outs: ['x'],
    code: '// Wanders randomly between 0 and 1\nstate.v = clamp((state.v ?? 0.5) + rand(-step, step), 0, 1);\nx = state.v;\n',
  },
  {
    name: 'CROSSFADE', ins: [['a', 0], ['b', 1], ['mix', 0.5]], outs: ['x'],
    code: '// Blend from a to b\nx = lerp(a, b, clamp(mix, 0, 1));\n',
  },
  {
    name: 'MIN, MAX, AVERAGE', ins: [['a', 0], ['b', 0], ['c', 0]], outs: ['lowest', 'highest', 'mean'],
    code: 'lowest = Math.min(a, b, c);\nhighest = Math.max(a, b, c);\nmean = (a + b + c) / 3;\n',
  },
  {
    name: 'PEAK FOLLOWER (WAVE IN)', ins: [['audio', 0, 'wave']], outs: ['env'],
    code: '// A wave input arrives as its loudness (0..1).\n// Rises fast, falls slowly.\nstate.v = Math.max(audio, (state.v || 0) - dt * 0.8);\nenv = state.v;\n',
  },
  {
    name: 'ARPEGGIATE A CHORD', ins: [['root', 220], ['rate', 6]], outs: ['pitch', 'step'],
    code: '// Cycle through a minor chord. root is a frequency in Hz.\nconst chord = [0, 3, 7, 12];\nstate.i = ((state.i || 0) + dt * rate) % chord.length;\nstep = Math.floor(state.i);\npitch = root * Math.pow(2, chord[step] / 12);\n',
  },
];

const scriptValid = (name) => /^[A-Za-z_$][\w$]*$/.test(name) && !SCRIPT_RESERVED.has(name);

class ScriptBlock extends Block {
  constructor(app, x, y) {
    super(app, { type: 'script', title: 'SCRIPT', desc: 'Your own JavaScript between values' }, x, y);
    const ctx = app.ctx;
    this.ins = []; // { id, name, kind, def, node, an, buf }
    this.outs = []; // { id, name, node, value }
    this.nextId = 1;
    this.state = {};
    this.code = '';
    this.fn = null;
    this.error = '';
    this.logText = '';
    this.paused = false;
    this.rate = 30;
    this.frame = 0;
    this.t0 = performance.now();
    this.last = this.t0;
    this.log = (...args) => { this.logText = args.map((a) => (typeof a === 'number' ? +a.toFixed(4) : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '); };

    this.inBox = h('div', { class: 'script-list' });
    this.outBox = h('div', { class: 'script-list' });
    this.addInBtn = h('button', { text: '+ INPUT', onclick: () => { this.addInput(); this.afterPortChange(); } });
    this.addOutBtn = h('button', { text: '+ OUTPUT', onclick: () => { this.addOutput(); this.afterPortChange(); } });
    this.editor = h('textarea', { class: 'script-code', spellcheck: 'false', autocomplete: 'off', wrap: 'off' });
    this.editor.dataset.tipkey = 'code';
    let pending = null;
    this.editor.addEventListener('input', () => {
      clearTimeout(pending);
      pending = setTimeout(() => this.setCode(this.editor.value), 250);
    });
    this.editor.addEventListener('blur', () => { clearTimeout(pending); this.setCode(this.editor.value); });
    this.editor.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = this.editor;
      this.editor.value = `${value.slice(0, a)}  ${value.slice(b)}`;
      this.editor.selectionStart = this.editor.selectionEnd = a + 2;
    });
    this.status = h('div', { class: 'script-status', text: '' });
    this.exampleSelect = h('select', { onchange: () => { if (this.exampleSelect.value !== '') this.loadExample(+this.exampleSelect.value); this.exampleSelect.value = ''; } },
      h('option', { value: '', text: '- EXAMPLES -' }),
      SCRIPT_EXAMPLES.map((e, i) => h('option', { value: i, text: e.name })));
    this.rateSlider = makeSlider({ label: 'RATE', min: 1, max: 240, value: 30, log: true, decimals: 0, onInput: (v) => this.setRate(v) });
    this.pauseBtn = h('button', { text: 'PAUSE', onclick: () => this.setPaused(!this.paused) });
    this.resetBtn = h('button', { text: 'RESET MEMORY', onclick: () => { this.state = {}; this.t0 = performance.now(); this.frame = 0; this.logText = ''; } });

    this.body.append(
      h('div', { class: 'cap', text: 'INPUTS (NAME, DEFAULT WHEN UNWIRED)' }), this.inBox, this.addInBtn,
      h('div', { class: 'cap', text: 'OUTPUTS' }), this.outBox, this.addOutBtn,
      this.exampleSelect, this.editor, this.status,
      this.rateSlider.el, h('div', { class: 'btn-row' }, this.pauseBtn, this.resetBtn));

    this.addInput('a', 0);
    this.addInput('b', 0);
    this.addOutput('x');
    this.addOutput('y');
    this.afterPortChange();
    this.setCode(SCRIPT_DEFAULT);
    this.startTimer();
  }

  /* ---------- inputs and outputs ---------- */

  uniqueName(base) {
    const taken = new Set([...this.ins.map((i) => i.name), ...this.outs.map((o) => o.name)]);
    if (!taken.has(base) && scriptValid(base)) return base;
    for (let n = 1; ; n++) if (!taken.has(`${base}${n}`) && scriptValid(`${base}${n}`)) return `${base}${n}`;
  }

  addInput(name, def = 0, kind = 'value', id = null) {
    const nm = this.uniqueName(name || 'abcdefghijklmnopqrstuvw'[this.ins.length % 23] || 'in');
    const inp = { id: id || `i${this.nextId++}`, name: nm, kind, def, node: this.app.ctx.createGain(), an: null, buf: null };
    if (id) this.nextId = Math.max(this.nextId, parseInt(id.slice(1), 10) + 1);
    this.ins.push(inp);
    this.renderInputRow(inp);
    return inp;
  }

  addOutput(name, id = null) {
    const nm = this.uniqueName(name || 'xyzw'[this.outs.length % 4] || 'out');
    const node = this.app.ctx.createConstantSource();
    node.offset.value = 0;
    node.start();
    const out = { id: id || `o${this.nextId++}`, name: nm, node, value: 0 };
    if (id) this.nextId = Math.max(this.nextId, parseInt(id.slice(1), 10) + 1);
    this.outs.push(out);
    this.renderOutputRow(out);
    return out;
  }

  // Removes the wires that touch a port before the port itself goes away.
  detach(portId, isOut) {
    for (const c of this.app.conns.filter((cn) => (isOut ? cn.from : cn.to).block === this && (isOut ? cn.from : cn.to).port === portId)) this.app.disconnect(c);
  }

  removeInput(inp) {
    this.removeInputQuiet(inp);
    this.afterPortChange();
  }

  removeOutput(out) {
    this.removeOutputQuiet(out);
    this.afterPortChange();
  }

  renderInputRow(inp) {
    const name = h('input', { type: 'text', value: inp.name, maxlength: 16, spellcheck: 'false' });
    name.dataset.tipkey = 'inName';
    name.addEventListener('change', () => this.rename(inp, name));
    const kind = h('button', { text: inp.kind === 'wave' ? 'WAVE' : 'VALUE', onclick: () => this.toggleKind(inp, kind) });
    kind.dataset.tipkey = 'kind';
    const def = h('input', { type: 'number', step: 'any', value: inp.def });
    def.dataset.tipkey = 'default';
    def.addEventListener('change', () => { const v = parseFloat(def.value); inp.def = Number.isNaN(v) ? 0 : v; def.value = inp.def; });
    const del = h('button', { text: '\u00d7', onclick: () => this.removeInput(inp) });
    del.dataset.tipkey = 'remove';
    inp.row = h('div', { class: 'script-row' }, name, kind, def, del);
    inp.defEl = def;
    this.inBox.append(inp.row);
  }

  renderOutputRow(out) {
    const name = h('input', { type: 'text', value: out.name, maxlength: 16, spellcheck: 'false' });
    name.dataset.tipkey = 'outName';
    name.addEventListener('change', () => this.rename(out, name));
    const del = h('button', { text: '\u00d7', onclick: () => this.removeOutput(out) });
    del.dataset.tipkey = 'remove';
    out.row = h('div', { class: 'script-row out' }, name, del);
    this.outBox.append(out.row);
  }

  rename(item, field) {
    const nm = field.value.trim();
    const clash = [...this.ins, ...this.outs].some((o) => o !== item && o.name === nm);
    if (!scriptValid(nm) || clash) {
      this.flash(clash ? `"${nm}" IS ALREADY USED` : `"${nm}" IS NOT A VALID NAME (LETTERS, DIGITS, _ AND $; NOT A RESERVED WORD)`);
      field.value = item.name;
      return;
    }
    item.name = nm;
    this.afterPortChange();
  }

  toggleKind(inp, btn) {
    this.toggleKindQuiet(inp, btn, inp.kind === 'wave' ? 'value' : 'wave');
    this.afterPortChange();
  }

  flash(text) {
    this.flashText = text;
    this.flashUntil = performance.now() + 4000;
  }

  // Rebuilds the port list from the inputs and outputs, then recompiles. Existing wires stay attached.
  afterPortChange() {
    for (const p of [...this.inputs]) this.removePort(p.id, false);
    for (const p of [...this.outputs]) this.removePort(p.id, true);
    for (const i of this.ins) this.addPort({ id: i.id, label: i.name, kind: i.kind }, false);
    for (const o of this.outs) this.addPort({ id: o.id, label: o.name, kind: 'value' }, true);
    this.compile();
    this.app.refreshPortStates();
    this.app.renderWires();
  }

  /* ---------- code ---------- */

  setCode(code) {
    this.code = code;
    if (this.editor.value !== code) this.editor.value = code;
    this.compile();
  }

  compile() {
    const outDecl = this.outs.length ? `let ${this.outs.map((o, k) => `${o.name} = __out[${k}]`).join(', ')};` : '';
    const body = `"use strict";\n${outDecl}\n(() => {\n${this.code}\n})();\nreturn [${this.outs.map((o) => o.name).join(', ')}];`;
    try {
      this.fn = new Function(...this.ins.map((i) => i.name), 'state', 't', 'dt', 'frame', 'log', ...SCRIPT_HELPER_NAMES, '__out', body);
      this.error = '';
    } catch (err) {
      this.fn = null;
      this.error = err.message;
    }
  }

  loadExample(i) {
    const ex = SCRIPT_EXAMPLES[i];
    // Reuse existing ports in order, so wires stay where they are; add or remove the difference.
    while (this.ins.length > ex.ins.length) this.removeInputQuiet(this.ins[this.ins.length - 1]);
    while (this.outs.length > ex.outs.length) this.removeOutputQuiet(this.outs[this.outs.length - 1]);
    ex.ins.forEach(([, def, kind = 'value'], k) => {
      if (k >= this.ins.length) this.addInput(`tmp${k}`, def, kind);
      const inp = this.ins[k];
      inp.def = def;
      inp.defEl.value = def;
      if (inp.kind !== kind) this.toggleKindQuiet(inp, inp.row.querySelector('button'), kind);
    });
    ex.outs.forEach((name, k) => { if (k >= this.outs.length) this.addOutput(`tmp${k}`); });
    // names are assigned afterwards, once the port list has its final size, so a rename never collides with a leftover name
    ex.ins.forEach(([name], k) => { this.ins[k].name = name; this.ins[k].row.querySelector('input').value = name; });
    ex.outs.forEach((name, k) => { this.outs[k].name = name; this.outs[k].row.querySelector('input').value = name; });
    this.state = {};
    this.afterPortChange();
    this.setCode(ex.code);
  }

  removeInputQuiet(inp) {
    this.detach(inp.id, false);
    inp.node.disconnect();
    if (inp.an) inp.an.disconnect();
    this.ins.splice(this.ins.indexOf(inp), 1);
    inp.row.remove();
  }

  removeOutputQuiet(out) {
    this.detach(out.id, true);
    out.node.stop();
    out.node.disconnect();
    this.outs.splice(this.outs.indexOf(out), 1);
    out.row.remove();
  }

  toggleKindQuiet(inp, btn, kind) {
    inp.kind = kind;
    btn.textContent = kind === 'wave' ? 'WAVE' : 'VALUE';
    inp.defEl.disabled = kind === 'wave';
    this.detach(inp.id, false);
    if (kind === 'wave' && !inp.an) {
      inp.an = this.app.ctx.createAnalyser();
      inp.an.fftSize = 1024;
      inp.node.connect(inp.an);
      inp.an.connect(this.app.sink);
      inp.buf = new Float32Array(1024);
    }
  }

  /* ---------- running ---------- */

  startTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.run(), 1000 / this.rate);
  }

  setRate(r) {
    this.rate = clamp(Math.round(r), 1, 240);
    this.startTimer();
  }

  setPaused(on) {
    this.paused = on;
    this.pauseBtn.textContent = on ? 'RUN' : 'PAUSE';
    this.pauseBtn.classList.toggle('active', on);
  }

  readInput(inp) {
    if (inp.kind === 'wave') {
      if (!inp.an) return 0;
      inp.an.getFloatTimeDomainData(inp.buf);
      let pk = 0;
      for (let i = 0; i < inp.buf.length; i++) { const a = Math.abs(inp.buf[i]); if (a > pk) pk = a; }
      return pk;
    }
    const wired = this.app.valueFor(this, inp.id);
    return typeof wired === 'number' && Number.isFinite(wired) ? wired : inp.def;
  }

  run() {
    const now = performance.now();
    const dt = Math.min(1, (now - this.last) / 1000);
    this.last = now;
    if (this.paused || !this.fn) return;
    this.frame++;
    try {
      const res = this.fn(
        ...this.ins.map((i) => this.readInput(i)), this.state, (now - this.t0) / 1000, dt, this.frame, this.log,
        ...SCRIPT_HELPER_NAMES.map((n) => SCRIPT_HELPERS[n]), this.outs.map((o) => o.value));
      this.error = '';
      const at = this.app.ctx.currentTime;
      this.outs.forEach((o, k) => {
        const v = Number(res[k]);
        if (!Number.isFinite(v)) { this.error = `"${o.name}" IS NOT A NUMBER (${String(res[k])})`; return; }
        if (v !== o.value) {
          o.value = v;
          o.node.offset.setTargetAtTime(v, at, 0.004);
        }
      });
    } catch (err) {
      this.error = `${err.name}: ${err.message}`;
    }
  }

  getValue(portId) {
    const o = this.outs.find((out) => out.id === portId);
    return o ? o.value : undefined;
  }

  audioIn(portId) { return this.ins.find((i) => i.id === portId).node; }
  audioOut(portId) { return this.outs.find((o) => o.id === portId).node; }

  /* ---------- state ---------- */

  getState() {
    return {
      ins: this.ins.map((i) => ({ id: i.id, name: i.name, kind: i.kind, def: i.def })),
      outs: this.outs.map((o) => ({ id: o.id, name: o.name })),
      code: this.code, rate: this.rate, paused: this.paused,
    };
  }

  setState(s) {
    for (const i of [...this.ins]) this.removeInputQuiet(i);
    for (const o of [...this.outs]) this.removeOutputQuiet(o);
    (s.ins || []).forEach((i) => {
      const inp = this.addInput(i.name, i.def, 'value', i.id);
      if (i.kind === 'wave') this.toggleKindQuiet(inp, inp.row.querySelector('button'), 'wave');
    });
    (s.outs || []).forEach((o) => this.addOutput(o.name, o.id));
    this.rateSlider.set(s.rate || 30, true);
    this.setRate(s.rate || 30);
    this.setPaused(!!s.paused);
    this.state = {};
    this.afterPortChange();
    this.setCode(s.code ?? SCRIPT_DEFAULT);
  }

  /* ---------- display ---------- */

  draw() {
    let text;
    let cls = '';
    if (this.flashText && performance.now() < this.flashUntil) { text = this.flashText; cls = 'error'; }
    else if (this.error) { text = this.error; cls = 'error'; }
    else if (this.paused) text = 'PAUSED';
    else text = this.logText ? `LOG: ${this.logText}` : `RUNNING AT ${this.rate} HZ`;
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.classList.toggle('error', cls === 'error');
  }

  destroy() {
    clearInterval(this.timer);
    for (const i of this.ins) { i.node.disconnect(); if (i.an) i.an.disconnect(); }
    for (const o of this.outs) { o.node.stop(); o.node.disconnect(); }
  }
}

Object.assign(BLOCK_TYPES, { script: ScriptBlock });
