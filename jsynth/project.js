'use strict';

/* Save and load: projects and single packs are plain JSON files. Nothing leaves the browser. */

const PROJECT_FORMAT = 'jsynth';
const PACK_FORMAT = 'jsynth-pack';
const FORMAT_VERSION = 1;

const safeFileName = (name, fallback) => {
  const clean = String(name || '').trim().replace(/\.json$/i, '').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
  return `${clean || fallback}.json`;
};

Object.assign(App.prototype, {
  serializeProject() {
    return {
      format: PROJECT_FORMAT,
      version: FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      folders: [...this.folders.values()].map((f) => ({ id: f.id, name: f.name, parent: f.parent, open: f.open })),
      main: this.serializeTab(this.mainTab),
    };
  },

  download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = h('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  async saveProject() {
    const name = await this.askText('SAVE PROJECT AS (.json)', this.projectName || 'my-patch');
    if (name === null || !name.trim()) return;
    const file = safeFileName(name, 'my-patch');
    this.projectName = file.replace(/\.json$/, '');
    this.download(file, JSON.stringify(this.serializeProject(), null, 2));
    this.setStatus(`SAVED ${file}`);
  },

  async exportPack(pack) {
    const name = await this.askText('EXPORT PACK AS (.json)', pack.name.toLowerCase());
    if (name === null || !name.trim()) return;
    const file = safeFileName(name, 'pack');
    this.download(file, JSON.stringify({ format: PACK_FORMAT, version: FORMAT_VERSION, pack: this.serializePack(pack) }, null, 2));
    this.setStatus(`EXPORTED ${file}`);
  },

  // Reads a project file (replaces everything) or a pack file (adds the pack to the open tab).
  async loadFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      this.setStatus(`${file.name} IS NOT VALID JSON`, true);
      return;
    }
    if (!data || typeof data !== 'object' || ![PROJECT_FORMAT, PACK_FORMAT].includes(data.format)) {
      this.setStatus(`${file.name} IS NOT A JSYNTH FILE`, true);
      return;
    }
    if (data.version > FORMAT_VERSION) {
      this.setStatus(`${file.name} WAS SAVED BY A NEWER JSYNTH`, true);
      return;
    }
    if (data.format === PACK_FORMAT) {
      if (!data.pack || !Array.isArray(data.pack.blocks)) this.setStatus(`${file.name} HAS NO PACK IN IT`, true);
      else this.importPackData(data.pack);
      return;
    }
    if (!data.main || !Array.isArray(data.main.blocks)) {
      this.setStatus(`${file.name} HAS NO PROJECT IN IT`, true);
      return;
    }
    if (!(await this.askConfirm(`LOAD ${file.name}? THE CURRENT PROJECT WILL BE REPLACED.`, 'LOAD'))) return;
    this.projectName = file.name.replace(/\.json$/i, '');
    this.loadProjectData(data);
  },

  // Removes every block, pack and folder, leaving an empty MAIN tab.
  clearProject() {
    this.switchTab(this.mainTab);
    for (const b of [...this.blocks.values()].filter((b) => b.tab === this.mainTab)) this.removeBlock(b);
    this.clearSelection();
    this.select(null);
    this.folders = new Map();
    this.folderSeq = 0;
    this.stage.scrollTo(0, 0);
  },

  async newProject() {
    if (!(await this.askConfirm('START A NEW EMPTY PROJECT? ANYTHING NOT SAVED WILL BE LOST.', 'NEW'))) return;
    this.clearProject();
    this.projectName = '';
    this.renderTabs();
    this.renderWires();
    this.setStatus('NEW EMPTY PROJECT');
  },

  loadProjectData(data) {
    this.loadSkipped = 0;
    this.clearProject();
    for (const f of data.folders || []) {
      this.folders.set(f.id, { id: f.id, name: f.name, parent: f.parent ?? null, open: f.open !== false });
      this.folderSeq = Math.max(this.folderSeq, f.id);
    }
    this.populateTab(this.mainTab, null, data.main, true);
    this.renderTabs();
    this.renderWires();
    this.setStatus(this.loadSkipped ? `LOADED - ${this.loadSkipped} UNKNOWN BLOCKS SKIPPED` : 'PROJECT LOADED', !!this.loadSkipped);
  },

  importPackData(packData) {
    const tab = this.activeTab;
    const spot = this.findFreeSpot(tab, 300, 360);
    this.loadSkipped = 0;
    const pack = this.addBlock('pack', spot.x, spot.y, tab, packData.name || 'IMPORTED PACK');
    this.populatePack(pack, packData);
    this.clearSelection();
    this.setSelected(pack, true);
    if (!spot.visible) this.scrollToWs(spot.x - 20, spot.y - 20);
    this.renderWires();
    this.setStatus(this.loadSkipped ? `PACK ADDED - ${this.loadSkipped} UNKNOWN BLOCKS SKIPPED` : `PACK ${pack.name} ADDED`, !!this.loadSkipped);
    return pack;
  },
});

window.addEventListener('DOMContentLoaded', () => {
  const picker = document.getElementById('fileInput');
  const ready = () => {
    if (!app.ready) app.setStatus('AUDIO ENGINE IS NOT READY YET', true);
    return app.ready;
  };
  document.getElementById('save').addEventListener('click', () => { if (ready()) app.saveProject(); });
  document.getElementById('newProject').addEventListener('click', () => { if (ready()) app.newProject(); });
  document.getElementById('load').addEventListener('click', () => { if (ready()) picker.click(); });
  picker.addEventListener('change', () => {
    const [file] = picker.files;
    picker.value = '';
    if (file) app.loadFile(file);
  });

  // Dropping a .json file anywhere on the page loads it.
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    if (ready()) app.loadFile(e.dataTransfer.files[0]);
  });

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() === 's') { e.preventDefault(); if (ready()) app.saveProject(); }
    if (e.key.toLowerCase() === 'o') { e.preventDefault(); if (ready()) picker.click(); }
  });
});
