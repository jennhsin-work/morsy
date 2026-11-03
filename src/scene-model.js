// Scene document: an assembly hierarchy.
//
//   Model (root)
//   └─ Component  { id, name, transform, meta }      e.g. "hull", "oar_left"
//      └─ Part    { id, componentId, primitive, modifiers, transform, material }
//
// World matrix of a part = M_component · M_part. Agents own components; the
// UI selects at either level. Every change is a serialisable op so undo/redo,
// persistence and parallel agent work all compose; `transaction()` groups many
// ops (a whole agent run streamed in piece by piece) into one undo step.

import * as THREE from "three";
import { loopSubdivide } from "./geometry/subdivide.js";
import { loftGeometry, tubeGeometry, greeble, plating, radialArray } from "./geometry/detail.js";

let nextId = 1;
export const uid = (prefix = "part") => `${prefix}_${(nextId++).toString(36)}${Date.now().toString(36).slice(-3)}`;

export const PRIMITIVES = ["box", "cylinder", "sphere", "cone", "torus", "plane", "capsule", "lathe", "extrude", "loft", "tube"];
export const MODIFIERS = ["taper", "twist", "bend", "noise", "mirror", "array", "subdivide", "greeble", "plating", "radial"];

export const identityTransform = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

export function defaultComponent(overrides = {}) {
  return { id: uid("comp"), name: "component", transform: identityTransform(), meta: { agent: null, role: "" }, ...overrides };
}

export function defaultPart(overrides = {}) {
  return {
    id: uid(),
    componentId: null,
    name: "Part",
    primitive: { type: "box", params: { width: 1, height: 1, depth: 1, segments: 1 } },
    transform: { position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    material: { color: "#9aa4b5", roughness: 0.7, metalness: 0.05, emissive: "#000000", emissiveIntensity: 0 },
    modifiers: [],
    meta: { agent: null, strategy: null },
    ...overrides,
  };
}

export class SceneDocument {
  constructor() {
    this.parts = new Map(); this.components = new Map();
    this.undoStack = []; this.redoStack = []; this.listeners = new Set();
    this.inTransaction = false;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, ids, componentIds = []) { for (const fn of this.listeners) fn({ kind, ids, componentIds }); }

  get(id) { return this.parts.get(id); }
  getComponent(id) { return this.components.get(id); }
  list() { return [...this.parts.values()]; }
  listComponents() { return [...this.components.values()]; }
  partsOf(componentId) { return this.list().filter((p) => p.componentId === componentId); }
  componentOf(partId) { const p = this.parts.get(partId); return p ? this.components.get(p.componentId) : null; }

  snapshot() { return JSON.parse(JSON.stringify({ components: this.listComponents(), parts: this.list() })); }

  // Accepts the current {components, parts} shape or the legacy flat parts array
  // (parts named "component: detail" are grouped into components by prefix).
  restore(data) {
    const parts = Array.isArray(data) ? data : data.parts ?? [];
    const comps = Array.isArray(data) ? [] : data.components ?? [];
    this.components = new Map(comps.map((c) => [c.id, normaliseComponent(c)]));
    this.parts = new Map();
    for (const raw of parts) {
      const p = normalisePart(raw);
      if (!p.componentId || !this.components.has(p.componentId)) p.componentId = this.ensureComponentFor(p).id;
      this.parts.set(p.id, p);
    }
    this.emit("restore", [...this.parts.keys()], [...this.components.keys()]);
  }

  // Legacy / loose parts: group by "name: detail" prefix, else one component per part.
  ensureComponentFor(part) {
    const prefix = part.name.includes(":") ? part.name.split(":")[0].trim() : part.name;
    let c = this.listComponents().find((x) => x.name === prefix);
    if (!c) { c = defaultComponent({ name: prefix, meta: { agent: part.meta?.agent ?? null, role: "" } }); this.components.set(c.id, c); }
    return c;
  }

  // Group many applyOps calls into one undo step.
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.undoStack.push(this.snapshot()); this.redoStack.length = 0; if (this.undoStack.length > 100) this.undoStack.shift();
    this.inTransaction = true;
    const done = () => { this.inTransaction = false; };
    try { const r = fn(); if (r && typeof r.then === "function") return r.finally(done); done(); return r; }
    catch (e) { done(); throw e; }
  }

  // ops: add | update | remove | clear | addComponent | updateComponent | removeComponent
  applyOps(ops, { record = true } = {}) {
    if (!ops?.length) return [];
    if (record && !this.inTransaction) { this.undoStack.push(this.snapshot()); this.redoStack.length = 0; if (this.undoStack.length > 100) this.undoStack.shift(); }
    const touched = [], touchedComps = [];
    for (const o of ops) {
      switch (o.op) {
        case "clear": touched.push(...this.parts.keys()); touchedComps.push(...this.components.keys()); this.parts.clear(); this.components.clear(); break;
        case "addComponent": { const c = normaliseComponent(o.component); this.components.set(c.id, c); touchedComps.push(c.id); break; }
        case "updateComponent": { const cur = this.components.get(o.id); if (!cur) break; this.components.set(o.id, normaliseComponent(deepMerge(cur, o.patch))); touchedComps.push(o.id); break; }
        case "removeComponent": { if (!this.components.delete(o.id)) break; touchedComps.push(o.id); for (const p of this.partsOf(o.id)) { this.parts.delete(p.id); touched.push(p.id); } break; }
        case "add": {
          const part = normalisePart(o.part);
          if (!part.componentId || !this.components.has(part.componentId)) { const c = this.ensureComponentFor(part); part.componentId = c.id; touchedComps.push(c.id); }
          this.parts.set(part.id, part); touched.push(part.id); break;
        }
        case "update": {
          const cur = this.parts.get(o.id); if (!cur) break;
          this.parts.set(o.id, normalisePart(deepMerge(cur, o.patch))); touched.push(o.id); break;
        }
        case "remove": {
          const p = this.parts.get(o.id); if (!p) break;
          this.parts.delete(o.id); touched.push(o.id);
          if (!this.partsOf(p.componentId).length) { this.components.delete(p.componentId); touchedComps.push(p.componentId); }
          break;
        }
      }
    }
    this.emit("ops", touched, touchedComps);
    return touched;
  }

  undo() { if (!this.undoStack.length || this.inTransaction) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); }
  redo() { if (!this.redoStack.length || this.inTransaction) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); }
}

