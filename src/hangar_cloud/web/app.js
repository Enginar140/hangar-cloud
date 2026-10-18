import { Viewer } from './viewer.js';

const $ = (sel) => document.querySelector(sel);
const LEVELS = { info: 0, event: 1, warning: 2, error: 3 };
const MAX_LOGS = 3000;

const state = { sim: 'idle', vehicles: [], logs: [], unseen: 0, selected: null, info: null };

const viewer = new Viewer($('#viewport'), { onSelect: (name) => selectVehicle(name) });
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

const fmt = (v, unit = '', d = 1) => (v == null ? '—' : `${Number(v).toFixed(d)}${unit}`);

// --- top bar ---------------------------------------------------------------

function setSimState(s) {
  state.sim = s;
  const pill = $('#state');
  pill.textContent = s;
  pill.className = 'pill ' + s;
  const busy = s === 'starting' || s === 'running' || s === 'stopping';
  $('#start').hidden = busy;
  $('#stop').hidden = !busy;
  $('#stop').disabled = s === 'stopping';
  for (const id of ['#apply', '#load']) $(id).disabled = busy;
  if (!busy) $('#speed').textContent = '';
  $('#view-empty').hidden = busy || state.hasScene;
}

function setSpeed(speed) {
  const s = $('#speed');
  if (speed == null) { s.textContent = ''; return; }
  s.textContent = `sim ×${speed.toFixed(2)}`;
  s.className = 'metric ' + (speed >= 0.9 ? 'good' : speed >= 0.5 ? 'warn' : 'bad');
}

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
  };
}

// --- vehicles --------------------------------------------------------------

function renderVehicles() {
  const box = $('#vehicles');
  const follow = $('#follow');
  const current = follow.value;
  follow.replaceChildren(el('option', { value: '' }, 'free camera'),
    ...state.vehicles.filter((v) => v.gazebo).map((v) => el('option', { value: v.name }, v.name)));
  follow.value = state.vehicles.some((v) => v.name === current) ? current : '';
  const scope = $('#output-scope');
  const sv = scope.value;
  scope.replaceChildren(el('option', { value: '*' }, 'all vehicles'),
    ...state.vehicles.map((v) => el('option', { value: v.name }, v.name)));
  scope.value = sv;

  if (!state.vehicles.length) {
    box.replaceChildren(el('p', { class: 'muted' }, 'Vehicles show up here when the simulation starts.'));
    return;
  }
  // keep cards (and anything typed into them) between updates
  const cards = new Map([...box.querySelectorAll('.vehicle')].map((c) => [c.dataset.name, c]));
  const keep = new Set();
  for (const v of state.vehicles) {
    let card = cards.get(v.name);
    if (!card) {
      card = vehicleCard(v);
      box.append(card);
    }
    keep.add(card);
    updateCard(card, v);
  }
  for (const c of box.children) if (!keep.has(c)) c.remove();
  $('#script-ports').replaceChildren(...state.vehicles.map((v) =>
    el('div', {}, el('b', {}, v.name), `  sysid ${v.sysid} · tcp ${v.script_ports.join(', ')} (free for scripts)`)));
}

