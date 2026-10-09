'use strict';

/* The example project that loads at startup: "NEON DRIVE", a synthwave track with 8-bit and Game Boy accents.

   It is built from ordinary blocks, so everything can be opened, edited and rewired:
   - a SONG sequencer (SEQUENCER PRO) steps through eight 4-bar sections and triggers the other sequencers
     with its TRIG lanes: T1 drums, T2 bass, T3 lead, T4 chip zap;
   - the arpeggio and the pad loop all the time, so the intro is just those two;
   - the kick fires a ducking envelope that makes the bass, arp and pad pump (sidechain style);
   - every part is a pack, so open one (OPEN, or its tab on the left) to see how it is made. */

const DEMO_BPM = 112;
const DEMO_SECTION = 64; // sixteenth notes in a 4-bar section

// A scale-degree sequence in the 64-step format used by SEQUENCER PRO.
const demoSeq = (o) => {
  const fit = (a, fill) => Array.from({ length: SP_STEPS }, (_, i) => (a && a[i] !== undefined ? a[i] : fill));
  return {
    pat: fit(o.pat, 0), rest: fit(o.rest, false), vel: fit(o.vel, 1), mult: fit(o.mult, 1), trig: fit(o.trig, 0),
    scaleIdx: 1, root: o.root ?? 45, steps: o.steps, bpm: DEMO_BPM, gate: o.gate ?? 60, glide: o.glide ?? 0,
    per: 0, pulse: o.pulse ?? 30, mode: o.mode ?? 0, dir: 0, follow: true, sel: 0, playing: false,
  };
};
const demoLfo = (type, rate, min, max) => (b) => { b.setType(type); S(b, { rate }); b.range.set(min, max); };
const demoOsc = (type, o = {}) => (b) => { b.setType(type); S(b, { amp: o.amp ?? 0.6, detune: o.detune ?? 0, pw: o.pw ?? 0.5, ...(o.freq ? { freq: o.freq } : {}) }); };
const demoFx = (preset, mix, tweaks = {}) => (b) => {
  b.applyPreset(FX_PRESETS.findIndex((p) => p.name === preset));
  b.setParam('mix', mix);
  for (const [id, v] of Object.entries(tweaks)) b.setParam(id, v);
};
const demoDelay = (time, fb, wet, damp) => (b) => S(b, { time, fb, wet, damp });

/* ---------- the parts ---------- */

