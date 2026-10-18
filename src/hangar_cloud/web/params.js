// The Parameters tab: read, search, edit, save and load a vehicle's parameters.

const SHOW = 200;  // rows drawn at once; searching narrows the rest down

export class ParamEditor {
  constructor({ api, toast, el, root }) {
    Object.assign(this, { api, toast, el, root });
    this.vehicle = null;
    this.data = null;      // {params: {NAME: [value, isInt]}, count, complete, changed, version, type}
    this.first = {};       // values when first read, for "changed"
    this.meta = new Map(); // "type/version" -> descriptions
    this.open = new Set(); // rows with their details shown
    this.fetching = false;
    this.q = (s) => root.querySelector(s);
    this.q('#param-vehicle').onchange = (e) => this.show(e.target.value);
    this.q('#param-fetch').onclick = () => this.fetch();
    this.q('#param-search').oninput = () => this.render();
    this.q('#param-changed').onchange = () => this.render();
    this.q('#param-save').onclick = () => this.save();
    this.q('#param-file').onchange = (e) => { if (e.target.files[0]) this.load(e.target.files[0]); e.target.value = ''; };
  }

  get active() { return this.root.classList.contains('active'); }

  // called with every telemetry update
  setVehicles(vehicles) {
    const sel = this.q('#param-vehicle');
    const names = vehicles.map((v) => v.name);
    if ([...sel.options].map((o) => o.value).join() !== names.join()) {
      sel.replaceChildren(...names.map((n) => this.el('option', { value: n }, n)));
      if (!names.includes(this.vehicle)) this.vehicle = null;
    }
    this.vehicles = vehicles;
    if (!names.length) {
      this.vehicle = null;
      this.data = null;
      this.render();
      return;
    }
    if (!this.vehicle) this.vehicle = names[0];
    sel.value = this.vehicle;
    const v = vehicles.find((x) => x.name === this.vehicle);
    const p = v && v.params;
    if (this.fetching && p) this.status(`Reading parameters… ${p.have}${p.count ? ` of ${p.count}` : ''}`);
    if (this.active && p && this.data && p.changed !== this.data.changed && !this.fetching) this.reload();
    else if (this.active && !this.data && v && v.status === 'online' && !this.fetching && !this.loading) this.show(this.vehicle);
  }

  shown() {
    if (this.vehicle && !this.data) this.show(this.vehicle);
    else this.render();
  }

  async show(name) {
    this.vehicle = name;
    this.data = null;
    this.first = {};
    this.open.clear();
    this.render();
    this.loading = true;
    try {
      const data = await this.api(`/api/vehicles/${encodeURIComponent(name)}/params`);
      if (name !== this.vehicle) return;
      if (!data.complete) { await this.fetch(); return; }
      this.take(data);
    } catch (e) {
      this.status(e.message);
    } finally { this.loading = false; }
  }

  async reload() {
    try {
      const data = await this.api(`/api/vehicles/${encodeURIComponent(this.vehicle)}/params`);
      if (data.vehicle === this.vehicle) this.take(data);
    } catch { /* the next update tries again */ }
  }

  async fetch() {
    const name = this.vehicle;
    if (!name || this.fetching) return;
    this.fetching = true;
    this.q('#param-fetch').disabled = true;
    this.status('Reading parameters…');
    try {
      const data = await this.api(`/api/vehicles/${encodeURIComponent(name)}/params/fetch`, {});
      if (name === this.vehicle) this.take(data);
    } catch (e) {
      this.status(e.message);
      this.toast(`${name}: ${e.message}`, 'bad');
    } finally {
      this.fetching = false;
      this.q('#param-fetch').disabled = false;
    }
  }

  take(data) {
    this.data = data;
    for (const [n, [v]] of Object.entries(data.params)) if (!(n in this.first)) this.first[n] = v;
    this.loadMeta(false);
    this.render();
  }

  metaKey() { return this.data ? `${this.data.type}/${this.data.version}` : ''; }

  async loadMeta(download) {
    const key = this.metaKey();
    if (!key || (this.meta.has(key) && !download)) return;
    const url = `/api/vehicles/${encodeURIComponent(this.vehicle)}/params/meta`;
    try {
      this.meta.set(key, download ? 'loading' : null);
      if (download) this.render();
      const m = await this.api(url, download ? {} : undefined);
      this.meta.set(key, m);
    } catch (e) {
      this.meta.set(key, null);
      if (download) this.toast(e.message, 'bad');
    }
    this.render();
  }

  status(text, ...extra) {
    this.q('#param-status').replaceChildren(text, ...extra);
  }

  // --- list --------------------------------------------------------------------

