'use strict';

/* EFFECTS block: one wave in, one wave out, fourteen very different effects and a big preset library.
   The DSP lives in fx-dsp.js and runs in an AudioWorklet. Every effect uses four knobs plus MIX, all 0..1 so any
   control value can be wired to them; the knob labels and the readout change to suit the selected effect. */

const FX_WORKLET_SRC = `
const FX_GATE_PATTERNS = ${JSON.stringify(FX_GATE_PATTERNS)};
${FxDsp.toString()}

class FxProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['p1', 'p2', 'p3', 'p4', 'mix'].map((name) => (
      { name, defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }));
  }
  constructor() {
    super();
    this.dsp = new FxDsp(sampleRate);
    this.p = [0.5, 0.5, 0.5, 0.5, 0.5];
    this.port.onmessage = (e) => {
      if (e.data.mode !== undefined) this.dsp.setMode(e.data.mode);
      if (e.data.freeze !== undefined) this.dsp.freeze = e.data.freeze;
    };
  }
  process(inputs, outputs, params) {
    const p = this.p;
    p[0] = params.p1[0]; p[1] = params.p2[0]; p[2] = params.p3[0]; p[3] = params.p4[0]; p[4] = params.mix[0];
    this.dsp.run(inputs[0][0], outputs[0][0], p);
    return true;
  }
}
registerProcessor('fx-processor', FxProcessor);
`;

/* ---------- unit conversions: knob (0..1) <-> real units, matching the DSP ---------- */

const fxHz = (v) => `${v >= 1000 ? (v / 1000).toFixed(2) + ' k' : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)}Hz`;
const fxMs = (v) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;
const fxPct = (t) => `${Math.round(t * 100)} %`;
const fxExp = (min, max, t) => min * Math.pow(max / min, t);
const fxSigned = (v, unit, d = 0) => `${v > 0 ? '+' : ''}${v.toFixed(d)} ${unit}`;

