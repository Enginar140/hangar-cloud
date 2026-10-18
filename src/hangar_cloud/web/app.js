import { Viewer } from './viewer.js';
import { VehicleMap } from './map.js';
import { ParamEditor } from './params.js';

const $ = (sel) => document.querySelector(sel);
const LEVELS = { info: 0, event: 1, warning: 2, error: 3 };
const MAX_LOGS = 3000;
const COLORS = ['#4da3ff', '#ffa94d', '#5fd68a', '#ff6b8b', '#b98cff', '#f5d04a', '#45d0d6', '#ff8f5e'];

const state = {
  sim: 'idle', vehicles: [], logs: [], unseen: 0, selected: null, camera: 'free',
  hasScene: false, startedAt: null, info: null, pip: null, view: '3d', home: null,
};
let map = null;  // made the first time it is shown

const viewer = new Viewer($('#viewport'), {
  onSelect: (name) => selectVehicle(name, true),
  onCamera: (deg) => { $('#compass').style.setProperty('--heading', `${-deg}deg`); },
});
window.viewer = viewer;  // handy in the browser console

// --- helpers ---------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 401) { location.href = '/'; throw new Error('not logged in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(text, kind = '') {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 4500);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

const num = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d));
const colorOf = (name) => {
  const i = state.vehicles.findIndex((v) => v.name === name);
  return COLORS[(i < 0 ? 0 : i) % COLORS.length];
};

async function command(name, line) {
  try {
    const r = await api(`/api/vehicles/${encodeURIComponent(name)}/command`, { line });
    toast(`${name}: ${r.result || line}`);
  } catch (e) { toast(`${name}: ${e.message}`, 'bad'); }
}

// --- top bar ---------------------------------------------------------------

function setSimState(s) {
  state.sim = s;
  const pill = $('#state');
  pill.querySelector('span').textContent = s;
  pill.className = 'state ' + s;
  const busy = s === 'starting' || s === 'running' || s === 'stopping';
  $('#start').hidden = busy;
  $('#stop').hidden = !busy;
  $('#stop').disabled = s === 'stopping';
  for (const id of ['#apply', '#load']) $(id).disabled = busy;
  if (!busy) { setSpeed(null); state.startedAt = null; }
  renderEmpty();
}

// the message over the view: nothing running, or vehicles that Gazebo does not draw
function renderEmpty() {
  const busy = state.sim === 'starting' || state.sim === 'running' || state.sim === 'stopping';
  const no3d = state.sim === 'running' && state.vehicles.length > 0 && !state.vehicles.some((v) => v.gazebo);
  $('#empty-idle').hidden = busy;
  $('#empty-no3d').hidden = !no3d;
  $('#view-empty').hidden = state.view === 'map' || state.hasScene || (busy && !no3d);
}

$('#empty-map').onclick = () => setView('map');
$('#empty-gazebo').onclick = async () => {
  try {
    if (state.sim !== 'idle' && state.sim !== 'error') await api('/api/stop', {});
    renderPreflight(await api('/api/scenario/load', { id: 'example:runway-3d' }));
    refresh();
    toast('Gazebo example loaded: press Start');
  } catch (e) { toast(e.message, 'bad'); }
};

function setSpeed(speed) {
  const box = $('#stat-speed');
  box.querySelector('strong').textContent = speed == null ? '—' : `×${speed.toFixed(2)}`;
  box.querySelector('.meter span').style.width = `${Math.min(speed || 0, 1) * 100}%`;
  box.className = 'stat' + (speed == null ? '' : speed >= 0.9 ? '' : speed >= 0.5 ? ' warn' : ' bad');
}

function tickUptime() {
  const s = $('#stat-uptime strong');
  if (!state.startedAt) { s.textContent = '—'; return; }
  const t = Math.max(0, Math.floor(Date.now() / 1000 - state.startedAt));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
  s.textContent = (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}
setInterval(tickUptime, 1000);

$('#start').onclick = async () => {
  try { await api('/api/start', {}); } catch (e) { toast(e.message, 'bad'); }
};
$('#stop').onclick = async () => {
  $('#stop').disabled = true;
  try { await api('/api/stop', {}); } catch (e) { toast(e.message, 'bad'); }
};

// --- tabs ------------------------------------------------------------------

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('active', x === b);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab);
    if (b.dataset.tab === 'logs') { state.unseen = 0; updateBadge(); scrollLogs(true); }
    if (b.dataset.tab === 'params') params.shown();
  };
}

// --- vehicles --------------------------------------------------------------

