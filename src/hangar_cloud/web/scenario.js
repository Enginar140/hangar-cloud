// The scenario as a form: world, vehicles (add, copy, remove), positions, cameras, parameters.
// It edits the same data as the YAML file; fields it does not show (outputs, …) are kept.

export class ScenarioForm {
  constructor({ el, root, onChange }) {
    Object.assign(this, { el, root, onChange });
    this.data = null;
    this.catalog = { models: [], worlds: [] };
    this.disabled = false;
  }

  set(data, catalog) {
    this.data = structuredClone(data || { vehicles: [] });
    this.data.vehicles ||= [];
    if (catalog) this.catalog = catalog;
    this.render();
  }

  get() {
    return structuredClone(this.data);
  }

  setDisabled(on) {
    this.disabled = on;
    for (const x of this.root.querySelectorAll('input, select, textarea, button')) x.disabled = on;
  }

  changed() {
    this.onChange?.();
  }

  model(name) {
    return this.catalog.models.find((m) => m.name === name);
  }

  // --- drawing -------------------------------------------------------------

  render() {
    const { el } = this;
    const d = this.data;
    const usesGazebo = d.vehicles.some((v) => this.model(v.model)?.gazebo);

    const world = el('select', { 'aria-label': 'World' },
      el('option', { value: '' }, '— none (built-in physics only) —'),
      ...this.catalog.worlds.map((w) => el('option', { value: w.name }, w.name)));
    world.value = d.world || '';
    world.onchange = () => {
      if (world.value) d.world = world.value; else delete d.world;
      this.changed();
      this.render();
    };
    const name = el('input', { value: d.name || '', placeholder: 'name', 'aria-label': 'Scenario name' });
    name.oninput = () => { d.name = name.value.trim() || 'hangar'; this.changed(); };
    const speed = el('input', { type: 'number', min: '0.1', max: '10', step: '0.1', value: d.speedup ?? 1, 'aria-label': 'Speed' });
    speed.onchange = () => {
      const x = Number(speed.value);
      if (x > 0 && x !== 1) d.speedup = x; else delete d.speedup;
      this.changed();
    };

    const worldNote = usesGazebo && !d.world
      ? el('p', { class: 'note bad' }, 'Gazebo vehicles need a world.')
      : !usesGazebo && d.world && d.vehicles.length
        ? el('p', { class: 'muted small' }, 'No vehicle uses Gazebo, so the world is not loaded.') : null;

    const top = el('section', { class: 'card sc-top' },
      el('div', { class: 'grid2' },
        el('label', {}, el('small', {}, 'NAME'), name),
        el('label', {}, el('small', {}, 'SPEED (×REAL TIME)'), speed)),
      el('label', {}, el('small', {}, 'WORLD (GAZEBO)'), world),
      worldNote,
      this.homeBox());

    const cards = d.vehicles.map((v, i) => this.vehicleCard(v, i));
    const add = el('button', { class: 'btn primary', onclick: () => this.addVehicle() }, '+ Add vehicle');
    this.root.replaceChildren(top,
      el('div', { class: 'sc-head' }, el('h3', {}, `Vehicles (${d.vehicles.length})`), add),
      ...(cards.length ? cards : [el('div', { class: 'empty' }, 'No vehicles yet.')]));
    this.setDisabled(this.disabled);
  }

  homeBox() {
    const { el } = this;
    const d = this.data;
    const h = d.home || {};
    const field = (key, label, step) => {
      const input = el('input', { type: 'number', step, value: h[key] ?? '', placeholder: 'default', 'aria-label': label });
      input.onchange = () => {
        const x = input.value === '' ? null : Number(input.value);
        d.home ||= {};
        if (x == null || Number.isNaN(x)) delete d.home[key]; else d.home[key] = x;
        if (!Object.keys(d.home).length) delete d.home;
        this.changed();
      };
      return el('label', {}, el('small', {}, label), input);
    };
    return el('details', { class: 'sc-home', ...(d.home ? { open: '' } : {}) },
      el('summary', {}, 'Start location (home)'),
      el('p', { class: 'muted small' }, 'Empty: the world\'s own location, or ArduPilot\'s default without a world.'),
      el('div', { class: 'grid4' },
        field('lat', 'LAT', 'any'), field('lon', 'LON', 'any'), field('alt', 'ALT (M)', 'any'), field('heading', 'HEADING', 'any')));
  }

  modelSelect(value) {
    const { el } = this;
    const sel = el('select', { 'aria-label': 'Model' });
    const group = (label, list) => {
      if (!list.length) return null;
      const g = el('optgroup', { label });
      for (const m of list) g.append(el('option', { value: m.name }, `${m.name} · ${m.type}`));
      return g;
    };
    sel.append(...[group('Gazebo: 3D view, cameras', this.catalog.models.filter((m) => m.gazebo)),
      group('Built-in physics: map only', this.catalog.models.filter((m) => !m.gazebo))].filter(Boolean));
    if (value && !this.model(value)) sel.append(el('option', { value }, `${value} (not installed)`));
    sel.value = value;
    return sel;
  }

