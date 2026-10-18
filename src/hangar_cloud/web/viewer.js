// The Gazebo scene, drawn by Three.js in the browser (the server needs no GPU for it).
// Gazebo is Z-up and so is everything here.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const MAX_TERRAIN_SEGMENTS = 1024;  // 1025 x 1025 heights: every one of them, like Gazebo
const TERRAIN_SINK = 0.05;  // m; vehicles resting on the ground never sink into it on screen
const TRAIL_POINTS = 4000;
const TRAIL_STEP = 0.3;  // m between trail points
const SHADOW_RANGE = 40;  // m around the camera's target that gets shadows
const FLAT = { minSize: 300, maxThickness: 0.05, stack: 1.0, spread: 10, maxEdge: 50 };  // see settleGround()
const SKY = { top: new THREE.Color(0x3d78c4), horizon: new THREE.Color(0xd6e4f0), ground: new THREE.Color(0x8d969c) };

// Gazebo cameras look along +x with +z up; Three's look along -z with +y up.
const GZ_TO_THREE = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)));

const fileUrl = (path) => '/files' + path.split('/').map(encodeURIComponent).join('/');

function setPose(obj, p) {
  if (!p) return;
  obj.position.set(p[0], p[1], p[2]);
  obj.quaternion.set(p[3], p[4], p[5], p[6]);
}

function color(c, fallback) {
  return c ? new THREE.Color(c[0], c[1], c[2]) : new THREE.Color(fallback);
}

