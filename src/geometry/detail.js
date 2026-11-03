// Detail-geometry layers: the "secondary and tertiary" forms that make a hard-
// surface model read as a machine. Pure functions over three.js geometries.
//
//   loftGeometry   – a hull from cross-section stations along Z (the Spaceship
//                    Generator idea: a box extruded station by station, each
//                    station scaled/offset; superellipse roundness per station)
//   tubeGeometry   – a pipe along a smooth path
//   greeble        – scatter small boxes/cylinders on a surface, oriented to it
//   plating        – raised panels on a regular grid in each face's tangent plane
//   radialArray    – N copies rotated around an axis (thruster rings, bolts)
import * as THREE from "three";

// stations: [[z, width, height, yOffset], …] from back to front; roundness 0..1
// (0 = sharp box section, 1 = ellipse). Closed caps at both ends.
export function loftGeometry(stations, { roundness = 0.35, sides = 24 } = {}) {
  const st = stations.filter((s) => Array.isArray(s) && s.length >= 3).map((s) => [+s[0], Math.max(1e-3, +s[1]), Math.max(1e-3, +s[2]), +(s[3] ?? 0)]);
  if (st.length < 2) return new THREE.BoxGeometry(1, 1, 1);
  st.sort((a, b) => a[0] - b[0]);
  const n = Math.max(4, Math.round(sides));
  // superellipse exponent: roundness 1 → p=2 (ellipse); 0 → p→∞ (rectangle)
  const p = 2 + (1 - THREE.MathUtils.clamp(roundness, 0, 1)) * 10;
  const ring = (w, h, y0, z) => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / p) * (w / 2), y = Math.sign(s) * Math.pow(Math.abs(s), 2 / p) * (h / 2);
      pts.push([x, y + y0, z]);
    }
    return pts;
  };
  const rings = st.map(([z, w, h, y0]) => ring(w, h, y0, z));
  const pos = [], uv = [];
  const tri = (a, b, c, ua, ub, uc) => { pos.push(...a, ...b, ...c); uv.push(...ua, ...ub, ...uc); };
  for (let k = 0; k < rings.length - 1; k++) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; const u0 = i / n, u1 = (i + 1) / n, v0 = k / (rings.length - 1), v1 = (k + 1) / (rings.length - 1);
      tri(A[i], B[i], B[j], [u0, v0], [u0, v1], [u1, v1]);
      tri(A[i], B[j], A[j], [u0, v0], [u1, v1], [u1, v0]);
    }
  }
  // caps (fan around the station centre)
  const cap = (R, z, y0, flip) => { const c = [0, y0, z]; for (let i = 0; i < n; i++) { const j = (i + 1) % n; const a = R[i], b = R[j]; flip ? tri(c, b, a, [0.5, 0.5], [0, 0], [1, 0]) : tri(c, a, b, [0.5, 0.5], [0, 0], [1, 0]); } };
  cap(rings[0], st[0][0], st[0][3], true); cap(rings.at(-1), st.at(-1)[0], st.at(-1)[3], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export function tubeGeometry(path, { radius = 0.05, segments = 32, radialSegments = 10, closed = false } = {}) {
  const pts = (path ?? []).filter((q) => Array.isArray(q) && q.length === 3).map((q) => new THREE.Vector3(+q[0], +q[1], +q[2]));
  if (pts.length < 2) return new THREE.CylinderGeometry(radius, radius, 1, radialSegments);
  const curve = new THREE.CatmullRomCurve3(pts, closed, "catmullrom", 0.5);
  return new THREE.TubeGeometry(curve, Math.max(2, Math.round(segments)), Math.max(1e-3, radius), Math.max(3, Math.round(radialSegments)), closed);
}

// Deterministic PRNG so the same seed gives the same greebles (replayable).
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Which faces qualify: "all" | "top" | "sides" | "bottom" | "front" | "back"
function faceAllowed(n, faces) {
  switch (faces) {
    case "top": return n.y > 0.6; case "bottom": return n.y < -0.6;
    case "sides": return Math.abs(n.x) > 0.6; case "front": return n.z > 0.6; case "back": return n.z < -0.6;
    default: return true;
  }
}

// Scatter `count` greebles across the geometry's triangles (area-weighted),
// each a box (or cylinder) sitting on the surface, aligned to the face normal.
// Sizes are relative to the geometry's bounding diagonal so the same spec works
// on a 10 cm panel and a 10 m hull.
export function greeble(source, { count = 40, minSize = 0.03, maxSize = 0.1, height = 0.5, faces = "all", shape = "box", seed = 1, pattern = "random", cell = 0.12 } = {}) {
  const pos = source.attributes.position; const nTri = pos.count / 3;
  if (!nTri) return [];
  // Size reference: the geometric mean of the bounding box (not the diagonal), so a
  // long thin hull doesn't get plates as big as its width; then clamped to an
  // absolute range so detail stays "small stuff" on any object.
  source.computeBoundingBox(); const sz = source.boundingBox.getSize(new THREE.Vector3());
  const diag = THREE.MathUtils.clamp(Math.cbrt(Math.max(1e-6, sz.x) * Math.max(1e-6, sz.y) * Math.max(1e-6, sz.z)), 0.05, 3);
  const rnd = mulberry32(seed * 7919 + 13);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  // area-weighted triangle table (only allowed faces)
  const areas = []; let total = 0;
  for (let t = 0; t < nTri; t++) {
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac); const area = n.length() / 2; n.normalize();
    const ok = area > 1e-9 && faceAllowed(n, faces);
    areas.push(ok ? area : 0); total += ok ? area : 0;
  }
  if (!total) return [];
  const out = []; const used = new Set();
  const up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), m = new THREE.Matrix4(), tangent = new THREE.Vector3(), bit = new THREE.Vector3();
  const tries = pattern === "grid" ? count * 6 : count;
  for (let k = 0; k < tries && out.length < count; k++) {
    // pick a triangle by area
    let r = rnd() * total, t = 0; while (t < nTri - 1 && r > areas[t]) { r -= areas[t]; t++; }
    if (!areas[t]) continue;
    a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac).normalize();
    // random point in the triangle (uniform)
    let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const pt = a.clone().addScaledVector(ab, u).addScaledVector(ac, v);
    // tangent frame on the face
    tangent.copy(Math.abs(n.y) < 0.9 ? up : new THREE.Vector3(1, 0, 0)).cross(n).normalize(); bit.crossVectors(n, tangent);
    if (pattern === "grid") { // snap to a cell in the tangent plane, one greeble per cell
      const cs = THREE.MathUtils.clamp(cell * diag, 0.02, 1.2); const cu = Math.round(pt.dot(tangent) / cs), cv = Math.round(pt.dot(bit) / cs);
      const key = `${Math.round(n.x * 2)},${Math.round(n.y * 2)},${Math.round(n.z * 2)}:${cu},${cv}`;
      if (used.has(key)) continue; used.add(key);
      const d = pt.dot(n); pt.copy(tangent).multiplyScalar(cu * cs).addScaledVector(bit, cv * cs).addScaledVector(n, d);
    }
    const lim = (v) => THREE.MathUtils.clamp(v, 0.008, 0.8); // absolute size limits in metres
    const w = lim((minSize + rnd() * (maxSize - minSize)) * diag), dpt = lim((minSize + rnd() * (maxSize - minSize)) * diag), h = Math.max(0.002, Math.min(0.3, height * Math.min(w, dpt)));
    let g = shape === "cylinder" ? new THREE.CylinderGeometry(w / 2, w / 2, h, 12) : new THREE.BoxGeometry(w, h, dpt);
    g = g.toNonIndexed(); g.translate(0, h / 2 - 0.002, 0); // sit on the surface, slightly embedded
    q.setFromUnitVectors(up, n); m.compose(pt, q, new THREE.Vector3(1, 1, 1));
    if (pattern === "random") { const spin = new THREE.Quaternion().setFromAxisAngle(n, rnd() * Math.PI * (shape === "cylinder" ? 0 : 0.5)); m.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(spin).setPosition(0, 0, 0)); m.setPosition(pt); }
    g.applyMatrix4(m); out.push(g);
  }
  return out;
}

// Raised plates on a regular grid: like greeble with pattern "grid", but flat,
// larger, and covering most of the surface (panel lines appear as the gaps).
export function plating(source, { cell = 0.18, inset = 0.12, height = 0.02, faces = "all", seed = 3, jitter = 0.3 } = {}) {
  const cellSize = cell, size = cell * (1 - inset);
  return greeble(source, { count: 400, minSize: size, maxSize: size, height: height / size, faces, seed, pattern: "grid", cell: cellSize }).map((g) => {
    // random drop-outs and size jitter so the pattern isn't a perfect checkerboard
    const rnd = mulberry32(seed * 31 + g.attributes.position.array[0] * 1000 | 0);
    if (rnd() < jitter * 0.3) return null;
    return g;
  }).filter(Boolean);
}

export function radialArray(source, { count = 6, axis = "y", startAngle = 0 } = {}) {
  const out = []; const ax = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "z" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const n = Math.max(1, Math.min(64, Math.round(count)));
  for (let i = 1; i < n; i++) { const g = source.clone(); g.applyMatrix4(new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(startAngle) + (i / n) * Math.PI * 2)); out.push(g); }
  return out;
}