function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = k in (a ?? {}) && typeof a[k] === "object" && a[k] !== null && !Array.isArray(a[k]) && typeof b[k] === "object" && b[k] !== null && !Array.isArray(b[k]) ? deepMerge(a[k], b[k]) : b[k];
  return out;
}

const vec3 = (v, d) => (Array.isArray(v) && v.length === 3 ? v.map((n) => (Number.isFinite(+n) ? +n : 0)) : d);

export function normaliseComponent(c) {
  const d = defaultComponent();
  const comp = deepMerge(d, c ?? {});
  comp.id ||= uid("comp"); comp.name = String(comp.name || "component");
  comp.transform.position = vec3(comp.transform.position, d.transform.position);
  comp.transform.rotation = vec3(comp.transform.rotation, d.transform.rotation);
  comp.transform.scale = vec3(comp.transform.scale, d.transform.scale).map((s) => s || 1e-3);
  return comp;
}

export function normalisePart(p) {
  const d = defaultPart();
  const part = deepMerge(d, p ?? {});
  part.id ||= uid();
  if (!PRIMITIVES.includes(part.primitive?.type)) part.primitive = d.primitive;
  part.primitive.params = { ...primitiveDefaults(part.primitive.type), ...(part.primitive.params ?? {}) };
  if (part.primitive.profile && !Array.isArray(part.primitive.profile)) delete part.primitive.profile;
  for (const k of ["position", "rotation", "scale"]) part.transform[k] = vec3(part.transform[k], d.transform[k]);
  if (part.transform.scale.some((s) => s === 0)) part.transform.scale = part.transform.scale.map((s) => s || 1e-3);
  part.modifiers = (part.modifiers ?? []).filter((m) => MODIFIERS.includes(m?.type));
  return part;
}

