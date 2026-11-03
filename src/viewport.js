// three.js viewport. Scene graph mirrors the document hierarchy:
//   model (Group) → component Group (per doc component) → Mesh (per part)
// so component transforms compose with part transforms through three's own
// matrix math, and the gizmo can drive either level. Picking resolves a hit
// mesh to its component or part depending on the selection mode; parts
// render as soon as they exist and are swapped for their optimized mesh when
// the worker delivers it (the doc update carries `optimized`).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { ViewHelper } from "three/addons/helpers/ViewHelper.js";
import { buildGeometry } from "./scene-model.js";

export class Viewport {
  constructor(container, doc, { onSelect, onStats, onHover, helperEl }) {
    this.container = container; this.doc = doc; this.onSelect = onSelect; this.onStats = onStats; this.onHover = onHover;
    this.meshes = new Map(); this.groups = new Map();
    this.selection = null; // primary { type: "component"|"part", id }
    this.extra = [];       // additional selections (Shift+click), same shape
    this.selectMode = "component"; this.shading = "smooth";

    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true; this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x3c3c3c);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500); this.camera.position.set(3.5, 2.6, 4.2);
    this.model = new THREE.Group(); this.model.name = "model"; this.scene.add(this.model);

    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3326, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(5, 8, 4); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = key.shadow.camera.bottom = -8; key.shadow.camera.right = key.shadow.camera.top = 8;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ab7ff, 0.5); fill.position.set(-6, 3, -4); this.scene.add(fill);
    this.grid = new THREE.GridHelper(24, 24, 0x6a6a6a, 0x4c4c4c); this.grid.position.y = 0.001; this.scene.add(this.grid);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.3 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = true; this.orbit.dampingFactor = 0.12; this.orbit.target.set(0, 0.6, 0);
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.DOLLY };
    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.addEventListener("dragging-changed", (e) => { this.orbit.enabled = !e.value; e.value ? this.beginDrag() : this.commitGizmo(); });
    this.gizmo.addEventListener("objectChange", () => { this.gizmoDirty = true; this.applyPivotDelta(); this.onSelect?.(this.selection, true); });
    this.scene.add(this.gizmo.getHelper()); this.gizmo.enabled = false; this.gizmo.visible = false;
    // Multi-selection pivot: the gizmo drives this empty, and its delta is applied to every selected object.
    this.pivot = new THREE.Group(); this.pivot.name = "pivot"; this.scene.add(this.pivot);

    this.viewHelper = new ViewHelper(this.camera, helperEl); this.viewHelper.center = this.orbit.target;
    helperEl.addEventListener("pointerup", (e) => this.viewHelper.handleClick(e));
    this.clock = new THREE.Clock();

    // Selection outline: a bright box around the selected component / part.
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0x80b7e0); this.selBox.visible = false; this.scene.add(this.selBox);
    this.hoverBox = new THREE.Box3Helper(new THREE.Box3(), 0x8a8a8a); this.hoverBox.visible = false; this.scene.add(this.hoverBox);

    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => { this.down = [e.clientX, e.clientY, e.altKey]; });
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    el.addEventListener("pointermove", (e) => this.onHover(e));

    this.uvMaterial = makeUVStressMaterial();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    doc.onChange(({ kind, ids, componentIds }) => (kind === "restore" ? this.rebuildAll() : this.rebuild(ids, componentIds)));
    this.rebuildAll();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() { const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1; this.renderer.setSize(w, h, true); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  frame() {
    const dt = this.clock.getDelta();
    if (this.viewHelper.animating) this.viewHelper.update(dt); else this.orbit.update();
    this.renderer.clear(); this.renderer.render(this.scene, this.camera); this.viewHelper.render(this.renderer);
  }

  // ---- tools / gizmo ---------------------------------------------------------
  setTool(tool) {
    this.tool = tool;
    if (tool === "select") { this.gizmo.enabled = false; this.gizmo.visible = false; this.gizmo.detach(); return; }
    this.gizmo.setMode(tool); this.gizmo.enabled = true; this.attachGizmo();
  }
  attachGizmo() {
    const objs = this.selectedObjects();
    if (!objs.length || !this.gizmo.enabled) { this.gizmo.detach(); this.gizmo.visible = false; return; }
    if (objs.length === 1) { this.gizmo.attach(objs[0]); this.gizmo.visible = true; return; }
    // Several: park the pivot at the set's centre and drive that.
    const box = new THREE.Box3(); for (const o of objs) box.expandByObject(o, true);
    this.pivot.position.copy(box.getCenter(new THREE.Vector3())); this.pivot.rotation.set(0, 0, 0); this.pivot.scale.set(1, 1, 1);
    this.gizmo.attach(this.pivot); this.gizmo.visible = true;
  }
  setSnap(on) { this.gizmo.setTranslationSnap(on ? 0.1 : null); this.gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null); this.gizmo.setScaleSnap(on ? 0.1 : null); }

  beginDrag() {
    if (this.gizmo.object !== this.pivot) return;
    this.pivot.updateMatrixWorld(true);
    this.dragStart = { pivotInv: this.pivot.matrixWorld.clone().invert(), objs: this.selectedObjects().map((o) => { o.updateMatrixWorld(true); return { o, world: o.matrixWorld.clone() }; }) };
  }
  // world' = pivotNow · pivotStart⁻¹ · worldStart, then back into each object's parent space.
  applyPivotDelta() {
    if (this.gizmo.object !== this.pivot || !this.dragStart) return;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(this.dragStart.pivotInv);
    const parentInv = new THREE.Matrix4();
    for (const { o, world } of this.dragStart.objs) {
      o.parent.updateMatrixWorld(true); parentInv.copy(o.parent.matrixWorld).invert();
      const local = parentInv.multiply(delta.clone().multiply(world));
      local.decompose(o.position, o.quaternion, o.scale);
    }
  }

  commitGizmo() {
    if (!this.gizmoDirty || !this.selection) return; this.gizmoDirty = false;
    const deg = (r) => +THREE.MathUtils.radToDeg(r).toFixed(2);
    const ops = [];
    for (const s of this.selectionSet()) {
      const obj = s.type === "component" ? this.groups.get(s.id) : this.meshes.get(s.id); if (!obj) continue;
      const transform = { position: obj.position.toArray().map((v) => +v.toFixed(4)), rotation: [deg(obj.rotation.x), deg(obj.rotation.y), deg(obj.rotation.z)], scale: obj.scale.toArray().map((v) => +v.toFixed(4)) };
      ops.push(s.type === "component" ? { op: "updateComponent", id: s.id, patch: { transform } } : { op: "update", id: s.id, patch: { transform } });
    }
    this.dragStart = null;
    this.doc.applyOps(ops);
  }

  // ---- picking ---------------------------------------------------------------
  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects([...this.meshes.values()].filter((m) => m.visible), false)[0]?.object ?? null;
  }
  onPointerUp(e) {
    if (!this.down || this.down[2] || Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 4 || this.gizmo.dragging) return;
    const hit = this.pick(e);
    if (!hit) { if (!e.shiftKey) this.select(null); return; }
    const partId = hit.userData.id; const compId = this.doc.get(partId)?.componentId;
    const add = e.shiftKey;
    if (add) { // Shift+click: add/toggle at the level of the current selection (or the pick mode)
      const level = this.selection?.type ?? (this.selectMode === "component" ? "component" : "part");
      this.select(level === "component" ? { type: "component", id: compId } : { type: "part", id: partId }, { add: true }); return;
    }
    // Component mode: first click picks the component; clicking inside an already
    // selected component drills to the part (Maya-like "select hierarchy → child").
    if (this.selectMode === "component" && !(this.selection?.type === "component" && this.selection.id === compId) && !(this.selection?.type === "part" && this.doc.get(this.selection.id)?.componentId === compId))
      this.select({ type: "component", id: compId });
    else this.select({ type: "part", id: partId });
  }
  onDoubleClick(e) { const hit = this.pick(e); if (hit) this.select({ type: "part", id: hit.userData.id }); }
  onHover(e) {
    if (this.down || this.gizmo.dragging) return;
    const hit = this.pick(e);
    if (!hit) { this.hoverBox.visible = false; this.container.style.cursor = ""; this.onHover?.(null); return; }
    const part = this.doc.get(hit.userData.id); const comp = part && this.doc.getComponent(part.componentId);
    const obj = this.selectMode === "component" ? this.groups.get(part?.componentId) : hit;
    if (obj) { this.hoverBox.box.setFromObject(obj, true); this.hoverBox.visible = true; this.container.style.cursor = "pointer"; }
    this.onHover?.({ component: comp?.name ?? "", part: part?.name.replace(/^.*?:\s*/, "") ?? "", x: e.clientX, y: e.clientY, level: this.selectMode === "component" && !(this.selection && (this.selection.id === part?.componentId || this.doc.get(this.selection.id)?.componentId === part?.componentId)) ? "component" : "part" });
  }

  selectedObject() {
    if (!this.selection) return null;
    return this.selection.type === "component" ? this.groups.get(this.selection.id) ?? null : this.meshes.get(this.selection.id) ?? null;
  }
  selectionSet() { return this.selection ? [this.selection, ...this.extra] : []; }
  selectedObjects() { return this.selectionSet().map((s) => (s.type === "component" ? this.groups.get(s.id) : this.meshes.get(s.id))).filter(Boolean); }
  exists(s) { return s && (s.type === "component" ? this.groups.has(s.id) : this.meshes.has(s.id)); }
  // add: Shift semantics — toggle membership; the clicked item becomes primary.
  select(selection, { add = false } = {}) {
    const same = (a, b) => a && b && a.type === b.type && a.id === b.id;
    if (!this.exists(selection)) selection = null;
    if (add && selection) {
      const set = this.selectionSet();
      if (set.some((s) => same(s, selection))) { // toggle off
        const rest = set.filter((s) => !same(s, selection)); this.selection = rest[0] ?? null; this.extra = rest.slice(1);
      } else { this.extra = set.filter((s) => s.type === selection.type); this.selection = selection; } // mixed levels are not allowed
    } else { this.selection = selection; this.extra = []; }
    for (const [pid, m] of this.meshes) this.applyMaterial(m, this.doc.get(pid));
    this.attachGizmo(); this.updateSelBox();
    this.onSelect?.(this.selection);
  }
  selectAll(type = "component") {
    const ids = type === "component" ? [...this.groups.keys()] : [...this.meshes.keys()];
    if (!ids.length) return; this.selection = { type, id: ids[0] }; this.extra = ids.slice(1).map((id) => ({ type, id }));
    for (const [pid, m] of this.meshes) this.applyMaterial(m, this.doc.get(pid));
    this.attachGizmo(); this.updateSelBox(); this.onSelect?.(this.selection);
  }
  selectParent() { if (this.selection?.type === "part") this.select({ type: "component", id: this.doc.get(this.selection.id).componentId }); }
  setSelectMode(mode) { this.selectMode = mode; if (mode === "component" && this.selection?.type === "part") this.selectParent(); }
  updateSelBox() {
    const objs = this.selectedObjects();
    if (!objs.length) { this.selBox.visible = false; return; }
    const box = new THREE.Box3(); for (const o of objs) box.expandByObject(o, true);
    this.selBox.box.copy(box); this.selBox.visible = true;
  }
  isSelected(part) {
    return this.selectionSet().some((s) => (s.type === "part" ? s.id === part.id : s.id === part.componentId));
  }

  // ---- shading ---------------------------------------------------------------
  setShading(mode) { this.shading = mode; for (const m of this.meshes.values()) this.applyMaterial(m, this.doc.get(m.userData.id)); }
  toggleGrid() { this.grid.visible = !this.grid.visible; return this.grid.visible; }
  applyMaterial(mesh, part) {
    if (!part) return;
    if (mesh.userData.ownMat && mesh.material !== this.uvMaterial) mesh.material.dispose();
    if (this.shading === "uv") { mesh.material = this.uvMaterial; mesh.userData.ownMat = false; return; }
    const selected = this.isSelected(part); const strong = selected && this.selection?.type === "part";
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(part.material.color || "#999"), roughness: part.material.roughness ?? 0.7, metalness: part.material.metalness ?? 0.05, wireframe: this.shading === "wire", side: THREE.DoubleSide });
    // Emissive (engine glow, lights) comes from the part; selection tint is layered on top.
    if (part.material.emissiveIntensity > 0 && part.material.emissive) { mat.emissive.set(part.material.emissive); mat.emissiveIntensity = part.material.emissiveIntensity; }
    if (selected) { mat.emissive.set(0x3b6f91); mat.emissiveIntensity = strong ? 1 : 0.45; if (this.shading === "wire") mat.color.set(0x80b7e0); }
    else if (this.shading === "wire") mat.color.set(0x9ac8ff);
    if (!part.optimized) { mat.transparent = true; mat.opacity = 0.85; } // placeholder until the optimizer delivers
    mesh.material = mat; mesh.userData.ownMat = true;
  }

  // ---- scene graph sync ---------------------------------------------------------
  rebuildAll() {
    for (const m of this.meshes.values()) this.disposeMesh(m); this.meshes.clear();
    for (const g of this.groups.values()) this.model.remove(g); this.groups.clear();
    this.rebuild([...this.doc.parts.keys()], [...this.doc.components.keys()]);
    if (this.selection && !this.selectedObject()) this.select(null);
  }
  groupFor(compId) {
    let g = this.groups.get(compId);
    if (!g) { g = new THREE.Group(); g.userData.id = compId; this.model.add(g); this.groups.set(compId, g); }
    const c = this.doc.getComponent(compId);
    if (c) { g.name = c.name; g.position.fromArray(c.transform.position); g.rotation.set(...c.transform.rotation.map(THREE.MathUtils.degToRad)); g.scale.fromArray(c.transform.scale); g.visible = c.visible !== false; }
    return g;
  }
  rebuild(ids, componentIds = []) {
    for (const cid of componentIds) { if (this.doc.getComponent(cid)) this.groupFor(cid); else { const g = this.groups.get(cid); if (g) { this.model.remove(g); this.groups.delete(cid); } } }
    for (const id of ids) {
      const part = this.doc.get(id); const old = this.meshes.get(id);
      if (!part) { if (old) { this.disposeMesh(old); this.meshes.delete(id); } continue; }
      const geom = part.optimized ? fromSerialized(part.optimized) : buildGeometry(part);
      let mesh = old;
      if (!mesh) { mesh = new THREE.Mesh(geom); mesh.castShadow = mesh.receiveShadow = true; mesh.userData.id = id; this.meshes.set(id, mesh); }
      else { mesh.geometry.dispose(); mesh.geometry = geom; }
      const group = this.groupFor(part.componentId); if (mesh.parent !== group) group.add(mesh);
      mesh.position.fromArray(part.transform.position); mesh.rotation.set(...part.transform.rotation.map(THREE.MathUtils.degToRad)); mesh.scale.fromArray(part.transform.scale);
      mesh.visible = part.visible !== false;
      this.applyMaterial(mesh, part);
    }
    // drop empty groups
    for (const [cid, g] of this.groups) if (!this.doc.getComponent(cid)) { this.model.remove(g); this.groups.delete(cid); }
    this.extra = this.extra.filter((s) => this.exists(s));
    if (this.selection && !this.selectedObject()) this.select(this.extra[0] ?? null); else { this.updateSelBox(); if (this.gizmo.enabled && !this.gizmo.dragging) this.attachGizmo(); }
    this.stats();
  }
  stats() {
    let tris = 0, verts = 0;
    for (const m of this.meshes.values()) { if (!m.visible) continue; const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; verts += g.attributes.position.count; }
    this.onStats?.({ components: this.groups.size, parts: this.meshes.size, tris, verts });
  }
  disposeMesh(m) { m.parent?.remove(m); m.geometry.dispose(); if (m.userData.ownMat) m.material.dispose(); }

  // Render the model from several canonical angles (for the agent's self-review),
  // then restore the user's camera. Returns [{name, mediaType, data}].
  captureViews(width = 512) {
    const saved = { pos: this.camera.position.clone(), target: this.orbit.target.clone() };
    const box = new THREE.Box3().expandByObject(this.model, true);
    if (box.isEmpty()) return [];
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
    const views = { "front three-quarter": [0.7, 0.45, 0.9], "rear three-quarter": [-0.7, 0.4, -0.9], "side": [1, 0.15, 0.05], "top": [0.05, 1, 0.05] };
    const out = [];
    const src = this.renderer.domElement; const h = Math.round((width * src.height) / src.width);
    for (const [name, d] of Object.entries(views)) {
      this.camera.position.copy(c).add(new THREE.Vector3(...d).normalize().multiplyScalar(s * 1.25 + 0.3)); this.camera.lookAt(c);
      this.renderer.clear(); this.renderer.render(this.scene, this.camera);
      const cv = Object.assign(document.createElement("canvas"), { width, height: h });
      cv.getContext("2d").drawImage(src, 0, 0, width, h);
      out.push({ name, mediaType: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.8).split(",")[1] });
    }
    this.camera.position.copy(saved.pos); this.orbit.target.copy(saved.target); this.camera.lookAt(saved.target);
    return out;
  }

  // Small JPEG of the current view (for the generation history).
  thumbnail(width = 240) {
    this.frame();
    const src = this.renderer.domElement; const h = Math.round((width * src.height) / src.width);
    const c = Object.assign(document.createElement("canvas"), { width, height: h });
    c.getContext("2d").drawImage(src, 0, 0, width, h);
    return c.toDataURL("image/jpeg", 0.7);
  }

  // ---- camera ------------------------------------------------------------------
  frameAll() { this.frameObjects([this.model]); }
  frameSelected() { const o = this.selectedObject(); o ? this.frameObjects([o]) : this.frameAll(); }
  frameObjects(list) {
    const box = new THREE.Box3(); for (const o of list) box.expandByObject(o, true);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c); this.camera.position.copy(c).add(dir.multiplyScalar(s * 1.3 + 0.3));
  }
  setView(name) {
    const c = this.orbit.target.clone(); const d = Math.max(2, this.camera.position.distanceTo(c));
    const dirs = { persp: [0.6, 0.45, 0.66], top: [0, 1, 1e-4], front: [0, 0, 1], side: [1, 0, 0] };
    const v = new THREE.Vector3(...(dirs[name] ?? dirs.persp)).normalize().multiplyScalar(d);
    this.camera.position.copy(c).add(v); this.camera.lookAt(c);
  }
}

function fromSerialized(s) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(s.positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(s.normals, 3));
  if (s.uvs) g.setAttribute("uv", new THREE.Float32BufferAttribute(s.uvs, 2));
  g.setIndex(s.indices);
  return g;
}

function makeUVStressMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normalMatrix * normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; varying vec3 vN;
      void main(){ vec2 c = floor(vUv * 16.0); float k = mod(c.x + c.y, 2.0);
        float l = 0.55 + 0.45 * max(0.0, dot(normalize(vN), normalize(vec3(0.4,0.8,0.5))));
        vec3 col = mix(vec3(0.15,0.2,0.35), vec3(0.9,0.85,0.6), k) * l;
        gl_FragColor = vec4(col, 1.0); }`,
  });
}
