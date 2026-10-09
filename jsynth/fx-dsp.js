'use strict';

/* DSP for the EFFECTS block. Plain JS with no browser dependencies: effects.js ships FxDsp's source into an
   AudioWorklet, and the same file can be loaded in Node to test every effect offline.
   Every effect reads four knobs (p1..p4, each 0..1) plus MIX; what the knobs mean depends on the effect (see FX_MODES in effects.js). */

const FX_GATE_PATTERNS = [
  'x.x.x.x.x.x.x.x.', 'xx.xx.xx.xx.xx.x', 'x..x..x..x..x..x', 'xxx.xxx.xxx.xxx.',
  'x.xxx.x.x.xxx.x.', 'x...x...x...x...', 'xx..xx..xx..xx..', 'x.x..xx.x.x..xx.',
].map((p) => Array.from(p, (c) => (c === 'x' ? 1 : 0)));

class FxDsp {
  constructor(sr) {
    this.sr = sr;
    this.N = Math.ceil(sr * 2.5);
    this.buf = new Float32Array(this.N); // shared delay/record buffer
    this.cap = new Float32Array(Math.ceil(sr * 0.55)); // stutter slice
    this.sN = Math.ceil(sr * 0.2);
    this.sbuf = new Float32Array(this.sN); // shimmer pitch shifter
    this.hh = new Float32Array(128); // frequency shifter history
    this.hk = new Float32Array(16);
    for (let j = 0; j < 16; j++) {
      const k = 2 * j + 1;
      this.hk[j] = (2 / (Math.PI * k)) * (0.54 + 0.46 * Math.cos((Math.PI * k) / 32));
    }
    const scale = sr / 44100;
    this.cb = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => new Float32Array(Math.round(n * scale)));
    this.ab = [556, 441, 341, 225].map((n) => new Float32Array(Math.round(n * scale)));
    this.cs = new Float32Array(8);
    this.ci = new Int32Array(8);
    this.ai = new Int32Array(4);
    this.gPos = new Float32Array(24);
    this.gAge = new Float32Array(24);
    this.gLen = new Float32Array(24);
    this.gRate = new Float32Array(24);
    this.gOn = new Uint8Array(24);
    this.z = new Float32Array(6); // phaser stages
    this.s = new Float32Array([0.5, 0.5, 0.5, 0.5]); // smoothed knobs
    this.mx = 0.5;
    this.coef = 1 - Math.exp(-1 / (0.004 * sr));
    this.mode = 0;
    this.freeze = false;
    this.rng = 22222;
    this.reset();
  }

  setMode(m) {
    this.mode = m;
    this.reset();
  }

  reset() {
    this.buf.fill(0); this.cap.fill(0); this.sbuf.fill(0); this.hh.fill(0);
    for (const b of this.cb) b.fill(0);
    for (const b of this.ab) b.fill(0);
    this.cs.fill(0); this.ci.fill(0); this.ai.fill(0); this.z.fill(0); this.gOn.fill(0);
    this.w = 0; this.sw = 0; this.hi = 0;
    this.last = 0; this.lp = 0; this.lp2 = 0;
    this.ph = 0; this.ph2 = 0; this.nz = 0;
    this.dA = 0; this.sdA = 0; this.dS = 0;
    this.shim = 0;
    this.sc = 1e9; this.sL = 1; this.capLen = 1; this.rep = false; this.rev = false; this.rec = 0; this.runLeft = 0;
    this.gs = 1; this.gt = 0;
    this.low = 0; this.band = 0; this.env = 0;
    this.theta = 0;
  }

  rand() {
    this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  wr(v) {
    this.buf[this.w] = v;
    this.w = this.w + 1 === this.N ? 0 : this.w + 1;
  }

  // Reads d samples behind the newest sample, with linear interpolation.
  tapRead(buf, N, w, d) {
    if (d > N - 2) d = N - 2;
    if (d < 0) d = 0;
    let p = w - 1 - d;
    if (p < 0) p += N;
    const i = p | 0;
    const f = p - i;
    const j = i + 1 === N ? 0 : i + 1;
    return buf[i] * (1 - f) + buf[j] * f;
  }

  rd(d) { return this.tapRead(this.buf, this.N, this.w, d); }

  // Two crossfaded taps sliding through the buffer: the heart of the pitch shifter.
  shifted(buf, N, w, dA, W) {
    const g = 0.5 - 0.5 * Math.cos((6.283185307 * dA) / W);
    let dB = dA + W * 0.5;
    if (dB >= W) dB -= W;
    return g * this.tapRead(buf, N, w, dA + 1) + (1 - g) * this.tapRead(buf, N, w, dB + 1);
  }

  run(inp, out, p) {
    const n = out.length;
    const s = this.s;
    const c = this.coef;
    for (let i = 0; i < n; i++) {
      const x = inp ? inp[i] : 0;
      s[0] += (p[0] - s[0]) * c;
      s[1] += (p[1] - s[1]) * c;
      s[2] += (p[2] - s[2]) * c;
      s[3] += (p[3] - s[3]) * c;
      this.mx += (p[4] - this.mx) * c;
      let wet = this.step(x, s);
      if (!(wet > -8 && wet < 8)) { this.reset(); wet = 0; } // NaN or runaway feedback
      out[i] = x * (1 - this.mx) + wet * this.mx;
    }
  }

  step(x, s) {
    switch (this.mode) {
      case 0: return this.chorus(x, s);
      case 1: return this.flanger(x, s);
      case 2: return this.phaser(x, s);
      case 3: return this.tremolo(x, s);
      case 4: return this.ring(x, s);
      case 5: return this.pitch(x, s);
      case 6: return this.reverb(x, s);
      case 7: return this.tape(x, s);
      case 8: return this.stutter(x, s);
      case 9: return this.gate(x, s);
      case 10: return this.wah(x, s);
      case 11: return this.fshift(x, s);
      case 12: return this.reson(x, s);
      case 13: return this.gran(x, s);
      default: return x;
    }
  }

  lfoStep(rate) {
    this.ph += rate / this.sr;
    if (this.ph >= 1) this.ph -= 1;
    return Math.sin(6.283185307 * this.ph);
  }

  /* 0 CHORUS: two detuned delay taps. p: rate, depth, delay, drift */
  chorus(x, s) {
    const sr = this.sr;
    const rate = 0.05 * Math.pow(160, s[0]);
    const base = (2 + s[2] * 28) * 0.001 * sr;
    this.ph += rate / sr;
    if (this.ph >= 1) this.ph -= 1;
    this.nz += (this.rand() * 2 - 1 - this.nz) * 0.0004;
    const dr = this.nz * 100 * s[3] * 0.0015 * sr;
    const l1 = Math.sin(6.283185307 * this.ph);
    const l2 = Math.sin(6.283185307 * (this.ph + 0.33));
    const dep = s[1] * 0.9;
    this.wr(x);
    const d1 = Math.max(1, base * (1 + dep * l1) + dr);
    const d2 = Math.max(1, base * 1.15 * (1 + dep * l2) - dr);
    return 0.5 * (this.rd(d1) + this.rd(d2));
  }

  /* 1 FLANGER: short swept delay with feedback. p: rate, depth, feedback (-95..+95%), manual */
  flanger(x, s) {
    const sr = this.sr;
    const lfo = this.lfoStep(0.03 * Math.pow(300, s[0]));
    const base = (0.25 + s[3] * 4.75) * 0.001 * sr;
    const fb = (s[2] * 2 - 1) * 0.95;
    this.wr(x + fb * this.last);
    const y = this.rd(Math.max(1, base * (1 + s[1] * 0.9 * lfo)));
    this.last = y;
    return y;
  }

  /* 2 PHASER: six swept all-pass stages. p: rate, depth, feedback, center */
  phaser(x, s) {
    const sr = this.sr;
    const lfo = this.lfoStep(0.03 * Math.pow(300, s[0]));
    const center = 150 * Math.pow(3500 / 150, s[3]);
    const f = Math.min(sr * 0.45, center * Math.pow(2, 2 * s[1] * lfo));
    const t = Math.tan((Math.PI * f) / sr);
    const a = (t - 1) / (t + 1);
    let v = x + this.last * s[2] * 0.92;
    for (let i = 0; i < 6; i++) {
      const y = a * v + this.z[i];
      this.z[i] = v - a * y;
      v = y;
    }
    this.last = v;
    return v;
  }

  /* 3 TREMOLO: volume LFO that morphs from sine to square. p: rate, depth, shape */
  tremolo(x, s) {
    const lfo = this.lfoStep(0.5 * Math.pow(48, s[0]));
    const k = 1 + s[2] * 24;
    const shaped = Math.tanh(k * lfo) / Math.tanh(k);
    return x * (1 - s[1] * (0.5 - 0.5 * shaped));
  }

  /* 4 RING MOD: multiplies by a sine carrier. p: frequency, wobble, wobble rate, tone */
  ring(x, s) {
    const sr = this.sr;
    this.ph2 += (0.1 * Math.pow(120, s[2])) / sr;
    if (this.ph2 >= 1) this.ph2 -= 1;
    const f = 20 * Math.pow(150, s[0]) * Math.pow(2, 2 * s[1] * Math.sin(6.283185307 * this.ph2));
    this.ph += f / sr;
    if (this.ph >= 1) this.ph -= 1;
    const y = x * Math.sin(6.283185307 * this.ph);
    this.lp += (1 - Math.exp((-6.283185307 * 500 * Math.pow(36, s[3])) / sr)) * (y - this.lp);
    return this.lp;
  }

  /* 5 PITCH SHIFT: semitones, fine cents, feedback (endless risers), grain window. p: semis, fine, feedback, window */
  pitch(x, s) {
    const sr = this.sr;
    const semis = Math.round((s[0] * 2 - 1) * 24) + (s[1] * 2 - 1) * 0.5;
    const r = Math.pow(2, semis / 12);
    const W = (20 + s[3] * 100) * 0.001 * sr;
    this.wr(x + s[2] * 0.9 * this.last);
    let wet = x;
    if (Math.abs(r - 1) > 1e-6) {
      this.dA += 1 - r;
      while (this.dA >= W) this.dA -= W;
      while (this.dA < 0) this.dA += W;
      wet = this.shifted(this.buf, this.N, this.w, this.dA, W);
    }
    this.last = wet;
    return wet;
  }

  /* 6 REVERB: Freeverb-style combs and all-passes, with pre-delay and an optional octave-up shimmer in the tail. p: decay, damp, pre-delay, shimmer */
  reverb(x, s) {
    const sr = this.sr;
    const fz = this.freeze;
    const fbk = fz ? 1 : 0.7 + s[0] * 0.285;
    const damp = fz ? 0.05 : 0.05 + s[1] * 0.85;
    const pre = s[2] * 0.15 * sr;
    this.wr(x);
    const px = pre > 1 ? this.rd(pre) : x;
    // The shimmer feed shrinks as the decay lengthens, which keeps the feedback loop below unity gain.
    const inp = (fz ? 0 : px + s[3] * 3.5 * (1 - fbk) * this.shim) * 0.03;
    let sum = 0;
    for (let c = 0; c < 8; c++) {
      const b = this.cb[c];
      const i = this.ci[c];
      const o = b[i];
      this.cs[c] = o * (1 - damp) + this.cs[c] * damp;
      b[i] = inp + this.cs[c] * fbk;
      this.ci[c] = i + 1 === b.length ? 0 : i + 1;
      sum += o;
    }
    for (let a = 0; a < 4; a++) {
      const b = this.ab[a];
      const i = this.ai[a];
      const bo = b[i];
      b[i] = sum + bo * 0.5;
      this.ai[a] = i + 1 === b.length ? 0 : i + 1;
      sum = -sum + bo;
    }
    if (s[3] > 0.001) {
      const W = 0.05 * sr;
      this.sbuf[this.sw] = sum;
      this.sw = this.sw + 1 === this.sN ? 0 : this.sw + 1;
      this.sdA -= 1; // octave up: the tap slides toward the newest sample one extra sample per sample
      while (this.sdA < 0) this.sdA += W;
      this.shim = Math.tanh(this.shifted(this.sbuf, this.sN, this.sw, this.sdA, W));
    } else {
      this.shim = 0;
    }
    return sum;
  }

  /* 7 TAPE ECHO: a delay with wow, flutter, saturation and a dark loop. Moving TIME bends the pitch like a real tape. p: time, feedback, wobble, tone */
  tape(x, s) {
    const sr = this.sr;
    const target = 30 * Math.pow(40, s[0]) * 0.001 * sr;
    this.dS += (target - this.dS) * 0.0006;
    this.ph += 0.55 / sr; if (this.ph >= 1) this.ph -= 1;
    this.ph2 += 7.3 / sr; if (this.ph2 >= 1) this.ph2 -= 1;
    this.nz += (this.rand() * 2 - 1 - this.nz) * 0.002;
    const mod = s[2] * sr * 0.001 * (1.6 * Math.sin(6.283185307 * this.ph) + 0.25 * Math.sin(6.283185307 * this.ph2) + 12 * this.nz);
    const y = this.rd(Math.max(1, this.dS + mod));
    const fz = this.freeze;
    const fb = fz ? 1 : s[1] * 0.97;
    this.lp += (1 - Math.exp((-6.283185307 * 800 * Math.pow(15, s[3])) / sr)) * (y - this.lp);
    this.wr(Math.tanh(1.3 * ((fz ? 0 : x) + fb * this.lp)) / 1.3);
    return y;
  }

  /* 8 STUTTER: repeats (and reverses) slices of the live signal. p: slice length, repeat chance, reverse chance, speed */
  stutter(x, s) {
    const sr = this.sr;
    if (this.sc >= this.sL) {
      this.sc = 0;
      this.sL = Math.max(64, Math.round(8 * Math.pow(62.5, s[0]) * 0.001 * sr));
      const again = (this.freeze || this.rand() < s[1]) && this.rec >= this.sL;
      if (again) {
        if (!this.rep || (!this.freeze && --this.runLeft <= 0)) {
          const L = Math.min(this.sL, this.cap.length);
          for (let k = 0; k < L; k++) {
            let j = this.w - L + k;
            if (j < 0) j += this.N;
            this.cap[k] = this.buf[j];
          }
          this.capLen = L;
          this.runLeft = 2 + Math.floor(this.rand() * 6); // after a few repeats, grab fresh material
        }
        this.rev = this.rand() < s[2];
      }
      this.rep = again;
    }
    if (!this.freeze) { this.wr(x); this.rec++; }
    let wet = x;
    if (this.rep) {
      const pos = Math.floor((this.sc * Math.pow(2, s[3] * 2 - 1)) % this.capLen);
      const fade = Math.max(1, Math.min(this.sL * 0.25, 0.002 * sr));
      const g = Math.min(1, this.sc / fade, (this.sL - this.sc) / fade);
      wet = this.cap[this.rev ? this.capLen - 1 - pos : pos] * g;
    }
    this.sc++;
    return wet;
  }

  /* 9 TRANCE GATE: chops the sound with a 16-step pattern. p: step rate, depth, pattern, smoothing */
  gate(x, s) {
    this.ph += (2 * Math.pow(16, s[0])) / this.sr;
    if (this.ph >= 16) this.ph -= 16;
    const pat = FX_GATE_PATTERNS[Math.min(7, Math.floor(s[2] * 8))];
    const target = 1 - s[1] * (1 - pat[Math.floor(this.ph)]);
    this.gs += (target - this.gs) * (1 - Math.exp(-1 / (0.0005 * Math.pow(40, s[3]) * this.sr)));
    return x * this.gs;
  }

  /* 10 WAH: resonant band-pass swept by a pedal position, an LFO and the input loudness. p: pedal, resonance, LFO speed, envelope */
  wah(x, s) {
    const sr = this.sr;
    const a = Math.abs(x);
    this.env += (a - this.env) * (a > this.env ? 0.01 : 0.0003);
    const lfo = s[2] > 0.02 ? 0.35 * this.lfoStep(0.2 * Math.pow(50, s[2])) : 0;
    const pos = Math.min(1, Math.max(0, s[0] + lfo + s[3] * Math.min(1, this.env * 4)));
    const fc = 300 * Math.pow(2800 / 300, pos);
    const f = 2 * Math.sin((Math.PI * fc) / sr);
    const q = 1 / (1 + s[1] * 11);
    this.low += f * this.band;
    const high = x - this.low - q * this.band;
    this.band += f * high;
    return this.band * q * 2.8;
  }

  /* 11 FREQUENCY SHIFT: moves every partial by a fixed number of Hz (inharmonic, metallic). p: shift, feedback, -, tone */
  fshift(x, s) {
    const sr = this.sr;
    const v = s[0] * 2 - 1;
    const shift = Math.sign(v) * v * v * 1000;
    this.hh[this.hi] = x + s[1] * 0.85 * this.last;
    const m = this.hi;
    this.hi = (this.hi + 1) & 127;
    let im = 0;
    for (let j = 0; j < 16; j++) {
      const k = 2 * j + 1;
      im += this.hk[j] * (this.hh[(m - 32 - k) & 127] - this.hh[(m - 32 + k) & 127]);
    }
    const re = this.hh[(m - 32) & 127];
    this.theta += (6.283185307 * shift) / sr;
    if (this.theta > 6.283185307) this.theta -= 6.283185307; else if (this.theta < 0) this.theta += 6.283185307;
    const y = re * Math.cos(this.theta) - im * Math.sin(this.theta);
    this.last = y;
    this.lp += (1 - Math.exp((-6.283185307 * 500 * Math.pow(36, s[3])) / sr)) * (y - this.lp);
    return this.lp;
  }

  /* 12 RESONATOR: a tuned feedback comb that rings at one pitch. p: pitch, resonance, damping, drift */
  reson(x, s) {
    const sr = this.sr;
    const f = 30 * Math.pow(66.67, s[0]);
    this.ph += 0.3 / sr; if (this.ph >= 1) this.ph -= 1;
    const d = (sr / f) * (1 + s[3] * 0.02 * Math.sin(6.283185307 * this.ph));
    const fb = s[1] * 0.985;
    const y = this.rd(Math.max(1, d - 1));
    this.lp += (1 - 0.9 * s[2]) * (y - this.lp);
    const v = x + fb * this.lp;
    this.wr(Math.tanh(v / 3) * 3);
    return v * Math.sqrt(1 - fb * fb);
  }

  /* 13 GRANULAR: scatters tiny windowed grains of the recent past. p: grain size, spray, density, pitch scatter */
  gran(x, s) {
    const sr = this.sr;
    if (!this.freeze) this.wr(x);
    const G = Math.max(64, 15 * Math.pow(26, s[0]) * 0.001 * sr);
    const dens = 2 * Math.pow(40, s[2]);
    this.gt -= dens / sr;
    if (this.gt <= 0) {
      this.gt += 0.7 + 0.6 * this.rand();
      for (let g = 0; g < 24; g++) {
        if (this.gOn[g]) continue;
        const rate = Math.pow(2, (this.rand() * 2 - 1) * s[3]);
        const delay = G * Math.max(1, rate) + 2 + this.rand() * s[1] * 1.5 * sr;
        let pos = this.w - 1 - delay;
        while (pos < 0) pos += this.N;
        this.gPos[g] = pos; this.gAge[g] = 0; this.gLen[g] = G; this.gRate[g] = rate; this.gOn[g] = 1;
        break;
      }
    }
    let sum = 0;
    for (let g = 0; g < 24; g++) {
      if (!this.gOn[g]) continue;
      const win = 0.5 - 0.5 * Math.cos((6.283185307 * this.gAge[g]) / this.gLen[g]);
      const p = this.gPos[g];
      const i = p | 0;
      const f = p - i;
      sum += win * (this.buf[i] * (1 - f) + this.buf[i + 1 === this.N ? 0 : i + 1] * f);
      let np = p + this.gRate[g];
      if (np >= this.N) np -= this.N;
      this.gPos[g] = np;
      if (++this.gAge[g] >= this.gLen[g]) this.gOn[g] = 0;
    }
    return (sum * 1.4) / Math.sqrt(Math.max(1, (dens * G) / sr));
  }
}

if (typeof module !== 'undefined') module.exports = { FxDsp, FX_GATE_PATTERNS };
