// A recorded run (replay.json version 1) played back in the 3D view and on the map.
//
// Tracks are columns in metres north (n) / east (e) of the origin and height (h, up), so the
// 3D view's frame (x east, y north, z up) takes them as they are. Missing roll/pitch count as
// level, a missing yaw comes from the direction of travel.

const EARTH = 6378137;
const D2R = Math.PI / 180;

export class Replay {
  constructor(data, id) {
    if (data.version !== 1) throw new Error(`replay format version ${data.version}; this page reads version 1`);
    this.id = id;
    this.name = data.name || id;
    this.origin = data.origin || { lat: 0, lon: 0, alt: 0 };
    this.world = data.world || null;
    this.events = (data.events || []).slice().sort((a, b) => a.t - b.t);
    this.zones = (data.zones || []).filter((z) => Array.isArray(z.poly) && z.poly.length >= 3);
    this.tracks = Object.entries(data.tracks || {}).map(([name, t]) => prepare(name, t)).filter((t) => t.t.length);
    if (!this.tracks.length) throw new Error('the replay has no tracks');
    this.start = Math.min(0, ...this.tracks.map((t) => t.t[0]), ...this.events.map((e) => e.t));
    this.end = Math.max(...this.tracks.map((t) => t.t[t.t.length - 1]), ...this.events.map((e) => e.t));
    this.cosLat = Math.cos(this.origin.lat * D2R);
  }

  // metres north/east of the origin -> latitude, longitude
  latlon(n, e) {
    return [this.origin.lat + (n / EARTH) / D2R, this.origin.lon + (e / (EARTH * this.cosLat)) / D2R];
  }

  // every track at time t: position, attitude, fields; null when it has not started yet
  at(t) {
    return this.tracks.map((tr) => sample(tr, t));
  }

  // the path flown until t (at most `max` points), as [n, e, h]
  path(track, t, max = 4000) {
    const end = upper(track.t, t);
    const step = Math.max(1, Math.ceil(end / max));
    const out = [];
    for (let i = 0; i < end; i += step) out.push([track.n[i], track.e[i], track.h[i]]);
    return out;
  }

  extent() {
    let r = 100;
    for (const tr of this.tracks) for (let i = 0; i < tr.t.length; i += 10) r = Math.max(r, Math.abs(tr.n[i]), Math.abs(tr.e[i]));
    for (const z of this.zones) for (const [n, e] of z.poly) r = Math.max(r, Math.abs(n), Math.abs(e));
    return r;
  }

  // a scene the 3D view can draw: ground, and a simple aircraft per track
  scene() {
    const size = Math.ceil(this.extent() * 2.6 / 100) * 100;
    const models = [{
      id: 1, name: 'ground', static: true, pose: [0, 0, 0, 0, 0, 0, 1], models: [],
      links: [{ id: 2, name: 'ground', pose: [0, 0, 0, 0, 0, 0, 1], visuals: [{
        id: 3, name: 'ground', pose: [0, 0, 0, 0, 0, 0, 1], scale: [1, 1, 1], transparency: 0,
        material: { diffuse: [0.42, 0.5, 0.36, 1], roughness: 1 },
        geometry: { kind: 'plane', size: [size, size], normal: [0, 0, 1] },
      }] }],
    }];
    this.tracks.forEach((tr, i) => {
      const id = 1000 + i * 100;
      tr.id = id;
      models.push({ id, name: tr.name, static: false, pose: [0, 0, 0, 0, 0, 0, 1], models: [],
        links: [{ id: id + 1, name: 'body', pose: [0, 0, 0, 0, 0, 0, 1], visuals: shape(tr.kind, id + 2) }] });
    });
    return { t: 'scene', world: this.world || 'replay', scene: { name: 'replay', lights: [], models } };
  }
}