export class Viewer {
  constructor(container, { onSelect, onCamera } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onCamera = onCamera;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(SKY.horizon, 1500, 12000);
    this.scene.add(this.sky = makeSky());
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 30000);
    this.camera.position.set(-25, -25, 15);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x5a5040, 1.1));
    this.sunDir = new THREE.Vector3(-0.4, 0.3, -0.85).normalize();
    this.sun = new THREE.DirectionalLight(0xfff4e6, 2.6);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -SHADOW_RANGE;
    sc.right = sc.top = SHADOW_RANGE;
    sc.near = 1;
    sc.far = 600;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.trailGroup = new THREE.Group();
    this.scene.add(this.trailGroup);
    this.entities = new Map();   // Gazebo entity id -> Object3D
    this.models = new Map();     // top-level model name -> Object3D
    this.vehicles = new Map();   // vehicle name -> { label, trail }
    this.savedTrails = new Map();
    this.cache = new Map();      // mesh file -> Promise<Object3D>
    this.viewCams = new Map();   // vehicle name -> [{ name, cam, width, height, sensor }]
    this.pip = null;             // { vehicle, index, el, full }
    this.target = null;          // followed vehicle
    this.mode = 'free';          // free | follow | chase | top
    this.chaseDistance = 8;
    this.lastTarget = new THREE.Vector3();
    this.userMoved = false;
    this.pending = 0;
    this.showTrails = true;

    this.pickRay = new THREE.Raycaster();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4) this.pick(e);
      down = null;
    });
    el.addEventListener('wheel', (e) => {
      if (this.mode === 'chase' || this.mode === 'top') {
        this.chaseDistance = Math.min(Math.max(this.chaseDistance * (e.deltaY > 0 ? 1.12 : 0.89), 2), 400);
        e.preventDefault();
      }
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const obj = this.target && this.models.get(this.target);
    if (obj && this.mode !== 'free') {
      const p = obj.getWorldPosition(new THREE.Vector3());
      if (this.mode === 'follow') {
        this.camera.position.add(p.clone().sub(this.lastTarget));
        this.controls.target.copy(p);
      } else {
        const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
        fwd.z = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
        fwd.normalize();
        const d = this.chaseDistance;
        const want = this.mode === 'chase'
          ? p.clone().addScaledVector(fwd, -d).add(new THREE.Vector3(0, 0, d * 0.32))
          : p.clone().add(new THREE.Vector3(0, -0.01, d * 4));  // top: north up
        this.camera.position.lerp(want, 0.15);
        const look = this.mode === 'chase' ? p.clone().addScaledVector(fwd, d * 0.15).add(new THREE.Vector3(0, 0, d * 0.08)) : p;
        this.controls.target.lerp(look, 0.3);
      }
      this.lastTarget.copy(p);
    }
    this.controls.enabled = (this.mode === 'free' || this.mode === 'follow') && !(this.pip && this.pip.full);
    this.controls.update();
    this.updateTrails();
    this.render();
    if (this.onCamera) {
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      this.onCamera(Math.atan2(dir.x, dir.y) * 180 / Math.PI);  // 0 = looking north
    }
  }

  render() {
    // shadows follow what you look at; the sky follows the camera
    const t = this.controls.target;
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).addScaledVector(this.sunDir, -300);
    const W = this.container.clientWidth, H = this.container.clientHeight;
    const view = this.pip && this.viewCamera(this.pip.vehicle, this.pip.index);
    if (view && this.pip.full) {  // the vehicle's camera fills the view, letterboxed
      this.renderer.setClearColor(0x05080c);
      this.renderer.clear();
      const k = Math.min(W / view.cam.aspect, H);
      const w = k * view.cam.aspect, h = k;
      this.renderView(view.cam, (W - w) / 2, (H - h) / 2, w, h);
      this.labels.domElement.style.visibility = 'hidden';
      return;
    }
    this.labels.domElement.style.visibility = '';
    this.placeSky(this.camera);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    if (view && this.pip.el) {
      const box = this.pip.el.getBoundingClientRect(), own = this.container.getBoundingClientRect();
      if (box.width > 0) this.renderView(view.cam, box.left - own.left, box.top - own.top, box.width, box.height);
    }
  }

  /** Draw what cam sees into a rectangle of the canvas (CSS pixels, from the top left). */
  renderView(cam, x, y, w, h) {
    const H = this.container.clientHeight;
    const r = this.renderer;
    this.placeSky(cam);
    r.setViewport(x, H - y - h, w, h);
    r.setScissor(x, H - y - h, w, h);
    r.setScissorTest(true);
    r.render(this.scene, cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.container.clientWidth, H);
  }

  placeSky(cam) {  // around the camera, inside its far plane (beyond it the sky would be cut away)
    this.sky.position.copy(cam.getWorldPosition(new THREE.Vector3()));
    this.sky.scale.setScalar(cam.far * 0.5);
  }

  // --- vehicle cameras ---------------------------------------------------------

  viewCameras(name) {
    return this.viewCams.get(name) || [];
  }

  viewCamera(name, index = 0) {
    const list = this.viewCameras(name);
    return list[Math.min(index, list.length - 1)] || null;
  }

  addViewCamera(vehicle, entry) {
    if (!this.viewCams.has(vehicle)) this.viewCams.set(vehicle, []);
    this.viewCams.get(vehicle).push(entry);
  }

  setPip(pip) {
    this.pip = pip;
  }

  /** The vehicle camera's picture as ImageData, for processing in the browser
   *  (OpenCV.js, TensorFlow.js, ...). At most the size of this page's canvas. */
  grabFrame(name, index = 0, maxWidth = 1280) {
    const view = this.viewCamera(name, index);
    if (!view) return null;
    const canvas = this.renderer.domElement, pr = this.renderer.getPixelRatio();
    let w = Math.min(view.width, maxWidth), h = Math.round(w / view.cam.aspect);
    const k = Math.min(1, canvas.width / w, canvas.height / h);
    w = Math.floor(w * k);
    h = Math.floor(h * k);
    // draw into the canvas's bottom-left corner, copy it out, then draw the page again
    this.renderView(view.cam, 0, canvas.height / pr - h / pr, w / pr, h / pr);
    const out = new OffscreenCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, 0, canvas.height - h, w, h, 0, 0, w, h);
    this.render();
    return ctx.getImageData(0, 0, w, h);
  }

  async saveFrame(name, index = 0) {
    const img = this.grabFrame(name, index, 4096);
    if (!img) return false;
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d').putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  }

  // --- scene ---------------------------------------------------------------

  clear(keepTrails = false) {
    for (const [name, v] of this.vehicles) {
      v.label.removeFromParent();
      v.trail.line.removeFromParent();
      if (keepTrails) this.savedTrails.set(name, v.trail);
    }
    if (!keepTrails) this.savedTrails.clear();
    this.vehicles.clear();
    this.world.clear();
    this.entities.clear();
    this.models.clear();
    this.viewCams.clear();
  }

  setScene(msg) {
    this.clear(true);  // a model was added: keep the paths flown so far
    const s = msg.scene;
    const sun = s.lights.find((l) => l.type === 3 || l.name === 'sun');  // 3 = directional
    if (sun && sun.direction && Math.hypot(...sun.direction) > 0) {
      this.sunDir.set(...sun.direction).normalize();
      if (this.sunDir.z > -0.25) this.sunDir.z = -0.25;  // keep some light on top surfaces
      this.sunDir.normalize();
    }
    let extent = 0;
    for (const m of s.models) {
      this.models.set(m.name, this.model(m, this.world, m.static, m.name));
      for (const link of m.links) {
        for (const v of link.visuals) {
          const g = v.geometry || {};
          if (g.kind === 'heightmap' || g.kind === 'plane') extent = Math.max(extent, g.size[0]);
        }
      }
    }
    // fog hides the world's edge, not the place you fly in
    extent = Math.max(extent, 400);
    this.scene.fog.near = extent * 0.35;
    this.scene.fog.far = extent * 1.6;
    if (!this.userMoved) this.frameVehicles();
    this.settleGround();  // primitives are there now; meshes call it again when loaded
  }

  model(m, parent, isStatic, top) {
    const g = new THREE.Group();
    g.name = m.name;
    g.userData.static = isStatic;
    setPose(g, m.pose);
    this.entities.set(m.id, g);
    for (const link of m.links) {
      const lg = new THREE.Group();
      lg.name = link.name;
      setPose(lg, link.pose);
      this.entities.set(link.id, lg);
      for (const v of link.visuals) lg.add(this.visual(v, isStatic));
      for (const c of link.cameras || []) {
        const holder = new THREE.Group();
        setPose(holder, c.pose);
        const cam = viewCamera(c.hfov, c.width, c.height, c.near, c.far);
        holder.add(cam);
        lg.add(holder);
        this.addViewCamera(top, { name: c.name, cam, width: c.width, height: c.height, sensor: true });
      }
      g.add(lg);
    }
    for (const n of m.models) this.model(n, g, isStatic || n.static, top);
    parent.add(g);
    return g;
  }

  visual(v, isStatic) {
    const g = new THREE.Group();
    g.name = v.name;
    setPose(g, v.pose);
    if (v.scale) g.scale.set(...v.scale);
    this.entities.set(v.id, g);
    const geo = v.geometry;
    if (!geo) return g;
    const shade = (obj) => {
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = !isStatic && v.cast_shadows !== false;
        o.receiveShadow = true;
      });
      return obj;
    };
    if (geo.kind === 'mesh') {
      this.mesh(geo, v).then((obj) => obj && g.add(shade(obj)));
    } else if (geo.kind === 'heightmap') {
      this.heightmap(geo).then((obj) => obj && g.add(obj));
    } else {
      const shape = primitive(geo);
      if (shape) g.add(shade(new THREE.Mesh(shape, material(v))));
    }
    return g;
  }

  async mesh(geo, v) {
    const file = geo.file;
    if (!this.cache.has(file)) this.cache.set(file, this.track(loadMesh(file)));
    let obj;
    try {
      obj = (await this.cache.get(file)).clone(true);
    } catch (e) {
      console.warn('mesh', file, e);
      return null;
    }
    if (geo.submesh) {
      const part = obj.getObjectByName(geo.submesh);
      if (part) {
        part.removeFromParent();
        if (geo.center) {
          const box = new THREE.Box3().setFromObject(part);
          part.position.sub(box.getCenter(new THREE.Vector3()));
        }
        obj = part;
      }
    }
    const wrap = new THREE.Group();
    wrap.scale.set(...geo.scale);
    wrap.add(obj);
    const mat = v.material;
    if (mat && (mat.diffuse || mat.albedo_map) && !hasTextures(obj)) {
      const m = material(v);
      obj.traverse((o) => { if (o.isMesh) o.material = m; });
    }
    return wrap;
  }

  async heightmap(geo) {
    const [sx, sy, sz] = geo.size;
    let n, z;
    try {
      if (geo.heights) {
        const buf = await this.track(fetch(fileUrl(geo.heights.file)).then((r) => r.arrayBuffer()));
        const raw = new Uint16Array(buf);
        n = geo.heights.n;
        const k = geo.heights.scale;
        z = (r, c) => raw[r * n + c] * k;
      } else {
        const img = await this.track(loadImage(fileUrl(geo.file)));
        n = img.width;
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, img.width, img.height).data;
        z = (r, c) => (px[(r * img.width + c) * 4] / 255) * sz;
      }
    } catch (e) {
      console.warn('heightmap', e);
      return null;
    }
    const seg = Math.min(n - 1, MAX_TERRAIN_SEGMENTS);
    const plane = new THREE.PlaneGeometry(sx, sy, seg, seg);  // vertex rows run from +y (north) down
    const pos = plane.attributes.position;
    for (let i = 0; i <= seg; i++) {
      for (let j = 0; j <= seg; j++) {
        const r = Math.round((i / seg) * (n - 1)), c = Math.round((j / seg) * (n - 1));
        pos.setZ(i * (seg + 1) + j, z(r, c));
      }
    }
    plane.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8f7a, roughness: 1, metalness: 0 });
    const tex = geo.textures[0];
    if (tex && tex.diffuse) {
      const t = await this.track(new THREE.TextureLoader().loadAsync(fileUrl(tex.diffuse))).catch(() => null);
      if (t) {
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(sx / (tex.size || sx), sy / (tex.size || sy));
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        mat.map = t;
        mat.color.set(0xffffff);
      }
    }
    const mesh = new THREE.Mesh(plane, mat);
    mesh.receiveShadow = true;
    mesh.position.set(geo.pos[0], geo.pos[1], geo.pos[2] - TERRAIN_SINK);
    return mesh;
  }

  track(promise) {
    this.pending++;
    this.dispatchLoading();
    return promise.finally(() => {
      this.pending--;
      this.dispatchLoading();
      if (!this.pending) this.settleGround();
    });
  }

  /** Worlds often stack huge flat layers a centimetre apart (a runway plane on a grass
   *  plane, each two triangles kilometres wide). Over triangles that size the depth
   *  buffer cannot tell them apart and the wrong one shows, differently from run to run.
   *  Keep the top layer where it is and spread the ones below it further down. */
  settleGround() {
    const flats = [];
    this.world.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.split) {  // huge triangles clip and interpolate badly: cut them up once
        const box = new THREE.Box3().setFromObject(o);
        const size = box.getSize(new THREE.Vector3());
        if (Math.max(size.x, size.y) > FLAT.minSize && o.geometry.attributes.position.count < 5000) {
          const edge = Math.max(FLAT.maxEdge, Math.max(size.x, size.y) / 100);
          o.geometry = subdivide(o.geometry, o.getWorldScale(new THREE.Vector3()), edge);
        }
        o.userData.split = true;
      }
      if (o.userData.restZ !== undefined) {  // undo a previous pass
        const wp = o.getWorldPosition(new THREE.Vector3());
        wp.z += o.userData.restZ;
        o.parent.worldToLocal(wp);
        o.position.copy(wp);
        delete o.userData.restZ;
      }
      const box = new THREE.Box3().setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      if (size.z < FLAT.maxThickness && Math.max(size.x, size.y) > FLAT.minSize) flats.push([o, box.max.z]);
    });
    if (flats.length < 2) return;
    const top = Math.max(...flats.map(([, z]) => z));
    for (const [o, z] of flats) {
      const gap = top - z;
      if (gap <= 1e-4 || gap > FLAT.stack) continue;
      const drop = gap * (FLAT.spread - 1);
      const wp = o.getWorldPosition(new THREE.Vector3());
      wp.z -= drop;
      o.parent.worldToLocal(wp);
      o.position.copy(wp);
      o.userData.restZ = drop;
    }
  }

  dispatchLoading() {
    this.container.dispatchEvent(new CustomEvent('loading', { detail: this.pending }));
  }

  // --- updates ---------------------------------------------------------------

  updatePoses(list) {
    for (const p of list) {
      const obj = this.entities.get(p[0]);
      if (obj) {
        obj.position.set(p[1], p[2], p[3]);
        obj.quaternion.set(p[4], p[5], p[6], p[7]);
      }
    }
  }

  remove(ids) {
    for (const id of ids) {
      const obj = this.entities.get(id);
      if (obj) obj.removeFromParent();
      this.entities.delete(id);
    }
  }

  setVehicles(vehicles) {
    const names = new Set();
    for (const v of vehicles) {
      const obj = this.models.get(v.name);
      if (!obj) continue;
      names.add(v.name);
      let entry = this.vehicles.get(v.name);
      if (!entry) {
        const holder = document.createElement('div');  // CSS2DRenderer sets this one's transform
        const el = document.createElement('div');
        el.className = 'vlabel';
        el.addEventListener('click', () => this.onSelect && this.onSelect(v.name));
        holder.append(el);
        const label = new CSS2DObject(holder);
        obj.add(label);
        const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
        label.position.set(0, 0, Math.min(Math.max(size.z, 0.3), 3) * 0.6 + 0.2);
        const trail = this.savedTrails.get(v.name) || makeTrail(v.color);
        this.savedTrails.delete(v.name);
        trail.line.visible = this.showTrails;
        this.trailGroup.add(trail.line);
        entry = { label, trail };
        this.vehicles.set(v.name, entry);
        if (!this.viewCameras(v.name).length && v.view) {  // no camera on the model: one at its usual mount
          const [x, y, z, roll, pitch, yaw] = v.view.pose;
          const holder = new THREE.Group();
          holder.position.set(x, y, z);
          holder.quaternion.setFromEuler(new THREE.Euler(...[roll, pitch, yaw].map(THREE.MathUtils.degToRad), 'ZYX'));
          const cam = viewCamera(THREE.MathUtils.degToRad(v.view.hfov_deg), v.view.width, v.view.height, 0.05, 20000);
          holder.add(cam);
          obj.add(holder);
          this.addViewCamera(v.name, { name: 'nose (browser only)', cam, width: v.view.width, height: v.view.height, sensor: false });
        }
      }
      const t = v.telemetry || {};
      const el = entry.label.element.firstChild;
      el.style.setProperty('--c', v.color);
      const alt = t.alt_rel == null ? '' : `<span>${t.alt_rel.toFixed(0)} m</span>`;
      el.innerHTML = `<i></i><b>${escapeHtml(v.name)}</b><span>${escapeHtml(t.mode || '—')}</span>${alt}`;
      el.classList.toggle('armed', !!t.armed);
      el.classList.toggle('selected', this.target === v.name);
    }
    for (const [name, entry] of this.vehicles) {
      if (!names.has(name)) {
        entry.label.removeFromParent();
        entry.trail.line.removeFromParent();
        this.vehicles.delete(name);
      }
    }
  }

  updateTrails() {
    for (const [name, entry] of this.vehicles) {
      const obj = this.models.get(name);
      if (!obj) continue;
      const p = obj.getWorldPosition(new THREE.Vector3());
      const tr = entry.trail;
      const arr = tr.positions;
      if (tr.count) {
        const i = (tr.count - 1) * 3;
        if (Math.hypot(arr[i] - p.x, arr[i + 1] - p.y, arr[i + 2] - p.z) < TRAIL_STEP) continue;
      }
      if (tr.count === TRAIL_POINTS) {  // drop the oldest quarter
        const drop = TRAIL_POINTS / 4;
        arr.copyWithin(0, drop * 3);
        tr.count -= drop;
      }
      arr.set([p.x, p.y, p.z], tr.count * 3);
      tr.count++;
      tr.line.geometry.setDrawRange(0, tr.count);
      tr.line.geometry.attributes.position.needsUpdate = true;
    }
  }

  setTrails(on) {
    this.showTrails = on;
    for (const v of this.vehicles.values()) v.trail.line.visible = on;
  }

  clearTrails() {
    for (const v of this.vehicles.values()) {
      v.trail.count = 0;
      v.trail.line.geometry.setDrawRange(0, 0);
    }
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.pickRay.setFromCamera(ndc, this.camera);
    const candidates = [...this.vehicles.keys()].map((n) => this.models.get(n)).filter(Boolean);
    const hit = this.pickRay.intersectObjects(candidates, true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && !this.vehicles.has(o.name)) o = o.parent;
    if (o && this.onSelect) this.onSelect(o.name);
  }

  setCamera(mode, target) {
    this.mode = target ? mode : 'free';
    this.target = target || null;
    const obj = this.target && this.models.get(this.target);
    if (!obj) return;
    const p = obj.getWorldPosition(new THREE.Vector3());
    const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()).length();
    this.chaseDistance = Math.min(Math.max(size * 4, 5), 40);
    if (this.mode === 'follow') {
      const d = this.chaseDistance * 1.6;
      this.camera.position.copy(p).add(new THREE.Vector3(-d, -d, d * 0.6));
      this.controls.target.copy(p);
    }
    this.lastTarget.copy(p);
  }

  look(position, target) {  // for tests and links: camera at position, looking at target
    this.mode = 'free';
    this.target = null;
    this.camera.position.set(...position);
    this.controls.target.set(...target);
  }

  frameVehicles() {
    const names = [...this.vehicles.keys()];
    const pool = names.length ? names : [...this.models.keys()].filter((n) => !this.models.get(n).userData.static);
    const box = new THREE.Box3();
    for (const n of pool) box.expandByPoint(this.models.get(n).getWorldPosition(new THREE.Vector3()));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length(), 16);
    this.mode = 'free';
    this.target = null;
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(-r, -r * 1.2, r * 0.7));
  }
}