const FX_MODES = [
  {
    name: 'CHORUS', desc: 'Doubles the sound with gently detuned copies.', def: [0.3, 0.4, 0.4, 0.2, 0.5],
    params: [
      { label: 'RATE', tip: 'Speed of the pitch wobble.', fmt: (t) => fxHz(fxExp(0.05, 8, t)) },
      { label: 'DEPTH', tip: 'How far the copies drift in pitch.', fmt: (t) => fxPct(t) },
      { label: 'DELAY', tip: 'Base delay of the copies. Longer sounds wider and more detuned.', fmt: (t) => fxMs(2 + 28 * t) },
      { label: 'DRIFT', tip: 'Random, tape-like wander added to the wobble.', fmt: (t) => fxPct(t) },
    ],
  },
  {
    name: 'FLANGER', desc: 'A swept, jet-like comb filter.', def: [0.25, 0.6, 0.7, 0.3, 0.5],
    params: [
      { label: 'RATE', tip: 'Speed of the sweep.', fmt: (t) => fxHz(fxExp(0.03, 9, t)) },
      { label: 'DEPTH', tip: 'How wide the sweep is.', fmt: (t) => fxPct(t) },
      { label: 'FDBK', tip: 'Feedback. Past the middle it rings brightly; below the middle it sounds hollow and metallic.', fmt: (t) => fxSigned((t * 2 - 1) * 95, '%') },
      { label: 'MANUAL', tip: 'Centre of the sweep. Shorter is higher and more whistling.', fmt: (t) => fxMs(0.25 + 4.75 * t) },
    ],
  },
  {
    name: 'PHASER', desc: 'Swirling notches from a chain of all-pass filters.', def: [0.3, 0.6, 0.4, 0.5, 0.5],
    params: [
      { label: 'RATE', tip: 'Speed of the swirl.', fmt: (t) => fxHz(fxExp(0.03, 9, t)) },
      { label: 'DEPTH', tip: 'How far the notches sweep.', fmt: (t) => fxPct(t) },
      { label: 'FDBK', tip: 'Feedback. Higher makes the notches sharper and more vocal.', fmt: (t) => fxPct(t * 0.92) },
      { label: 'CENTER', tip: 'Middle frequency of the sweep.', fmt: (t) => fxHz(fxExp(150, 3500, t)) },
    ],
  },
  {
    name: 'TREMOLO', desc: 'Pulses the volume, from soft throb to hard chop.', def: [0.45, 0.7, 0.1, 0, 1],
    params: [
      { label: 'RATE', tip: 'Speed of the pulsing.', fmt: (t) => fxHz(fxExp(0.5, 24, t)) },
      { label: 'DEPTH', tip: 'How deep the volume dips.', fmt: (t) => fxPct(t) },
      { label: 'SHAPE', tip: 'Morphs the pulse from a smooth sine to a hard square chop.', fmt: (t) => `${fxPct(t)} SQR` },
      null,
    ],
  },
  {
    name: 'RING MOD', desc: 'Multiplies by a tone: bells, robots and metallic clangs.', def: [0.4, 0, 0.3, 1, 0.6],
    params: [
      { label: 'FREQ', tip: 'Frequency of the carrier tone. Low is a growl; high is a bell.', fmt: (t) => fxHz(fxExp(20, 3000, t)) },
      { label: 'WOBBLE', tip: 'How far an LFO bends the carrier frequency.', fmt: (t) => `\u00b1${(2 * t).toFixed(1)} oct` },
      { label: 'W.RATE', tip: 'Speed of the carrier wobble.', fmt: (t) => fxHz(fxExp(0.1, 12, t)) },
      { label: 'TONE', tip: 'Low-pass on the result. Lower is softer.', fmt: (t) => fxHz(fxExp(500, 18000, t)) },
    ],
  },
  {
    name: 'PITCH SHIFT', desc: 'Moves the pitch up or down, with feedback for endless risers.', def: [0.75, 0.5, 0, 0.4, 0.5],
    params: [
      { label: 'SEMI', tip: 'Shift in semitones, from two octaves down to two up. The middle is no shift.', fmt: (t) => fxSigned(Math.round((t * 2 - 1) * 24), 'st') },
      { label: 'FINE', tip: 'Fine tuning, plus or minus half a semitone. A little of it thickens the sound.', fmt: (t) => fxSigned((t * 2 - 1) * 50, 'ct') },
      { label: 'FDBK', tip: 'Feeds the shifted sound back in, so it keeps climbing or falling.', fmt: (t) => fxPct(t * 0.9) },
      { label: 'WINDOW', tip: 'Grain size. Short is tighter but warbles; long is smoother but smears.', fmt: (t) => fxMs(20 + 100 * t) },
    ],
  },
  {
    name: 'REVERB', desc: 'Rooms, halls and caverns, with an optional shimmer.', def: [0.6, 0.4, 0.05, 0, 0.3],
    params: [
      { label: 'DECAY', tip: 'How long the tail rings. All the way up is nearly endless.', fmt: (t) => fxPct(t) },
      { label: 'DAMP', tip: 'How quickly high frequencies die away. Higher is darker and warmer.', fmt: (t) => fxPct(t) },
      { label: 'PREDLY', tip: 'Gap before the reverb starts. Longer separates it from the dry sound.', fmt: (t) => fxMs(150 * t) },
      { label: 'SHIMMR', tip: 'Feeds an octave-up copy of the tail back in, for a glittering, angelic bloom.', fmt: (t) => fxPct(t) },
    ],
  },
  {
    name: 'TAPE ECHO', desc: 'Worn-tape echo: dark, wobbly repeats that bend when you change the time.', def: [0.45, 0.45, 0.2, 0.6, 0.4],
    params: [
      { label: 'TIME', tip: 'Delay time. Turning it while sound plays bends the pitch like a real tape machine.', fmt: (t) => fxMs(fxExp(30, 1200, t)) },
      { label: 'FDBK', tip: 'How many repeats. Near the top they pile up and self-oscillate.', fmt: (t) => fxPct(t * 0.97) },
      { label: 'WOBBLE', tip: 'Wow and flutter: slow and fast tape speed drift.', fmt: (t) => fxPct(t) },
      { label: 'TONE', tip: 'Brightness of the repeats. Lower sounds like older tape.', fmt: (t) => fxHz(fxExp(800, 12000, t)) },
    ],
  },
  {
    name: 'STUTTER', desc: 'Glitchy beat-repeater: loops, reverses and slows slices of the sound.', def: [0.3, 0.6, 0.2, 0.5, 1],
    params: [
      { label: 'SLICE', tip: 'Length of each slice. Short is a machine gun; long is a skipping record.', fmt: (t) => fxMs(fxExp(8, 500, t)) },
      { label: 'REPEAT', tip: 'Chance that a slice gets looped instead of playing live.', fmt: (t) => fxPct(t) },
      { label: 'REVERSE', tip: 'Chance that a looped slice plays backwards.', fmt: (t) => fxPct(t) },
      { label: 'SPEED', tip: 'Playback speed of looped slices. The middle is normal; low is slow and low-pitched.', fmt: (t) => `${Math.pow(2, t * 2 - 1).toFixed(2)}x` },
    ],
  },
  {
    name: 'TRANCE GATE', desc: 'Chops the sound with rhythmic 16-step patterns.', def: [0.5, 1, 0, 0.3, 1],
    params: [
      { label: 'RATE', tip: 'Steps per second. The 16-step pattern repeats continuously.', fmt: (t) => `${fxExp(2, 32, t).toFixed(1)} /s` },
      { label: 'DEPTH', tip: 'How completely the gaps cut the sound.', fmt: (t) => fxPct(t) },
      { label: 'PATTRN', tip: 'Picks one of eight rhythm patterns.', fmt: (t) => `${Math.min(7, Math.floor(t * 8)) + 1} / 8` },
      { label: 'SMOOTH', tip: 'Softens the edges of each chop. Low is clicky; high is pumping.', fmt: (t) => fxMs(fxExp(0.5, 20, t)) },
    ],
  },
  {
    name: 'WAH', desc: 'A resonant sweep you steer by hand, by LFO or by playing dynamics.', def: [0.5, 0.5, 0, 0, 1],
    params: [
      { label: 'PEDAL', tip: 'Position of the wah pedal. Wire an LFO, knob or envelope here to move it.', fmt: (t) => fxHz(fxExp(300, 2800, t)) },
      { label: 'RESO', tip: 'Sharpness of the peak. Higher is more vocal and nasal.', fmt: (t) => `Q ${(1 + 11 * t).toFixed(1)}` },
      { label: 'LFO', tip: 'Speed of an automatic sweep. All the way down turns it off.', fmt: (t) => (t > 0.02 ? fxHz(fxExp(0.2, 10, t)) : 'OFF') },
      { label: 'ENV', tip: 'Auto-wah: louder playing opens the filter further.', fmt: (t) => fxPct(t) },
    ],
  },
  {
    name: 'FREQ SHIFT', desc: 'Moves every partial by a fixed number of Hz: inharmonic, alien, metallic.', def: [0.6, 0, 0, 1, 0.5],
    params: [
      { label: 'SHIFT', tip: 'Shift in Hz, down to -1000 and up to +1000. The middle is none. Unlike pitch shifting, it breaks harmonics.', fmt: (t) => { const v = t * 2 - 1; return fxSigned(Math.sign(v) * v * v * 1000, 'Hz'); } },
      { label: 'FDBK', tip: 'Feeds the shifted sound back in for endlessly rising or falling spirals.', fmt: (t) => fxPct(t * 0.85) },
      null,
      { label: 'TONE', tip: 'Low-pass on the result. Lower is softer.', fmt: (t) => fxHz(fxExp(500, 18000, t)) },
    ],
  },
  {
    name: 'RESONATOR', desc: 'Makes any sound ring like a metal tube tuned to one pitch.', def: [0.4, 0.8, 0.3, 0.1, 0.5],
    params: [
      { label: 'PITCH', tip: 'The pitch the resonator rings at. Wire a sequencer or keyboard pitch here.', fmt: (t) => fxHz(fxExp(30, 2000, t)) },
      { label: 'RESON', tip: 'How long the ringing lasts.', fmt: (t) => fxPct(t * 0.985) },
      { label: 'DAMP', tip: 'How quickly highs die away inside the tube. Higher is duller.', fmt: (t) => fxPct(t) },
      { label: 'DRIFT', tip: 'Slowly wanders the tuning for a living, shimmering ring.', fmt: (t) => fxPct(t) },
    ],
  },
  {
    name: 'GRANULAR', desc: 'Shreds the recent past into tiny grains and scatters them.', def: [0.5, 0.4, 0.6, 0.2, 0.8],
    params: [
      { label: 'SIZE', tip: 'Length of each grain. Tiny is dust and sand; large is blurred and pad-like.', fmt: (t) => fxMs(fxExp(15, 400, t)) },
      { label: 'SPRAY', tip: 'How far back in time grains are taken from. Higher smears the sound.', fmt: (t) => fxMs(1500 * t) },
      { label: 'DENSITY', tip: 'Grains per second. More is smoother; fewer is sparse and bubbly.', fmt: (t) => `${fxExp(2, 80, t).toFixed(0)} /s` },
      { label: 'SCATTR', tip: 'Random pitch of each grain, up to plus or minus this many octaves.', fmt: (t) => `\u00b1${t.toFixed(2)} oct` },
    ],
  },
];

