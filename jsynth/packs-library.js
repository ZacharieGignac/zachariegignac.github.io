'use strict';

/* Premade packs. Each one is described declaratively (blocks, settings, wires, inputs, outputs)
   and built into a real pack by App.buildPack, so everything stays editable once it is added. */

const S = (b, vals) => {
  for (const [k, v] of Object.entries(vals)) {
    const m = b.modifiers[k];
    m.slider.set(v, true);
    m.param.cancelScheduledValues(0);
    m.param.value = m.slider.get(); // applied immediately, so a new pack never starts with a ramp
  }
};
const ENV = (b, [a, d, s, r, min = 0, max = 1]) => {
  b.attack.set(a, true);
  b.decay.set(d, true);
  b.sustain.set(s, true);
  b.release.set(r, true);
  b.range.set(min, max);
};
const delaySpec = (d) => ['delay', (b) => S(b, { time: d.time, fb: d.fb, wet: d.wet, damp: d.damp ?? 6000 })];

/* Builds the spec of a typical synth voice or sound effect:
   oscillators -> (mixer) -> distortion -> filter -> (pre-delay) -> amp envelope -> (delay) -> (chorus).
   voice: true gives PITCH + GATE inputs (play it with a KEYBOARD); otherwise a TRIGGER input. */
function chain(o) {
  const blocks = {};
  const wires = [];
  const gateTo = [];
  const pitchTo = [];
  const oscs = o.oscs || [];
  const lfo = (type, rate, min, max) => ['lfo', (b) => { b.setType(type); S(b, { rate }); b.range.set(min, max); }];

  if (o.seq) blocks.seq = ['seq', (b) => b.configure(o.seq)];
  if (o.pitchEnv) { blocks.pe = ['adsr', (b) => ENV(b, o.pitchEnv)]; gateTo.push('pe.gate'); }
  if (o.pitchLfo) blocks.pl = lfo(o.pitchLfo.type, o.pitchLfo.rate, o.pitchLfo.min, o.pitchLfo.max);
  if (o.pwm) blocks.pwm = lfo(0, o.pwm[0], o.pwm[1], o.pwm[2]);

  oscs.forEach((s, i) => {
    const id = `o${i}`;
    const det = s.detune ?? 0;
    blocks[id] = ['osc', (b) => {
      b.setType(s.type ?? 1);
      S(b, { amp: s.amp ?? (oscs.length > 1 ? 0.8 : 0.5), detune: det, pw: s.pw ?? 0.5, ...(s.freq ? { freq: s.freq } : {}) });
    }];
    if (o.seq) wires.push(['seq.pitch', `${id}.freq`]);
    else if (o.pitchEnv) wires.push(['pe.out', `${id}.freq`]);
    else if (o.pitchLfo) wires.push(['pl.out', `${id}.freq`]);
    else if (o.voice) pitchTo.push(`${id}.freq`);
    if (o.vib) {
      blocks[`v${i}`] = lfo(0, o.vib[0], det - o.vib[1], det + o.vib[1]);
      wires.push([`v${i}.out`, `${id}.detune`]);
    }
    if (o.pwm) wires.push(['pwm.out', `${id}.pw`]);
  });

  let src;
  if (oscs.length > 1) {
    blocks.mix = ['mix'];
    oscs.forEach((_, i) => wires.push([`o${i}.out`, `mix.in${i + 1}`]));
    src = 'mix.out';
  } else {
    src = 'o0.out';
  }

  if (o.fm) {
    const fm = o.fm;
    blocks.m = ['osc', (b) => { b.setType(0); S(b, { amp: 1, detune: fm.ratio ?? 0 }); }];
    blocks.mg = ['gain', (b) => S(b, { gain: 0 })];
    blocks.ie = ['adsr', (b) => ENV(b, fm.env)];
    blocks.w = ['w2v', (b) => { b.setMode(0); b.setRange(-fm.index, fm.index); }];
    wires.push(['m.out', 'mg.in'], ['ie.out', 'mg.gain'], ['mg.out', 'w.in'], ['w.out', 'o0.detune']);
    pitchTo.push('m.freq');
    gateTo.push('ie.gate');
  }

  const stage = (id, spec) => {
    blocks[id] = spec;
    wires.push([src, `${id}.in`]);
    src = `${id}.out`;
  };
  if (o.dist) {
    const d = o.dist;
    stage('dist', ['dist', (b) => {
      b.setMode(d.mode ?? 1);
      S(b, { drive: d.drive ?? 4, bias: d.bias ?? 0, mix: d.mix ?? 1, bits: d.bits ?? 16, rate: d.rate ?? 1, tone: d.tone ?? 20000, level: d.level ?? 0.9 });
    }]);
  }
  if (o.filter) {
    const f = o.filter;
    stage('filt', ['filter', (b) => { b.setType(f.type ?? 0); S(b, { cutoff: f.cutoff ?? 2000, q: f.q ?? 1 }); }]);
    if (f.env) {
      blocks.fenv = ['adsr', (b) => ENV(b, f.env)];
      wires.push(['fenv.out', 'filt.cutoff']);
      gateTo.push('fenv.gate');
    }
    if (f.lfo) {
      blocks.flfo = lfo(0, f.lfo[0], f.lfo[1], f.lfo[2]);
      wires.push(['flfo.out', 'filt.cutoff']);
    }
  }
  if (o.preDelay) stage('pdly', delaySpec(o.preDelay));
  if (o.amp) {
    blocks.amp = ['adsr', (b) => ENV(b, o.amp)];
    stage('vca', ['gain', (b) => S(b, { gain: 0 })]);
    wires.push(['amp.out', 'vca.gain']);
    if (o.seqGate) wires.push(['seq.gate', 'amp.gate']); else gateTo.push('amp.gate');
  }
  if (o.delay) stage('dly', delaySpec(o.delay));
  if (o.chorus) {
    stage('chor', ['delay', (b) => S(b, { time: 0.018, fb: 0, wet: 0.5, damp: 12000 })]);
    blocks.clfo = lfo(0, 0.6, 0.012, 0.026);
    wires.push(['clfo.out', 'chor.time']);
  }

  const inputs = [];
  if (o.voice) {
    inputs.push({ name: 'PITCH', kind: 'value', to: pitchTo }, { name: 'GATE', kind: 'value', to: gateTo });
  } else if (!o.noInputs) {
    const to = [...gateTo];
    if (o.seq) to.push('seq.trig');
    if (to.length) inputs.push({ name: 'TRIGGER', kind: 'value', to });
  }
  return {
    cat: o.cat, name: o.name, desc: o.desc, blocks, wires, inputs,
    play: o.voice ? 'keys' : (inputs.length ? 'trigger' : 'none'),
    outputs: [{ name: 'WAVE', kind: 'wave', from: src }],
  };
}