function renderVehicles() {
  const box = $('#vehicles');
  const online = state.vehicles.filter((v) => v.status === 'online').length;
  $('#stat-vehicles strong').textContent = state.vehicles.length ? `${online}/${state.vehicles.length} online` : '—';

  const follow = $('#follow');
  const gz = state.vehicles.filter((v) => v.gazebo || state.view === 'map');
  if (follow.options.length - 1 !== gz.length || gz.some((v, i) => follow.options[i + 1].value !== v.name)) {
    follow.replaceChildren(el('option', { value: '' }, 'vehicle…'), ...gz.map((v) => el('option', { value: v.name }, v.name)));
  }
  follow.value = state.selected || '';
  const scope = $('#output-scope');
  if (scope.options.length - 1 !== state.vehicles.length) {
    const sv = scope.value;
    scope.replaceChildren(el('option', { value: '*' }, 'all vehicles'),
      ...state.vehicles.map((v) => el('option', { value: v.name }, v.name)));
    scope.value = sv;
  }

  renderEmpty();
  if (!state.vehicles.length) {
    if (!box.querySelector('.empty')) box.replaceChildren(el('div', { class: 'empty' }, 'Vehicles show up here when the simulation starts.'));
    renderHud();
    return;
  }
  box.querySelector('.empty')?.remove();
  const cards = new Map([...box.querySelectorAll('.vehicle')].map((c) => [c.dataset.name, c]));
  const keep = new Set();
  for (const v of state.vehicles) {
    let card = cards.get(v.name);
    if (!card) { card = vehicleCard(v); box.append(card); }
    keep.add(card);
    updateCard(card, v);
  }
  for (const c of [...box.children]) if (!keep.has(c)) c.remove();
  $('#script-ports').replaceChildren(...state.vehicles.map((v) =>
    el('div', {}, el('b', {}, v.name), ` · sysid ${v.sysid} · tcp ${v.script_ports.join(', ')}`)));
  renderHud();
}

function vehicleCard(v) {
  const run = (line) => () => command(v.name, line);
  const mode = el('select', { class: 'mode', 'aria-label': 'Flight mode' });
  mode.addEventListener('change', () => { if (mode.value) command(v.name, `mode ${mode.value}`); });
  const arm = el('button', { class: 'btn arm' }, 'Arm');
  arm.addEventListener('click', () => command(v.name, arm.classList.contains('armed') ? 'disarm' : 'arm'));
  const alt = el('input', { type: 'number', value: v.kind === 'plane' ? '50' : '20', min: '1', max: '5000', 'aria-label': 'Takeoff altitude' });
  const line = el('input', { placeholder: 'mode GUIDED · param set NAME VALUE' });
  const send = () => { if (line.value.trim()) { command(v.name, line.value.trim()); line.value = ''; } };
  line.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const tile = (k, label, unit, extra) => el('div', { class: 'tile' }, el('small', {}, label), el('strong', { 'data-k': k }, '—'), el('em', {}, unit), extra);
  return el('div', { class: 'vehicle', 'data-name': v.name },
    el('header', { onclick: () => selectVehicle(v.name, true), title: 'Show it in the view' },
      el('i'), el('b', {}, v.name), el('span', { class: 'model' }, `${v.model} · ${v.kind}`), el('span', { class: 'status' })),
    el('div', { class: 'tiles' },
      tile('alt', 'ALTITUDE', 'm'), tile('spd', 'SPEED', 'm/s'), tile('hdg', 'HEADING', '°'),
      tile('bat', 'BATTERY', '%', el('div', { class: 'level' }, el('span')))),
    el('div', { class: 'vbody' },
      el('div', { class: 'chips' }, el('span', { 'data-k': 'ready' }), el('span', { 'data-k': 'gps' }), el('span', { 'data-k': 'sim' })),
      el('div', { class: 'controls' }, mode, arm),
      el('div', { class: 'controls' },
        el('div', { class: 'takeoff' }, el('button', { onclick: () => command(v.name, `takeoff ${alt.value || 20}`) }, 'Takeoff'), alt, el('span', {}, 'm')),
        el('button', { class: 'btn', onclick: run('rtl') }, 'RTL'),
        el('button', { class: 'btn', onclick: run('land') }, 'Land'),
        v.gazebo ? el('button', { class: 'btn', onclick: () => openPip(v.name), title: 'Its camera, drawn by your browser' }, 'Camera') : null),
      el('details', { class: 'cmd' }, el('summary', {}, 'Command line'),
        el('div', { class: 'row' }, line, el('button', { class: 'btn', onclick: send }, 'Send')))));
}

