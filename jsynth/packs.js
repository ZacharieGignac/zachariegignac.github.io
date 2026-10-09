'use strict';

/* Packs: a group of blocks that lives in its own tab and is used as a single block elsewhere.
   A pack block exposes ports backed by "pack in" / "pack out" blocks inside its tab. Audio flows
   through plain gain nodes, so the packed blocks keep running no matter which tab is open. */

class PackBlock extends Block {
  constructor(app, x, y, name) {
    app.packCount = (app.packCount || 0) + 1;
    const label = name || `PACK ${app.packCount}`;
    super(app, { type: 'pack', title: label, desc: 'Packed group of blocks' }, x, y);
    this.isPack = true;
    this.name = label;
    this.inBlocks = {};
    this.outBlocks = {};
    this.inNodes = {};
    this.outNodes = {};
    this.portSeq = 0;
    this.packTab = app.createTab(label, this);
    this.el.classList.add('pack');
    this.titleText = this.titleEl.querySelector('span');
    this.titleEl.addEventListener('dblclick', (e) => { if (e.target !== this.closeBtn) app.renamePack(this); });

    this.map = h('canvas', { class: 'scope', width: 240, height: 80 });
    this.count = h('div', { class: 'readout small', text: '0 BLOCKS' });
    this.body.append(
      h('div', { class: 'scope-wrap' }, h('span', { class: 'cap', text: 'INSIDE' }), this.map),
      this.count,
      h('div', { class: 'btn-row' },
        h('button', { text: 'OPEN', onclick: () => app.switchTab(this.packTab) }),
        h('button', { text: 'UNPACK', onclick: () => app.unpack(this) })));
  }

  rename(name) {
    this.name = name;
    this.title = name;
    this.titleText.textContent = name;
    this.packTab.name = name;
    this.app.renderTabs();
  }

  addPackPort(kind, isInput, label, tip) {
    const id = `${isInput ? 'i' : 'o'}${++this.portSeq}`;
    (isInput ? this.inNodes : this.outNodes)[id] = this.app.ctx.createGain();
    this.addPort({ id, label, kind }, !isInput);
    this.portRows[id].querySelector('.name').title = tip || label;
    return id;
  }

  // Creates a pack input together with its "pack in" block inside the pack tab.
  addInlet(kind, label, x, y, tip) {
    const id = this.addPackPort(kind, true, label, tip);
    return this.app.addBlock('packin', x, y, this.packTab, this, id, kind);
  }

  addOutlet(kind, label, x, y, tip) {
    const id = this.addPackPort(kind, false, label, tip);
    return this.app.addBlock('packout', x, y, this.packTab, this, id, kind);
  }

  setPortLabel(id, label) {
    this.portRows[id].querySelector('.name').textContent = label;
  }

  // Called when an inner "pack in/out" block is deleted: the port disappears with it.
  removePackPort(id) {
    if (this.destroying) return;
    const isInput = id[0] === 'i';
    for (const c of this.app.conns.filter((c) => (isInput ? c.to : c.from).block === this && (isInput ? c.to : c.from).port === id)) {
      this.app.disconnect(c);
    }
    const nodes = isInput ? this.inNodes : this.outNodes;
    nodes[id].disconnect();
    delete nodes[id];
    delete (isInput ? this.inBlocks : this.outBlocks)[id];
    this.removePort(id, !isInput);
  }

  audioIn(portId) { return this.inNodes[portId]; }
  audioOut(portId) { return this.outNodes[portId]; }

  getValue(portId) {
    const inner = this.outBlocks[portId];
    return inner ? this.app.valueFor(inner, 'in') : undefined;
  }

  innerBlocks() {
    return [...this.app.blocks.values()].filter((b) => b.tab === this.packTab && !b.isPackIO);
  }

  getState() { return { tab: this.app.serializePack(this) }; }

