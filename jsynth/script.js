'use strict';

/* SCRIPT: your own JavaScript between inputs and outputs.
   Add as many named inputs and outputs as you like. Inputs arrive as variables, outputs are variables you assign.
   The script runs several times per second (RATE). Everything is plain JavaScript, so Math, conditions, loops and the
   persistent `state` object are all available.
   Ports can also be WAVEs. A wave input reaches the main code as its loudness; a wave output is made by the WAVE CODE,
   which runs for every audio sample on the audio thread: wave inputs are the current sample, wave outputs are assigned
   the sample to play, and value inputs and outputs are available as variables that update at the script's RATE. */

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
  'state', 't', 'dt', 'frame', 'log', 'sr', '__out', ...SCRIPT_HELPER_NAMES,
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'await', 'async', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'Math',
]);

/* The WAVE CODE runs here. It has its own `state`, `t` and `dt` (one sample), and `sr` (sample rate). */
const SCRIPT_WORKLET_SRC = `
const __SCRIPT_HELPERS = { ${Object.entries(SCRIPT_HELPERS).map(([k, f]) => `${k}: ${f.toString()}`).join(', ')} };
class ScriptWaveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.nIn = options.processorOptions.nIn;
    this.run = null;
    this.state = {};
    this.vals = [];
    this.t = 0;
    this.logText = '';
    this.sentLog = '';
    this.blocks = 0;
    this.log = (...args) => { this.logText = args.map((a) => (typeof a === 'number' ? +a.toFixed(4) : typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '); };
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.vals) this.vals = m.vals;
      if (m.reset) { for (const k of Object.keys(this.state)) delete this.state[k]; this.t = 0; this.logText = ''; }
      if (m.compile) this.compile(m.compile);
    };
  }
  compile(c) {
    const names = [...c.valueIns, ...c.valueOuts, ...c.waveIns, ...c.waveOuts];
    const nv = c.valueIns.length + c.valueOuts.length;
    const lines = ['"use strict";', 'let t = 0;'];
    if (names.length) lines.push('let ' + names.map((n) => n + ' = 0').join(', ') + ';');
    lines.push('const __user = () => {', c.code, '};');
    lines.push('return (len, I, O, V, t0) => {', 'for (let __i = 0; __i < len; __i++) {', 't = t0 + __i * dt;');
    for (let k = 0; k < nv; k++) lines.push(names[k] + ' = V[' + k + '] ?? 0;');
    c.waveIns.forEach((n, k) => lines.push(n + ' = I[' + k + '] ? I[' + k + '][__i] : 0;'));
    c.waveOuts.forEach((n) => lines.push(n + ' = 0;'));
    lines.push('__user();');
    c.waveOuts.forEach((n, k) => lines.push('O[' + k + '][__i] = Number.isFinite(' + n + ') ? ' + n + ' : 0;'));
    lines.push('}', '};');
    try {
      this.run = new Function('state', 'log', 'sr', 'dt', ...Object.keys(__SCRIPT_HELPERS), lines.join('\\n'))(
        this.state, this.log, sampleRate, 1 / sampleRate, ...Object.values(__SCRIPT_HELPERS));
      this.port.postMessage({ error: '' });
    } catch (err) {
      this.run = null;
      this.port.postMessage({ error: err.name + ': ' + err.message });
    }
  }
  process(inputs, outputs) {
    const outs = outputs.map((o) => o[0]);
    const len = outs[0].length;
    if (this.run) {
      const I = [];
      for (let k = 0; k < this.nIn; k++) I.push(inputs[k] && inputs[k][0] ? inputs[k][0] : null);
      try {
        this.run(len, I, outs, this.vals, this.t);
      } catch (err) {
        this.run = null;
        for (const o of outs) o.fill(0);
        this.port.postMessage({ error: err.name + ': ' + err.message });
      }
    }
    this.t += len / sampleRate;
    if (++this.blocks % 16 === 0 && this.logText !== this.sentLog) {
      this.sentLog = this.logText;
      this.port.postMessage({ log: this.logText });
    }
    return true;
  }
}
registerProcessor('script-wave-processor', ScriptWaveProcessor);
`;

const SCRIPT_DEFAULT = `// Inputs: a, b (values), inp (wave)    Outputs: x, y (values), out (wave)
// t = seconds, dt = time since the last run, state = memory that lasts
x = a * 2 + b;
y = Math.sin(t * 2) * 0.5 + 0.5;
`;

