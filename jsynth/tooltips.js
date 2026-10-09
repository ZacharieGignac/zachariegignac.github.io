'use strict';

/* Tooltips for every control. One delegated hover handler looks up a short description from the tables
   below, so controls created later (mixer inputs, menus, dialogs, wires, packs) are covered too.
   Titles written by the code that builds an element always win over these. */

const WAVE_BUTTONS = {
  SINE: 'Pure tone with no harmonics. Soft and clean.',
  SAW: 'Bright, buzzy wave with every harmonic. Great for basses and leads.',
  SQUARE: 'Hollow, woody tone. Change its character with PULSE.',
  TRI: 'Mellow tone, softer than a square.',
  'S&H': 'Sample and hold: a new random level at every cycle. Handy as a random control source.',
  NOISE: 'Random hiss. Good for drums, wind and filter sweeps.',
};

const COMMON_CAPTIONS = {
  INPUT: 'Oscilloscope view of the wave coming into this block.',
  OUTPUT: 'Oscilloscope view of the wave leaving this block.',
  WAVE: 'Oscilloscope view of the wave.',
};

const COMMON_INPUTS = {
  MIN: 'Lowest value this block outputs.',
  MAX: 'Highest value this block outputs.',
};

const PORT_TIPS = {
  'wave:in': 'Wave input (green). Drag a wire here from a WAVE OUT port.',
  'wave:out': 'Wave output (green). Drag from here to a WAVE IN port.',
  'value:in': 'Control input (amber). Wire a value here to drive this setting; its slider locks while wired.',
  'value:out': 'Control output (amber). Drag from here to an amber input to control it.',
};