/** Split triangles in half across their longest edge until no edge is longer than
 *  maxEdge (measured with the object's world scale). Keeps normals and UVs. */
function subdivide(geometry, scale, maxEdge) {
  const src = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const names = ['position', 'normal', 'uv'].filter((n) => src.attributes[n]);
  let tris = [];
  const pos = src.attributes.position;
  for (let i = 0; i < pos.count; i += 3) {
    tris.push([0, 1, 2].map((k) => Object.fromEntries(names.map((n) => [n, Array.from({ length: src.attributes[n].itemSize }, (_, c) => src.attributes[n].array[(i + k) * src.attributes[n].itemSize + c])]))));
  }
  const len = (a, b) => Math.hypot((a[0] - b[0]) * scale.x, (a[1] - b[1]) * scale.y, (a[2] - b[2]) * scale.z);
  const mid = (a, b) => Object.fromEntries(names.map((n) => [n, a[n].map((x, c) => (x + b[n][c]) / 2)]));
  const out = [];
  while (tris.length && out.length < 400000) {
    const t = tris.pop();
    const e = [len(t[0].position, t[1].position), len(t[1].position, t[2].position), len(t[2].position, t[0].position)];
    const k = e.indexOf(Math.max(...e));
    if (e[k] <= maxEdge) { out.push(t); continue; }
    const a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3], m = mid(a, b);
    tris.push([a, m, c], [m, b, c]);
  }
  out.push(...tris);
  const geom = new THREE.BufferGeometry();
  for (const n of names) {
    const size = src.attributes[n].itemSize;
    const arr = new Float32Array(out.length * 3 * size);
    out.forEach((t, i) => t.forEach((v, j) => arr.set(v[n], (i * 3 + j) * size)));
    geom.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  for (const g of src.groups) geom.addGroup(0, out.length * 3, g.materialIndex);  // single-material planes in practice
  return geom;
}