export function primitiveDefaults(type) {
  switch (type) {
    case "box": return { width: 1, height: 1, depth: 1, segments: 1 };
    case "cylinder": return { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 24, heightSegments: 1 };
    case "cone": return { radius: 0.5, height: 1, radialSegments: 24 };
    case "sphere": return { radius: 0.5, widthSegments: 24, heightSegments: 16 };
    case "torus": return { radius: 0.5, tube: 0.15, radialSegments: 12, tubularSegments: 32 };
    case "plane": return { width: 1, height: 1, segments: 1 };
    case "capsule": return { radius: 0.3, length: 1, capSegments: 6, radialSegments: 16 };
    case "lathe": return { segments: 32 };
    case "extrude": return { depth: 1, segments: 1, bevel: 0 };
    case "loft": return { roundness: 0.35, sides: 24 };
    case "tube": return { radius: 0.05, segments: 32, radialSegments: 10 };
    default: return {};
  }
}
// Default profiles for the curve-based primitives (lathe: [radius, height] pairs; extrude: [x, y] outline).
export const DEFAULT_PROFILE = {
  lathe: [[0, 0], [0.5, 0], [0.55, 0.3], [0.4, 0.7], [0.45, 1], [0.3, 1.05], [0, 1.05]],
  extrude: [[-0.5, 0], [0.5, 0], [0.5, 0.6], [0, 1], [-0.5, 0.6]],
  // loft stations: [z, width, height, yOffset] back → front
  loft: [[-1.5, 0.6, 0.5, 0], [-0.8, 1.0, 0.7, 0.05], [0.2, 1.1, 0.6, 0.1], [1.0, 0.7, 0.4, 0.15], [1.6, 0.25, 0.2, 0.2]],
  // tube path points
  tube: [[-0.5, 0, 0], [-0.2, 0.3, 0], [0.2, 0.3, 0.1], [0.5, 0, 0.1]],
};

// ---- Transform math ---------------------------------------------------------

export function transformToMatrix(t, out = new THREE.Matrix4()) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...t.rotation.map(THREE.MathUtils.degToRad)));
  return out.compose(new THREE.Vector3(...t.position), q, new THREE.Vector3(...t.scale));
}
export function matrixToTransform(m) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s);
  const e = new THREE.Euler().setFromQuaternion(q);
  const r4 = (v) => +v.toFixed(4);
  return { position: p.toArray().map(r4), rotation: [e.x, e.y, e.z].map((r) => +THREE.MathUtils.radToDeg(r).toFixed(2)), scale: s.toArray().map(r4) };
}
// World matrix of a part: component · part.
export function partWorldMatrix(doc, part) {
  const c = doc.getComponent(part.componentId);
  const m = transformToMatrix(part.transform);
  return c ? transformToMatrix(c.transform).multiply(m) : m;
}

// ---- Geometry generation (layer 1: primitive, layer 2: modifier stack) ------