  render() {
    const list = this.q('#param-list');
    this.q('#param-save').disabled = !this.data;
    this.q('#param-load').classList.toggle('disabled', !this.data);
    if (!this.vehicle) {
      this.status('Parameters show up here when the simulation runs.');
      list.replaceChildren();
      return;
    }
    if (!this.data) { list.replaceChildren(); return; }
    const meta = this.meta.get(this.metaKey());
    const docs = meta && meta !== 'loading' ? meta.params : {};
    const q = this.q('#param-search').value.trim().toLowerCase();
    const changedOnly = this.q('#param-changed').checked;
    const names = Object.keys(this.data.params).filter((n) => {
      if (changedOnly && !this.changed(n, docs[n])) return false;
      if (!q) return true;
      const d = docs[n];
      return n.toLowerCase().includes(q) || (d && (d.n + ' ' + d.d).toLowerCase().includes(q));
    });
    // name matches first, then description matches
    if (q) names.sort((a, b) => (b.toLowerCase().includes(q) - a.toLowerCase().includes(q)) || a.localeCompare(b));

    const count = Object.keys(this.data.params).length;
    const extra = [];
    if (meta === 'loading') extra.push(' · getting descriptions…');
    else if (meta) extra.push(` · descriptions for ${meta.firmware} ${meta.release}`);
    else if (meta === null && this.data.type) {
      extra.push(' · ', this.el('button', {
        class: 'link', onclick: () => this.loadMeta(true),
        title: 'Downloads the parameter list of this firmware version from autotest.ardupilot.org, once',
      }, 'Get descriptions'));
    }
    this.status(`${count} parameters${this.data.version ? ` · firmware ${this.data.version}` : ''}`, ...extra);

    const rows = names.slice(0, SHOW).map((n) => this.row(n, docs[n]));
    if (names.length > SHOW) rows.push(this.el('div', { class: 'muted more' }, `${names.length - SHOW} more; type to narrow down`));
    if (!names.length) rows.push(this.el('div', { class: 'empty' }, changedOnly ? 'Nothing changed yet.' : 'No match.'));
    // keep a value being typed through live updates
    const active = document.activeElement;
    const focused = active && list.contains(active) && active.matches('input, select') ? active.closest('.prm')?.dataset.name : null;
    if (focused) {
      const keep = list.querySelector(`.prm[data-name="${focused}"]`);
      const i = names.indexOf(focused);
      if (keep && i >= 0 && i < SHOW) rows[i] = keep;
    }
    list.replaceChildren(...rows);
  }

  row(name, doc) {
    const [value, isInt] = this.data.params[name];
    const changed = this.changed(name, doc);
    const control = this.control(name, value, isInt, doc);
    const head = this.el('div', { class: 'prm-head' },
      this.el('button', { class: 'prm-name', onclick: () => this.toggle(name), title: doc ? doc.n : 'Details' },
        this.el('code', {}, name), doc && doc.n ? this.el('small', {}, doc.n) : null),
      control, this.el('span', { class: 'unit' }, doc?.u || ''));
    const row = this.el('div', { class: 'prm' + (changed ? ' changed' : ''), 'data-name': name }, head);
    if (this.open.has(name)) row.append(this.details(name, value, doc));
    return row;
  }

  // changed since read, leaving out counters the autopilot keeps itself (STAT_RUNTIME, …)
  changed(name, doc) {
    const first = this.first[name];
    if (first === undefined || this.data.params[name][0] === first) return false;
    return !(doc?.vol || name.startsWith('STAT_'));
  }