function prepare(name, t) {
  const n = t.t.length;
  const col = (k) => (Array.isArray(t[k]) && t[k].length === n ? t[k] : new Array(n).fill(null));
  const tr = { name, team: t.team || '', model: t.model || '', t: t.t, n: col('n'), e: col('e'), h: col('h'),
    roll: col('roll'), pitch: col('pitch'), yaw: col('yaw').slice(), fields: {} };
  for (const [k, v] of Object.entries(t.fields || {})) if (Array.isArray(v) && v.length === n) tr.fields[k] = v;
  // heading from the direction of travel where the file has none
  let last = null;
  for (let i = 0; i < n; i++) {
    if (tr.yaw[i] != null) { last = tr.yaw[i]; continue; }
    const j = Math.min(i + 1, n - 1), k = j === i ? Math.max(i - 1, 0) : i;
    const dn = tr.n[j] - tr.n[k], de = tr.e[j] - tr.e[k];
    tr.yaw[i] = Math.hypot(dn, de) > 0.05 ? (Math.atan2(de, dn) / D2R + 360) % 360 : last;
    last = tr.yaw[i];
  }
  const m = (tr.model + ' ' + name).toLowerCase();
  tr.kind = /copter|quad|iris|hexa|octo/.test(m) ? 'copter' : /rover|boat|truck|car/.test(m) ? 'rover' : 'plane';
  return tr;
}

// index of the first time > t
function upper(ts, t) {
  let lo = 0, hi = ts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

function lerp(a, b, f) { return a == null ? b : b == null ? a : a + (b - a) * f; }
function lerpAngle(a, b, f) {
  if (a == null || b == null) return a ?? b;
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

function sample(tr, t) {
  const ts = tr.t;
  if (t < ts[0]) return { track: tr, started: false };
  const j = upper(ts, t);
  const i = Math.max(j - 1, 0), k = Math.min(j, ts.length - 1);
  const f = k === i ? 0 : (t - ts[i]) / (ts[k] - ts[i]);
  const s = { track: tr, started: true, ended: t > ts[ts.length - 1], i,
    n: lerp(tr.n[i], tr.n[k], f), e: lerp(tr.e[i], tr.e[k], f), h: lerp(tr.h[i], tr.h[k], f) ?? 0,
    yaw: lerpAngle(tr.yaw[i], tr.yaw[k], f) ?? 0, roll: lerp(tr.roll[i], tr.roll[k], f) ?? 0,
    pitch: lerp(tr.pitch[i], tr.pitch[k], f) ?? 0, fields: {} };
  for (const [key, v] of Object.entries(tr.fields)) s.fields[key] = v[i];
  const back = Math.max(i - 2, 0), fwd = Math.min(i + 2, ts.length - 1);
  const dt = ts[fwd] - ts[back];
  s.speed = dt > 0 ? Math.hypot(tr.n[fwd] - tr.n[back], tr.e[fwd] - tr.e[back]) / dt : 0;
  s.climb = dt > 0 && tr.h[fwd] != null && tr.h[back] != null ? (tr.h[fwd] - tr.h[back]) / dt : 0;
  return s;
}

// [id, x, y, z, qx, qy, qz, qw] for the 3D view: x east, y north, z up; the body's x forward
export function pose(s) {
  const yaw = (90 - s.yaw) * D2R, pitch = -s.pitch * D2R, roll = s.roll * D2R;  // NED angles -> ENU
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  return [s.track.id, s.e, s.n, s.h,
    sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

function shape(kind, id) {
  const box = (i, name, size, pos, color) => ({
    id: id + i, name, pose: [...pos, 0, 0, 0, 1], scale: [1, 1, 1], transparency: 0,
    material: { diffuse: color, roughness: 0.6 }, geometry: { kind: 'box', size },
  });
  const body = [0.92, 0.93, 0.95, 1], dark = [0.25, 0.27, 0.3, 1];
  if (kind === 'copter') {
    return [box(0, 'body', [0.5, 0.5, 0.18], [0, 0, 0], body), box(1, 'arm1', [1.4, 0.08, 0.05], [0, 0, 0.05], dark),
      box(2, 'arm2', [0.08, 1.4, 0.05], [0, 0, 0.05], dark), box(3, 'nose', [0.2, 0.12, 0.1], [0.3, 0, 0], [1, 0.4, 0.2, 1])];
  }
  if (kind === 'rover') return [box(0, 'body', [1.2, 0.8, 0.5], [0, 0, 0.25], body)];
  // a fixed-wing about 2.4 m across, so it can be seen from a distance
  return [box(0, 'fuselage', [1.6, 0.2, 0.2], [0, 0, 0], body), box(1, 'wing', [0.45, 2.4, 0.05], [0.1, 0, 0.05], body),
    box(2, 'tail', [0.3, 0.8, 0.04], [-0.72, 0, 0.05], body), box(3, 'fin', [0.3, 0.04, 0.35], [-0.72, 0, 0.2], dark),
    box(4, 'nose', [0.2, 0.18, 0.18], [0.85, 0, 0], [1, 0.4, 0.2, 1])];
}