export function buildGeometry(part) {
  const { type, params: p } = part.primitive;
  const seg = clampInt(p.segments, 1, 32);
  let g;
  switch (type) {
    case "box": g = new THREE.BoxGeometry(p.width, p.height, p.depth, seg, seg, seg); break;
    case "cylinder": g = new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, clampInt(p.radialSegments, 3, 96), clampInt(p.heightSegments, 1, 32)); break;
    case "cone": g = new THREE.ConeGeometry(p.radius, p.height, clampInt(p.radialSegments, 3, 96)); break;
    case "sphere": g = new THREE.SphereGeometry(p.radius, clampInt(p.widthSegments, 4, 96), clampInt(p.heightSegments, 3, 64)); break;
    case "torus": g = new THREE.TorusGeometry(p.radius, p.tube, clampInt(p.radialSegments, 3, 48), clampInt(p.tubularSegments, 3, 128)); break;
    case "plane": g = new THREE.PlaneGeometry(p.width, p.height, seg, seg); break;
    case "capsule": g = new THREE.CapsuleGeometry(p.radius, p.length, clampInt(p.capSegments, 1, 16), clampInt(p.radialSegments, 4, 64)); break;
    case "lathe": {
      const prof = profilePoints(part.primitive.profile, DEFAULT_PROFILE.lathe).map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
      g = new THREE.LatheGeometry(prof, clampInt(p.segments, 3, 128)); break;
    }
    case "extrude": {
      const pts = profilePoints(part.primitive.profile, DEFAULT_PROFILE.extrude).map(([x, y]) => new THREE.Vector2(x, y));
      const shape = new THREE.Shape(pts);
      const bevel = Math.max(0, num(p.bevel, 0));
      g = new THREE.ExtrudeGeometry(shape, { depth: num(p.depth, 1), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, steps: seg });
      g.translate(0, 0, -num(p.depth, 1) / 2); break; // centre on Z like the other primitives
    }
    case "loft": g = loftGeometry(profilePoints(part.primitive.profile, DEFAULT_PROFILE.loft, 3), { roundness: num(p.roundness, 0.35), sides: clampInt(p.sides, 4, 64) }); break;
    case "tube": g = tubeGeometry(profilePoints(part.primitive.profile, DEFAULT_PROFILE.tube, 3), { radius: num(p.radius, 0.05), segments: clampInt(p.segments, 2, 128), radialSegments: clampInt(p.radialSegments, 3, 32) }); break;
    default: g = new THREE.BoxGeometry(1, 1, 1);
  }
  if (g.index) g = g.toNonIndexed();
  for (const m of part.modifiers) applyModifier(g, m);
  g.computeVertexNormals();
  return g;
}

function profilePoints(profile, fallback, arity = 2) {
  const pts = (Array.isArray(profile) ? profile : fallback).filter((q) => Array.isArray(q) && q.length >= arity && q.slice(0, arity).every((x) => Number.isFinite(+x))).map((q) => q.map((x) => +x));
  return pts.length >= (arity === 2 ? 3 : 2) ? pts : fallback;
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(+v) ? +v : lo)));
const num = (v, d) => (Number.isFinite(+v) ? +v : d);

function applyModifier(g, m) {
  const pos = g.attributes.position;
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const h = Math.max(1e-6, bb.max.y - bb.min.y);
  const v = new THREE.Vector3();
  const t = (y) => (y - bb.min.y) / h; // 0 at bottom, 1 at top
  switch (m.type) {
    case "taper": { const f = num(m.factor, 0.5); for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const s = 1 + (f - 1) * t(v.y); pos.setXYZ(i, v.x * s, v.y, v.z * s); } break; }
    case "twist": { const a = THREE.MathUtils.degToRad(num(m.angle, 45)); for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const r = a * t(v.y); const c = Math.cos(r), s = Math.sin(r); pos.setXYZ(i, v.x * c - v.z * s, v.y, v.x * s + v.z * c); } break; }
    case "bend": {
      const a = THREE.MathUtils.degToRad(num(m.angle, 30));
      if (Math.abs(a) > 1e-4) { const R = h / a; for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const th = (v.y - bb.min.y) / R; const r = R - v.x; pos.setXYZ(i, R - r * Math.cos(th), bb.min.y + r * Math.sin(th), v.z); } }
      break;
    }
    case "noise": { const amp = num(m.amplitude, 0.05), freq = num(m.frequency, 3); for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); const n = hashNoise(v.x * freq, v.y * freq, v.z * freq); const d = v.clone().normalize().multiplyScalar(n * amp); pos.setXYZ(i, v.x + d.x, v.y + d.y, v.z + d.z); } break; }
    case "mirror": {
      const axis = ["x", "y", "z"].includes(m.axis) ? m.axis : "x";
      const copy = g.clone(); const cp = copy.attributes.position;
      for (let i = 0; i < cp.count; i++) { v.fromBufferAttribute(cp, i); v[axis] = -v[axis]; cp.setXYZ(i, v.x, v.y, v.z); }
      flipWinding(copy); mergeInto(g, [copy]); break;
    }
    case "array": {
      const count = clampInt(m.count, 1, 16); const off = Array.isArray(m.offset) ? m.offset : [1.2, 0, 0];
      const copies = []; for (let k = 1; k < count; k++) { const c = g.clone(); c.translate(off[0] * k, off[1] * k, off[2] * k); copies.push(c); }
      mergeInto(g, copies); break;
    }
    case "greeble": {
      mergeInto(g, greeble(g, { count: clampInt(m.count, 1, 400), minSize: num(m.minSize, 0.03), maxSize: num(m.maxSize, 0.1), height: num(m.height, 0.5), faces: m.faces ?? "all", shape: m.shape === "cylinder" ? "cylinder" : "box", seed: clampInt(m.seed, 1, 1e6), pattern: m.pattern === "grid" ? "grid" : "random", cell: num(m.cell, 0.12) }));
      return;
    }
    case "plating": {
      mergeInto(g, plating(g, { cell: num(m.cell, 0.18), inset: num(m.inset, 0.12), height: num(m.height, 0.02), faces: m.faces ?? "all", seed: clampInt(m.seed, 1, 1e6), jitter: num(m.jitter, 0.3) }));
      return;
    }
    case "radial": { mergeInto(g, radialArray(g, { count: clampInt(m.count, 1, 64), axis: ["x", "y", "z"].includes(m.axis) ? m.axis : "y", startAngle: num(m.angle, 0) })); return; }
    case "subdivide": {
      const { positions, uvs } = loopSubdivide(pos.array, g.attributes.uv?.array ?? null, clampInt(m.levels, 1, 3));
      g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      if (uvs) g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      g.deleteAttribute("normal"); return;
    }
  }
  g.attributes.position.needsUpdate = true;
}