const TIPS = {
  osc: {
    params: {
      freq: 'Pitch in Hz. 440 Hz is the note A4.',
      phase: 'Where in its cycle the wave starts, in degrees. Only for SINE, SAW, SQUARE and TRI.',
      detune: 'Fine pitch shift in cents (100 = one semitone). Tip: a few cents against a second oscillator thickens the sound.',
      pw: 'Pulse width: how long a square wave stays high. 0.5 is an even square. Only used by SQUARE.',
      amp: 'Height of the wave before it leaves the block (1 = full scale).',
    },
    ports: { out: 'The generated wave.' },
    buttons: WAVE_BUTTONS,
    captions: { WAVE: 'Oscilloscope view of the generated wave.' },
  },
  gain: {
    params: { gain: 'Volume multiplier: 1 = unchanged, 0 = silent, 4 = four times louder. Tip: wire an ADSR here for a volume envelope.' },
    buttons: { 'INVERT PHASE': 'Flips the wave upside down. Mixed with the original it cancels out.' },
  },
  dist: {
    params: {
      drive: 'How hard the wave is pushed into the distortion. Higher is grittier.',
      bias: 'Shifts the wave off-centre before distortion for lopsided, richer tones.',
      mix: 'Dry/wet balance: 0 = clean, 1 = fully distorted.',
      bits: 'Bit-crusher resolution. Lower is grainier; 16 is off.',
      rate: 'Sample-rate divider. 1 is off; higher gives a lo-fi, aliased sound.',
      tone: 'Low-pass filter after the distortion. Lower is darker and tames harshness.',
      level: 'Output volume after distortion. Tip: turn it down if high DRIVE gets too loud.',
    },
    buttons: {
      SOFT: 'Smooth, tube-like saturation.',
      HARD: 'Hard clipping. Flat-tops the wave for a harsh, aggressive sound.',
      FOLD: 'Wavefolder: peaks fold back on themselves for metallic, complex tones.',
      FUZZ: 'Lopsided clipping for a thick, fuzz-pedal sound.',
      RECT: 'Rectifier: flips the negative half up, adding an octave-up tone.',
      SINE: 'Sine shaper: smooth, bell-like folds.',
      CHEBY: 'Chebyshev shaper: adds strong, specific harmonics.',
      WRAP: 'Over-range peaks wrap around to the other side. Digital and glitchy.',
    },
    selects: ['Load a ready-made distortion setting (mode and knobs).'],
    captions: { 'TRANSFER CURVE': 'How input level (across) maps to output level (up). A straight diagonal means no distortion.' },
  },
  mix: {
    params: { level: 'Master volume of the mix. Inputs are averaged so adding waves does not clip.' },
    ports: { 'in#': 'Wave input. Wiring the last free input adds a new empty one.' },
    labels: { 'LVL #': 'Volume of this input before mixing.' },
    captions: { MIXED: 'Oscilloscope view of the mixed wave.' },
  },
  knob: {
    ports: { out: 'The dial value. Drag to a control input.' },
    labels: { GLIDE: 'Smooths changes: time in ms to slide to a new value.' },
    buttons: {
      LIN: 'Linear: the dial moves the value evenly.',
      EXP: 'Exponential: fine control near MIN, big jumps near MAX.',
      LOG: 'Logarithmic: fine control near MAX, big jumps near MIN. Good for frequencies.',
    },
    inputs: { MIN: 'Value at the lowest dial position.', MAX: 'Value at the highest dial position.', STEP: 'Snap to this many evenly spaced values. 0 = smooth.' },
    canvases: { dial: 'Drag up or down to turn. Hold Shift for fine control; the mouse wheel works too.' },
    readout: 'Current output value. Click it and type a number to set the knob exactly (Enter to apply, Esc to cancel).',
  },
  w2v: {
    ports: { in: 'Wave to turn into a control value.', out: 'Control value between MIN and MAX.' },
    labels: {
      ATTACK: 'ENVELOPE mode: how fast the value rises when the sound gets louder (ms).',
      RELEAS: 'ENVELOPE mode: how fast the value falls when the sound gets quieter (ms).',
    },
    buttons: {
      DIRECT: 'Follows the wave itself: its swings map onto MIN..MAX. Best for slow waves.',
      ENVELOPE: 'Follows the wave\u2019s loudness. Good for turning audio into a control, like an auto-wah.',
    },
    inputs: { MIN: 'Value output when the signal is at its lowest.', MAX: 'Value output when the signal is at its highest.' },
    captions: { 'VALUE (MIN..MAX)': 'The control value over time, scaled to MIN..MAX.' },
    readout: 'Current output value.',
  },
  out: {
    params: {
      vol: 'Output volume. Keep it low while patching.',
      pan: 'Stereo position: -1 left, 0 centre, 1 right.',
    },
    buttons: {
      MUTE: 'Silences the output without changing VOL.',
      LIMITER: 'Squashes loud peaks above -3 dB so the output does not clip.',
    },
    captions: { LEVEL: 'Output level meter. Keep it out of the red.', 'OUTPUT WAVE': 'Oscilloscope view of what is sent to the speakers.' },
  },
  filter: {
    params: {
      cutoff: 'Frequency where the filter starts to act, in Hz. Tip: sweep it with an LFO or ADSR.',
      q: 'Resonance: boosts the sound around the cutoff. High values ring or whistle.',
      gain: 'Boost or cut in dB. Only used by PEAK, LO SHELF and HI SHELF.',
    },
    buttons: {
      LOWPASS: 'Lets lows through and removes highs. Makes sounds darker.',
      HIGHPASS: 'Removes lows and keeps highs. Thins a sound out.',
      BANDPASS: 'Only a band around the cutoff passes through.',
      NOTCH: 'Removes a narrow band around the cutoff.',
      PEAK: 'Boosts or cuts a band around the cutoff (see GAIN dB).',
      'LO SHELF': 'Boosts or cuts everything below the cutoff (see GAIN dB).',
      'HI SHELF': 'Boosts or cuts everything above the cutoff (see GAIN dB).',
    },
    captions: { 'FREQUENCY RESPONSE': 'How much of each frequency (20 Hz to 20 kHz) passes through the filter.' },
  },
  lfo: {
    params: {
      rate: 'Speed of the cycle in Hz. 0.02 to 60 Hz, so it is slow.',
      depth: 'Strength of the wave (0-1) before it is mapped onto MIN..MAX.',
      pw: 'Pulse width. Only used by SQUARE.',
    },
    buttons: {
      ...WAVE_BUTTONS,
      SQUARE: 'Jumps between MIN and MAX. Change the split with PULSE.',
      'S&H': 'A new random value every cycle. Classic random stepping modulation.',
      NOISE: 'Constantly jittering random values.',
    },
    inputs: { MIN: 'Lowest value the LFO outputs.', MAX: 'Highest value. Tip: match MIN..MAX to what you wire it to, like 200..2000 for a filter cutoff.' },
    ports: { out: 'Slowly moving control value between MIN and MAX.' },
    captions: { WAVE: 'Oscilloscope view of the LFO wave.' },
    readout: 'Current output value.',
  },
  delay: {
    params: {
      time: 'Time between echoes, in seconds.',
      fb: 'How much of the echo is fed back. Higher gives more repeats; above 1 keeps building.',
      wet: 'Volume of the echoes. 0 is the dry sound only.',
      damp: 'Low-pass on the echoes: lower makes each repeat darker.',
    },
    captions: { 'OUTPUT (DRY + ECHOES)': 'Oscilloscope view of the original sound plus its echoes.' },
  },
  spectrum: {
    ports: { 'b#': 'Loudness of this frequency band as a control value. Set its range in Hz below, then wire it to anything: a filter, a gain, a detector...' },
    labels: {
      SMOOTH: 'Averages the display over time so it moves less. Also smooths the band outputs.',
      RANGE: 'Decibel range shown. The band outputs (0-1) span this window, so a smaller range makes them more sensitive.',
      BANDS: 'How many frequency bands to watch (0-8). Each one gets its own value output.',
      LEVEL: 'How a band\u2019s loudness is measured.',
      OUT: 'The range of the band outputs.',
    },
    buttons: {
      'PEAK HOLD': 'Shows a marker that holds each band\u2019s recent peak.',
      PEAK: 'A band reports its loudest frequency. Quick and sensitive.',
      AVERAGE: 'A band reports its average power. Steadier for broad ranges.',
      '0-1': 'Band outputs run from 0 (silent, at the bottom of RANGE) to 1 (full scale).',
      dB: 'Band outputs are levels in decibels, from -100 up to 0.',
    },
    inputs: {
      'B# LO': 'Lowest frequency of this band, in Hz.',
      'HI Hz': 'Highest frequency of this band, in Hz.',
    },
    canvases: { spectrum: 'Frequency spectrum on a log scale (30 Hz to 18 kHz). Taller bars are louder. Amber zones are your bands, with a line showing the level each reports.' },
    readout: 'The loudest frequency right now and its level.',
  },
  seq: {
    ports: {
      trig: 'Gate input for ONE-SHOT mode: each rising edge plays the pattern once.',
      pitch: 'Pitch in Hz of the current step. Wire it to an oscillator\u2019s FREQ.',
      gate: 'High while a note sounds, low during rests. Wire it to an ADSR\u2019s GATE IN.',
    },
    labels: {
      BPM: 'Tempo in beats per minute. Each step is a sixteenth note.',
      STEPS: 'How many steps the pattern has (2-16).',
      'GATE %': 'How long the gate stays high within each step. Short = staccato.',
      GLIDE: 'Slide time between pitches in ms. 0 jumps straight to the next note.',
    },
    buttons: {
      PLAY: 'Start the pattern.',
      STOP: 'Stop the pattern.',
      RANDOM: 'Fill the pattern with random notes.',
      CLEAR: 'Reset the pattern.',
      LOOP: 'Repeat the pattern forever.',
      'ONE-SHOT': 'Play the pattern once each time the TRIG input goes high.',
    },
    selects: ['Root note: the lowest note of the scale.', 'Scale the bars are snapped to. Pick one and every pattern sounds musical.'],
    canvases: { steps: 'Drag bars to set each step\u2019s pitch. Shift or right-click makes a step a rest. The amber column is the playhead.' },
    readout: 'The note currently playing.',
  },
  adsr: {
    ports: { gate: 'Gate input. Rising starts the attack; falling starts the release.', out: 'Envelope value between MIN and MAX.' },
    labels: {
      ATTACK: 'Time to rise to full level once the gate goes high (ms).',
      DECAY: 'Time to fall from full level to the sustain level (ms).',
      SUSTAIN: 'Level held while the gate stays high (0-1).',
      RELEAS: 'Time to fall back to zero once the gate goes low (ms).',
    },
    buttons: { 'HOLD TO TRIGGER': 'Hold the mouse button to send a test gate.' },
    inputs: { MIN: 'Output value when the envelope is at zero.', MAX: 'Output value at the top of the attack. Tip: wire to a GAIN for volume, or a filter cutoff.' },
    captions: { SHAPE: 'The envelope shape with the current settings.', 'LIVE (LAST 4 SEC)': 'The envelope output over the last four seconds.' },
    readout: 'Current output value.',
  },
  trigger: {
    ports: { out: 'Gate: 1 while on, 0 while off. Wire it to an ADSR\u2019s GATE IN.' },
    labels: {
      LENGTH: 'How long the gate stays on in PULSE and REPEAT modes (ms).',
      'RATE Hz': 'Pulses per second in REPEAT mode.',
    },
    buttons: {
      PULSE: 'Each press sends one short gate of LENGTH.',
      HOLD: 'The gate stays on while the button (or SPACE) is held.',
      TOGGLE: 'Each press flips the gate on or off.',
      REPEAT: 'Press once to pulse automatically at RATE; press again to stop.',
      TRIGGER: 'Click, or press SPACE, to send a gate.',
      'STOP REPEAT': 'Stop the repeating pulses.',
    },
  },
  keyboard: {
    ports: {
      pitch: 'Pitch in Hz of the last key pressed. Wire it to an oscillator\u2019s FREQ.',
      gate: 'High while any key is held. Wire it to an ADSR\u2019s GATE IN.',
    },
    labels: {
      OCTAVE: 'Shifts every key up or down by octaves.',
      GLIDE: 'Slide time between notes in ms. 0 jumps straight to the new pitch.',
    },
    canvases: { keys: 'Click or drag across the keys, or play with A W S E D F T G Y H U J K O L P ; on your computer keyboard.' },
  },
  audioin: {
    params: { gain: 'Input volume (0-4). Raise it for quiet microphones.' },
    ports: { out: 'The incoming audio as a wave.' },
    buttons: {
      'INPUT OFF': 'Start listening to the audio input. The browser asks for permission.',
      'INPUT ON': 'Stop listening to the audio input.',
      'ECHO CANCEL': 'Ask the browser to remove speaker echo from the input.',
      'NOISE SUPPRESS': 'Ask the browser to reduce background noise.',
      'AUTO GAIN': 'Let the browser adjust the input volume automatically.',
    },
    selects: ['Choose which microphone or audio input to use.'],
    captions: { LEVEL: 'Input level meter. Keep it out of the red.', 'INPUT WAVE': 'Oscilloscope view of the incoming audio.' },
    readout: 'Input status.',
  },
  domfreq: {
    ports: {
      in: 'Wave to analyse.',
      f1: 'Frequency in Hz of the first detected peak. Wire it to an oscillator\u2019s FREQ.',
      f2: 'Second detected frequency in Hz. Needs VALUES of 2 or more.',
      f3: 'Third detected frequency in Hz. Needs VALUES of 3 or more.',
      f4: 'Fourth detected frequency in Hz. Needs VALUES of 4.',
      gate: '1 while at least one frequency is detected, otherwise 0. Wire it to an ADSR\u2019s GATE IN.',
    },
    labels: {
      VALUES: 'How many frequencies to report (1-4). Unused outputs stay at 0.',
      THRESH: 'Minimum level in dB for a peak to count. Raise it to ignore background noise.',
      SPACING: 'Minimum distance between reported peaks, in semitones. Stops one note being reported twice.',
      AVERAGE: 'Smooths the analysis over time. Higher is steadier but slower to react.',
      GLIDE: 'Slide time in ms when an output changes frequency. 0 jumps instantly.',
      FFT: 'Analysis size. Bigger is more precise and better at low pitches, but reacts slower.',
    },
    buttons: {
      '4K': 'Fastest reaction, coarsest precision.',
      '8K': 'Balanced precision and speed.',
      '16K': 'High precision, slower reaction.',
      '32K': 'Highest precision and slowest reaction. Best for low bass notes.',
      LOUDEST: 'FREQ 1 is the loudest peak, FREQ 2 the next loudest, and so on.',
      'LOW > HIGH': 'Outputs are sorted by pitch, lowest first. Steadier for chords.',
      'HIGH > LOW': 'Outputs are sorted by pitch, highest first.',
      FUNDAMENTAL: 'Ignores harmonics of a lower peak, so a note reports its base pitch instead of a louder overtone.',
      'SNAP NOTE': 'Rounds each output to the nearest note (A4 = 440 Hz).',
      'HOLD LAST': 'When the sound stops, keep the last frequency instead of dropping to 0.',
    },
    inputs: { MIN: 'Lowest frequency searched, in Hz.', MAX: 'Highest frequency searched, in Hz.' },
    canvases: { spectrum: 'Spectrum of the input within MIN..MAX. Amber lines are the detected peaks; the dashed red line is the threshold.' },
    readout: 'Detected frequencies with note names and cents.',
  },
  fx: {
    ports: { in: 'Wave to process.', out: 'The processed wave.' },
    selects: [
      'Pick a ready-made sound. Presets set the effect type and every knob.',
      'Choose the effect algorithm. Knob names and meanings change with it.',
    ],
    buttons: {
      FREEZE: 'Holds the sound: reverb sustains forever, tape echo repeats endlessly, stutter and granular loop what they last heard.',
      RANDOM: 'Randomises the knobs of this effect (not MIX). Great for happy accidents.',
    },
    captions: { OUTPUT: 'Oscilloscope view of the processed wave.' },
    readout: 'The knobs in real units for the selected effect.',
  },
  seqpro: {
    ports: {
      trig: 'Trigger input. TRIGGERED mode plays N/TRIG steps on each rising edge; LOOP mode restarts from step 1. Triggers from another sequencer are sample-accurate.',
      reset: 'Rewinds to the first step and stops a triggered run.',
      bpm: 'Wire a value here to set the tempo from another block.',
      pitch: 'Pitch in Hz of the current step. Wire it to an oscillator\u2019s FREQ.',
      gate: 'High while a note sounds, low during rests. Wire it to an ADSR\u2019s GATE IN.',
      vel: 'Velocity (0-1) of the current step. Wire it to a GAIN or filter.',
      step: 'Number of the current step (1-64).',
      t1: 'Pulses on every step that has the T1 flag. Wire it to another sequencer\u2019s TRIG IN to fire or step it.',
      t2: 'Pulses on every step that has the T2 flag.',
      t3: 'Pulses on every step that has the T3 flag.',
      t4: 'Pulses on every step that has the T4 flag.',
      done: 'Pulses each time the whole sequence has played. Wire it to another sequencer\u2019s TRIG IN to chain them.',
    },
    labels: {
      BPM: 'Tempo. Each step is a sixteenth note, multiplied by the step\u2019s own DLY.',
      STEPS: 'How many steps the sequence uses (1-64).',
      'GATE %': 'How long the gate stays high within each step. Short is staccato.',
      GLIDE: 'Slide time between pitches in ms. 0 jumps straight to the next note.',
      'N/TRIG': 'TRIGGERED mode: steps played per trigger. 1 steps one at a time; 0 plays the whole sequence from step 1.',
      PULSE: 'Length in ms of the pulses on TRIG 1-4 and DONE. Longer pulses give envelopes more time to decay while the gate is held.',
    },
    buttons: {
      PLAY: 'Start the sequencer.',
      STOP: 'Stop the sequencer.',
      TRIGGER: 'Send a trigger by hand, as if it arrived on TRIG IN.',
      RANDOM: 'Fill the pitches with random notes.',
      CLEAR: 'Reset every step: pitch, velocity, delay and trigger flags.',
      LOOP: 'Plays continuously. A trigger restarts it from step 1.',
      TRIGGERED: 'Waits for triggers. Each one plays N/TRIG steps.',
      FWD: 'Plays steps forwards.',
      REV: 'Plays steps backwards.',
      PING: 'Plays forwards then backwards.',
      RAND: 'Plays steps in random order.',
      '1-16': 'Show steps 1-16.',
      '17-32': 'Show steps 17-32.',
      '33-48': 'Show steps 33-48.',
      '49-64': 'Show steps 49-64.',
      FOLLOW: 'Flips the page to follow the playing step.',
    },
    selects: [
      'Root note: the lowest note of the scale.',
      'Scale the pitch bars are snapped to.',
      'Pitch of the selected step. Choose REST for silence.',
    ],
    inputs: {
      STEP: 'The step being edited (click any column to select it).',
      'DLY \u00d7': 'Delay before the next step, as a multiple of the base step time: 1 is normal, 2 is twice as long, 0.5 is half. Any value from 0.05 to 32.',
      VEL: 'Velocity (0-1) of the selected step.',
    },
    canvases: {
      'sp-grid': 'Step editor, 16 steps per page. Top to bottom: pitch bars (drag; Shift or right-click = rest), velocity, delay before the next step, and four trigger flags T1-T4 (click or drag to toggle). The amber column is the playhead.',
    },
    readout: 'The playing step, note and tempo.',
  },
  detector: {
    ports: {
      in: 'Wave to listen to.',
      thr: 'Wire a value (in dB, -100 to 0) here to set the LEVEL threshold from another block.',
      time: 'Wire a value (in seconds) here to set the countdown TIME from another block.',
      reset: 'A rising edge clears the countdown, the latch and the count.',
      fire: 'A short pulse each time the countdown finishes. Wire it to a trigger or an ADSR\u2019s GATE IN.',
      held: 'High after firing: until the condition ends (ONCE), while it holds (REPEAT), or until RESET (MANUAL).',
      match: 'High while the level currently meets the condition.',
      prog: 'Countdown progress, 0 to 1.',
      left: 'Seconds left on the countdown.',
      lvl: 'Measured level as a linear value, 0 to 1.',
      count: 'How many times it has fired.',
    },
    labels: {
      WHEN: 'Which levels start the countdown.',
      METER: 'How the level is measured.',
      AFTER: 'What happens once the countdown finishes.',
      BREAK: 'What happens to the countdown when the condition stops being met.',
      LEVEL: 'Threshold in dB (0 dB is full scale). For ABOVE and BELOW it is the only level; for BETWEEN and OUTSIDE it is one edge of the window.',
      TO: 'The other edge of the level window, used by BETWEEN and OUTSIDE.',
      'TIME': 'How long the condition must be met before it fires, in seconds (0.01 to 600).',
      SMOOTH: 'Smooths the measured level over this many ms, so brief spikes do not count.',
      'LO Hz': 'Only sound above this frequency is measured.',
      'HI Hz': 'Only sound below this frequency is measured. Together with LO Hz this sets the frequency range.',
    },
    buttons: {
      ABOVE: 'Counts down while the level is louder than LEVEL.',
      BELOW: 'Counts down while the level is quieter than LEVEL. Good for detecting silence.',
      BETWEEN: 'Counts down while the level is inside the window from LEVEL to TO.',
      OUTSIDE: 'Counts down while the level is outside the window from LEVEL to TO.',
      PEAK: 'Measures the loudest moment. Fast and sensitive.',
      RMS: 'Measures average power. Steadier and closer to perceived loudness (about 3 dB lower than peak for a sine).',
      ONCE: 'Fires once, then re-arms when the condition ends.',
      REPEAT: 'Fires again every TIME seconds for as long as the condition holds.',
      MANUAL: 'Fires once, then stays latched until RESET.',
      RESTART: 'The countdown starts over whenever the condition breaks.',
      PAUSE: 'The countdown holds its progress until the condition returns.',
      DRAIN: 'The countdown runs backwards while the condition is broken.',
      RESET: 'Clears the countdown, the latch and the count.',
      'FIRE NOW': 'Fires immediately, to test what is wired to it.',
    },
    captions: {
      'LEVEL HISTORY': 'The last few seconds of level. The amber line is the threshold; amber shading marks the matching zone, and white lines mark each firing.',
      COUNTDOWN: 'Countdown progress. It turns white while latched.',
    },
    readout: 'Level, countdown time and how often it has fired.',
  },
  script: {
    ports: {
      'i#': 'Script input. Wire a value in and use it in your code by this name. A WAVE input arrives as its loudness (0 to 1).',
      'o#': 'Script output. Assign a number to this name in your code and it comes out here.',
    },
    buttons: {
      '+ INPUT': 'Add another input.',
      '+ OUTPUT': 'Add another output.',
      PAUSE: 'Stop running the script. Outputs hold their last values.',
      RUN: 'Start running the script again.',
      'RESET MEMORY': 'Clears `state`, and restarts the clock `t`.',
    },
    labels: { RATE: 'How many times per second the script runs (1-240).' },
    selects: ['Load an example script. It reuses your existing input and output ports where it can, so wires stay in place.'],
    keys: {
      code: 'Your JavaScript. Inputs are variables; assign to the output names. Also available: t (seconds), dt (seconds since the last run), frame, state (an object that persists), log(...), Math, and clamp, lerp, map, mtof, ftom, rand. Avoid endless loops: they would freeze the page.',
      inName: 'Name of this input, used as a variable in your code.',
      outName: 'Name of this output, used as a variable in your code.',
      kind: 'VALUE: a control value. WAVE: the loudness of a wave. Changing it unplugs the wire.',
      default: 'The value used while nothing is wired to this input. It works as a manual knob.',
      remove: 'Remove this port and anything wired to it.',
    },
    captions: {
      'INPUTS (NAME, DEFAULT WHEN UNWIRED)': 'Each input becomes a variable in your script.',
      OUTPUTS: 'Each output is a variable you assign in your script.',
    },
  },
  pack: {
    buttons: { OPEN: 'Open this pack\u2019s tab to see and edit what is inside.', UNPACK: 'Dissolve the pack and put its blocks back in this tab.' },
    captions: { INSIDE: 'Miniature map of the blocks inside this pack.' },
    readout: 'Number of blocks inside this pack.',
    title: 'Packed group of blocks. Double-click the title to rename; right-click for more options.',
  },
  packin: {
    ports: { out: 'Whatever enters the pack through its matching port appears here.' },
    labels: { NAME: 'Label of the matching port on the outside of the pack.' },
  },
  packout: {
    ports: { in: 'Connect here to send a signal out through the matching pack port.' },
    labels: { NAME: 'Label of the matching port on the outside of the pack.' },
  },
};