  draw() {
    const blocks = this.innerBlocks();
    this.count.textContent = `${blocks.length} BLOCK${blocks.length === 1 ? '' : 'S'} - ${Object.keys(this.inBlocks).length} IN / ${Object.keys(this.outBlocks).length} OUT`;
    const g = this.map.getContext('2d');
    const W = this.map.width;
    const H = this.map.height;
    g.fillStyle = '#031006';
    g.fillRect(0, 0, W, H);
    if (!blocks.length) return;
    const rects = blocks.map((b) => ({ x: b.x, y: b.y, w: b.w || 264, h: b.h || 320 }));
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const s = Math.min((W - 12) / (maxX - minX), (H - 12) / (maxY - minY));
    const ox = (W - (maxX - minX) * s) / 2;
    const oy = (H - (maxY - minY) * s) / 2;
    g.strokeStyle = '#33ff66';
    g.fillStyle = 'rgba(51,255,102,0.18)';
    g.lineWidth = 1;
    for (const r of rects) {
      const x = ox + (r.x - minX) * s;
      const y = oy + (r.y - minY) * s;
      g.fillRect(x, y, r.w * s, r.h * s);
      g.strokeRect(x + 0.5, y + 0.5, r.w * s, r.h * s);
    }
  }

  destroy() {
    this.destroying = true;
    const app = this.app;
    if (this.packTab) {
      if (app.activeTab === this.packTab) app.switchTab(this.tab);
      for (const b of this.innerBlocks()) app.removeBlock(b);
      for (const b of [...app.blocks.values()].filter((b) => b.tab === this.packTab)) app.removeBlock(b);
      app.tabs.delete(this.packTab.id);
      this.packTab.ws.remove();
      this.packTab = null;
      app.renderTabs();
    }
    for (const n of [...Object.values(this.inNodes), ...Object.values(this.outNodes)]) n.disconnect();
  }
}

/* Boundary blocks inside a pack's tab. */

class PackInBlock extends Block {
  constructor(app, x, y, pack, portId, kind) {
    super(app, {
      type: 'packin', title: 'PACK INPUT', desc: 'Signal entering the pack',
      outputs: [{ id: 'out', label: kind === 'wave' ? 'WAVE' : 'VALUE', kind }],
    }, x, y);
    this.isPackIO = true;
    this.pack = pack;
    this.portId = portId;
    this.kind = kind;
    pack.inBlocks[portId] = this;
    this.nameInput = h('input', { type: 'text', maxlength: 24, value: pack.portRows[portId].querySelector('.name').textContent });
    this.nameInput.addEventListener('input', () => pack.setPortLabel(portId, this.nameInput.value));
    this.body.append(h('div', { class: 'ctl names' }, h('span', { text: 'NAME' }), this.nameInput));
  }

  audioOut() { return this.pack.inNodes[this.portId]; }
  getValue() { return this.app.valueFor(this.pack, this.portId); }
  destroy() { this.pack.removePackPort(this.portId); }
}

class PackOutBlock extends Block {
  constructor(app, x, y, pack, portId, kind) {
    super(app, {
      type: 'packout', title: 'PACK OUTPUT', desc: 'Signal leaving the pack',
      inputs: [{ id: 'in', label: kind === 'wave' ? 'WAVE' : 'VALUE', kind }],
    }, x, y);
    this.isPackIO = true;
    this.pack = pack;
    this.portId = portId;
    this.kind = kind;
    pack.outBlocks[portId] = this;
    this.nameInput = h('input', { type: 'text', maxlength: 24, value: pack.portRows[portId].querySelector('.name').textContent });
    this.nameInput.addEventListener('input', () => pack.setPortLabel(portId, this.nameInput.value));
    this.body.append(h('div', { class: 'ctl names' }, h('span', { text: 'NAME' }), this.nameInput));
  }

  audioIn() { return this.pack.outNodes[this.portId]; }
  destroy() { this.pack.removePackPort(this.portId); }
}

Object.assign(BLOCK_TYPES, { pack: PackBlock, packin: PackInBlock, packout: PackOutBlock });

/* ---------- app: pack / unpack ---------- */