/* ---------- presets ---------- */

const fxL = (min, max, v) => Math.log(v / min) / Math.log(max / min);
const fxN = (min, max, v) => (v - min) / (max - min);
const fxSemi = (st) => (st / 24 + 1) / 2;
const fxShift = (hz) => (Math.sign(hz) * Math.sqrt(Math.abs(hz) / 1000) + 1) / 2;
const fxFb = (pct) => (pct / 95 + 1) / 2;
const fxPat = (n) => (n - 0.5) / 8;

// [name, effect index, p1, p2, p3, p4, mix]
const FX_PRESET_GROUPS = [
  ['MODULATION', [
    ['CLASSIC CHORUS', 0, fxL(0.05, 8, 0.8), 0.45, fxN(2, 30, 12), 0.15, 0.5],
    ['LUSH ENSEMBLE', 0, fxL(0.05, 8, 0.35), 0.7, fxN(2, 30, 22), 0.4, 0.6],
    ['TAPE WOBBLE', 0, fxL(0.05, 8, 0.5), 0.08, fxN(2, 30, 10), 0.9, 1],
    ['SEASICK WARBLE', 0, fxL(0.05, 8, 5.5), 0.5, fxN(2, 30, 8), 0.1, 1],
    ['JET FLANGER', 1, fxL(0.03, 9, 0.12), 0.85, fxFb(80), fxN(0.25, 5, 1.5), 0.5],
    ['METAL FLANGE', 1, fxL(0.03, 9, 0.05), 0.5, fxFb(-90), fxN(0.25, 5, 0.8), 0.5],
    ['SLOW PHASER', 2, fxL(0.03, 9, 0.15), 0.6, 0.45, fxL(150, 3500, 700), 0.5],
    ['VOCAL PHASER', 2, fxL(0.03, 9, 0.6), 0.5, 0.85, fxL(150, 3500, 1200), 0.5],
    ['WARBLE TREMOLO', 3, fxL(0.5, 24, 6), 0.7, 0, 0, 1],
    ['SURF TREMOLO', 3, fxL(0.5, 24, 9), 0.85, 0.35, 0, 1],
    ['HELICOPTER', 3, fxL(0.5, 24, 14), 1, 1, 0, 1],
  ]],
  ['ROBOTS & BELLS', [
    ['DALEK', 4, fxL(20, 3000, 30), 0.1, 0.3, 1, 1],
    ['BELL TONES', 4, fxL(20, 3000, 520), 0, 0.3, 1, 0.6],
    ['ALIEN WARBLE', 4, fxL(20, 3000, 180), 0.35, fxL(0.1, 12, 3), 1, 0.8],
    ['ROBOT VOICE', 12, fxL(30, 2000, 140), 0.8, 0.2, 0.05, 0.7],
  ]],
  ['SPACE', [
    ['SMALL ROOM', 6, 0.25, 0.5, fxN(0, 150, 5), 0, 0.25],
    ['CONCERT HALL', 6, 0.7, 0.35, fxN(0, 150, 30), 0, 0.3],
    ['CATHEDRAL', 6, 0.93, 0.3, fxN(0, 150, 60), 0, 0.38],
    ['SHIMMER VERB', 6, 0.85, 0.3, 0.1, 0.45, 0.45],
    ['SPACE STATION', 6, 0.97, 0.6, 0.7, 0.25, 0.5],
    ['ENDLESS HALL', 6, 1, 0.2, 0.2, 0.2, 0.6],
  ]],
  ['ECHO', [
    ['SLAPBACK', 7, fxL(30, 1200, 110), 0.15, 0.1, fxL(800, 12000, 6000), 0.35],
    ['TAPE ECHO', 7, fxL(30, 1200, 380), 0.45, 0.25, fxL(800, 12000, 3000), 0.4],
    ['DUB ECHO', 7, fxL(30, 1200, 520), 0.72, 0.3, fxL(800, 12000, 1400), 0.45],
    ['RUNAWAY ECHO', 7, fxL(30, 1200, 300), 1, 0.5, fxL(800, 12000, 2500), 0.5],
    ['WOBBLY MEMORY', 7, fxL(30, 1200, 700), 0.6, 1, fxL(800, 12000, 1600), 0.5],
  ]],
  ['PITCH', [
    ['OCTAVE DOWN', 5, fxSemi(-12), 0.5, 0, fxN(20, 120, 60), 0.7],
    ['OCTAVE UP', 5, fxSemi(12), 0.5, 0, fxN(20, 120, 60), 0.5],
    ['CHIPMUNK', 5, fxSemi(10), 0.5, 0, fxN(20, 120, 40), 1],
    ['DEMON', 5, fxSemi(-9), 0.5, 0, fxN(20, 120, 70), 1],
    ['FIFTH UP', 5, fxSemi(7), 0.5, 0, 0.4, 0.45],
    ['DETUNE THICKENER', 5, 0.5, 0.8, 0, 0.4, 0.5],
    ['ENDLESS RISER', 5, fxSemi(2), 0.5, 0.85, fxN(20, 120, 40), 0.6],
    ['ENDLESS FALL', 5, fxSemi(-3), 0.5, 0.85, fxN(20, 120, 40), 0.6],
  ]],
  ['GLITCH', [
    ['STUTTER 1/16', 8, fxL(8, 500, 125), 0.7, 0, 0.5, 1],
    ['GLITCH BLENDER', 8, fxL(8, 500, 90), 0.8, 0.5, 0.5, 1],
    ['HALF-SPEED SMEAR', 8, fxL(8, 500, 220), 1, 0.2, 0, 1],
    ['TAPE SCRATCH', 8, fxL(8, 500, 160), 0.9, 1, 0.8, 1],
    ['MACHINE GUN', 8, fxL(8, 500, 30), 1, 0, 0.5, 1],
  ]],
  ['RHYTHM', [
    ['TRANCE GATE', 9, fxL(2, 32, 8), 1, fxPat(1), fxL(0.5, 20, 3), 1],
    ['SYNCOPATOR', 9, fxL(2, 32, 12), 1, fxPat(5), fxL(0.5, 20, 2), 1],
    ['ROLLING CHOP', 9, fxL(2, 32, 16), 1, fxPat(7), fxL(0.5, 20, 1.5), 1],
    ['DEEP PULSE', 9, fxL(2, 32, 4), 0.8, fxPat(6), fxL(0.5, 20, 8), 1],
    ['HYPER GATE', 9, fxL(2, 32, 28), 1, fxPat(2), fxL(0.5, 20, 1), 1],
  ]],
  ['FILTER FX', [
    ['WAH PEDAL', 10, fxL(300, 2800, 900), 0.6, 0, 0, 1],
    ['AUTO WAH', 10, fxL(300, 2800, 350), 0.65, 0, 0.8, 1],
    ['LFO WAH', 10, fxL(300, 2800, 900), 0.6, fxL(0.2, 10, 1.5), 0, 1],
    ['TELEPHONE', 10, fxL(300, 2800, 1190), 0.15, 0, 0, 1],
    ['UNDERWATER', 10, fxL(300, 2800, 380), 0.1, fxL(0.2, 10, 0.7), 0, 1],
    ['MEGAPHONE', 10, fxL(300, 2800, 1800), 0.35, 0, 0, 1],
  ]],
  ['FREQUENCY SHIFT', [
    ['SPACE WARP', 11, fxShift(200), 0, 0, 1, 0.6],
    ['BARBERPOLE', 11, fxShift(30), 0.88, 0, 1, 0.6],
    ['DISSONANT DOWN', 11, fxShift(-85), 0, 0, 1, 0.5],
    ['ALIEN RADIO', 11, fxShift(500), 0.35, 0, fxL(500, 18000, 3000), 1],
  ]],
  ['RESONATOR', [
    ['METAL TUBE', 12, fxL(30, 2000, 110), 0.9, 0.25, 0.05, 0.5],
    ['STEEL DRUM', 12, fxL(30, 2000, 220), 0.93, 0.5, 0.2, 0.6],
    ['HOLLOW PIPE', 12, fxL(30, 2000, 82), 0.85, 0.6, 0, 0.5],
    ['WIND CHIME', 12, fxL(30, 2000, 880), 0.96, 0.1, 0.3, 0.45],
  ]],
  ['TEXTURE', [
    ['GRANULAR CLOUD', 13, fxL(15, 400, 120), fxN(0, 1500, 600), fxL(2, 80, 20), 0.15, 0.8],
    ['SHATTERED GLASS', 13, fxL(15, 400, 30), fxN(0, 1500, 1000), fxL(2, 80, 40), 0.6, 0.9],
    ['SANDSTORM', 13, 0, 1, 1, 0.3, 1],
    ['PAD MAKER', 13, 1, 0.2, fxL(2, 80, 10), 0.05, 1],
    ['BUBBLES', 13, fxL(15, 400, 60), 0.3, fxL(2, 80, 6), 0.5, 0.9],
  ]],
];