function demoDrums() {
  const trig = [];
  const vel = [];
  for (let s = 0; s < 64; s++) {
    const bar = s >> 4;
    const p = s & 15;
    let m = 0;
    if (p % 4 === 0 || ((bar === 1 || bar === 3) && p === 10)) m |= 1; // kick
    if (p === 4 || p === 12 || (bar === 3 && (p === 10 || p >= 13))) m |= 2; // snare, with a roll in the last bar
    if (p % 4 === 1 || p % 4 === 3) m |= 4; // closed hat on the 16ths between the beats, leaving air around the kick
    if (p % 4 === 2 && !(bar === 3 && p >= 12)) m |= 8; // open hat on the off-beats
    trig.push(m);
    vel.push(p % 4 === 1 ? 0.45 : p % 4 === 3 ? 0.75 : 0.9);
  }
  return {
    name: 'DRUM MACHINE',
    blocks: {
      seq: ['seqpro', (b) => b.setState(demoSeq({ steps: 64, trig, vel, mode: 1, pulse: 50 }))],
      nz: ['osc', demoOsc(5, { amp: 1 })],
      // kick: a sine that falls in pitch, with its own volume envelope
      kp: ['adsr', (b) => ENV(b, [1, 100, 0, 60, 42, 165])],
      ko: ['osc', demoOsc(0, { amp: 1 })],
      ka: ['adsr', (b) => ENV(b, [1, 400, 0, 190, 0, 1.3])],
      kv: ['gain', (b) => S(b, { gain: 0 })],
      // snare: filtered noise plus a short triangle body
      sf: ['filter', (b) => { b.setType(2); S(b, { cutoff: 2600, q: 1.2 }); }],
      se: ['adsr', (b) => ENV(b, [1, 300, 0, 90, 0, 1.7])],
      sv: ['gain', (b) => S(b, { gain: 0 })],
      so: ['osc', demoOsc(3, { amp: 1, freq: 190 })],
      sb: ['adsr', (b) => ENV(b, [1, 200, 0, 60, 0, 1.1])],
      sbv: ['gain', (b) => S(b, { gain: 0 })],
      // hats: short, high-passed noise ticks; the sequencer's VELOCITY output accents them
      hf: ['filter', (b) => { b.setType(1); S(b, { cutoff: 8200, q: 1 }); }],
      he: ['adsr', (b) => ENV(b, [1, 25, 0, 8, 0, 0.6])],
      hv: ['gain', (b) => S(b, { gain: 0 })],
      hvel: ['gain', (b) => S(b, { gain: 0 })],
      of: ['filter', (b) => { b.setType(1); S(b, { cutoff: 6500, q: 1 }); }],
      oe: ['adsr', (b) => ENV(b, [1, 1000, 0, 90, 0, 0.35])],
      ov: ['gain', (b) => S(b, { gain: 0 })],
      // the sidechain envelope: drops to 30% on every kick and swells back
      duck: ['adsr', (b) => ENV(b, [3, 1000, 0, 320, 1, 0.3])],
      mix: ['mix', (b) => S(b, { level: 2 })],
    },
    wires: [
      ['seq.t1', 'kp.gate'], ['seq.t1', 'ka.gate'], ['seq.t1', 'duck.gate'],
      ['seq.t2', 'se.gate'], ['seq.t2', 'sb.gate'], ['seq.t3', 'he.gate'], ['seq.t4', 'oe.gate'],
      ['kp.out', 'ko.freq'], ['ko.out', 'kv.in'], ['ka.out', 'kv.gain'],
      ['nz.out', 'sf.in'], ['sf.out', 'sv.in'], ['se.out', 'sv.gain'],
      ['so.out', 'sbv.in'], ['sb.out', 'sbv.gain'],
      ['nz.out', 'hf.in'], ['hf.out', 'hv.in'], ['he.out', 'hv.gain'], ['hv.out', 'hvel.in'], ['seq.vel', 'hvel.gain'],
      ['nz.out', 'of.in'], ['of.out', 'ov.in'], ['oe.out', 'ov.gain'],
      ['kv.out', 'mix.in1'], ['sv.out', 'mix.in2'], ['sbv.out', 'mix.in3'], ['hvel.out', 'mix.in4'], ['ov.out', 'mix.in5'],
    ],
    inputs: [{ name: 'TRIGGER', kind: 'value', to: ['seq.trig'] }],
    outputs: [{ name: 'WAVE', kind: 'wave', from: 'mix.out' }, { name: 'DUCK', kind: 'value', from: 'duck.out' }],
  };
}

function demoBass() {
  const roots = [0, 5, 2, 6]; // A, F, C, G (A natural minor degrees)
  const shape = [0, 0, 7, 0, 0, 0, 7, 0]; // octave jumps on the 3rd and 7th eighth
  const accent = [1, 0.6, 0.85, 0.6, 1, 0.6, 0.85, 0.7];
  const pat = []; const vel = []; const mult = [];
  roots.forEach((r) => shape.forEach((o, i) => { pat.push(r + o); vel.push(accent[i]); mult.push(2); }));
  return {
    name: 'NEON BASS',
    blocks: {
      seq: ['seqpro', (b) => b.setState(demoSeq({ steps: 32, pat, vel, mult, root: 33, gate: 55, mode: 1 }))],
      o1: ['osc', demoOsc(1, { amp: 0.6, detune: -6 })],
      o2: ['osc', demoOsc(2, { amp: 0.5, detune: 6 })],
      mix: ['mix'],
      fe: ['adsr', (b) => ENV(b, [2, 170, 0.1, 70, 260, 2400])],
      fl: ['filter', (b) => { b.setType(0); S(b, { cutoff: 900, q: 3 }); }],
      ds: ['dist', (b) => { b.setMode(0); S(b, { drive: 3, mix: 0.6, level: 0.9 }); }],
      ae: ['adsr', (b) => ENV(b, [3, 200, 0.65, 80, 0, 1.3])],
      vca: ['gain', (b) => S(b, { gain: 0 })],
      dk: ['gain', (b) => S(b, { gain: 1 })],
    },
    wires: [
      ['seq.pitch', 'o1.freq'], ['seq.pitch', 'o2.freq'], ['o1.out', 'mix.in1'], ['o2.out', 'mix.in2'],
      ['seq.gate', 'fe.gate'], ['fe.out', 'fl.cutoff'], ['mix.out', 'fl.in'], ['fl.out', 'ds.in'],
      ['seq.gate', 'ae.gate'], ['ds.out', 'vca.in'], ['ae.out', 'vca.gain'], ['vca.out', 'dk.in'],
    ],
    inputs: [
      { name: 'TRIGGER', kind: 'value', to: ['seq.trig'] },
      { name: 'DUCK', kind: 'value', to: ['dk.gain'] },
    ],
    outputs: [{ name: 'WAVE', kind: 'wave', from: 'dk.out' }],
  };
}