const MENU_TIPS = {
  'OPEN PACK': 'Show the inside of this pack.',
  'DUPLICATE PACK': 'Add a copy of this pack to the open tab.',
  UNPACK: 'Dissolve the pack and put its blocks back in this tab.',
  'EXPORT PACK AS JSON': 'Save this pack as a file you can load into any project.',
  'RENAME PACK': 'Change the pack\u2019s name.',
  'PACK # BLOCK': 'Wrap the selected blocks into one pack block. Wires to other blocks become pack ports.',
  'DELETE # BLOCK': 'Delete the selected blocks and their wires.',
  'SELECT ALL': 'Select every block in this tab.',
  'OPEN TAB': 'Show this tab.',
  'ADD A COPY TO THE OPEN TAB': 'Add a copy of this pack to the open tab.',
  'MOVE OUT OF FOLDER': 'Move this out of its folder to the top level.',
  'MOVE TO FOLDER:': 'Move this into that folder.',
  'NEW SUBFOLDER': 'Create a folder inside this folder.',
  'RENAME FOLDER': 'Change the folder\u2019s name.',
  'DELETE FOLDER (KEEPS CONTENTS)': 'Delete the folder. Its tabs and folders move up a level.',
  'NEW FOLDER': 'Create a folder to organise pack tabs.',
};