  control(name, value, isInt, doc) {
    if (doc?.v && String(fmt(value, isInt)) in doc.v && !doc.ro) {
      const sel = this.el('select', { 'aria-label': name });
      for (const [code, label] of Object.entries(doc.v).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        sel.append(this.el('option', { value: code }, `${code} · ${label}`));
      }
      sel.value = String(fmt(value, isInt));
      sel.onchange = () => this.set(name, Number(sel.value), doc);
      return sel;
    }
    const input = this.el('input', {
      type: 'number', value: fmt(value, isInt), step: isInt ? '1' : 'any', 'aria-label': name,
    });
    if (doc?.ro) input.disabled = true;
    const commit = () => {
      const x = Number(input.value);
      if (input.value === '' || Number.isNaN(x)) { input.value = fmt(value, isInt); return; }
      if (x !== value) this.set(name, x, doc);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') { input.value = fmt(value, isInt); input.blur(); }
    });
    input.addEventListener('change', commit);
    return input;
  }

  details(name, value, doc) {
    const box = this.el('div', { class: 'prm-doc' });
    if (!doc) {
      box.append(this.el('p', { class: 'muted' }, this.meta.get(this.metaKey())
        ? 'No description for this parameter.' : 'Use “Get descriptions” above for what this parameter does.'));
      return box;
    }
    box.append(this.el('p', {}, doc.d));
    const facts = [];
    if (doc.r) facts.push(`range ${doc.r[0]} … ${doc.r[1]}${doc.u ? ' ' + doc.u : ''}`);
    if (doc.i) facts.push(`step ${doc.i}`);
    if (doc.rb) facts.push('needs a reboot');
    if (doc.ro) facts.push('read-only');
    if (doc.adv) facts.push('advanced');
    if (facts.length) box.append(this.el('p', { class: 'muted' }, facts.join(' · ')));
    if (doc.b) {
      const bits = this.el('div', { class: 'bits' });
      for (const [bit, label] of Object.entries(doc.b).sort((a, b) => Number(a[0]) - Number(b[0]))) {
        const mask = 2 ** Number(bit);
        const box2 = this.el('input', { type: 'checkbox' });
        box2.checked = Math.floor(value / mask) % 2 === 1;
        box2.onchange = () => this.set(name, box2.checked ? value + mask : value - mask, doc);
        bits.append(this.el('label', {}, box2, ` ${bit} · ${label}`));
      }
      box.append(bits);
    }
    return box;
  }

  toggle(name) {
    if (this.open.has(name)) this.open.delete(name); else this.open.add(name);
    this.render();
  }

  async set(name, value, doc) {
    if (doc?.r && (value < doc.r[0] || value > doc.r[1]) &&
        !confirm(`${name} = ${value} is outside its usual range (${doc.r[0]} … ${doc.r[1]}). Set it anyway?`)) {
      this.render();
      return;
    }
    const row = this.q(`.prm[data-name="${name}"]`);
    row?.classList.add('busy');
    try {
      const r = await this.api(`/api/vehicles/${encodeURIComponent(this.vehicle)}/params`, { name, value });
      this.data.params[r.name] = [r.value, this.data.params[r.name]?.[1] ?? false];
      this.toast(`${this.vehicle}: ${r.name} = ${fmt(r.value, this.data.params[r.name][1])}${doc?.rb ? ' (reboot needed)' : ''}`);
    } catch (e) {
      this.toast(`${name}: ${e.message}`, 'bad');
    }
    this.render();
  }

  // --- files -------------------------------------------------------------------

  save() {
    if (!this.data) return;
    const lines = Object.entries(this.data.params).map(([n, [v, isInt]]) => `${n},${fmt(v, isInt)}`);
    const text = `# ${this.vehicle}, saved by Hangar Cloud ${new Date().toISOString()}\n${lines.join('\n')}\n`;
    const a = this.el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `${this.vehicle}.param` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async load(file) {
    if (!this.data) return;
    const wanted = parseParamFile(await file.text());
    const diff = [], unknown = [];
    for (const [n, v] of wanted) {
      const cur = this.data.params[n];
      if (!cur) unknown.push(n);
      else if (Math.abs(cur[0] - v) > 1e-6 * Math.max(1, Math.abs(v))) diff.push([n, cur[0], v, cur[1]]);
    }
    const box = this.q('#param-import');
    const close = () => box.replaceChildren();
    if (!diff.length) {
      this.toast(unknown.length ? `Nothing to change; ${unknown.length} names not on this vehicle` : 'Nothing to change: same values');
      return;
    }
    const apply = this.el('button', { class: 'btn primary' }, `Apply ${diff.length}`);
    apply.onclick = async () => {
      apply.disabled = true;
      let done = 0;
      const failed = [];
      for (const [n, , v] of diff) {
        apply.textContent = `Applying ${++done}/${diff.length}…`;
        try {
          const r = await this.api(`/api/vehicles/${encodeURIComponent(this.vehicle)}/params`, { name: n, value: v });
          this.data.params[r.name] = [r.value, this.data.params[r.name][1]];
        } catch { failed.push(n); }
      }
      close();
      this.render();
      this.toast(failed.length ? `${diff.length - failed.length} set; failed: ${failed.join(', ')}` : `${diff.length} parameters set`,
        failed.length ? 'bad' : '');
    };
    const items = diff.slice(0, 300).map(([n, a, b, isInt]) =>
      this.el('li', {}, this.el('code', {}, n), ` ${fmt(a, isInt)} → `, this.el('b', {}, String(fmt(b, isInt)))));
    box.replaceChildren(this.el('section', { class: 'card' },
      this.el('h3', {}, `${file.name}: ${diff.length} different`),
      unknown.length ? this.el('p', { class: 'muted' }, `${unknown.length} names are not on this vehicle and are skipped.`) : null,
      this.el('ul', { class: 'diff' }, ...items),
      this.el('div', { class: 'row' }, apply, this.el('button', { class: 'btn', onclick: close }, 'Cancel'))));
    box.scrollIntoView({ block: 'nearest' });
  }
}

// "NAME,VALUE", "NAME VALUE" or "NAME\tVALUE" lines; # comments (Mission Planner, MAVProxy, QGC)
export function parseParamFile(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/[,\s]+/);
    // QGC: vehicle-id component-id NAME VALUE type
    const [name, value] = parts.length >= 5 && /^\d+$/.test(parts[0]) ? [parts[2], parts[3]] : parts;
    const x = Number(value);
    if (/^[A-Z][A-Z0-9_]*$/i.test(name || '') && value !== undefined && !Number.isNaN(x)) out.set(name.toUpperCase(), x);
  }
  return out;
}

function fmt(v, isInt) {
  return isInt ? Math.round(v) : Number(v.toPrecision(7));
}