function updateCard(card, v) {
  const t = v.telemetry || {};
  card.style.setProperty('--c', colorOf(v.name));
  card.classList.toggle('selected', state.selected === v.name);
  const st = card.querySelector('.status');
  st.textContent = v.status;
  st.className = 'status ' + v.status;
  const set = (k, text) => { card.querySelector(`[data-k="${k}"]`).textContent = text; };
  set('alt', num(t.alt_rel));
  set('spd', num(t.groundspeed));
  set('hdg', num(t.heading, 0));
  set('bat', t.battery == null ? '—' : t.battery);
  const level = card.querySelector('.tile .level');
  level.querySelector('span').style.width = `${t.battery ?? 0}%`;
  level.className = 'level' + (t.battery != null && t.battery < 15 ? ' out' : t.battery != null && t.battery < 35 ? ' low' : '');

  const ready = card.querySelector('[data-k="ready"]');
  ready.textContent = t.ready == null ? 'checks …' : t.ready ? 'ready to arm' : 'not ready';
  ready.className = t.ready ? 'ok' : t.ready === false ? 'no' : '';
  const gps = card.querySelector('[data-k="gps"]');
  gps.textContent = t.gps_fix >= 3 ? `GPS 3D · ${t.satellites} sats` : t.gps_fix ? `GPS fix ${t.gps_fix}` : 'no GPS';
  gps.className = t.gps_fix >= 3 ? 'ok' : 'no';
  set('sim', t.sim_speed == null ? 'sim —' : `sim ×${t.sim_speed.toFixed(2)}`);

  const mode = card.querySelector('select.mode');
  if (document.activeElement !== mode) {
    const modes = v.modes && v.modes.length ? v.modes : [t.mode || '—'];
    if (mode.dataset.modes !== modes.join()) {
      mode.replaceChildren(...modes.map((m) => el('option', { value: m }, m)));
      mode.dataset.modes = modes.join();
    }
    mode.value = modes.includes(t.mode) ? t.mode : modes[0];
    mode.disabled = !(v.modes && v.modes.length);
  }
  const arm = card.querySelector('.arm');
  arm.textContent = t.armed ? 'Disarm' : 'Arm';
  arm.classList.toggle('armed', !!t.armed);
}

function renderHud() {
  const hud = $('#hud');
  const v = state.vehicles.find((x) => x.name === state.selected);
  if (!v || !(state.hasScene || state.view === 'map')) { hud.hidden = true; return; }
  const t = v.telemetry || {};
  hud.hidden = false;
  hud.style.setProperty('--c', colorOf(v.name));
  hud.querySelector('.hud-head b').textContent = v.name;
  hud.querySelector('.hud-mode').textContent = t.mode || '—';
  hud.querySelector('.hud-armed').hidden = !t.armed;
  const set = (k, text) => { hud.querySelector(`[data-k="${k}"]`).textContent = text; };
  set('alt', num(t.alt_rel));
  set('spd', num(t.groundspeed));
  set('climb', num(t.climb));
  set('hdg', num(t.heading, 0));
  set('bat', t.battery ?? '—');
}

function selectVehicle(name, toggle = false) {
  state.selected = toggle && state.selected === name ? null : name;
  map?.select(state.selected);
  if (state.view === 'map') {
    if (state.selected) map.setFollow(true);
    setMapFollow(!!state.selected);
    renderVehicles();
    return;
  }
  if (state.pip && state.selected && state.pip.vehicle !== state.selected) {
    state.pip = { vehicle: state.selected, index: 0, full: state.pip.full };
    updatePip();
  }
  if (!state.selected) { setCameraMode('free'); return; }
  if (state.camera === 'free') setCameraMode('follow');
  else { applyCamera(); renderVehicles(); }
}

function setCameraMode(mode) {
  if (mode !== 'free' && !state.selected) {
    const first = state.vehicles.find((v) => v.gazebo);
    if (!first) { toast(state.vehicles.length ? 'These vehicles are not in Gazebo: see the Map' : 'No vehicle in 3D yet', 'bad'); return; }
    state.selected = first.name;
  }
  state.camera = mode;
  for (const b of document.querySelectorAll('#cam-mode button')) b.classList.toggle('active', b.dataset.mode === mode);
  applyCamera();
  renderVehicles();
}

function applyCamera() {
  viewer.setCamera(state.camera, state.camera === 'free' ? null : state.selected);
  viewer.setVehicles(withColors(state.vehicles));
}