function viewCamera(hfov, width, height, near, far) {
  const aspect = width / height;
  const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect));
  const cam = new THREE.PerspectiveCamera(vfov, aspect, Math.max(near, 0.02), Math.min(far, 25000));
  cam.quaternion.copy(GZ_TO_THREE);
  return cam;
}

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: { top: { value: SKY.top }, horizon: { value: SKY.horizon }, ground: { value: SKY.ground } },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir;
      void main() {
        float h = vDir.z;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, ground, pow(-h, 0.4));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

function makeTrail(css) {
  const positions = new Float32Array(TRAIL_POINTS * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geom.setDrawRange(0, 0);
  const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(css), transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geom, mat);
  line.frustumCulled = false;
  return { positions, count: 0, line };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function hasTextures(obj) {
  let found = false;
  obj.traverse((o) => {
    if (o.isMesh) for (const m of [].concat(o.material)) if (m && m.map) found = true;
  });
  return found;
}

function material(v) {
  const m = v.material || {};
  const opacity = 1 - (v.transparency || 0);
  const mat = new THREE.MeshStandardMaterial({
    color: color(m.diffuse, 0xb0b0b0),
    emissive: color(m.emissive, 0x000000),
    roughness: m.roughness ?? 0.75,
    metalness: Math.min(m.metalness ?? 0.0, 0.6),  // no environment map: fully metallic looks black
    transparent: opacity < 1,
    opacity,
    side: m.double_sided ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (m.albedo_map && m.albedo_map.startsWith('/')) {
    const loader = /\.tga$/i.test(m.albedo_map) ? new TGALoader() : new THREE.TextureLoader();
    loader.load(fileUrl(m.albedo_map), (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
      mat.needsUpdate = true;
    });
  }
  return mat;
}

function primitive(g) {
  const Z = (geom) => geom.rotateX(Math.PI / 2);  // Three's round shapes run along y, Gazebo's along z
  switch (g.kind) {
    case 'box': return new THREE.BoxGeometry(...g.size);
    case 'cylinder': return Z(new THREE.CylinderGeometry(g.radius, g.radius, g.length, 32));
    case 'cone': return Z(new THREE.ConeGeometry(g.radius, g.length, 32));
    case 'capsule': return Z(new THREE.CapsuleGeometry(g.radius, g.length, 6, 16));
    case 'sphere': return new THREE.SphereGeometry(g.radius, 32, 16);
    case 'ellipsoid': return new THREE.SphereGeometry(1, 32, 16).scale(...g.radii);
    case 'plane': {
      const geom = new THREE.PlaneGeometry(g.size[0], g.size[1]);
      const n = new THREE.Vector3(...g.normal).normalize();
      geom.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n));
      return geom;
    }
    default: return null;
  }
}

async function loadMesh(file) {
  const obj = await loadMeshFile(file);
  // Blender exports its lamps and cameras into .dae files; Gazebo ignores them and so do we
  // (a quadcopter otherwise brings eight point lights that wash the ground out).
  const extras = [];
  obj.traverse((o) => {
    if (o.isLight || o.isCamera) extras.push(o);
    // Gazebo draws meshes one-sided: a camera inside its own housing does not see the housing
    if (o.isMesh) for (const m of [].concat(o.material)) if (m) m.side = THREE.FrontSide;
  });
  for (const o of extras) o.removeFromParent();
  return obj;
}

async function loadMeshFile(file) {
  const url = fileUrl(file);
  const ext = file.split('.').pop().toLowerCase();
  if (ext === 'dae') {
    const dae = await new ColladaLoader().loadAsync(url);
    const s = dae.scene;
    // The loader turns Z-up files to Three's usual Y-up; we are Z-up, so undo that,
    // and turn Y-up files up the way Gazebo does.
    if (Math.abs(s.rotation.x + Math.PI / 2) < 1e-6) s.rotation.set(0, 0, 0);
    else s.rotation.set(Math.PI / 2, 0, 0);
    return s;
  }
  if (ext === 'obj') {
    const text = await (await fetch(url)).text();
    const loader = new OBJLoader();
    const lib = text.match(/^mtllib\s+(.+?)\s*$/m);
    if (lib) {
      const dir = url.slice(0, url.lastIndexOf('/') + 1);
      try {
        const mtl = await new MTLLoader().setPath(dir).loadAsync(lib[1]);
        mtl.preload();
        loader.setMaterials(mtl);
      } catch (e) { console.warn('mtl', e); }
    }
    return loader.parse(text);
  }
  if (ext === 'stl') {
    const geom = await new STLLoader().loadAsync(url);
    return new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.7 }));
  }
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.rotation.set(Math.PI / 2, 0, 0);
    return gltf.scene;
  }
  throw new Error(`cannot show .${ext} meshes`);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
