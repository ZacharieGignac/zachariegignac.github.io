'use strict';

/* AUDIO PLAYER: plays an audio file from your computer (mp3, wav, ogg, flac, m4a...) as a wave.
   Load a file with the button or drop it on the block (or anywhere on the workspace). The whole file is decoded into
   memory, so seeking, looping and speed changes are instant. Saved projects remember the file name, not the audio. */

const PLAYER_W = 560;
const PLAYER_H = 128;
const PLAYER_RULER = 14; // bottom strip for time labels
const PLAYER_METER_H = 30;
const PLAYER_CACHE = new Map(); // key -> { name, buffer }: lets copied blocks and packs share one decoded file

const isAudioFile = (file) => (file.type || '').startsWith('audio/') || /\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|weba|webm|mp4)$/i.test(file.name || '');

function playerTime(s, tenths = true) {
  if (!Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${(tenths ? sec.toFixed(1) : Math.floor(sec).toString()).padStart(tenths ? 4 : 2, '0')}`;
}

class AudioPlayerBlock extends Block {
  constructor(app, x, y) {
    super(app, {
      type: 'player', title: 'AUDIO PLAYER', desc: 'Plays an audio file (mp3, wav, ogg...) as a wave',
      inputs: [{ id: 'trig', label: 'TRIG IN', kind: 'value' }],
      outputs: [
        { id: 'out', label: 'WAVE OUT', kind: 'wave' },
        { id: 'l', label: 'WAVE L', kind: 'wave' },
        { id: 'r', label: 'WAVE R', kind: 'wave' },
        { id: 'pos', label: 'POSITION 0-1', kind: 'value' },
        { id: 'play', label: 'PLAYING 0/1', kind: 'value' },
      ],
    }, x, y);
    const ctx = app.ctx;

    // file -> envelope -> vol -> (mono mix | left | right)
    this.vol = ctx.createGain();
    this.vol.channelCount = 2;
    this.vol.channelCountMode = 'explicit';
    this.vol.channelInterpretation = 'speakers';
    this.mono = ctx.createGain();
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.mono.channelInterpretation = 'speakers';
    this.vol.connect(this.mono);
    this.split = ctx.createChannelSplitter(2);
    this.vol.connect(this.split);
    this.left = ctx.createGain();
    this.right = ctx.createGain();
    this.split.connect(this.left, 0);
    this.split.connect(this.right, 1);
    this.anL = makeAnalyser(app, this.left);
    this.anR = makeAnalyser(app, this.right);

    // Drives every playback node's speed. Wiring a value into SPEED adds to it, like the other parameter ports.
    this.speedNode = ctx.createConstantSource();
    this.speedNode.offset.value = 1;
    this.speedNode.start();
    this.outNodes = {};
    this.outVals = { pos: 0, play: 0 };
    for (const id of Object.keys(this.outVals)) {
      const n = ctx.createConstantSource();
      n.offset.value = 0;
      n.start();
      this.outNodes[id] = n;
    }
    this.trigIn = ctx.createGain();
    this.trigAn = ctx.createAnalyser();
    this.trigAn.fftSize = 2048;
    this.trigIn.connect(this.trigAn);
    this.trigAn.connect(app.sink);
    this.trigBuf = new Float32Array(this.trigAn.fftSize);
    this.trigHigh = false;

    this.buffer = null;
    this.key = '';
    this.name = '';
    this.missing = ''; // name of a file a loaded project used, which has to be chosen again
    this.peaks = null;
    this.src = null;
    this.env = null;
    this.playing = false;
    this.pos = 0;
    this.lastT = ctx.currentTime;
    this.loop = false;
    this.gateMode = false;
    this.token = 0;
    this.scrub = null; // fraction while dragging on the waveform
    this.hover = null;
    this.dragOver = false;
    this.meterHold = [-100, -100];
    this.meterHoldT = [0, 0];

    this.initModifiers([
      { id: 'vol', param: this.vol.gain, label: 'VOL', port: 'VOL 0-2', min: 0, max: 2, value: 1, decimals: 2 },
      { id: 'speed', param: this.speedNode.offset, label: 'SPEED', port: 'SPEED 0.25-4', min: 0.25, max: 4, value: 1, log: true, decimals: 2 },
    ]);

    this.fileInput = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.oga,.opus,.m4a,.aac,.flac,.weba,.webm' });
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      const [f] = this.fileInput.files;
      this.fileInput.value = '';
      if (f) this.loadFile(f);
    });
    this.loadBtn = h('button', { text: 'LOAD AUDIO FILE', onclick: () => this.fileInput.click() });
    this.playBtn = h('button', { text: 'PLAY', onclick: () => this.toggle() });
    this.stopBtn = h('button', { text: 'STOP', onclick: () => this.stop() });
    this.loopBtn = h('button', { text: 'LOOP', onclick: () => this.setLoop(!this.loop) });
    this.gateBtn = h('button', { text: 'GATE MODE', onclick: () => this.setGateMode(!this.gateMode) });
    this.nameEl = h('div', { class: 'readout small player-name', text: 'NO FILE LOADED' });
    this.nameEl.dataset.tipkey = 'file';
    this.infoEl = h('div', { class: 'cap hint', text: '' });
    this.timeEl = h('div', { class: 'readout player-time', text: '0:00.0 / 0:00.0' });
    this.timeEl.dataset.tipkey = 'time';
    this.canvas = h('canvas', { class: 'player-wave', width: PLAYER_W, height: PLAYER_H });
    this.meter = h('canvas', { class: 'player-meter', width: PLAYER_W, height: PLAYER_METER_H });
    this.bindCanvas();
    this.bindDrop();

    this.body.append(
      this.fileInput, h('div', { class: 'btn-row' }, this.loadBtn), this.nameEl, this.canvas, this.timeEl, this.infoEl,
      h('div', { class: 'btn-row' }, this.playBtn, this.stopBtn, this.loopBtn),
      this.modifiers.vol.slider.el, this.modifiers.speed.slider.el,
      this.meter,
      h('div', { class: 'btn-row' }, this.gateBtn),
      h('div', { class: 'cap hint', text: 'DROP AN AUDIO FILE ON THIS BLOCK. TRIG IN RESTARTS IT.' }));
    this.setLoop(false);
    this.setGateMode(false);
    this.updateButtons();
  }

  /* ---------- loading ---------- */

  setMessage(text, error = false) {
    this.nameEl.textContent = text;
    this.nameEl.style.color = error ? '#ff4a3a' : '';
  }

  async loadFile(file) {
    const token = ++this.token;
    this.setMessage(`DECODING ${file.name}...`);
    let buffer;
    try {
      buffer = await this.app.ctx.decodeAudioData(await file.arrayBuffer());
    } catch (err) {
      if (token === this.token) this.setMessage(`COULD NOT DECODE ${file.name}`, true);
      return;
    }
    if (token !== this.token) return; // a newer load replaced this one, or the block was deleted
    this.setBuffer(buffer, file.name, `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  setBuffer(buffer, name, key) {
    this.killSource();
    this.playing = false;
    this.pos = 0;
    this.buffer = buffer;
    this.name = name;
    this.key = key;
    this.missing = '';
    PLAYER_CACHE.set(key, { name, buffer });
    this.peaks = this.computePeaks(buffer);
    this.renderWave();
    this.setMessage(name);
    this.updateButtons();
    this.lastT = this.app.ctx.currentTime;
  }

  computePeaks(buf) {
    const mins = new Float32Array(PLAYER_W);
    const maxs = new Float32Array(PLAYER_W);
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const n = buf.length;
    let top = 0;
    for (let x = 0; x < PLAYER_W; x++) {
      const a = Math.floor((x * n) / PLAYER_W);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / PLAYER_W));
      let lo = 0;
      let hi = 0;
      for (const d of chans) {
        for (let i = a; i < b; i++) {
          const v = d[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      mins[x] = lo;
      maxs[x] = hi;
      top = Math.max(top, -lo, hi);
    }
    return { mins, maxs, top };
  }

  // Pre-draws the waveform twice (dim for what is still to come, bright for what has played) so a frame only has to blit.
  renderWave() {
    const plotH = PLAYER_H - PLAYER_RULER;
    const { mins, maxs, top } = this.peaks;
    const mid = plotH / 2;
    const amp = (mid - 5) / Math.max(top, 0.02);
    const make = (fill) => {
      const c = document.createElement('canvas');
      c.width = PLAYER_W;
      c.height = plotH;
      const g = c.getContext('2d');
      g.fillStyle = fill(g);
      for (let x = 0; x < PLAYER_W; x++) {
        const y0 = mid - maxs[x] * amp;
        g.fillRect(x, y0, 1, Math.max(1.5, (maxs[x] - mins[x]) * amp));
      }
      return c;
    };
    this.waveDim = make(() => 'rgba(51,255,102,0.38)');
    this.waveLit = make((g) => {
      const grad = g.createLinearGradient(0, 0, 0, plotH);
      grad.addColorStop(0, '#d8ffe4');
      grad.addColorStop(0.5, '#33ff66');
      grad.addColorStop(1, '#d8ffe4');
      return grad;
    });
  }

  /* ---------- transport ---------- */

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  speedNow() {
    const wired = this.isWired('speed') ? this.app.valueFor(this, 'speed') : undefined;
    return Math.max(0, typeof wired === 'number' && Number.isFinite(wired) ? wired : this.modifiers.speed.slider.get());
  }

  startSource(offset) {
    this.killSource();
    const ctx = this.app.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    src.playbackRate.value = 0;
    this.speedNode.connect(src.playbackRate);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, ctx.currentTime);
    env.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.006);
    src.connect(env);
    env.connect(this.vol);
    src.onended = () => {
      if (this.src !== src) return;
      // reached the end of the file: rewind and stop
      this.src = null;
      this.env = null;
      this.playing = false;
      this.pos = 0;
      this.discard(src, env);
      this.updateButtons();
    };
    src.start(0, clamp(offset, 0, Math.max(0, this.duration - 0.001)));
    this.src = src;
    this.env = env;
  }

  discard(src, env) {
    try { this.speedNode.disconnect(src.playbackRate); } catch (_) { /* already gone */ }
    src.disconnect();
    env.disconnect();
  }

  // Fades out quickly, so stopping and seeking do not click.
  killSource() {
    const { src, env } = this;
    if (!src) return;
    this.src = null;
    this.env = null;
    src.onended = null;
    const t = this.app.ctx.currentTime;
    env.gain.cancelScheduledValues(t);
    env.gain.setTargetAtTime(0, t, 0.004);
    try { src.stop(t + 0.03); } catch (_) { /* never started */ }
    setTimeout(() => this.discard(src, env), 150);
  }

  play(from) {
    if (!this.buffer) return;
    if (this.app.ctx.state === 'suspended') this.app.ctx.resume();
    if (from !== undefined) this.pos = from;
    else if (this.pos >= this.duration - 0.01) this.pos = 0;
    this.advance();
    this.startSource(this.pos);
    this.playing = true;
    this.updateButtons();
  }

  pause() {
    if (!this.playing) return;
    this.advance();
    this.killSource();
    this.playing = false;
    this.updateButtons();
  }

  toggle() {
    if (!this.buffer) { this.fileInput.click(); return; }
    if (this.playing) this.pause(); else this.play();
  }

  stop() {
    this.killSource();
    this.playing = false;
    this.pos = 0;
    this.updateButtons();
  }

  seek(seconds) {
    if (!this.buffer) return;
    this.pos = clamp(seconds, 0, this.duration);
    if (this.playing) this.play(this.pos);
  }

  setLoop(on) {
    this.loop = on;
    this.loopBtn.classList.toggle('active', on);
    if (this.src) this.src.loop = on;
  }

  setGateMode(on) {
    this.gateMode = on;
    this.gateBtn.classList.toggle('active', on);
  }

  updateButtons() {
    this.playBtn.textContent = this.playing ? 'PAUSE' : 'PLAY';
    this.playBtn.classList.toggle('active', this.playing);
    this.stopBtn.disabled = !this.buffer;
  }

  // Moves the position forward by the audio time that passed since last time, at the current speed.
  advance() {
    const t = this.app.ctx.currentTime;
    const dt = t - this.lastT;
    this.lastT = t;
    if (!this.playing || dt <= 0 || !this.buffer) return;
    this.pos += dt * this.speedNow();
    if (this.loop) this.pos %= this.duration;
    else this.pos = Math.min(this.pos, this.duration);
  }

  /* ---------- trigger, outputs, state ---------- */

  readTrigger() {
    this.trigAn.getFloatTimeDomainData(this.trigBuf);
    let high = false;
    for (let i = 0; i < this.trigBuf.length; i++) if (this.trigBuf[i] > 0.5) { high = true; break; }
    if (this.buffer) {
      if (high && !this.trigHigh) this.play(0);
      else if (!high && this.trigHigh && this.gateMode) this.stop();
    }
    this.trigHigh = high;
  }

  // Runs every frame, also while the block's tab is hidden, so the audio and the outputs never depend on the display.
  tick() {
    this.advance();
    this.readTrigger();
    const at = this.app.ctx.currentTime;
    const pos = this.duration ? this.pos / this.duration : 0;
    const play = this.playing ? 1 : 0;
    if (play !== this.outVals.play) this.outNodes.play.offset.setValueAtTime(play, at);
    this.outVals.pos = pos;
    this.outVals.play = play;
    this.outNodes.pos.offset.setTargetAtTime(pos, at, 0.03);
  }

  getValue(portId) { return this.outVals[portId]; }

  audioIn(portId) { return portId === 'trig' ? this.trigIn : this.modifiers[portId].param; }

  audioOut(portId) {
    if (portId === 'l') return this.left;
    if (portId === 'r') return this.right;
    return this.outNodes[portId] || this.mono;
  }

  getState() {
    return { ...super.getState(), file: this.name || this.missing, key: this.key, loop: this.loop, gate: this.gateMode };
  }

  setState(s) {
    super.setState(s);
    this.setLoop(!!s.loop);
    this.setGateMode(!!s.gate);
    const hit = s.key && PLAYER_CACHE.get(s.key);
    if (hit) this.setBuffer(hit.buffer, hit.name, s.key);
    else if (s.file) {
      this.missing = s.file;
      this.setMessage(`CHOOSE ${s.file} AGAIN`, true);
    }
  }

  /* ---------- display ---------- */

  fractionAt(e) {
    const r = this.canvas.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  }

  bindCanvas() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.buffer) { this.fileInput.click(); return; }
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.scrub = this.fractionAt(e);
    });
    c.addEventListener('pointermove', (e) => {
      this.hover = this.fractionAt(e);
      if (this.scrub !== null) this.scrub = this.hover;
    });
    c.addEventListener('pointerup', () => {
      if (this.scrub === null) return;
      this.seek(this.scrub * this.duration);
      this.scrub = null;
    });
    c.addEventListener('pointerleave', () => { this.hover = null; });
  }

  bindDrop() {
    const over = (on) => { this.dragOver = on; this.el.classList.toggle('drop-target', on); };
    this.el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      over(true);
    });
    this.el.addEventListener('dragleave', (e) => { if (!this.el.contains(e.relatedTarget)) over(false); });
    this.el.addEventListener('drop', (e) => {
      over(false);
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation(); // the page-wide handler would try to read it as a project file
      const file = [...e.dataTransfer.files].find(isAudioFile);
      if (file) this.loadFile(file);
      else this.setMessage('THAT IS NOT AN AUDIO FILE', true);
    });
  }

  draw() {
    this.tick();
    this.syncModifiers();
    this.drawWave();
    this.drawMeter();
    const dur = this.duration;
    const shown = this.scrub !== null ? this.scrub * dur : this.pos;
    const text = `${playerTime(shown)} / ${playerTime(dur)}`;
    if (this.timeEl.textContent !== text) this.timeEl.textContent = text;
    const b = this.buffer;
    const info = b
      ? `${b.numberOfChannels === 1 ? 'MONO' : 'STEREO'}  |  ${b.sampleRate} HZ  |  PEAK ${(this.peaks.top > 1e-5 ? 20 * Math.log10(this.peaks.top) : -100).toFixed(1)} DB`
      : '';
    if (this.infoEl.textContent !== info) this.infoEl.textContent = info;
  }

  label(g, text, x, y, color, align = 'left') {
    g.font = '10px monospace';
    g.textAlign = align;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(1,6,3,0.85)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.textAlign = 'left';
  }

  drawWave() {
    const g = this.canvas.getContext('2d');
    const W = PLAYER_W;
    const H = PLAYER_H;
    const plotH = H - PLAYER_RULER;
    const bg = g.createLinearGradient(0, 0, 0, plotH);
    bg.addColorStop(0, '#04140a');
    bg.addColorStop(0.5, '#020a05');
    bg.addColorStop(1, '#04140a');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#010603';
    g.fillRect(0, plotH, W, PLAYER_RULER);
    g.strokeStyle = 'rgba(51,255,102,0.3)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, Math.round(plotH / 2) + 0.5);
    g.lineTo(W, Math.round(plotH / 2) + 0.5);
    g.stroke();

    if (!this.buffer) {
      g.setLineDash([6, 5]);
      g.strokeStyle = this.dragOver ? '#ffb000' : 'rgba(51,255,102,0.45)';
      g.lineWidth = 2;
      g.strokeRect(10, 10, W - 20, plotH - 20);
      g.setLineDash([]);
      this.label(g, this.missing ? `CHOOSE ${this.missing} AGAIN` : 'DROP AN AUDIO FILE HERE', W / 2, plotH / 2 - 2, this.dragOver ? '#ffb000' : '#33ff66', 'center');
      this.label(g, 'OR CLICK TO CHOOSE ONE', W / 2, plotH / 2 + 14, '#1b8a38', 'center');
      return;
    }

    const dur = this.duration;
    const frac = this.scrub !== null ? this.scrub : dur ? this.pos / dur : 0;
    const px = Math.round(frac * W);
    g.drawImage(this.waveDim, 0, 0);
    if (px > 0) {
      g.save();
      g.beginPath();
      g.rect(0, 0, px, plotH);
      g.clip();
      g.drawImage(this.waveLit, 0, 0);
      g.restore();
    }

    // time ruler
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
    const step = steps.find((s) => dur / s <= 7) || 3600;
    g.strokeStyle = 'rgba(51,255,102,0.16)';
    g.beginPath();
    for (let t = step; t < dur - step * 0.2; t += step) {
      const x = Math.round((t / dur) * W) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, plotH + 3);
    }
    g.stroke();
    for (let t = step; t < dur - step * 0.4; t += step) this.label(g, playerTime(t, false), (t / dur) * W, H - 3, '#1b8a38', 'center');
    this.label(g, '0:00', 2, H - 3, '#1b8a38');
    this.label(g, playerTime(dur, false), W - 2, H - 3, '#1b8a38', 'right');

    if (this.hover !== null && this.scrub === null) {
      const x = Math.round(this.hover * W) + 0.5;
      g.strokeStyle = 'rgba(255,176,0,0.7)';
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, plotH);
      g.stroke();
      const right = this.hover > 0.8;
      this.label(g, playerTime(this.hover * dur), right ? x - 4 : x + 4, 12, '#ffb000', right ? 'right' : 'left');
    }

    // playhead
    const head = this.scrub !== null ? '#ffb000' : '#ffffff';
    g.shadowColor = head;
    g.shadowBlur = 8;
    g.fillStyle = head;
    g.fillRect(Math.min(px, W - 2), 0, 2, plotH);
    g.beginPath();
    g.moveTo(Math.min(px, W - 2) - 5, 0);
    g.lineTo(Math.min(px, W - 2) + 7, 0);
    g.lineTo(Math.min(px, W - 2) + 1, 7);
    g.fill();
    g.shadowBlur = 0;
    if (this.loop) this.label(g, 'LOOP', W - 4, 12, '#ffb000', 'right');
  }

  // Left and right level bars (-60 to 0 dB) with a held peak.
  drawMeter() {
    const g = this.meter.getContext('2d');
    const W = PLAYER_W;
    const H = PLAYER_METER_H;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    const bw = W - 16;
    const x0 = 14;
    const grad = g.createLinearGradient(x0, 0, x0 + bw, 0);
    grad.addColorStop(0, '#1fb84a');
    grad.addColorStop(0.7, '#33ff66');
    grad.addColorStop(0.86, '#ffb000');
    grad.addColorStop(1, '#ff4a3a');
    const now = performance.now();
    [['L', this.anL], ['R', this.anR]].forEach(([name, an], i) => {
      an.node.getFloatTimeDomainData(an.buf);
      let pk = 0;
      for (let k = an.buf.length - 2048; k < an.buf.length; k++) { const a = Math.abs(an.buf[k]); if (a > pk) pk = a; }
      const db = pk > 1e-5 ? 20 * Math.log10(pk) : -100;
      if (db >= this.meterHold[i]) { this.meterHold[i] = db; this.meterHoldT[i] = now; } else if (now - this.meterHoldT[i] > 700) this.meterHold[i] = Math.max(db, this.meterHold[i] - 0.8);
      const y = 3 + i * 13;
      const px = (v) => clamp((v + 60) / 60, 0, 1) * bw;
      g.fillStyle = '#04140a';
      g.fillRect(x0, y, bw, 10);
      g.fillStyle = grad;
      g.fillRect(x0, y, px(db), 10);
      g.fillStyle = '#ffffff';
      g.fillRect(x0 + Math.max(0, px(this.meterHold[i]) - 1), y, 2, 10);
      this.label(g, name, 1, y + 9, '#1b8a38');
    });
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.beginPath();
    for (let db = -48; db <= 0; db += 12) {
      const x = Math.round(x0 + ((db + 60) / 60) * bw) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, H);
    }
    g.stroke();
  }

  destroy() {
    this.token++;
    this.killSource();
    for (const n of Object.values(this.outNodes)) { n.stop(); n.disconnect(); }
    this.speedNode.stop();
    for (const n of [this.speedNode, this.vol, this.mono, this.split, this.left, this.right, this.anL.node, this.anR.node, this.trigIn, this.trigAn]) n.disconnect();
    // forget the decoded audio unless another block still plays the same file
    if (this.key && ![...this.app.blocks.values()].some((b) => b !== this && b.type === 'player' && b.key === this.key)) PLAYER_CACHE.delete(this.key);
  }
}

Object.assign(BLOCK_TYPES, { player: AudioPlayerBlock });

// A dropped audio file that is not on a player block gets a new player of its own.
App.prototype.dropAudioFile = function dropAudioFile(file) {
  const tab = this.activeTab;
  const spot = this.findFreeSpot(tab, 290, 440);
  const block = this.addBlock('player', spot.x, spot.y, tab);
  if (!spot.visible) this.scrollToWs(spot.x - 20, spot.y - 20);
  this.clearSelection();
  this.setSelected(block, true);
  block.loadFile(file);
  this.setStatus(`ADDED AUDIO PLAYER FOR ${file.name}`);
};