for (const b of document.querySelectorAll('#cam-mode button')) b.onclick = () => setCameraMode(b.dataset.mode);
$('#follow').onchange = (e) => {
  if (e.target.value) selectVehicle(e.target.value);
  else { state.selected = null; setCameraMode('free'); }
};
$('#frame').onclick = () => {
  if (state.view === 'map') { setMapFollow(false); map.fit(); return; }
  setCameraMode('free');
  viewer.frameVehicles();
};
$('#trails').onclick = (e) => {
  const on = !e.currentTarget.classList.contains('active');
  e.currentTarget.classList.toggle('active', on);
  viewer.setTrails(on);
  map?.setTrails(on);
};
$('#clear-trails').onclick = () => { viewer.clearTrails(); map?.clearTrails(); };
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'm' || e.key === 'M') { setView(state.view === 'map' ? '3d' : 'map'); return; }
  if (state.view === 'map') {
    if (e.key === 'Escape') { state.selected = null; map.select(null); setMapFollow(false); renderVehicles(); }
    return;
  }
  const keys = { 1: 'free', 2: 'follow', 3: 'chase', 4: 'top' };
  if (keys[e.key]) setCameraMode(keys[e.key]);
  if (e.key === 'Escape') {
    if (state.pip && state.pip.full) { state.pip.full = false; updatePip(); return; }
    state.selected = null;
    setCameraMode('free');
  }
  if (e.key === 'c' || e.key === 'C') { if (state.pip) closePip(); else openPip(state.selected); }
  if ((e.key === 'f' || e.key === 'F') && state.pip) { state.pip.full = !state.pip.full; updatePip(); }
});

// --- map -------------------------------------------------------------------

function setView(kind) {
  state.view = kind;
  for (const b of document.querySelectorAll('#view-kind button')) b.classList.toggle('active', b.dataset.kind === kind);
  document.body.classList.toggle('view-map', kind === 'map');
  $('#viewport').hidden = kind === 'map';
  $('#map').hidden = kind !== 'map';
  viewer.setPaused(kind === 'map');
  if (kind === 'map') {
    if (!map) {
      map = new VehicleMap($('#map'), {
        onSelect: (name) => selectVehicle(name, true),
        onGoto: (name, lat, lon, alt) => command(name, `goto ${lat.toFixed(7)} ${lon.toFixed(7)} ${alt}`),
      });
      $('#map').addEventListener('unfollow', () => setMapFollow(false));
      map.setTrails($('#trails').classList.contains('active'));
      map.setHome(state.home);
    }
    map.resize();
    map.select(state.selected);
    map.setVehicles(withColors(state.vehicles));
  }
  $('#pip').hidden = kind === 'map' || !state.pip;
  if (kind === '3d' && state.pip) updatePip();
  setSimState(state.sim);
  renderVehicles();
}

function setMapFollow(on) {
  map?.setFollow(on);
  $('#map-follow').classList.toggle('active', on);
}

for (const b of document.querySelectorAll('#view-kind button')) b.onclick = () => setView(b.dataset.kind);
for (const b of document.querySelectorAll('#map-tiles button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('#map-tiles button')) x.classList.toggle('active', x === b);
    map.setTiles(b.dataset.tiles);
  };
}
$('#map-follow').onclick = () => {
  const on = !$('#map-follow').classList.contains('active');
  if (on && !state.selected) {
    const first = state.vehicles[0];
    if (!first) return;
    state.selected = first.name;
    map.select(first.name);
  }
  setMapFollow(on);
};

// --- parameters --------------------------------------------------------------

const params = new ParamEditor({ api, toast, el, root: $('#tab-params') });

// --- vehicle camera (drawn by the browser) ---------------------------------

function openPip(name) {
  if (!name) {
    const first = state.vehicles.find((v) => v.gazebo);
    if (!first) { toast(state.vehicles.length ? 'These vehicles are not in Gazebo: see the Map' : 'No vehicle in 3D yet', 'bad'); return; }
    name = first.name;
  }
  state.pip = { vehicle: name, index: 0, full: false };
  if (state.selected !== name) selectVehicle(name);
  updatePip();
}

function closePip() {
  state.pip = null;
  updatePip();
}