const FX_PRESETS = FX_PRESET_GROUPS.flatMap(([group, list]) => list.map(([name, mode, ...v]) => ({ group, name, mode, v })));

/* ---------- block ---------- */

class FxBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'fx', title: 'EFFECTS', desc: 'Chorus, reverb, pitch shift, glitch and more',
      inputs: [{ id: 'in', label: 'WAVE IN', kind: 'wave' }],
      outputs: [{ id: 'out', label: 'WAVE OUT', kind: 'wave' }],
    }, x, y);
    const ctx = app.ctx;
    this.inNode = ctx.createGain();
    this.node = new AudioWorkletNode(ctx, 'fx-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    });
    this.inNode.connect(this.node);
    this.inAn = makeAnalyser(app, this.inNode);
    this.outAn = makeAnalyser(app, this.node);
    this.mode = 0;
    this.frozen = false;

    const P = (name) => this.node.parameters.get(name);
    this.initModifiers([
      ...[1, 2, 3, 4].map((n) => ({ id: `p${n}`, param: P(`p${n}`), label: `P${n}`, port: `P${n} 0-1`, min: 0, max: 1, value: 0.5, decimals: 2 })),
      { id: 'mix', param: P('mix'), label: 'MIX', port: 'MIX 0-1', min: 0, max: 1, value: 0.5, decimals: 2 },
    ]);

    this.presetSelect = h('select', { onchange: () => this.applyPreset(this.presetSelect.value) },
      h('option', { value: '', text: '- PRESET -' }),
      FX_PRESET_GROUPS.map(([group, list]) => h('optgroup', { label: group },
        list.map(([name]) => h('option', { value: FX_PRESETS.findIndex((p) => p.name === name), text: name })))));
    this.modeSelect = h('select', { onchange: () => this.setMode(+this.modeSelect.value, true) },
      FX_MODES.map((m, i) => h('option', { value: i, text: m.name })));
    this.freezeBtn = h('button', { text: 'FREEZE', onclick: () => this.setFreeze(!this.frozen) });
    this.diceBtn = h('button', { text: 'RANDOM', onclick: () => this.randomize() });
    this.readout = h('div', { class: 'readout small multi', text: '' });
    this.scopeIn = makeScope('INPUT');
    this.scopeOut = makeScope('OUTPUT');
    const m = this.modifiers;
    this.body.append(
      this.presetSelect, this.modeSelect,
      h('div', { class: 'btn-row' }, this.freezeBtn, this.diceBtn),
      m.p1.slider.el, m.p2.slider.el, m.p3.slider.el, m.p4.slider.el, m.mix.slider.el,
      this.readout, this.scopeIn.el, this.scopeOut.el);
    this.setMode(0);
    this.applyPreset(FX_PRESETS.findIndex((p) => p.name === 'LUSH ENSEMBLE'));
  }

  setMode(i, useDefaults = false) {
    this.mode = i;
    this.node.port.postMessage({ mode: i });
    this.modeSelect.value = i;
    FX_MODES[i].params.forEach((d, k) => {
      const id = `p${k + 1}`;
      const slider = this.modifiers[id].slider;
      slider.el.firstElementChild.textContent = d ? d.label : '-';
      this.portRows[id].querySelector('.name').textContent = `${d ? d.label : '-'} 0-1`;
      slider.setDisabled(!d, 'off');
    });
    if (useDefaults) {
      this.presetSelect.value = '';
      FX_MODES[i].def.forEach((v, k) => this.setParam(k < 4 ? `p${k + 1}` : 'mix', v));
    }
  }

  // Wired parameters keep following their source; only unwired ones are written.
  setParam(id, v) { this.modifiers[id].slider.set(v, !this.isWired(id)); }

  applyPreset(index) {
    if (index === '' || index < 0) return;
    const p = FX_PRESETS[+index];
    this.setMode(p.mode);
    p.v.forEach((v, k) => this.setParam(k < 4 ? `p${k + 1}` : 'mix', v));
    this.presetSelect.value = String(index);
  }

  setFreeze(on) {
    this.frozen = on;
    this.node.port.postMessage({ freeze: on });
    this.freezeBtn.classList.toggle('active', on);
  }

  randomize() {
    FX_MODES[this.mode].params.forEach((d, k) => { if (d) this.setParam(`p${k + 1}`, Math.random()); });
    this.presetSelect.value = '';
  }

  paramTip(id) {
    if (id === 'mix') return 'Dry/wet balance: 0 is the untouched sound, 1 is only the effect.';
    const d = FX_MODES[this.mode].params[+id.slice(1) - 1];
    return d ? `${FX_MODES[this.mode].name}: ${d.tip}` : 'Not used by this effect.';
  }

  getState() { return { ...super.getState(), mode: this.mode, frozen: this.frozen, preset: this.presetSelect.value }; }

  setState(s) {
    super.setState(s);
    this.setMode(s.mode || 0);
    this.setFreeze(!!s.frozen);
    this.presetSelect.value = s.preset || '';
  }

  audioIn(portId) { return portId === 'in' ? this.inNode : this.modifiers[portId].param; }
  audioOut() { return this.node; }

  updateReadout() {
    const lines = [];
    FX_MODES[this.mode].params.forEach((d, k) => {
      if (d) lines.push(`${d.label.padEnd(8)}${d.fmt(this.modifiers[`p${k + 1}`].slider.get())}`);
    });
    lines.push(`${'MIX'.padEnd(8)}${fxPct(this.modifiers.mix.slider.get())}`);
    const text = lines.join('\n');
    if (text !== this.readoutText) {
      this.readoutText = text;
      this.readout.textContent = text;
    }
  }

  draw() {
    this.syncModifiers();
    this.updateReadout();
    drawScope(this.scopeIn.canvas, this.inAn.node, this.inAn.buf);
    drawScope(this.scopeOut.canvas, this.outAn.node, this.outAn.buf);
  }

  destroy() {
    for (const n of [this.inNode, this.node, this.inAn.node, this.outAn.node]) n.disconnect();
  }
}

Object.assign(BLOCK_TYPES, { fx: FxBlock });