function vehicleCard(v) {
  const run = (line) => async () => {
    try {
      const r = await api(`/api/vehicles/${encodeURIComponent(v.name)}/command`, { line });
      toast(`${v.name}: ${r.result || line}`);
    } catch (e) { toast(`${v.name}: ${e.message}`, 'bad'); }
  };
  const input = el('input', { placeholder: 'mode GUIDED · takeoff 30 · param set NAME VALUE' });
  const send = () => { if (input.value.trim()) { run(input.value.trim())(); input.value = ''; } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  return el('div', { class: 'vehicle', 'data-name': v.name },
    el('div', { class: 'vhead' },
      el('b', { class: 'vname', onclick: () => selectVehicle(v.name) }, v.name),
      el('span', { class: 'muted vmodel' }, v.model),
      el('span', { class: 'pill vstatus' })),
    el('div', { class: 'grid' }),
    el('div', { class: 'buttons' },
      el('button', { onclick: run('arm') }, 'Arm'),
      el('button', { onclick: run('disarm') }, 'Disarm'),
      el('button', { onclick: run('takeoff 30') }, 'Takeoff 30 m'),
      el('button', { onclick: run('rtl') }, 'RTL'),
      el('button', { onclick: run('land') }, 'Land'),
      v.gazebo ? el('button', { onclick: () => selectVehicle(v.name) }, 'Follow') : null),
    el('div', { class: 'row' }, input, el('button', { onclick: send }, 'Send')));
}

function updateCard(card, v) {
  const t = v.telemetry || {};
  const st = card.querySelector('.vstatus');
  st.textContent = v.status;
  st.className = 'pill vstatus ' + v.status;
  card.classList.toggle('selected', state.selected === v.name);
  const ready = t.ready == null ? '—' : t.ready ? 'yes' : 'not yet';
  const gps = t.gps_fix >= 3 ? `3D (${t.satellites})` : t.gps_fix ? `fix ${t.gps_fix}` : 'none';
  const cells = [
    ['Mode', t.mode || '—'], ['Armed', t.armed ? 'ARMED' : 'no'], ['Ready', ready],
    ['Alt', fmt(t.alt_rel, ' m')], ['Speed', fmt(t.groundspeed, ' m/s')], ['Heading', fmt(t.heading, '°', 0)],
    ['Battery', t.battery == null ? '—' : `${t.battery}%`], ['GPS', gps], ['Sim speed', fmt(t.sim_speed, '×', 2)],
  ];
  card.querySelector('.grid').replaceChildren(...cells.flatMap(([k, val]) =>
    [el('span', { class: 'k' }, k), el('span', { class: 'v' + (k === 'Armed' && t.armed ? ' bad' : '') }, val)]));
}

function selectVehicle(name) {
  state.selected = state.selected === name ? null : name;
  $('#follow').value = state.selected || '';
  viewer.follow(state.selected);
  renderVehicles();
}

$('#follow').onchange = (e) => { state.selected = e.target.value || null; viewer.follow(state.selected); renderVehicles(); };
$('#frame').onclick = () => { state.selected = null; $('#follow').value = ''; viewer.follow(null); viewer.frameVehicles(); };

// --- scenario --------------------------------------------------------------

function renderInfo(info) {
  state.info = info;
  const sel = $('#scenarios');
  sel.replaceChildren(...info.scenarios.map((s) => el('option', { value: s.id }, `${s.name} (${s.kind})`)));
  if (info.scenario) {
    sel.value = info.scenario.id;
    $('#yaml').value = info.scenario.yaml;
    $('#scenario-name').textContent = info.scenario.id.replace(/^\w+:/, '');
  }
  $('#models').textContent = info.models.join(', ');
  $('#worlds').textContent = info.worlds.join(', ');
  renderOutputs(info.outputs || {});
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
    await api('/api/scenario', { yaml: $('#yaml').value }).catch(() => null);
    await api('/api/scenario/save', { name });
    toast(`Saved as ${name}`);
    refresh();
  } catch (e) { toast(e.message, 'bad'); }
};

// --- connect ---------------------------------------------------------------

function renderOutputs(outputs) {
  const list = $('#outputs');
  const rows = [];
  for (const [scope, urls] of Object.entries(outputs)) {
    for (const url of urls) {
      rows.push(el('li', {}, el('code', {}, url), el('span', { class: 'muted' }, scope === '*' ? ' all vehicles' : ` ${scope}`),
        el('button', { class: 'small', onclick: () => removeOutput(url, scope) }, 'Remove')));
    }
  }
  list.replaceChildren(...(rows.length ? rows : [el('li', { class: 'muted' }, 'No outputs.')]));
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
    el('span', { class: 's' }, l.source), el('span', { class: 'x' }, l.text));
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
  $('#loading').textContent = e.detail ? `loading ${e.detail} file${e.detail > 1 ? 's' : ''}…` : '';
});

function handle(msg) {
  switch (msg.t) {
    case 'hello':
      setSimState(msg.state);
      setSpeed(msg.sim_speed);
      state.vehicles = msg.vehicles;
      state.logs = msg.logs;
      renderVehicles();
      renderLogs();
      if (!msg.gazebo_view) $('#rtf').textContent = '3D view off on this server';
      break;
    case 'state':
      setSimState(msg.state);
      if (msg.state === 'idle' || msg.state === 'error') refresh();
      break;
    case 'log': addLog(msg.line); break;
    case 'vehicles':
      state.vehicles = msg.vehicles;
      setSpeed(msg.sim_speed);
      renderVehicles();
      viewer.setVehicles(state.vehicles);
      break;
    case 'scene':
      state.hasScene = true;
      $('#view-empty').hidden = true;
      viewer.setScene(msg);
      viewer.setVehicles(state.vehicles);
      if (state.selected) viewer.follow(state.selected);
      break;
    case 'scene_clear':
      state.hasScene = false;
      viewer.clear();
      state.logs = [];
      renderLogs();
      break;
    case 'poses': viewer.updatePoses(msg.p); break;
    case 'removed': viewer.remove(msg.ids); break;
    case 'stats': $('#rtf').textContent = `Gazebo RTF ${(msg.rtf * 100).toFixed(0)}%${msg.paused ? ' (paused)' : ''}`; break;
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