const DIALOG_TIPS = {
  CANCEL: 'Close without changing anything. Esc does the same.',
  OK: 'Confirm. Enter does the same.',
  DELETE: 'Confirm the deletion.',
  LOAD: 'Replace the current project with the loaded file.',
  NEW: 'Discard the current project and start an empty one.',
};

const STATIC_TIPS = {
  power: 'Turn the audio engine on or off. Browsers only allow sound after a click.',
  status: 'Messages about what the app is doing appear here.',
  hint: 'Wave ports (green) carry sound, value ports (amber) carry control numbers. Only matching colours connect.',
  blockFilter: 'Type to filter the block list.',
};

const SECTION_TIPS = {
  PACKS: 'Packs group blocks into one reusable block.',
  SOURCES: 'Blocks that create sounds or control values.',
  PROCESS: 'Blocks that change a sound or turn it into a value.',
  OUTPUT: 'Blocks that show or play the result.',
  'INSIDE A PACK': 'Ports that connect a pack\u2019s inner blocks to the outside. Only usable while a pack tab is open.',
};

const tipText = (el) => (el.textContent || '').trim();
// Collapses counters so "WAVE 3" and "PACK 2 BLOCKS" match one entry.
const tipKey = (s) => s.replace(/\s+\d+(?=\s|$)/g, ' #').replace(/\s+/g, ' ').trim();