function demoArp() {
  const chords = [[0, 2, 4, 7], [0, 2, 5, 7], [2, 4, 6, 9], [1, 3, 6, 8]]; // Am, F, C, G (inversions that stay close)
  const run = [[0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 2, 1], [0, 2, 1, 3, 2, 3, 1, 2, 0, 2, 1, 3, 3, 2, 1, 0]];
  const pat = []; const vel = [];
  chords.forEach((c, bar) => run[bar % 2].forEach((idx, i) => { pat.push(c[idx]); vel.push(i % 4 === 0 ? 1 : 0.65); }));
  return {
    name: 'GAMEBOY ARP',
    blocks: {
      seq: ['seqpro', (b) => b.setState(demoSeq({ steps: 64, pat, vel, root: 57, gate: 42 }))],
      pwm: ['lfo', demoLfo(0, 0.35, 0.12, 0.45)],
      o: ['osc', demoOsc(2, { amp: 0.45, pw: 0.25 })],
      ds: ['dist', (b) => { b.setMode(1); S(b, { drive: 1.5, mix: 1, bits: 6, rate: 1, tone: 4000, level: 0.55 }); }],
      ae: ['adsr', (b) => ENV(b, [1, 140, 0.15, 50, 0, 1])],
      vca: ['gain', (b) => S(b, { gain: 0 })],
      dl: ['delay', demoDelay(0.402, 0.38, 0.32, 7000)],
      dk: ['gain', (b) => S(b, { gain: 1 })],
    },
    wires: [
      ['seq.pitch', 'o.freq'], ['pwm.out', 'o.pw'], ['o.out', 'ds.in'], ['seq.gate', 'ae.gate'],
      ['ds.out', 'vca.in'], ['ae.out', 'vca.gain'], ['vca.out', 'dl.in'], ['dl.out', 'dk.in'],
    ],
    inputs: [{ name: 'DUCK', kind: 'value', to: ['dk.gain'] }],
    outputs: [{ name: 'WAVE', kind: 'wave', from: 'dk.out' }],
  };
}