function updatePip() {
  const box = $('#pip');
  const p = state.pip;
  const cams = p ? viewer.viewCameras(p.vehicle) : [];
  $('#camera').classList.toggle('active', !!p);
  if (!p || !cams.length || state.view === 'map') {
    box.hidden = true;
    viewer.setPip(null);
    if (p && state.hasScene && state.view !== 'map') toast(`${p.vehicle} is not in the 3D view`, 'bad');
    return;
  }
  p.index = Math.min(p.index, cams.length - 1);
  const cam = cams[p.index];
  box.hidden = false;
  box.classList.toggle('full', p.full);
  box.style.setProperty('--c', colorOf(p.vehicle));
  box.style.setProperty('--ar', `${cam.width} / ${cam.height}`);
  box.querySelector('b').textContent = p.vehicle;
  box.querySelector('.pip-name').textContent = cams.length > 1 ? '' : `${cam.name} · ${cam.width}×${cam.height}`;
  const sel = $('#pip-cam');
  sel.hidden = cams.length < 2;
  if (cams.length > 1) {
    sel.replaceChildren(...cams.map((c, i) => el('option', { value: i }, c.name)));
    sel.value = p.index;
  }
  viewer.setPip({ vehicle: p.vehicle, index: p.index, el: box.querySelector('.pip-hole'), full: p.full });
}

$('#camera').onclick = () => (state.pip ? closePip() : openPip(state.selected));
$('#pip-close').onclick = closePip;
$('#pip-full').onclick = () => { state.pip.full = !state.pip.full; updatePip(); };
$('#pip-cam').onchange = (e) => { state.pip.index = Number(e.target.value); updatePip(); };
$('#pip-save').onclick = async () => {
  if (!(await viewer.saveFrame(state.pip.vehicle, state.pip.index))) toast('No camera picture yet', 'bad');
};
// For your own processing in this browser:  const img = hangar.grabFrame('quad')  -> ImageData
window.hangar = {
  grabFrame: (vehicle, index = 0, maxWidth = 1280) => viewer.grabFrame(vehicle, index, maxWidth),
  cameras: (vehicle) => viewer.viewCameras(vehicle).map((c) => ({ name: c.name, width: c.width, height: c.height })),
};

// --- scenario --------------------------------------------------------------

function renderInfo(info) {
  state.info = info;
  const sel = $('#scenarios');
  sel.replaceChildren(...info.scenarios.map((s) => el('option', { value: s.id }, `${s.name} (${s.kind})`)));
  if (info.scenario) {
    sel.value = info.scenario.id;
    if (document.activeElement !== $('#yaml')) $('#yaml').value = info.scenario.yaml;
    $('#scenario-name').textContent = info.scenario.name || info.scenario.id.replace(/^\w+:/, '');
  }
  $('#models').textContent = info.models.join(', ');
  $('#worlds').textContent = info.worlds.join(', ');
  renderOutputs(info.outputs || {});
  state.home = info.home;
  map?.setHome(info.home);
  state.startedAt = info.started_at;
}

function renderPreflight(pf) {
  const box = $('#preflight');
  const items = [...pf.errors.map((e) => ['bad', e]), ...pf.warnings.map((w) => ['warn', w])];
  box.replaceChildren(...items.map(([k, t]) => el('div', { class: 'note ' + k }, t)));
  if (!items.length) box.replaceChildren(el('div', { class: 'note good' }, 'Ready to start.'));
}

$('#load').onclick = async () => {
  try { renderPreflight(await api('/api/scenario/load', { id: $('#scenarios').value })); refresh(); }
  catch (e) { toast(e.message, 'bad'); }
};
$('#apply').onclick = async () => {
  try { renderPreflight(await api('/api/scenario', { yaml: $('#yaml').value })); toast('Scenario applied'); refresh(); }
  catch (e) { toast(e.message, 'bad'); }
};
$('#save').onclick = async () => {
  const name = $('#save-name').value.trim();
  if (!name) { toast('Type a name first', 'bad'); return; }
  try {
    if (state.sim === 'idle' || state.sim === 'error') await api('/api/scenario', { yaml: $('#yaml').value });
    await api('/api/scenario/save', { name });
    toast(`Saved as ${name}`);
    refresh();
  } catch (e) { toast(e.message, 'bad'); }
};

// --- connect ---------------------------------------------------------------

function renderOutputs(outputs) {
  const rows = [];
  for (const [scope, urls] of Object.entries(outputs)) {
    for (const url of urls) {
      rows.push(el('li', {}, el('code', {}, url), el('span', { class: 'muted' }, scope === '*' ? 'all vehicles' : scope),
        el('button', { class: 'btn small', onclick: () => removeOutput(url, scope) }, 'Remove')));
    }
  }
  $('#outputs').replaceChildren(...(rows.length ? rows : [el('li', { class: 'muted' }, 'No outputs.')]));
}

