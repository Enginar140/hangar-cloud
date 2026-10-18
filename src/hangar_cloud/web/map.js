// A 2D map of the vehicles: where they are, where they flew, and "fly here" on a click.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';

const TRAIL_POINTS = 3000;
const TILES = {
  map: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxNativeZoom: 18,
    attribution: 'Imagery © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> and its partners',
  },
};

const ARROW = '<svg viewBox="-12 -12 24 24"><path d="M0-10 7 8 0 4-7 8z"/></svg>';
const ROUND = '<svg viewBox="-12 -12 24 24"><circle r="6"/></svg>';

export class VehicleMap {
  constructor(container, { onSelect, onGoto }) {
    this.onSelect = onSelect;
    this.onGoto = onGoto;
    this.map = L.map(container, { zoomControl: false, attributionControl: true, maxZoom: 22, worldCopyJump: true });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    this.map.setView([0, 0], 2);
    this.layer = null;
    this.setTiles('map');
    this.markers = new Map();  // name -> marker
    this.trails = new Map();   // name -> polyline
    this.home = null;
    this.selected = null;
    this.follow = false;
    this.placed = false;
    this.showTrails = true;
    this.vehicles = [];
    this.map.on('click', (e) => this.clicked(e.latlng));
    this.map.on('dragstart', () => { this.follow = false; container.dispatchEvent(new Event('unfollow')); });
  }

  setTiles(kind) {
    if (this.layer) this.layer.remove();
    const t = TILES[kind];
    this.layer = L.tileLayer(t.url, { maxZoom: 22, maxNativeZoom: t.maxNativeZoom, attribution: t.attribution })
      .addTo(this.map);
  }

  resize() { this.map.invalidateSize(); }

  setHome(home) {
    if (!home) return;
    const at = [home.lat, home.lon];
    if (!this.home) {
      this.home = L.marker(at, {
        icon: L.divIcon({ className: 'map-home', html: 'H', iconSize: [22, 22] }), title: 'Home', keyboard: false,
      }).addTo(this.map);
    } else this.home.setLatLng(at);
    if (!this.placed) this.map.setView(at, 17);
  }

  setVehicles(vehicles) {
    this.vehicles = vehicles;
    const seen = new Set();
    for (const v of vehicles) {
      const t = v.telemetry || {};
      if (t.lat == null || t.lon == null || (t.lat === 0 && t.lon === 0)) continue;
      seen.add(v.name);
      const at = [t.lat, t.lon];
      let m = this.markers.get(v.name);
      if (!m) {
        m = L.marker(at, { icon: this.icon(v), keyboard: false, zIndexOffset: 1000 }).addTo(this.map);
        m.on('click', (e) => { L.DomEvent.stopPropagation(e); this.onSelect(v.name); });
        this.markers.set(v.name, m);
        if (!this.placed) { this.map.setView(at, 17); this.placed = true; }
      }
      m.setLatLng(at);
      const node = m.getElement();
      if (node) {
        node.style.setProperty('--c', v.color);
        node.style.setProperty('--hdg', `${t.heading ?? 0}deg`);
        node.classList.toggle('selected', v.name === this.selected);
        node.classList.toggle('armed', !!t.armed);
        node.querySelector('.tag b').textContent = v.name;
        node.querySelector('.alt').textContent = t.alt_rel == null ? '' : `${t.alt_rel.toFixed(0)} m`;
      }
      this.extendTrail(v, at);
    }
    for (const [name, m] of this.markers) {
      if (!seen.has(name)) { m.remove(); this.markers.delete(name); }
    }
    if (this.follow && this.selected && this.markers.has(this.selected)) {
      this.map.panTo(this.markers.get(this.selected).getLatLng(), { animate: true, duration: 0.4 });
    }
  }