Object.assign(App.prototype, {
  // Plain-data snapshot of a tab's blocks, wires and (for a pack) its ports.
  serializeTab(tab, pack = null) {
    const blocks = [];
    const ios = [];
    for (const b of this.blocks.values()) {
      if (b.tab !== tab) continue;
      if (b.isPackIO) {
        ios.push({
          key: b.id, isIn: b.type === 'packin', kind: b.kind, portId: b.portId, x: b.x, y: b.y,
          label: pack.portRows[b.portId].querySelector('.name').textContent,
        });
      } else {
        blocks.push({ key: b.id, type: b.type, x: b.x, y: b.y, state: b.getState() });
      }
    }
    const conns = this.conns.filter((c) => c.tab === tab)
      .map((c) => ({ from: [c.from.block.id, c.from.port], to: [c.to.block.id, c.to.port] }));
    const data = { blocks, ios, conns };
    if (pack) Object.assign(data, { name: pack.name, folder: tab.folder });
    return data;
  },

  serializePack(pack) { return this.serializeTab(pack.packTab, pack); },

  // Fills a tab with blocks, settings and wires from serializeTab data. Block types this build
  // does not know are skipped (counted in loadSkipped) along with the wires that touch them.
  populateTab(tab, pack, data, restoreFolders = false) {
    const map = {};
    if (pack) pack.idMap = {}; // old port id -> new port id, so wires into nested packs still match
    for (const io of data.ios || []) {
      const block = io.isIn ? pack.addInlet(io.kind, io.label, io.x, io.y) : pack.addOutlet(io.kind, io.label, io.x, io.y);
      map[io.key] = block;
      pack.idMap[io.portId] = block.portId;
    }
    for (const bd of data.blocks || []) {
      if (!BLOCK_TYPES[bd.type]) { this.loadSkipped = (this.loadSkipped || 0) + 1; continue; }
      let block;
      if (bd.type === 'pack') {
        block = this.addBlock('pack', bd.x, bd.y, tab, bd.state.tab.name);
        this.populateTab(block.packTab, block, bd.state.tab, restoreFolders);
        if (restoreFolders) block.packTab.folder = bd.state.tab.folder ?? null;
      } else {
        block = this.addBlock(bd.type, bd.x, bd.y, tab);
        block.setState(bd.state);
      }
      map[bd.key] = block;
    }
    const portOf = (block, port) => (block.idMap && block.idMap[port]) || port;
    for (const c of data.conns || []) {
      const from = map[c.from[0]];
      const to = map[c.to[0]];
      if (from && to) this.connect(from, portOf(from, c.from[1]), to, portOf(to, c.to[1]));
    }
    for (const block of Object.values(map)) if (block.settle) block.settle();
  },

  populatePack(pack, data) { this.populateTab(pack.packTab, pack, data); },

  clonePack(pack, tab, x, y) {
    const data = this.serializePack(pack);
    const copy = this.addBlock('pack', x, y, tab, `${pack.name.replace(/( COPY)+$/, '')} COPY`);
    this.populatePack(copy, data);
    return copy;
  },

  // A pack tab was dragged somewhere: put a copy of that pack into the target tab.
  dropTab(source, target, x, y) {
    if (!source.pack) return null;
    let px = x;
    let py = y;
    if (px === undefined) {
      const spot = this.findFreeSpot(target, 300, 360, false);
      px = spot.x;
      py = spot.y;
    }
    const copy = this.clonePack(source.pack, target, Math.max(0, px), Math.max(0, py));
    if (target === this.activeTab) {
      this.clearSelection();
      this.setSelected(copy, true);
      this.renderWires();
    }
    return copy;
  },

  async renamePack(pack) {
    const name = await this.askText('PACK NAME', pack.name);
    if (name && name.trim()) pack.rename(name.trim().toUpperCase());
  },

  addPackIO(isInput, kind, x, y) {
    const pack = this.activeTab.pack;
    if (!pack) return null;
    if (x === undefined) {
      const spot = this.findFreeSpot(this.activeTab, 290, 200);
      x = spot.x;
      y = spot.y;
      if (!spot.visible) this.scrollToWs(x - 20, y - 20);
    }
    const label = `${isInput ? 'IN' : 'OUT'} ${pack.portSeq + 1}`;
    return isInput ? pack.addInlet(kind, label, x, y) : pack.addOutlet(kind, label, x, y);
  },

  packSelection(blocks) {
    const tab = this.activeTab;
    const set = new Set(blocks.filter((b) => !b.isPackIO && b.tab === tab));
    if (!set.size) return null;
    this.measureBlocks(tab);
    const list = [...set];
    const minX = Math.min(...list.map((b) => b.x));
    const minY = Math.min(...list.map((b) => b.y));
    const maxR = Math.max(...list.map((b) => b.x + (b.w || 264)));
    const pack = this.addBlock('pack', minX, minY, tab);
    const K = pack.packTab;

    const inner = [];
    const incoming = [];
    const outgoing = [];
    for (const c of this.conns.filter((c) => c.tab === tab)) {
      const a = set.has(c.from.block);
      const b = set.has(c.to.block);
      if (a && b) inner.push(c);
      else if (b) incoming.push(c);
      else if (a) outgoing.push(c);
    }

    this.clearSelection();
    const ox = 340 - minX;
    const oy = 60 - minY;
    for (const b of list) {
      b.tab = K;
      K.ws.append(b.el);
      b.moveTo(b.x + ox, b.y + oy);
    }
    for (const c of inner) { c.tab = K; K.svg.append(c.g); }

    const tip = (b, port, isOut) => `${b.title} ${this.portDef(b, port, isOut).label}`;
    const label = (b, port, isOut) => this.portDef(b, port, isOut).label;
    let inY = 60;
    for (const c of incoming) {
      const target = c.to.block;
      const kind = this.portDef(c.from.block, c.from.port, true).kind;
      this.disconnect(c, true);
      const pin = pack.addInlet(kind, label(target, c.to.port, false), 40, inY, tip(target, c.to.port, false));
      inY += 130;
      this.connect(pin, 'out', target, c.to.port);
      this.connect(c.from.block, c.from.port, pack, pin.portId);
    }

    const groups = new Map();
    for (const c of outgoing) {
      const key = `${c.from.block.id}:${c.from.port}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    let outY = 60;
    for (const conns of groups.values()) {
      const source = conns[0].from;
      const kind = this.portDef(source.block, source.port, true).kind;
      for (const c of conns) this.disconnect(c, true);
      const pout = pack.addOutlet(kind, label(source.block, source.port, true), maxR + ox + 80, outY, tip(source.block, source.port, true));
      outY += 130;
      this.connect(source.block, source.port, pout, 'in');
      for (const c of conns) this.connect(pack, pout.portId, c.to.block, c.to.port);
    }

    this.select(null);
    this.setSelected(pack, true);
    this.renderTabs();
    this.renderWires();
    return pack;
  },

  unpack(pack) {
    const T = pack.tab;
    const K = pack.packTab;
    if (!K || T !== this.activeTab) return;

    const ios = [...this.blocks.values()].filter((b) => b.tab === K && b.isPackIO);
    const real = [...this.blocks.values()].filter((b) => b.tab === K && !b.isPackIO);
    const externalSource = (portId) => {
      const c = this.conns.find((c) => c.to.block === pack && c.to.port === portId);
      return c ? c.from : null;
    };
    // Where a signal inside the pack really comes from once the pack's boundary is removed.
    const resolve = (from) => (from.block.isPackIO && from.block.pack === pack ? externalSource(from.block.portId) : from);

    // Plan: every new direct connection, and every input that ends up unwired.
    const plan = [];
    const emptied = [];
    for (const c of this.conns.filter((c) => c.tab === K && c.from.block.isPackIO && !c.to.block.isPackIO)) {
      const src = resolve(c.from);
      if (src) plan.push([src.block, src.port, c.to.block, c.to.port]); else emptied.push([c.to.block, c.to.port]);
    }
    for (const [portId, pout] of Object.entries(pack.outBlocks)) {
      const feed = this.conns.find((c) => c.to.block === pout);
      const src = feed ? resolve(feed.from) : null;
      for (const o of this.conns.filter((c) => c.from.block === pack && c.from.port === portId)) {
        if (src) plan.push([src.block, src.port, o.to.block, o.to.port]); else emptied.push([o.to.block, o.to.port]);
      }
    }

    for (const c of this.conns.filter((c) => c.from.block === pack || c.to.block === pack
      || (c.tab === K && (c.from.block.isPackIO || c.to.block.isPackIO)))) {
      this.disconnect(c, true);
    }

    const minX = real.length ? Math.min(...real.map((b) => b.x)) : 0;
    const minY = real.length ? Math.min(...real.map((b) => b.y)) : 0;
    this.clearSelection();
    for (const b of real) {
      b.tab = T;
      T.ws.append(b.el);
      b.moveTo(b.x - minX + pack.x, b.y - minY + pack.y);
      this.bringToFront(b);
    }
    for (const c of this.conns.filter((c) => c.tab === K)) { c.tab = T; T.svg.append(c.g); }

    pack.destroying = true;
    for (const b of ios) this.removeBlock(b);
    this.removeBlock(pack);
    K.ws.remove();
    this.tabs.delete(K.id);

    for (const [fb, fp, tb, tp] of plan) this.connect(fb, fp, tb, tp);
    const wired = new Set(plan.map(([, , tb, tp]) => `${tb.id}:${tp}`));
    for (const [b, p] of emptied) if (!wired.has(`${b.id}:${p}`)) b.onPortChange(p, false);

    for (const b of real) this.setSelected(b, true);
    this.renderTabs();
    this.renderWires();
  },
});
