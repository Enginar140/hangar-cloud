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
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xb8cde6);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 30000);
    this.camera.position.set(-25, -25, 15);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x4a4030, 1.4));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(400, -300, 850);
    this.scene.add(this.sun);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.entities = new Map();   // Gazebo entity id -> Object3D
    this.models = new Map();     // top-level model name -> Object3D
    this.vehicleLabels = new Map();
    this.cache = new Map();      // mesh file -> Promise<Object3D>
    this.following = null;
    this.lastFollow = new THREE.Vector3();
    this.userMoved = false;
    this.pending = 0;

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
    if (this.following) {
      const obj = this.models.get(this.following);
      if (obj) {
        const p = obj.getWorldPosition(new THREE.Vector3());
        this.camera.position.add(p.clone().sub(this.lastFollow));
        this.controls.target.copy(p);
        this.lastFollow.copy(p);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  // --- scene ---------------------------------------------------------------

  clear() {
    for (const label of this.vehicleLabels.values()) label.removeFromParent();
    this.vehicleLabels.clear();
    this.world.clear();
    this.entities.clear();
    this.models.clear();
  }

  setScene(msg) {
    this.clear();
    const s = msg.scene;
    if (s.background) this.scene.background = color(s.background);
    const sun = s.lights.find((l) => l.type === 3 || l.name === 'sun');  // 3 = directional
    if (sun && sun.direction) {
      const d = new THREE.Vector3(...sun.direction).normalize();
      this.sun.position.copy(d.multiplyScalar(-1000));
    }
    for (const m of s.models) {
      const obj = this.model(m, this.world);
      this.models.set(m.name, obj);
    }
    if (!this.userMoved) this.frameVehicles();
  }

  model(m, parent) {
    const g = new THREE.Group();
    g.name = m.name;
    setPose(g, m.pose);
    this.entities.set(m.id, g);
    for (const link of m.links) {
      const lg = new THREE.Group();
      lg.name = link.name;
      setPose(lg, link.pose);
      this.entities.set(link.id, lg);
      for (const v of link.visuals) lg.add(this.visual(v));
      g.add(lg);
    }
    for (const n of m.models) this.model(n, g);
    parent.add(g);
    return g;
  }

  visual(v) {
    const g = new THREE.Group();
    g.name = v.name;
    setPose(g, v.pose);
    if (v.scale) g.scale.set(...v.scale);
    this.entities.set(v.id, g);
    const geo = v.geometry;
    if (!geo) return g;
    if (geo.kind === 'mesh') {
      this.mesh(geo, v).then((obj) => obj && g.add(obj));
    } else if (geo.kind === 'heightmap') {
      this.heightmap(geo).then((obj) => obj && g.add(obj));
    } else {
      const shape = primitive(geo);
      if (shape) g.add(new THREE.Mesh(shape, material(v)));
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
        const buf = await (await fetch(fileUrl(geo.heights.file))).arrayBuffer();
        const raw = new Uint16Array(buf);
        n = geo.heights.n;
        const k = geo.heights.scale;
        z = (r, c) => raw[r * n + c] * k;
      } else {
        const img = await loadImage(fileUrl(geo.file));
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
    mesh.position.set(geo.pos[0], geo.pos[1], geo.pos[2] - TERRAIN_SINK);
    return mesh;
  }

  track(promise) {
    this.pending++;
    this.dispatchLoading();
    return promise.finally(() => { this.pending--; this.dispatchLoading(); });
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
      let label = this.vehicleLabels.get(v.name);
      if (!label) {
        const el = document.createElement('div');
        el.className = 'vlabel';
        el.addEventListener('click', () => this.onSelect && this.onSelect(v.name));
        label = new CSS2DObject(el);
        label.position.set(0, 0, 1.6);
        obj.add(label);
        this.vehicleLabels.set(v.name, label);
      }
      const t = v.telemetry || {};
      const alt = t.alt_rel == null ? '' : ` · ${t.alt_rel.toFixed(0)} m`;
      label.element.textContent = `${v.name} · ${t.mode || '-'}${t.armed ? ' · ARMED' : ''}${alt}`;
      label.element.classList.toggle('armed', !!t.armed);
      label.element.classList.toggle('selected', this.following === v.name);
    }
    for (const [name, label] of this.vehicleLabels) {
      if (!names.has(name)) { label.removeFromParent(); this.vehicleLabels.delete(name); }
    }
    this.vehicleNames = [...names];
  }

  follow(name) {
    this.following = name || null;
    const obj = name && this.models.get(name);
    if (obj) {
      const p = obj.getWorldPosition(new THREE.Vector3());
      this.camera.position.copy(p).add(new THREE.Vector3(-14, -14, 8));
      this.controls.target.copy(p);
      this.lastFollow.copy(p);
    }
  }

  look(position, target) {  // for tests and links: camera at position, looking at target
    this.following = null;
    this.camera.position.set(...position);
    this.controls.target.set(...target);
  }

  frameVehicles() {
    const names = [...this.models.keys()].filter((n) => !/terrain|ground|buildings|runway|sun/i.test(n));
    const box = new THREE.Box3();
    for (const n of names) box.expandByPoint(this.models.get(n).getWorldPosition(new THREE.Vector3()));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length(), 20);
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(-r, -r, r * 0.6));
  }
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
    metalness: m.metalness ?? 0.0,
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
  obj.traverse((o) => { if (o.isLight || o.isCamera) extras.push(o); });
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