  vehicleCard(v, i) {
    const { el } = this;
    const d = this.data;
    const m = this.model(v.model);
    const model = this.modelSelect(v.model);
    model.onchange = () => {
      // a name made from the old model follows the new one
      if (!v.name || v.name === stem(v.model) || v.name.startsWith(stem(v.model) + '_')) {
        delete v.name;
        v.name = this.freeName(model.value);
      }
      v.model = model.value;
      const nm = this.model(v.model);
      if (!nm?.gazebo) delete v.camera;
      if (nm?.gazebo && !d.world) {
        const w = this.catalog.worlds.find((x) => x.name.includes('runway')) || this.catalog.worlds[0];
        if (w) d.world = w.name;
      }
      this.changed();
      this.render();
    };
    const name = el('input', { value: v.name || '', placeholder: 'name', 'aria-label': 'Vehicle name' });
    name.oninput = () => { v.name = name.value.trim() || undefined; if (!v.name) delete v.name; this.changed(); };

    // position: x y z and heading; roll and pitch stay as they are
    const pose = v.pose ? [...v.pose, 0, 0, 0, 0, 0, 0].slice(0, 6) : null;
    const coord = (idx, label) => {
      const input = el('input', { type: 'number', step: 'any', value: pose ? pose[idx] : '', placeholder: 'auto', 'aria-label': label });
      input.onchange = () => {
        const inputs = [...input.closest('.grid4').querySelectorAll('input')].map((x) => x.value);
        if (inputs.every((x) => x === '')) { delete v.pose; this.changed(); return; }
        const p = v.pose ? [...v.pose, 0, 0, 0, 0, 0, 0].slice(0, 6) : [0, 0, m?.gazebo ? 0.3 : 0, 0, 0, 0];
        [0, 1, 2, 5].forEach((k, j) => { if (inputs[j] !== '') p[k] = Number(inputs[j]); });
        v.pose = p;
        this.changed();
      };
      return el('label', {}, el('small', {}, label), input);
    };

    const extras = [];
    if (m?.gazebo) {
      const cam = el('input', { type: 'checkbox' });
      cam.checked = !!v.camera && v.camera.enabled !== false;
      cam.onchange = () => {
        if (cam.checked) {
          const c = typeof v.camera === 'object' && v.camera ? { ...v.camera } : {};
          delete c.enabled;
          v.camera = c;
        } else delete v.camera;
        this.changed();
      };
      extras.push(el('label', { class: 'check', title: 'A camera stream from Gazebo (for OpenCV, QGC video). The browser draws its own camera view either way.' },
        cam, m.camera ? ' camera stream (the model has a camera)' : ' add a camera stream'));
    }
    const params = el('textarea', { rows: '3', spellcheck: 'false', placeholder: 'SIM_WIND_SPD 3\nWP_SPD 8', 'aria-label': 'Parameters' });
    params.value = Object.entries(v.params || {}).map(([k, x]) => `${k} ${x}`).join('\n');
    params.onchange = () => {
      const out = {};
      for (const line of params.value.split('\n')) {
        const [k, x] = line.trim().split(/[\s,=]+/);
        if (k && x !== undefined && !Number.isNaN(Number(x))) out[k.toUpperCase()] = Number(x);
      }
      v.params = out;
      this.changed();
    };
    const nParams = Object.keys(v.params || {}).length;

    return el('section', { class: 'card sc-vehicle' },
      el('div', { class: 'sc-vhead' },
        el('span', { class: 'idx' }, String(i + 1)), name,
        el('button', { class: 'btn ghost icon', title: 'Copy this vehicle', onclick: () => this.copyVehicle(i) },
          svg('M8 8h11v13H8zM5 3h11v3H7v11H5z')),
        el('button', { class: 'btn ghost icon', title: 'Remove', onclick: () => { d.vehicles.splice(i, 1); this.changed(); this.render(); } },
          svg('M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z'))),
      el('label', {}, el('small', {}, 'MODEL'), model),
      m?.description ? el('p', { class: 'muted small' }, m.description) : null,
      el('div', {},
        el('small', { class: 'lbl' }, m?.gazebo ? 'POSITION IN THE WORLD, M · empty: placed automatically' : 'START, M FROM HOME · empty: placed automatically'),
        el('div', { class: 'grid4' }, coord(0, 'X EAST'), coord(1, 'Y NORTH'), coord(2, 'Z UP'), coord(5, 'YAW °'))),
      ...extras,
      el('details', { class: 'sc-params', ...(nParams ? { open: '' } : {}) },
        el('summary', {}, `Parameters${nParams ? ` (${nParams})` : ''}`), params));
  }

  addVehicle() {
    const d = this.data;
    const last = d.vehicles[d.vehicles.length - 1];
    const gz = this.catalog.models.filter((m) => m.gazebo);
    const pick = last?.model || (d.world && gz.length ? (gz.find((m) => m.type === 'copter') || gz[0]).name : 'sitl:copter');
    d.vehicles.push({ model: pick, name: this.freeName(pick), params: {} });
    this.changed();
    this.render();
    this.root.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  copyVehicle(i) {
    const v = structuredClone(this.data.vehicles[i]);
    v.name = this.freeName(v.name || v.model);
    if (v.pose) v.pose = [v.pose[0], v.pose[1] - 10, ...v.pose.slice(2)];  // 10 m beside it
    this.data.vehicles.splice(i + 1, 0, v);
    this.changed();
    this.render();
  }

  freeName(base) {
    const st = stem(base);
    const used = new Set(this.data.vehicles.map((v) => v.name));
    if (!used.has(st)) return st;
    for (let n = 2; ; n++) if (!used.has(`${st}_${n}`)) return `${st}_${n}`;
  }
}

function stem(name) {
  return String(name).replace(/^sitl:/, '').replace(/_\d+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_');
}

function svg(path) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  s.append(p);
  return s;
}