function demoLead() {
  // [scale degree, length in sixteenths]: four bars over Am, F, C, G
  const tune = [
    [4, 6], [3, 2], [2, 4], [4, 4],
    [5, 6], [4, 2], [2, 4], [0, 4],
    [4, 4], [6, 4], [7, 2], [6, 2], [4, 4],
    [6, 6], [5, 2], [3, 4], [1, 2], [3, 2],
  ];
  return {
    name: 'SUNSET LEAD',
    blocks: {
      seq: ['seqpro', (b) => b.setState(demoSeq({ steps: tune.length, pat: tune.map((n) => n[0]), mult: tune.map((n) => n[1]), root: 69, gate: 92, glide: 30, mode: 1 }))],
      v1: ['lfo', demoLfo(0, 5.2, -18, 2)],
      v2: ['lfo', demoLfo(0, 5.2, -2, 18)],
      o1: ['osc', demoOsc(1, { amp: 0.6, detune: -9 })],
      o2: ['osc', demoOsc(1, { amp: 0.6, detune: 9 })],
      mix: ['mix'],
      fm: ['lfo', demoLfo(0, 0.2, 2400, 4600)],
      fl: ['filter', (b) => { b.setType(0); S(b, { cutoff: 3400, q: 1.5 }); }],
      ae: ['adsr', (b) => ENV(b, [12, 300, 0.75, 260, 0, 1.1])],
      vca: ['gain', (b) => S(b, { gain: 0 })],
      fx: ['fx', demoFx('LUSH ENSEMBLE', 0.5)],
    },
    wires: [
      ['seq.pitch', 'o1.freq'], ['seq.pitch', 'o2.freq'], ['v1.out', 'o1.detune'], ['v2.out', 'o2.detune'],
      ['o1.out', 'mix.in1'], ['o2.out', 'mix.in2'], ['fm.out', 'fl.cutoff'], ['mix.out', 'fl.in'],
      ['seq.gate', 'ae.gate'], ['fl.out', 'vca.in'], ['ae.out', 'vca.gain'],       ['vca.out', 'fx.in'],
    ],
    inputs: [{ name: 'TRIGGER', kind: 'value', to: ['seq.trig'] }],
          outputs: [{ name: 'WAVE', kind: 'wave', from: 'fx.out' }],
  };
}

function demoPad() {
  const pad = (pat) => (b) => b.setState(demoSeq({ steps: 4, pat, mult: [16, 16, 16, 16], root: 45, gate: 96 }));
  return {
    name: 'DREAM PAD',
    blocks: {
      sa: ['seqpro', pad([2, 7, 4, 8])], // the thirds of Am, F, C, G
      sb: ['seqpro', pad([4, 9, 6, 10])], // and their fifths
      a1: ['osc', demoOsc(1, { amp: 0.5, detune: -10 })],
      a2: ['osc', demoOsc(1, { amp: 0.5, detune: 10 })],
      b1: ['osc', demoOsc(1, { amp: 0.5, detune: -10 })],
      b2: ['osc', demoOsc(1, { amp: 0.5, detune: 10 })],
      mix: ['mix'],
      fm: ['lfo', demoLfo(0, 0.12, 900, 2600)],
      fl: ['filter', (b) => { b.setType(0); S(b, { cutoff: 1400, q: 1 }); }],
      ae: ['adsr', (b) => ENV(b, [450, 600, 0.85, 900, 0, 1.5])],
      vca: ['gain', (b) => S(b, { gain: 0 })],
      fx: ['fx', demoFx('SHIMMER VERB', 0.45, { p2: 0.7, p4: 0.3 })], // dark and gentle: more damping, less shimmer
      dk: ['gain', (b) => S(b, { gain: 1 })],
    },
    wires: [
      ['sa.pitch', 'a1.freq'], ['sa.pitch', 'a2.freq'], ['sb.pitch', 'b1.freq'], ['sb.pitch', 'b2.freq'],
      ['a1.out', 'mix.in1'], ['a2.out', 'mix.in2'], ['b1.out', 'mix.in3'], ['b2.out', 'mix.in4'],
      ['fm.out', 'fl.cutoff'], ['mix.out', 'fl.in'], ['sa.gate', 'ae.gate'], ['fl.out', 'vca.in'], ['ae.out', 'vca.gain'],
      ['vca.out', 'fx.in'], ['fx.out', 'dk.in'],
    ],
    inputs: [{ name: 'DUCK', kind: 'value', to: ['dk.gain'] }],
    outputs: [{ name: 'WAVE', kind: 'wave', from: 'dk.out' }],
  };
}