const C8 = 'GAME SOUND EFFECTS - 8-BIT';
const CCHIP = 'CHIP INSTRUMENTS AND DRUMS - 8-BIT';
const C16 = 'GAME SOUNDS - 16-BIT';
const C70 = 'SYNTHS AND DRUMS - 70s';
const C80 = 'SYNTHS AND DRUMS - 80s';
const C90 = 'SYNTHS AND DRUMS - 90s';

const PACK_LIBRARY = [
  /* ---- 8-bit game sound effects (trigger them with the TRIGGER block or SPACE) ---- */
  chain({
    cat: C8, name: 'COIN', desc: 'Mario-style coin: a short note then a long higher one',
    seq: { scale: 'CHROMATIC', root: 83, pattern: [0, 5, 5, 5, 5, 5], bpm: 260, gate: 0.9, mode: 1 },
    oscs: [{ type: 2, pw: 0.5 }], amp: [1, 380, 0, 60],
  }),
  chain({
    cat: C8, name: 'JUMP', desc: 'Mario-style jump: pitch swoops upward',
    oscs: [{ type: 2, pw: 0.5 }], pitchEnv: [150, 60, 0.7, 140, 170, 950], amp: [1, 260, 0.4, 120],
  }),
  chain({
    cat: C8, name: 'POWER-UP', desc: 'Mario-style mushroom: fast rising arpeggio',
    seq: { scale: 'MAJOR', root: 60, pattern: [0, 2, 4, 7, 9, 11, 13, 14], bpm: 520, gate: 0.9, mode: 1 }, seqGate: true,
    oscs: [{ type: 2, pw: 0.25 }], amp: [1, 40, 0.8, 25],
  }),
  chain({
    cat: C8, name: '1-UP', desc: 'Mario-style extra life: six bright notes',
    seq: { scale: 'MAJOR', root: 72, pattern: [2, 4, 9, 7, 8, 11], bpm: 190, gate: 0.85, mode: 1 }, seqGate: true,
    oscs: [{ type: 2, pw: 0.5 }], amp: [1, 60, 0.6, 30],
  }),
  chain({
    cat: C8, name: 'SECRET JINGLE', desc: 'Zelda-style "you found it" eight-note jingle',
    seq: { scale: 'CHROMATIC', root: 56, pattern: [11, 10, 7, 1, 0, 8, 12, 16], bpm: 160, gate: 0.8, mode: 1 }, seqGate: true,
    oscs: [{ type: 2, pw: 0.25 }], amp: [1, 90, 0.6, 40],
  }),
  chain({
    cat: C8, name: 'HURT', desc: 'Zelda-style damage: noisy downward zap',
    oscs: [{ type: 2, amp: 0.4 }, { type: 5, amp: 0.35 }], pitchEnv: [1, 140, 0, 10, 90, 800],
    dist: { mode: 1, drive: 2, bits: 6, rate: 2 }, amp: [1, 220, 0, 20],
  }),
  chain({
    cat: C8, name: 'LASER ZAP', desc: 'Space-shooter laser: high to low sweep',
    oscs: [{ type: 2, pw: 0.25 }], pitchEnv: [1, 230, 0, 10, 150, 2600], amp: [1, 260, 0, 15],
  }),
  chain({
    cat: C8, name: 'BUSTER SHOT', desc: 'Mega Man-style blaster: short, narrow pulse',
    oscs: [{ type: 2, pw: 0.125 }], pitchEnv: [1, 110, 0, 10, 300, 1600], dist: { mode: 1, drive: 1, bits: 6 }, amp: [1, 130, 0, 10],
  }),
  chain({
    cat: C8, name: 'EXPLOSION', desc: 'NES-style blast: noise through a falling filter',
    oscs: [{ type: 5, amp: 0.8 }], filter: { cutoff: 300, q: 1, env: [1, 800, 0, 250, 150, 5000] },
    dist: { mode: 1, drive: 2, bits: 6, rate: 3, level: 0.8 }, amp: [2, 1000, 0, 300],
  }),
  chain({
    cat: C8, name: 'MENU BLIP', desc: 'Cursor move beep',
    oscs: [{ type: 2, pw: 0.5, freq: 1320, amp: 0.6 }], amp: [1, 70, 0, 10],
  }),
  chain({
    cat: C8, name: 'MENU CONFIRM', desc: 'Two-tone "select" chime',
    seq: { scale: 'CHROMATIC', root: 79, pattern: [0, 5], bpm: 420, gate: 0.9, mode: 1 }, seqGate: true,
    oscs: [{ type: 2, pw: 0.5 }], amp: [1, 60, 0.5, 20],
  }),
  chain({
    cat: C8, name: 'GAME OVER', desc: 'Long wobbling dive in pitch',
    oscs: [{ type: 2, pw: 0.5 }], pitchEnv: [1, 1500, 0, 150, 55, 330], vib: [6, 25],
    dist: { mode: 1, drive: 1, bits: 8 }, amp: [30, 1500, 0, 350],
  }),
  chain({
    cat: C8, name: 'WAKA WAKA', desc: 'Pac-Man-style munch: hold the trigger',
    oscs: [{ type: 3, amp: 0.7 }], pitchLfo: { type: 2, rate: 7, min: 200, max: 420 }, amp: [5, 1, 1, 40],
  }),
  chain({
    cat: C8, name: 'INVADER MARCH', desc: 'Space Invaders-style four-note march (always playing)',
    seq: { scale: 'CHROMATIC', root: 28, pattern: [5, 3, 1, 0], bpm: 150, gate: 0.5, mode: 0 }, seqGate: true, noInputs: true,
    oscs: [{ type: 2, pw: 0.5 }], dist: { mode: 1, drive: 1, bits: 6 }, amp: [1, 90, 0.5, 40],
  }),
  chain({
    cat: C8, name: 'ARCADE SIREN', desc: 'Wailing alarm (always playing)',
    oscs: [{ type: 2, pw: 0.5, amp: 0.5 }], pitchLfo: { type: 3, rate: 0.7, min: 450, max: 1000 }, noInputs: true,
  }),

  /* ---- 8-bit instruments and drums ---- */
  chain({
    cat: CCHIP, name: 'NES PULSE LEAD', desc: 'Narrow pulse lead with vibrato', voice: true,
    oscs: [{ type: 2, pw: 0.25 }], vib: [5.5, 15], dist: { mode: 1, drive: 1, bits: 7 }, amp: [1, 100, 0.75, 50],
  }),
  chain({
    cat: CCHIP, name: 'NES TRIANGLE BASS', desc: 'Stair-stepped 4-bit triangle bass', voice: true,
    oscs: [{ type: 3, amp: 0.8 }], dist: { mode: 1, drive: 1, bits: 4 }, amp: [1, 30, 1, 25],
  }),
  chain({
    cat: CCHIP, name: 'GAME BOY WAVE', desc: 'Gritty low-resolution wave channel', voice: true,
    oscs: [{ type: 1, amp: 0.45 }], dist: { mode: 1, drive: 1, bits: 4, rate: 2, tone: 9000 }, amp: [1, 180, 0.55, 80],
  }),
  chain({
    cat: CCHIP, name: 'C64 PULSE LEAD', desc: 'SID-style pulse width modulation with a filter', voice: true,
    oscs: [{ type: 2, pw: 0.5 }, { type: 1, detune: 7 }], pwm: [0.7, 0.15, 0.85],
    filter: { cutoff: 3500, q: 3 }, amp: [4, 200, 0.7, 120],
  }),
  chain({
    cat: CCHIP, name: 'CHIP KICK', desc: 'Triangle kick with a quick pitch drop',
    oscs: [{ type: 3, amp: 0.8 }], pitchEnv: [1, 120, 0, 10, 40, 240], dist: { mode: 1, drive: 1, bits: 6 }, amp: [1, 200, 0, 20],
  }),
  chain({
    cat: CCHIP, name: 'CHIP SNARE', desc: 'Noise plus a short triangle thump',
    oscs: [{ type: 5, amp: 0.6 }, { type: 3, amp: 0.5 }], pitchEnv: [1, 80, 0, 10, 120, 220],
    filter: { type: 1, cutoff: 1500, q: 1 }, dist: { mode: 1, drive: 1, bits: 5, rate: 2 }, amp: [1, 150, 0, 20],
  }),
  chain({
    cat: CCHIP, name: 'CHIP HI-HAT', desc: 'Crunchy filtered noise tick',
    oscs: [{ type: 5, amp: 0.6 }], filter: { type: 1, cutoff: 7000, q: 1 }, dist: { mode: 1, drive: 1, bits: 3, rate: 4 }, amp: [1, 45, 0, 10],
  }),

  /* ---- 16-bit game sounds ---- */
  chain({
    cat: C16, name: 'RING', desc: 'Sonic-style ring: two shimmering notes with echo',
    seq: { scale: 'CHROMATIC', root: 76, pattern: [12, 19], bpm: 300, gate: 0.95, mode: 1 },
    oscs: [{ type: 0, amp: 0.5 }], delay: { time: 0.09, fb: 0.3, wet: 0.3 }, amp: [1, 700, 0, 200],
  }),
  chain({
    cat: C16, name: 'FM BASS', desc: 'Genesis-style punchy FM bass', voice: true,
    oscs: [{ type: 0, amp: 0.7 }], fm: { ratio: 0, index: 700, env: [1, 300, 0.2, 100] },
    dist: { mode: 0, drive: 1.5, level: 0.9 }, amp: [1, 250, 0.85, 90],
  }),
  chain({
    cat: C16, name: 'FM BELL', desc: 'JRPG-style bell with a long echo', voice: true,
    oscs: [{ type: 0, amp: 0.55 }], fm: { ratio: 2400, index: 500, env: [1, 1500, 0, 600] },
    delay: { time: 0.28, fb: 0.35, wet: 0.3 }, amp: [1, 2000, 0, 800],
  }),
  chain({
    cat: C16, name: 'SNES STRINGS', desc: 'Warm, slightly crunchy string section', voice: true,
    oscs: [{ type: 1, detune: -9 }, { type: 1 }, { type: 1, detune: 9 }], filter: { cutoff: 3500, q: 1 },
    dist: { mode: 0, drive: 1, bits: 12, tone: 6000 }, chorus: true, amp: [350, 300, 0.9, 700],
  }),
  chain({
    cat: C16, name: 'ORCHESTRA HIT', desc: 'Big stacked chord stab',
    oscs: [{ type: 1, freq: 131, amp: 0.7 }, { type: 2, pw: 0.4, freq: 196, amp: 0.6 }, { type: 1, freq: 262, detune: 7, amp: 0.6 }],
    filter: { cutoff: 600, q: 1, env: [1, 400, 0.2, 200, 600, 4500] }, dist: { mode: 0, drive: 2, bits: 10, level: 0.8 }, amp: [1, 380, 0.1, 250],
  }),

  /* ---- 70s ---- */
  chain({
    cat: C70, name: 'MINIMOOG BASS', desc: 'Fat three-oscillator bass with a filter pluck', voice: true,
    oscs: [{ type: 1 }, { type: 2, pw: 0.5, detune: -1205 }, { type: 1, detune: 7 }],
    filter: { cutoff: 300, q: 6, env: [2, 300, 0.2, 150, 150, 2800] }, amp: [2, 250, 0.85, 120],
  }),
  chain({
    cat: C70, name: 'STRING ENSEMBLE', desc: 'Lush chorused string machine', voice: true,
    oscs: [{ type: 1, detune: -9 }, { type: 1 }, { type: 1, detune: 9 }], filter: { cutoff: 4500, q: 0.8 }, chorus: true, amp: [400, 300, 0.9, 800],
  }),
  chain({
    cat: C70, name: 'WAH CLAV', desc: 'Funky clavinet with a quick wah', voice: true,
    oscs: [{ type: 2, pw: 0.3, amp: 1 }], filter: { type: 2, cutoff: 1000, q: 5, env: [1, 150, 0, 60, 400, 3500] }, amp: [1, 220, 0, 60],
  }),
  chain({
    cat: C70, name: 'SCI-FI BLEEPS', desc: 'Random computer chatter (always playing)',
    oscs: [{ type: 2, pw: 0.5, amp: 0.35 }], pitchLfo: { type: 4, rate: 7, min: 150, max: 1800 },
    delay: { time: 0.18, fb: 0.35, wet: 0.3, damp: 5000 }, noInputs: true,
  }),
  chain({
    cat: C70, name: 'DISCO SYN DRUM', desc: 'Pew-pew electronic tom',
    oscs: [{ type: 3, amp: 0.7 }], pitchEnv: [1, 260, 0, 20, 60, 420], amp: [1, 320, 0, 40],
  }),
  chain({
    cat: C70, name: 'FILTER SWEEP', desc: 'Resonant noise sweep (modular style)',
    oscs: [{ type: 5, amp: 1.6 }], filter: { type: 2, cutoff: 400, q: 10, env: [1, 700, 0, 100, 200, 4000] }, amp: [3, 800, 0, 150],
  }),

  /* ---- 80s ---- */
  chain({
    cat: C80, name: 'BRASS STAB', desc: 'Jupiter-style swelling brass', voice: true,
    oscs: [{ type: 1, detune: -8 }, { type: 1, detune: 8 }], filter: { cutoff: 500, q: 1.5, env: [90, 300, 0.6, 150, 500, 5200] }, amp: [40, 200, 0.85, 120],
  }),
  chain({
    cat: C80, name: 'DX E-PIANO', desc: 'Glassy FM electric piano', voice: true,
    oscs: [{ type: 0, amp: 0.6 }], fm: { ratio: 0, index: 300, env: [1, 800, 0.05, 250] }, chorus: true, amp: [1, 1400, 0.1, 350],
  }),
  chain({
    cat: C80, name: 'SYNTHWAVE LEAD', desc: 'Detuned saws with a dotted echo', voice: true,
    oscs: [{ type: 1, detune: -10 }, { type: 1, detune: 10 }, { type: 2, pw: 0.5, detune: -1200, amp: 0.5 }],
    filter: { cutoff: 3500, q: 2 }, dist: { mode: 0, drive: 2, level: 0.85 }, delay: { time: 0.375, fb: 0.4, wet: 0.35 }, amp: [8, 200, 0.8, 300],
  }),
  chain({
    cat: C80, name: 'ANALOG POLY PAD', desc: 'Slow, breathing pad', voice: true,
    oscs: [{ type: 1, detune: -7 }, { type: 1, detune: 7 }], filter: { cutoff: 1800, q: 1, lfo: [0.2, 900, 2600] }, chorus: true, amp: [500, 400, 0.85, 1000],
  }),
  chain({
    cat: C80, name: '808 KICK', desc: 'Deep, booming kick drum',
    oscs: [{ type: 0, amp: 0.8 }], pitchEnv: [1, 320, 0, 20, 42, 190], dist: { mode: 0, drive: 2, level: 0.9 }, amp: [1, 700, 0, 60],
  }),
  chain({
    cat: C80, name: 'GATED SNARE', desc: 'Big snare with a reverb that stops abruptly',
    oscs: [{ type: 5, amp: 0.55 }, { type: 3, amp: 0.5 }], pitchEnv: [1, 100, 0, 10, 120, 260],
    filter: { cutoff: 6500, q: 1 }, preDelay: { time: 0.05, fb: 0.5, wet: 0.6, damp: 5000 }, amp: [1, 180, 0.6, 25],
  }),
  chain({
    cat: C80, name: 'SIMMONS TOM', desc: 'Electronic tom with a noisy click',
    oscs: [{ type: 3, amp: 1 }, { type: 5, amp: 0.15 }], pitchEnv: [1, 380, 0, 30, 70, 280], filter: { cutoff: 3500, q: 1 }, amp: [1, 420, 0, 50],
  }),

  /* ---- 90s ---- */
  chain({
    cat: C90, name: 'ACID 303', desc: 'Squelchy resonant bassline (try the keyboard GLIDE)', voice: true,
    oscs: [{ type: 1, amp: 0.4 }], dist: { mode: 0, drive: 2, level: 0.8 },
    filter: { cutoff: 300, q: 14, env: [1, 220, 0, 60, 150, 3800] }, amp: [1, 1, 1, 40],
  }),
  chain({
    cat: C90, name: 'SUPERSAW LEAD', desc: 'Trance lead: wide detuned saws with echo', voice: true,
    oscs: [{ type: 1, detune: -14 }, { type: 1 }, { type: 1, detune: 14 }], filter: { cutoff: 6500, q: 1 },
    delay: { time: 0.375, fb: 0.4, wet: 0.3 }, amp: [5, 300, 0.9, 250],
  }),
  chain({
    cat: C90, name: 'TRANCE PLUCK', desc: 'Short bright pluck with echo', voice: true,
    oscs: [{ type: 1 }, { type: 2, pw: 0.5, detune: 8 }], filter: { cutoff: 500, q: 4, env: [1, 220, 0, 50, 500, 6000] },
    delay: { time: 0.375, fb: 0.35, wet: 0.3 }, amp: [1, 300, 0, 100],
  }),
  chain({
    cat: C90, name: 'RAVE HOOVER', desc: 'Growling detuned saw wall', voice: true,
    oscs: [{ type: 1, detune: -60 }, { type: 1 }, { type: 1, detune: 45 }], dist: { mode: 2, drive: 5, level: 0.7 },
    filter: { cutoff: 2800, q: 2, lfo: [0.25, 1800, 3600] }, amp: [1, 1, 1, 200],
  }),
  chain({
    cat: C90, name: 'REESE BASS', desc: 'Drum & bass growl: two saws beating plus a sub', voice: true,
    oscs: [{ type: 1, detune: -18 }, { type: 1, detune: 18 }, { type: 0, detune: -1200 }], dist: { mode: 0, drive: 4, level: 0.8 },
    filter: { cutoff: 700, q: 2 }, amp: [3, 1, 1, 150],
  }),
  chain({
    cat: C90, name: 'ORBITAL PAD', desc: 'Huge evolving pad with long echoes', voice: true,
    oscs: [{ type: 1, detune: -12 }, { type: 1 }, { type: 1, detune: 12 }], filter: { cutoff: 2500, q: 1.5, lfo: [0.15, 800, 3200] },
    delay: { time: 0.5, fb: 0.55, wet: 0.4 }, amp: [700, 400, 0.9, 1500],
  }),
  chain({
    cat: C90, name: 'HOUSE ORGAN', desc: 'Drawbar organ with chorus', voice: true,
    oscs: [{ type: 0, amp: 0.7 }, { type: 0, detune: 1200, amp: 0.6 }, { type: 0, detune: 1902, amp: 0.5 }], chorus: true, amp: [2, 1, 1, 40],
  }),
  chain({
    cat: C90, name: '909 HI-HAT', desc: 'Crisp closed hi-hat',
    oscs: [{ type: 5, amp: 0.6 }], filter: { type: 1, cutoff: 7500, q: 1 }, amp: [1, 60, 0, 15],
  }),
  chain({
    cat: C90, name: 'RISER', desc: 'Build-up noise sweep: set the trigger to HOLD',
    oscs: [{ type: 5, amp: 0.6 }], filter: { type: 2, cutoff: 300, q: 4, env: [2500, 1, 1, 400, 300, 9000] }, amp: [2000, 1, 1, 300],
  }),
];