const SCRIPT_WAVE_DEFAULT = `// Runs for every audio sample. inp is the sample coming in; assign the sample to play to out.
out = inp;
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
  {
    name: 'WAVE: SOFT CLIP', ins: [['inp', 0, 'wave'], ['drive', 3]], outs: [['out', 'wave']],
    code: '// The WAVE CODE below runs for every audio sample.\n',
    wave: '// inp is the current sample of the wave coming in. Assign the sample to play to out.\nout = Math.tanh(inp * drive);\n',
  },
  {
    name: 'WAVE: BIT CRUSHER', ins: [['inp', 0, 'wave'], ['bits', 5]], outs: [['out', 'wave']],
    code: '// The WAVE CODE below runs for every audio sample.\n',
    wave: '// Fewer bits make a coarser, grittier wave.\nconst steps = Math.pow(2, bits - 1);\nout = Math.round(inp * steps) / steps;\n',
  },
  {
    name: 'WAVE: RING MODULATOR', ins: [['inp', 0, 'wave'], ['hz', 200]], outs: [['out', 'wave']],
    code: '// The WAVE CODE below runs for every audio sample.\n',
    wave: '// state keeps its value from one sample to the next. sr is the sample rate.\nstate.p = ((state.p || 0) + hz / sr) % 1;\nout = inp * Math.sin(state.p * 2 * Math.PI);\n',
  },
  {
    name: 'WAVE: MAKE A SAW', ins: [['hz', 110]], outs: [['out', 'wave']],
    code: '// The WAVE CODE below runs for every audio sample.\n',
    wave: '// No wave input needed: the code can generate a wave from nothing.\nstate.p = ((state.p || 0) + hz / sr) % 1;\nout = (state.p * 2 - 1) * 0.5;\n',
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
    this.bindEditor(this.editor, (code) => this.setCode(code));
    this.waveEditor = h('textarea', { class: 'script-code wave', spellcheck: 'false', autocomplete: 'off', wrap: 'off' });
    this.waveEditor.dataset.tipkey = 'waveCode';
    this.bindEditor(this.waveEditor, (code) => this.setWaveCode(code));
    this.waveBox = h('div', { class: 'script-list' }, h('div', { class: 'cap', text: 'WAVE CODE (RUNS FOR EVERY SAMPLE)' }), this.waveEditor);
    this.waveBox.style.display = 'none';
    this.waveCode = '';
    this.wnode = null; // audio-thread processor that runs the wave code, only while there is a wave output
    this.wsig = null;
    this.waveError = '';
    this.waveLog = '';
    this.status = h('div', { class: 'script-status', text: '' });
    this.exampleSelect = h('select', { onchange: () => { if (this.exampleSelect.value !== '') this.loadExample(+this.exampleSelect.value); this.exampleSelect.value = ''; } },
      h('option', { value: '', text: '- EXAMPLES -' }),
      SCRIPT_EXAMPLES.map((e, i) => h('option', { value: i, text: e.name })));
    this.rateSlider = makeSlider({ label: 'RATE', min: 1, max: 240, value: 30, log: true, decimals: 0, onInput: (v) => this.setRate(v) });
    this.pauseBtn = h('button', { text: 'PAUSE', onclick: () => this.setPaused(!this.paused) });
    this.resetBtn = h('button', {
      text: 'RESET MEMORY',
      onclick: () => {
        this.state = {}; this.t0 = performance.now(); this.frame = 0; this.logText = ''; this.waveLog = '';
        if (this.wnode) this.wnode.port.postMessage({ reset: true });
      },
    });

    this.expandBtn = h('button', { text: 'EXPAND EDITOR', onclick: () => this.setExpanded(true) });
    this.codeBox = h('div', { class: 'script-list' }, this.editor, this.waveBox, this.status);
    this.codeSlot = h('div', {}, this.codeBox);

    this.body.append(
      h('div', { class: 'cap', text: 'INPUTS (NAME, DEFAULT WHEN UNWIRED)' }), this.inBox, this.addInBtn,
      h('div', { class: 'cap', text: 'OUTPUTS' }), this.outBox, this.addOutBtn,
      this.exampleSelect, h('div', { class: 'btn-row' }, this.expandBtn), this.codeSlot,
      this.rateSlider.el, h('div', { class: 'btn-row' }, this.pauseBtn, this.resetBtn));

    this.addInput('a', 0);
    this.addInput('b', 0);
    this.addInput('inp', 0, 'wave');
    this.addOutput('x');
    this.addOutput('y');
    this.addOutput('out', null, 'wave');
    this.afterPortChange();
    this.setCode(SCRIPT_DEFAULT);
    this.setWaveCode(SCRIPT_WAVE_DEFAULT);
    this.startTimer();
  }

  // Moves the code editors into a large window over the workspace, and back again.
  setExpanded(on) {
    if (on === !!this.overlay) return;
    if (on) {
      const close = h('button', { text: 'CLOSE (ESC)', onclick: () => this.setExpanded(false) });
      this.overlay = h('div', { class: 'script-overlay' },
        h('div', { class: 'script-overlay-panel' },
          h('div', { class: 'script-overlay-bar' }, h('span', { text: 'SCRIPT EDITOR' }), close),
          this.codeBox));
      this.overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.setExpanded(false); });
      document.body.append(this.overlay);
      this.editor.focus();
    } else {
      this.codeSlot.append(this.codeBox);
      this.overlay.remove();
      this.overlay = null;
    }
  }

  // Applies the text 250 ms after typing stops (or on blur); TAB inserts spaces.
  bindEditor(ta, apply) {
    let pending = null;
    ta.addEventListener('input', () => {
      clearTimeout(pending);
      pending = setTimeout(() => apply(ta.value), 250);
    });
    ta.addEventListener('blur', () => { clearTimeout(pending); apply(ta.value); });
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = ta;
      ta.value = `${value.slice(0, a)}  ${value.slice(b)}`;
      ta.selectionStart = ta.selectionEnd = a + 2;
    });
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
    if (kind === 'wave') this.ensureAnalyser(inp);
    this.ins.push(inp);
    this.renderInputRow(inp);
    return inp;
  }

  ensureAnalyser(inp) {
    if (inp.an) return;
    inp.an = this.app.ctx.createAnalyser();
    inp.an.fftSize = 1024;
    inp.node.connect(inp.an);
    inp.an.connect(this.app.sink);
    inp.buf = new Float32Array(1024);
  }

  makeOutNode(kind) {
    if (kind === 'wave') return this.app.ctx.createGain();
    const node = this.app.ctx.createConstantSource();
    node.offset.value = 0;
    node.start();
    return node;
  }

  addOutput(name, id = null, kind = 'value') {
    const nm = this.uniqueName(name || 'xyzw'[this.outs.length % 4] || 'out');
    const out = { id: id || `o${this.nextId++}`, name: nm, kind, node: this.makeOutNode(kind), value: 0 };
    if (id) this.nextId = Math.max(this.nextId, parseInt(id.slice(1), 10) + 1);
    this.outs.push(out);
    this.renderOutputRow(out);
    return out;
  }

  valueOuts() { return this.outs.filter((o) => o.kind === 'value'); }

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
    const def = h('input', { type: 'number', step: 'any', value: inp.def, disabled: inp.kind === 'wave' });
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
    const kind = h('button', { text: out.kind === 'wave' ? 'WAVE' : 'VALUE', onclick: () => this.toggleOutKind(out, kind) });
    kind.dataset.tipkey = 'outKind';
    const del = h('button', { text: '\u00d7', onclick: () => this.removeOutput(out) });
    del.dataset.tipkey = 'remove';
    out.row = h('div', { class: 'script-row out' }, name, kind, del);
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

  toggleOutKind(out, btn) {
    this.toggleOutKindQuiet(out, btn, out.kind === 'wave' ? 'value' : 'wave');
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
    for (const o of this.outs) this.addPort({ id: o.id, label: o.name, kind: o.kind }, true);
    this.compile();
    this.syncWorklet();
    this.app.refreshPortStates();
    this.app.renderWires();
  }

  /* ---------- code ---------- */

  setCode(code) {
    this.code = code;
    if (this.editor.value !== code) this.editor.value = code;
    this.compile();
  }

  setWaveCode(code) {
    this.waveCode = code;
    if (this.waveEditor.value !== code) this.waveEditor.value = code;
    this.postWaveCode();
  }

  compile() {
    const vouts = this.valueOuts();
    // wave outputs are declared too, so mentioning one in the main code is harmless
    const declared = [...vouts.map((o, k) => `${o.name} = __out[${k}]`), ...this.outs.filter((o) => o.kind === 'wave').map((o) => `${o.name} = 0`)];
    const outDecl = declared.length ? `let ${declared.join(', ')};` : '';
    const body = `"use strict";\n${outDecl}\n(() => {\n${this.code}\n})();\nreturn [${vouts.map((o) => o.name).join(', ')}];`;
    try {
      this.fn = new Function(...this.ins.map((i) => i.name), 'state', 't', 'dt', 'frame', 'log', ...SCRIPT_HELPER_NAMES, '__out', body);
      this.error = '';
    } catch (err) {
      this.fn = null;
      this.error = err.message;
    }
  }

  /* ---------- wave code (runs on the audio thread) ---------- */

  // Creates or rebuilds the audio-thread processor when the set of wave ports changes, then sends it the code.
  syncWorklet() {
    const waveIns = this.ins.filter((i) => i.kind === 'wave');
    const waveOuts = this.outs.filter((o) => o.kind === 'wave');
    this.waveBox.style.display = waveIns.length || waveOuts.length ? '' : 'none';
    const sig = `${waveIns.map((i) => i.id)}|${waveOuts.map((o) => o.id)}`;
    if (sig !== this.wsig) {
      this.teardownWorklet();
      this.wsig = sig;
      if (waveOuts.length) {
        const node = new AudioWorkletNode(this.app.ctx, 'script-wave-processor', {
          numberOfInputs: waveIns.length, numberOfOutputs: waveOuts.length, outputChannelCount: waveOuts.map(() => 1),
          channelCount: 1, channelCountMode: 'explicit', processorOptions: { nIn: waveIns.length },
        });
        node.port.onmessage = (e) => {
          if ('error' in e.data) this.waveError = e.data.error;
          if ('log' in e.data) this.waveLog = e.data.log;
        };
        waveIns.forEach((inp, k) => inp.node.connect(node, 0, k));
        waveOuts.forEach((out, k) => {
          node.connect(out.node, k, 0);
          node.connect(this.app.sink, k, 0); // keeps the processor running while nothing is listening
        });
        this.wnode = node;
      }
    }
    this.postWaveCode();
  }

  teardownWorklet() {
    if (!this.wnode) return;
    for (const i of this.ins) { try { i.node.disconnect(this.wnode); } catch (_) { /* not connected */ } }
    this.wnode.disconnect();
    this.wnode.port.onmessage = null;
    this.wnode = null;
    this.waveError = '';
  }

  postWaveCode() {
    if (!this.wnode) return;
    const names = (list, kind) => list.filter((p) => p.kind === kind).map((p) => p.name);
    this.wnode.port.postMessage({
      compile: {
        code: this.waveCode,
        valueIns: names(this.ins, 'value'), valueOuts: names(this.outs, 'value'),
        waveIns: names(this.ins, 'wave'), waveOuts: names(this.outs, 'wave'),
      },
    });
    this.sendVals();
  }

  // Value inputs, then value outputs, in the order the audio thread expects.
  sendVals(inVals = this.ins.map((i) => this.readInput(i))) {
    if (!this.wnode) return;
    const vals = [];
    this.ins.forEach((i, k) => { if (i.kind === 'value') vals.push(inVals[k]); });
    for (const o of this.outs) if (o.kind === 'value') vals.push(o.value);
    this.wnode.port.postMessage({ vals });
  }

  loadExample(i) {
    const ex = SCRIPT_EXAMPLES[i];
    const outs = ex.outs.map((o) => (Array.isArray(o) ? o : [o, 'value']));
    // Reuse existing ports in order, so wires stay where they are; add or remove the difference.
    while (this.ins.length > ex.ins.length) this.removeInputQuiet(this.ins[this.ins.length - 1]);
    while (this.outs.length > outs.length) this.removeOutputQuiet(this.outs[this.outs.length - 1]);
    ex.ins.forEach(([, def, kind = 'value'], k) => {
      if (k >= this.ins.length) this.addInput(`tmp${k}`, def, kind);
      const inp = this.ins[k];
      inp.def = def;
      inp.defEl.value = def;
      if (inp.kind !== kind) this.toggleKindQuiet(inp, inp.row.querySelector('button'), kind);
    });
    outs.forEach(([, kind], k) => {
      if (k >= this.outs.length) this.addOutput(`tmp${k}`, null, kind);
      else if (this.outs[k].kind !== kind) this.toggleOutKindQuiet(this.outs[k], this.outs[k].row.querySelector('button'), kind);
    });
    // names are assigned afterwards, once the port list has its final size, so a rename never collides with a leftover name
    ex.ins.forEach(([name], k) => { this.ins[k].name = name; this.ins[k].row.querySelector('input').value = name; });
    outs.forEach(([name], k) => { this.outs[k].name = name; this.outs[k].row.querySelector('input').value = name; });
    this.state = {};
    this.afterPortChange();
    this.setCode(ex.code);
    this.setWaveCode(ex.wave || '');
  }

  removeInputQuiet(inp) {
    this.detach(inp.id, false);
    inp.node.disconnect();
    if (inp.an) inp.an.disconnect();
    this.ins.splice(this.ins.indexOf(inp), 1);
    inp.row.remove();
    this.wsig = null;
  }

  removeOutputQuiet(out) {
    this.detach(out.id, true);
    if (out.node.stop) out.node.stop();
    out.node.disconnect();
    this.outs.splice(this.outs.indexOf(out), 1);
    out.row.remove();
    this.wsig = null;
  }

  toggleOutKindQuiet(out, btn, kind) {
    this.detach(out.id, true);
    if (out.node.stop) out.node.stop();
    out.node.disconnect();
    out.kind = kind;
    out.node = this.makeOutNode(kind);
    out.value = 0;
    btn.textContent = kind === 'wave' ? 'WAVE' : 'VALUE';
    this.wsig = null;
  }

  toggleKindQuiet(inp, btn, kind) {
    inp.kind = kind;
    btn.textContent = kind === 'wave' ? 'WAVE' : 'VALUE';
    inp.defEl.disabled = kind === 'wave';
    this.detach(inp.id, false);
    if (kind === 'wave') this.ensureAnalyser(inp);
    this.wsig = null;
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
    if (this.paused) return;
    const inVals = this.ins.map((i) => this.readInput(i));
    if (!this.fn) { this.sendVals(inVals); return; }
    this.frame++;
    const vouts = this.valueOuts();
    try {
      const res = this.fn(
        ...inVals, this.state, (now - this.t0) / 1000, dt, this.frame, this.log,
        ...SCRIPT_HELPER_NAMES.map((n) => SCRIPT_HELPERS[n]), vouts.map((o) => o.value));
      this.error = '';
      const at = this.app.ctx.currentTime;
      vouts.forEach((o, k) => {
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
    this.sendVals(inVals);
  }

  getValue(portId) {
    const o = this.outs.find((out) => out.id === portId);
    return o && o.kind === 'value' ? o.value : undefined;
  }

  audioIn(portId) { return this.ins.find((i) => i.id === portId).node; }
  audioOut(portId) { return this.outs.find((o) => o.id === portId).node; }

  /* ---------- state ---------- */

  getState() {
    return {
      ins: this.ins.map((i) => ({ id: i.id, name: i.name, kind: i.kind, def: i.def })),
      outs: this.outs.map((o) => ({ id: o.id, name: o.name, kind: o.kind })),
      code: this.code, waveCode: this.waveCode, rate: this.rate, paused: this.paused,
    };
  }

  setState(s) {
    for (const i of [...this.ins]) this.removeInputQuiet(i);
    for (const o of [...this.outs]) this.removeOutputQuiet(o);
    (s.ins || []).forEach((i) => this.addInput(i.name, i.def, i.kind === 'wave' ? 'wave' : 'value', i.id));
    (s.outs || []).forEach((o) => this.addOutput(o.name, o.id, o.kind === 'wave' ? 'wave' : 'value'));
    this.rateSlider.set(s.rate || 30, true);
    this.setRate(s.rate || 30);
    this.setPaused(!!s.paused);
    this.state = {};
    this.afterPortChange();
    this.setCode(s.code ?? SCRIPT_DEFAULT);
    this.setWaveCode(s.waveCode || '');
  }

  /* ---------- display ---------- */

  draw() {
    let text;
    let cls = '';
    const logText = this.logText || this.waveLog;
    if (this.flashText && performance.now() < this.flashUntil) { text = this.flashText; cls = 'error'; }
    else if (this.error) { text = this.error; cls = 'error'; }
    else if (this.waveError) { text = `WAVE CODE: ${this.waveError}`; cls = 'error'; }
    else if (this.paused) text = 'PAUSED';
    else text = logText ? `LOG: ${logText}` : `RUNNING AT ${this.rate} HZ`;
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.classList.toggle('error', cls === 'error');
  }

  destroy() {
    clearInterval(this.timer);
    this.setExpanded(false);
    this.teardownWorklet();
    for (const i of this.ins) { i.node.disconnect(); if (i.an) i.an.disconnect(); }
    for (const o of this.outs) { if (o.node.stop) o.node.stop(); o.node.disconnect(); }
  }
}

Object.assign(BLOCK_TYPES, { script: ScriptBlock });