function tipBlockOf(el) {
  const blockEl = el.closest('.block');
  return blockEl ? [...app.blocks.values()].find((b) => b.el === blockEl) : null;
}

function tipPort(block, T, portId) {
  const def = block.inputs.find((p) => p.id === portId) || block.outputs.find((p) => p.id === portId);
  if (!def) return null;
  const isOut = block.outputs.includes(def);
  const own = T.ports && (T.ports[portId] || T.ports[portId.replace(/\d+$/, '#')]);
  if (own) return own;
  if (T.params && T.params[portId]) return `${T.params[portId]} (Control input: wire a value here.)`;
  const dyn = block.paramTip && block.paramTip(portId);
  if (dyn) return `${dyn} (Control input, 0 to 1: wire a value here.)`;
  return PORT_TIPS[`${def.kind}:${isOut ? 'out' : 'in'}`];
}

function tipFor(el) {
  const menuBtn = el.closest('.ctxmenu button');
  if (menuBtn) {
    const key = tipKey(tipText(menuBtn)).replace(/ BLOCKS$/, ' BLOCK');
    return [menuBtn, MENU_TIPS[key] || MENU_TIPS[Object.keys(MENU_TIPS).find((k) => k.endsWith(':') && key.startsWith(k))]];
  }
  const dialog = el.closest('.dialog');
  if (dialog) {
    const btn = el.closest('button');
    if (btn) return [btn, DIALOG_TIPS[tipText(btn)]];
    const field = el.closest('input');
    return field ? [field, 'Type a name, then press Enter. Esc cancels.'] : null;
  }
  const item = el.closest('#blocklist .item');
  if (item) {
    if (item.id === 'library') return [item, 'Browse ready-made packs, like game sounds and classic synth voices, and add one to the workspace.', true];
    const desc = item.querySelector('small');
    return [item, `${desc ? tipText(desc) : tipText(item)}. Click to add it, or drag it onto the workspace.`, true];
  }
  const head = el.closest('#blocklist h3');
  if (head) return [head, SECTION_TIPS[tipText(head)]];
  if (el.closest('#toolbar h1')) return [el.closest('h1'), 'JSYNTH: a modular synthesizer in your browser. Build sounds by wiring blocks together.'];
  if (el.closest('#toolbar .label')) return [el.closest('.label'), 'Zoom the workspace.'];
  const staticEl = el.closest('#power, #status, #hint, #blockFilter');
  if (staticEl) return [staticEl, STATIC_TIPS[staticEl.id]];

  const block = tipBlockOf(el);
  if (!block) return null;
  const T = TIPS[block.type] || {};
  const body = el.closest('.body');

  if (!body) {
    if (el.closest('.close')) return null;
    const row = el.closest('.port-row');
    if (row) return [row, tipPort(block, T, row.querySelector('.port').dataset.port)];
    const bar = el.closest('.title, .desc');
    if (bar) {
      const desc = block.el.querySelector('.desc').textContent;
      return [bar, T.title || `${desc}. Drag the title bar to move it; right-click for more options.`];
    }
    return null;
  }

  const keyed = el.closest('[data-tipkey]');
  if (keyed) return [keyed, T.keys && T.keys[keyed.dataset.tipkey]];

  const btn = el.closest('button');
  if (btn) return [btn, T.buttons && T.buttons[tipText(btn)]];

  const ctl = el.closest('.ctl');
  if (ctl) {
    const mod = Object.entries(block.modifiers || {}).find(([, m]) => m.slider.el === ctl);
    if (mod) {
      const tip = (T.params && T.params[mod[0]]) || (block.paramTip && block.paramTip(mod[0]));
      return [ctl, tip && `${tip} Wire a value into its port to automate it.`];
    }
    return [ctl, T.labels && T.labels[tipKey(tipText(ctl.firstElementChild))]];
  }

  const mm = el.closest('.minmax');
  if (mm) {
    let control = el.closest('input, select');
    const target = control || el.closest('span');
    if (!control) {
      const next = el.nextElementSibling;
      control = next && next.matches('input, select') ? next : el.previousElementSibling;
    }
    if (control && control.matches('select')) {
      return [target, T.selects && T.selects[[...block.el.querySelectorAll('select')].indexOf(control)]];
    }
    if (control) {
      const label = tipText(control.previousElementSibling || control);
      const inputs = T.inputs || {};
      return [target, inputs[label] || inputs[label.replace(/\d+/, '#')] || COMMON_INPUTS[label]];
    }
  }

  const select = el.closest('select');
  if (select) return [select, T.selects && T.selects[[...block.el.querySelectorAll('select')].indexOf(select)]];

  const wrap = el.closest('.scope-wrap');
  if (wrap) {
    const cap = tipText(wrap.querySelector('.cap'));
    return [wrap, (T.captions && T.captions[cap]) || COMMON_CAPTIONS[cap]];
  }
  const loneCap = el.closest('.cap');
  if (loneCap && T.captions && T.captions[tipText(loneCap)]) return [loneCap, T.captions[tipText(loneCap)]];
  const canvas = el.closest('canvas');
  if (canvas) {
    const cls = [...canvas.classList].find((c) => T.canvases && T.canvases[c]);
    return [canvas, cls && T.canvases[cls]];
  }
  const readout = el.closest('.readout');
  if (readout) return [readout, T.readout];
  return null;
}

function applyTip(el, text, force = false) {
  if (!text) return;
  // Titles set by the code that builds an element are kept; ours are refreshed (button labels can change).
  if (el.title && el.dataset.tip !== '1' && !force) return;
  el.title = text;
  el.dataset.tip = '1';
}

document.addEventListener('mouseover', (e) => {
  if (!(e.target instanceof Element)) return;
  const wire = e.target.closest('g.wire');
  if (wire) {
    if (!wire.querySelector('title')) {
      const t = document.createElementNS(SVG_NS, 'title');
      t.textContent = 'Wire. Click it and press Delete to cut it, or double-click to disconnect.';
      wire.prepend(t);
    }
    return;
  }
  const found = tipFor(e.target);
  if (found) applyTip(found[0], found[1], found[2]);
});