function hashNoise(x, y, z) { const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; }

function flipWinding(g) {
  const a = g.attributes.position.array;
  for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
  const uv = g.attributes.uv?.array;
  if (uv) for (let i = 0; i < uv.length; i += 6) for (let k = 0; k < 2; k++) { const t = uv[i + 2 + k]; uv[i + 2 + k] = uv[i + 4 + k]; uv[i + 4 + k] = t; }
}

function mergeInto(g, others) {
  const all = [g, ...others];
  for (const name of ["position", "uv"]) {
    const arrs = all.map((x) => x.attributes[name]?.array).filter(Boolean);
    if (arrs.length !== all.length) continue;
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Float32Array(total); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    g.setAttribute(name, new THREE.BufferAttribute(out, g.attributes[name].itemSize));
  }
  g.deleteAttribute("normal");
}

// ---- Export: one object, one group per component -----------------------------

export function toOBJ(doc, meshesById) {
  let out = "# Morsy export\no model\n"; let base = 1;
  for (const c of doc.listComponents()) {
    out += `g ${c.name.replace(/\s+/g, "_")}\n`;
    for (const p of doc.partsOf(c.id)) {
      const mesh = meshesById.get(p.id); if (!mesh) continue;
      const g = mesh.geometry; const pos = g.attributes.position; const uv = g.attributes.uv; const nrm = g.attributes.normal;
      mesh.updateWorldMatrix(true, false);
      const v = new THREE.Vector3(), n = new THREE.Vector3();
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
      out += `# ${p.name}\n`;
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); out += `v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${v.z.toFixed(5)}\n`; }
      if (uv) for (let i = 0; i < uv.count; i++) out += `vt ${uv.getX(i).toFixed(5)} ${uv.getY(i).toFixed(5)}\n`;
      if (nrm) for (let i = 0; i < nrm.count; i++) { n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize(); out += `vn ${n.x.toFixed(4)} ${n.y.toFixed(4)} ${n.z.toFixed(4)}\n`; }
      const idx = g.index;
      const tri = (a, b, cc) => `f ${[a, b, cc].map((i) => `${i + base}/${uv ? i + base : ""}/${nrm ? i + base : ""}`).join(" ")}\n`;
      if (idx) for (let i = 0; i < idx.count; i += 3) out += tri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      else for (let i = 0; i < pos.count; i += 3) out += tri(i, i + 1, i + 2);
      base += pos.count;
    }
  }
  return out;
}