  icon(v) {
    const shape = v.kind === 'rover' || v.kind === 'boat' ? ROUND : ARROW;
    return L.divIcon({
      className: 'map-vehicle', iconSize: [30, 30],
      html: `<div class="shape">${shape}</div><div class="tag"><b></b><span class="alt"></span></div>`,
    });
  }

  extendTrail(v, at) {
    let line = this.trails.get(v.name);
    if (!line) {
      line = L.polyline([], { color: v.color, weight: 3, opacity: 0.8, interactive: false });
      if (this.showTrails) line.addTo(this.map);
      this.trails.set(v.name, line);
    }
    const pts = line.getLatLngs();
    const last = pts[pts.length - 1];
    if (!last || this.map.distance(last, at) > 0.5) {
      line.addLatLng(at);
      if (pts.length > TRAIL_POINTS) { pts.splice(0, pts.length - TRAIL_POINTS); line.setLatLngs(pts); }
    }
  }

  setTrails(on) {
    this.showTrails = on;
    for (const line of this.trails.values()) {
      if (on) line.addTo(this.map); else line.remove();
    }
  }

  clearTrails() {
    for (const line of this.trails.values()) line.setLatLngs([]);
  }

  select(name) {
    this.selected = name;
    for (const [n, m] of this.markers) m.getElement()?.classList.toggle('selected', n === name);
  }

  setFollow(on) {
    this.follow = on;
    if (on && this.selected && this.markers.has(this.selected)) this.map.panTo(this.markers.get(this.selected).getLatLng());
  }

  fit() {
    const pts = [...this.markers.values()].map((m) => m.getLatLng());
    if (this.home) pts.push(this.home.getLatLng());
    if (pts.length === 1) this.map.setView(pts[0], 18);
    else if (pts.length) this.map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 19 });
  }

  clear() {
    for (const m of this.markers.values()) m.remove();
    for (const l of this.trails.values()) l.remove();
    this.markers.clear();
    this.trails.clear();
    this.placed = false;
  }

  // a click on the map: offer to fly a vehicle there
  clicked(latlng) {
    const flying = this.vehicles.filter((v) => v.status === 'online' && v.telemetry?.lat != null);
    if (!flying.length) return;
    const pick = flying.find((v) => v.name === this.selected) || flying.find((v) => v.telemetry.armed) || flying[0];
    const box = document.createElement('form');
    box.className = 'goto';
    const sel = document.createElement('select');
    for (const v of flying) sel.append(new Option(v.name, v.name, false, v.name === pick.name));
    const alt = document.createElement('input');
    Object.assign(alt, { type: 'number', min: '1', max: '5000', step: '1', title: 'Altitude above home, m' });
    const note = document.createElement('small');
    note.className = 'warn';
    const setAlt = () => {
      const v = flying.find((x) => x.name === sel.value);
      const a = v?.telemetry?.alt_rel;
      alt.value = a != null && a > 2 ? Math.round(a) : (v?.kind === 'plane' ? 60 : 20);
      note.textContent = v?.telemetry?.armed ? '' : `${v.name} is not armed: take off first`;
    };
    setAlt();
    sel.onchange = setAlt;
    const go = document.createElement('button');
    go.className = 'btn primary';
    go.textContent = 'Fly here';
    const dist = document.createElement('small');
    const from = this.markers.get(pick.name)?.getLatLng();
    dist.textContent = `${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}` + (from ? ` · ${fmtDist(this.map.distance(from, latlng))} from ${pick.name}` : '');
    const unit = document.createElement('span');
    unit.textContent = 'm';
    const row = document.createElement('div');
    row.className = 'row';
    row.append(sel, alt, unit);
    box.append(row, go, dist, note);
    const popup = L.popup({ className: 'map-popup', closeButton: true, autoPanPadding: [20, 20] })
      .setLatLng(latlng).setContent(box).openOn(this.map);
    box.onsubmit = (e) => {
      e.preventDefault();
      this.onGoto(sel.value, latlng.lat, latlng.lng, Number(alt.value));
      popup.close();
    };
  }
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`;
}