function demoZap() {
  return {
    name: 'CHIP ZAP',
    blocks: {
      pe: ['adsr', (b) => ENV(b, [1, 320, 0, 60, 140, 2600])],
      o: ['osc', demoOsc(2, { amp: 0.6 })],
      ds: ['dist', (b) => { b.setMode(1); S(b, { drive: 1.5, mix: 1, bits: 4, rate: 3, tone: 8000, level: 0.7 }); }],
      ae: ['adsr', (b) => ENV(b, [1, 500, 0, 260, 0, 0.55])],
      vca: ['gain', (b) => S(b, { gain: 0 })],
      dl: ['delay', demoDelay(0.402, 0.35, 0.3, 6000)],
    },
    wires: [['pe.out', 'o.freq'], ['o.out', 'ds.in'], ['ds.out', 'vca.in'], ['ae.out', 'vca.gain'], ['vca.out', 'dl.in']],
    inputs: [{ name: 'TRIGGER', kind: 'value', to: ['pe.gate', 'ae.gate'] }],
    outputs: [{ name: 'WAVE', kind: 'wave', from: 'dl.out' }],
  };
}

/* ---------- the project ---------- */

Object.assign(App.prototype, {
  buildDemo() {
    const port = (pack, label, isOut) => (isOut ? pack.outputs : pack.inputs).find((p) => p.label === label).id;

    // Sections of 4 bars: which parts are triggered at the start of each (T1 drums, T2 bass, T3 lead, T4 chip zap).
    const D = 1; const B = 2; const L = 4; const Z = 8;
    const sections = [0, D, D | B | Z, D | B | L, L, D | B | Z, D | B | L, D | B | L | Z];
    const song = this.addBlock('seqpro', 20, 20);
    song.setState(demoSeq({
      steps: sections.length, trig: sections, mult: sections.map(() => DEMO_SECTION), mode: 0, pulse: 120,
    }));

    const place = (spec, x, y) => this.buildPack(spec, x, y).pack;
    const drums = place(demoDrums(), 370, 20);
    const bass = place(demoBass(), 700, 20);
    const lead = place(demoLead(), 1030, 20);
    const arp = place(demoArp(), 370, 300);
    const pad = place(demoPad(), 700, 300);
    const zap = place(demoZap(), 1030, 300);

    const mix = this.addBlock('mix', 370, 620);
    const boost = this.addBlock('gain', 700, 620);
    const verb = this.addBlock('fx', 1030, 620);
    const out = this.addBlock('out', 1360, 620);
    S(mix, { level: 2 });
    S(boost, { gain: 1.9 }); // the mixer averages its inputs, so this makes the level back up
    verb.applyPreset(FX_PRESETS.findIndex((p) => p.name === 'CONCERT HALL'));
    verb.setParam('mix', 0.2);
    out.setLimiter(true);
    out.modifiers.vol.slider.set(0.85, true);

    const wire = (a, pa, b, pb) => this.connect(a, pa, b, pb);
    wire(song, 't1', drums, port(drums, 'TRIGGER', false));
    wire(song, 't2', bass, port(bass, 'TRIGGER', false));
    wire(song, 't3', lead, port(lead, 'TRIGGER', false));
    wire(song, 't4', zap, port(zap, 'TRIGGER', false));
    for (const p of [bass, arp, pad]) wire(drums, port(drums, 'DUCK', true), p, port(p, 'DUCK', false));

    // The mixer grows an input each time the last one is used.
    const levels = [[drums, 0.9], [bass, 0.7], [arp, 0.8], [lead, 1], [pad, 1], [zap, 1]];
    levels.forEach(([pack, level]) => {
      const id = [...mix.lanes.keys()].find((lane) => !mix.isWired(lane));
      wire(pack, port(pack, 'WAVE', true), mix, id);
      mix.lanes.get(id).level.set(level, true);
    });
    wire(mix, 'out', boost, 'in');
    wire(boost, 'out', verb, 'in');
    wire(verb, 'out', out, 'in');

    // Start every sequencer on the same instant so the parts lock together.
    const seqs = [...this.blocks.values()].filter((b) => b.type === 'seqpro');
    seqs.forEach((s) => s.stop());
    const t0 = this.ctx.currentTime + 0.35;
    seqs.forEach((s) => s.start(t0));

    this.projectName = 'neon-drive';
    setTimeout(() => this.zoomToFit(), 150);
  },
});