/* ---------- building and browsing ---------- */

const BLOCK_HEIGHT = { osc: 560, lfo: 480, adsr: 700, filter: 760, dist: 940, delay: 500, gain: 440, seq: 680, mix: 400, w2v: 580, seqpro: 1000, fx: 820, detector: 1000, script: 900 };

Object.assign(App.prototype, {
  buildPack(spec, x, y, tab = this.activeTab) {
    const pack = this.addBlock('pack', x, y, tab, spec.name);
    const K = pack.packTab;
    const ids = Object.keys(spec.blocks);

    // Columns follow the signal flow: a block sits one column right of the blocks that feed it.
    const preds = Object.fromEntries(ids.map((id) => [id, []]));
    for (const [from, to] of spec.wires) preds[to.split('.')[0]].push(from.split('.')[0]);
    const depth = {};
    const depthOf = (id) => {
      if (!(id in depth)) depth[id] = preds[id].length ? 1 + Math.max(...preds[id].map(depthOf)) : 0;
      return depth[id];
    };
    ids.forEach(depthOf);

    const colY = {};
    const blocks = {};
    for (const id of ids) {
      const [type, setup] = spec.blocks[id];
      const d = depth[id];
      const by = colY[d] ?? 60;
      colY[d] = by + (BLOCK_HEIGHT[type] || 500) + 30;
      blocks[id] = this.addBlock(type, 340 + d * 310, by, K);
      if (setup) setup(blocks[id]);
    }

    const link = (from, to, source, target) => {
      if (!this.connect(source.block, source.port, target.block, target.port)) console.warn(`pack ${spec.name}: cannot wire ${from} -> ${to}`);
    };
    const ref = (s) => { const [id, port] = s.split('.'); return { block: blocks[id], port }; };
    for (const [from, to] of spec.wires) link(from, to, ref(from), ref(to));

    let iy = 60;
    for (const inp of spec.inputs) {
      const inlet = pack.addInlet(inp.kind, inp.name, 40, iy);
      iy += 130;
      for (const t of inp.to) link(inp.name, t, { block: inlet, port: 'out' }, ref(t));
    }
    const outX = 340 + (Math.max(...Object.values(depth)) + 1) * 310;
    let oy = 60;
    for (const out of spec.outputs) {
      const outlet = pack.addOutlet(out.kind, out.name, outX, oy);
      oy += 130;
      link(out.from, out.name, ref(out.from), { block: outlet, port: 'in' });
    }
    return { pack, blocks };
  },

  // Finds an empty rectangle for new blocks, preferring what is currently on screen.
  findFreeSpot(tab, w, h, useView = true) {
    this.measureBlocks(tab);
    const rects = [...this.blocks.values()].filter((b) => b.tab === tab)
      .map((b) => ({ x: b.x - 20, y: b.y - 20, w: (b.w || 264) + 40, h: (b.h || 400) + 40 }));
    const free = (x, y) => !rects.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
    const scan = (x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y += 30) for (let x = x0; x <= x1; x += 30) if (free(x, y)) return { x, y, visible: false };
      return null;
    };
    const view = this.viewRect();
    const inView = useView && tab === this.activeTab
      ? scan(view.x + 20, view.y + 20, view.x + view.w - w, view.y + view.h - h)
      : null;
    if (inView) return { ...inView, visible: true };
    return scan(20, 20, 3000 - w, 4000 - h) || { x: 20, y: Math.max(0, ...rects.map((r) => r.y + r.h)), visible: false };
  },

  // Adds a library pack to the open tab. Only the pack itself is added; nothing existing is touched.
  addLibraryPack(spec) {
    const tab = this.activeTab;
    const spot = this.findFreeSpot(tab, 300, 540);
    const { pack } = this.buildPack(spec, spot.x, spot.y, tab);
    this.clearSelection();
    this.setSelected(pack, true);
    if (!spot.visible) this.scrollToWs(spot.x - 20, spot.y - 20);
    this.renderWires();
    return pack;
  },

  openLibrary() {
    if (this.libraryEl) return;
    const close = () => {
      this.libraryEl.remove();
      this.libraryEl = null;
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const tags = { trigger: 'INPUT: TRIGGER', keys: 'INPUTS: PITCH + GATE', none: 'NO INPUTS - ALWAYS ON' };

    const cats = [...new Set(PACK_LIBRARY.map((s) => s.cat))];
    const sections = cats.map((cat) => h('section', {},
      h('h3', { text: cat }),
      h('div', { class: 'grid' }, PACK_LIBRARY.filter((s) => s.cat === cat).map((spec) => h('button', {
        class: 'item', title: spec.desc,
        onclick: () => { this.addLibraryPack(spec); close(); },
      }, h('b', { text: spec.name }), h('small', { text: spec.desc }), h('span', { class: 'tag', text: tags[spec.play] }))))));

    const overlay = h('div', { class: 'dialog-overlay' },
      h('div', { class: 'library' },
        h('header', {},
          h('h2', { text: `PACK LIBRARY - ${PACK_LIBRARY.length} PREMADE PACKS` }),
          h('span', { class: 'lib-hint', text: 'ADDS ONLY THE PACK. WIRE IT TO A TRIGGER / KEYBOARD AND A SOUND OUT YOURSELF.' }),
          h('button', { text: 'CLOSE', onclick: close })),
        h('div', { class: 'cats' }, sections)));
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    this.libraryEl = overlay;
    window.addEventListener('keydown', onKey, true);
  },
});