async function removeOutput(url, scope) {
  try { await api('/api/outputs/remove', { url, scope }); refresh(); } catch (e) { toast(e.message, 'bad'); }
}

$('#output-add').onclick = async () => {
  try {
    await api('/api/outputs', { url: $('#output-url').value.trim(), scope: $('#output-scope').value });
    toast('Output added');
    refresh();
  } catch (e) { toast(e.message, 'bad'); }
};
$('#host-name').textContent = location.hostname;

// --- logs ------------------------------------------------------------------

function logVisible(l) {
  const min = LEVELS[$('#log-level').value] || 0;
  const f = $('#log-filter').value.toLowerCase();
  return (LEVELS[l.level] ?? 0) >= min && (!f || (l.source + ' ' + l.text).toLowerCase().includes(f));
}

function logRow(l) {
  return el('div', { class: 'log ' + l.level }, el('span', { class: 't' }, l.clock),
    el('span', { class: 's', title: l.source }, l.source), el('span', { class: 'x' }, l.text));
}

function renderLogs() {
  $('#logs').replaceChildren(...state.logs.filter(logVisible).map(logRow));
  scrollLogs(true);
}

function scrollLogs(force) {
  const box = $('#logs');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 60) box.scrollTop = box.scrollHeight;
}

function addLog(l) {
  state.logs.push(l);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  const box = $('#logs');
  if (logVisible(l)) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.append(logRow(l));
    while (box.childElementCount > MAX_LOGS) box.firstChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  }
  if (!$('#tab-logs').classList.contains('active') && LEVELS[l.level] >= 2) { state.unseen++; updateBadge(); }
}

function updateBadge() {
  const b = $('#log-badge');
  b.hidden = !state.unseen;
  b.textContent = state.unseen;
}

$('#log-level').onchange = renderLogs;
$('#log-filter').oninput = renderLogs;

// --- live updates ----------------------------------------------------------

async function refresh() {
  try { renderInfo(await api('/api/info')); } catch (e) { toast(e.message, 'bad'); }
}

$('#viewport').addEventListener('loading', (e) => {
  const chip = $('#loading');
  chip.hidden = !e.detail;
  chip.lastElementChild.textContent = `Loading ${e.detail} file${e.detail > 1 ? 's' : ''}`;
});

function withColors(vehicles) {
  return vehicles.map((v, i) => ({ ...v, color: COLORS[i % COLORS.length] }));
}

function handle(msg) {
  switch (msg.t) {
    case 'hello':
      setSimState(msg.state);
      setSpeed(msg.sim_speed);
      state.startedAt = msg.started_at;
      state.vehicles = msg.vehicles;
      state.logs = msg.logs;
      state.home = msg.home;
      map?.setHome(msg.home);
      params.setVehicles(state.vehicles);
      renderVehicles();
      renderLogs();
      if (!msg.gazebo_view) $('#rtf').textContent = '3D view off on this server';
      break;
    case 'state':
      setSimState(msg.state);
      refresh();
      break;
    case 'log': addLog(msg.line); break;
    case 'vehicles':
      state.vehicles = msg.vehicles;
      setSpeed(msg.sim_speed);
      renderVehicles();
      viewer.setVehicles(withColors(state.vehicles));
      map?.setVehicles(withColors(state.vehicles));
      params.setVehicles(state.vehicles);
      break;
    case 'scene':
      state.hasScene = true;
      renderEmpty();
      viewer.setScene(msg);
      viewer.setVehicles(withColors(state.vehicles));
      if (state.camera !== 'free') applyCamera();
      renderHud();
      if (state.pip) updatePip();
      break;
    case 'scene_clear':
      state.hasScene = false;
      closePip();
      viewer.clear();
      map?.clear();
      state.logs = [];
      renderLogs();
      renderHud();
      break;
    case 'poses': viewer.updatePoses(msg.p); break;
    case 'removed': viewer.remove(msg.ids); break;
    case 'stats': $('#rtf').textContent = `Gazebo ${(msg.rtf * 100).toFixed(0)}% real time${msg.paused ? ' · paused' : ''}`; break;
    case 'scenario': refresh(); break;
    default: break;
  }
}

let retry = 500;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { retry = 500; document.body.classList.remove('offline'); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    document.body.classList.add('offline');
    if (e.code === 4401) { location.href = '/'; return; }
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}

refresh();
connect();
renderVehicles();
