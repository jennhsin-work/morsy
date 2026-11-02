// Geometry optimization engine. Pure functions over flat typed arrays so the
// same code runs in a Web Worker, in Node tests, and in the main thread.
//
// Pipeline (each stage reports metrics):
//   1. weld        – merge coincident vertices → indexed mesh, exposes topology
//   2. clean       – drop degenerate / duplicate triangles
//   3. orient      – make winding consistent across shared edges, outward-facing
//   4. decimate    – feature-preserving edge collapse on flat regions only
//   5. uv          – measure distortion; re-project UVs if above threshold
//   6. normals     – angle-weighted normals with hard-edge preservation
//
// "Preserve design details" is implemented as a dihedral-angle guard: any edge
// sharper than `featureAngle` is treated as a design feature and is never
// collapsed, and its normals are kept hard.

export const DEFAULTS = {
  weldTolerance: 1e-4,
  featureAngle: 32, // degrees; sharper edges are protected features
  decimate: true,
  decimateMaxRatio: 0.35, // remove at most this fraction of triangles
  flatAngle: 4, // degrees; edges flatter than this are collapse candidates
  uvDistortionThreshold: 0.35,
  uvTexelScale: 1.0,
};

export function optimizeMesh(input, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = now();
  const report = { stages: [], before: {}, after: {} };

  let positions = Float32Array.from(input.positions);
  let uvs = input.uvs ? Float32Array.from(input.uvs) : null;
  let indices = input.indices ? Uint32Array.from(input.indices) : sequential(positions.length / 3);

  report.before = describe(positions, indices, uvs);

  // 1. weld
  const w = weld(positions, uvs, indices, o.weldTolerance);
  positions = w.positions; uvs = w.uvs; indices = w.indices;
  report.stages.push({ name: "weld", merged: w.merged });

  // 2. clean
  const c = removeDegenerate(positions, indices);
  indices = c.indices;
  report.stages.push({ name: "clean", degenerate: c.degenerate, duplicates: c.duplicates });

  // 3. orient
  const or = orientConsistently(positions, indices);
  indices = or.indices;
  report.stages.push({ name: "orient", flipped: or.flipped, nonManifoldEdges: or.nonManifold, boundaryEdges: or.boundary });

  // 4. decimate (feature-preserving)
  if (o.decimate && indices.length / 3 > 24) {
    const d = decimateFlat(positions, indices, uvs, o);
    positions = d.positions; indices = d.indices; uvs = d.uvs;
    report.stages.push({ name: "decimate", collapsed: d.collapsed, protectedEdges: d.protectedEdges });
  }

  // 5. uv
  const uvBefore = uvs ? uvDistortion(positions, indices, uvs) : null;
  let uvAfter = uvBefore;
  let reprojected = false;
  if (!uvs || uvBefore.mean > o.uvDistortionThreshold) {
    const cand = boxProjectUV(positions, indices, o.uvTexelScale);
    const m = uvDistortion(positions, indices, cand);
    if (!uvBefore || m.mean < uvBefore.mean) { uvs = cand; uvAfter = m; reprojected = true; }
  }
  report.stages.push({ name: "uv", before: uvBefore?.mean ?? null, after: uvAfter?.mean ?? null, maxAfter: uvAfter?.max ?? null, reprojected });

  // 6. normals
  const normals = featureNormals(positions, indices, o.featureAngle);

  report.after = describe(positions, indices, uvs);
  report.ms = Math.round(now() - t0);
  report.score = qualityScore(report, or);
  return { positions, indices, uvs, normals, report };
}

// ---------------------------------------------------------------------------

function now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }
function sequential(n) { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }

function describe(positions, indices, uvs) {
  return { vertices: positions.length / 3, triangles: indices.length / 3, hasUV: !!uvs };
}

export function weld(positions, uvs, indices, tol) {
  const inv = 1 / tol;
  const map = new Map(); const remap = new Uint32Array(positions.length / 3);
  const outP = [], outUV = []; let merged = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    // Key includes UV so seams are preserved (welding across a seam destroys the atlas).
    const u = uvs ? Math.round(uvs[i * 2] * 1e4) : 0, v = uvs ? Math.round(uvs[i * 2 + 1] * 1e4) : 0;
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)},${u},${v}`;
    let j = map.get(key);
    if (j === undefined) { j = outP.length / 3; map.set(key, j); outP.push(x, y, z); if (uvs) outUV.push(uvs[i * 2], uvs[i * 2 + 1]); }
    else merged++;
    remap[i] = j;
  }
  const outI = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) outI[i] = remap[indices[i]];
  return { positions: Float32Array.from(outP), uvs: uvs ? Float32Array.from(outUV) : null, indices: outI, merged };
}

export function removeDegenerate(positions, indices) {
  const out = []; const seen = new Set(); let degenerate = 0, duplicates = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    if (triArea(positions, a, b, c) < 1e-12) { degenerate++; continue; }
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); out.push(a, b, c);
  }
  return { indices: Uint32Array.from(out), degenerate, duplicates };
}

function triArea(p, a, b, c) {
  const ax = p[b * 3] - p[a * 3], ay = p[b * 3 + 1] - p[a * 3 + 1], az = p[b * 3 + 2] - p[a * 3 + 2];
  const bx = p[c * 3] - p[a * 3], by = p[c * 3 + 1] - p[a * 3 + 1], bz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function faceNormal(p, a, b, c, out) {
  const ax = p[b * 3] - p[a * 3], ay = p[b * 3 + 1] - p[a * 3 + 1], az = p[b * 3 + 2] - p[a * 3 + 2];
  const bx = p[c * 3] - p[a * 3], by = p[c * 3 + 1] - p[a * 3 + 1], bz = p[c * 3 + 2] - p[a * 3 + 2];
  out[0] = ay * bz - az * by; out[1] = az * bx - ax * bz; out[2] = ax * by - ay * bx;
  const l = Math.hypot(out[0], out[1], out[2]) || 1; out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}

// Build edge → faces adjacency. Edge key is undirected.
function edgeMap(indices) {
  const m = new Map();
  const nTri = indices.length / 3;
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t * 3 + e], b = indices[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      let arr = m.get(key); if (!arr) { arr = []; m.set(key, arr); } arr.push(t);
    }
  }
  return m;
}

export function orientConsistently(positions, indices) {
  const idx = Uint32Array.from(indices);
  const nTri = idx.length / 3;
  const em = edgeMap(idx);
  let nonManifold = 0, boundary = 0;
  for (const faces of em.values()) { if (faces.length > 2) nonManifold++; else if (faces.length === 1) boundary++; }

  // BFS over face adjacency; flip a neighbour if it traverses the shared edge in the same direction.
  const visited = new Uint8Array(nTri); let flipped = 0;
  const hasDirected = (t, a, b) => { for (let e = 0; e < 3; e++) if (idx[t * 3 + e] === a && idx[t * 3 + ((e + 1) % 3)] === b) return true; return false; };
  const flip = (t) => { const tmp = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = tmp; flipped++; };
  for (let seed = 0; seed < nTri; seed++) {
    if (visited[seed]) continue;
    const comp = []; const queue = [seed]; visited[seed] = 1;
    while (queue.length) {
      const t = queue.pop(); comp.push(t);
      for (let e = 0; e < 3; e++) {
        const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)];
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        const faces = em.get(key); if (!faces || faces.length !== 2) continue;
        const n = faces[0] === t ? faces[1] : faces[0];
        if (visited[n]) continue;
        if (hasDirected(n, a, b)) flip(n); // same direction → inconsistent
        visited[n] = 1; queue.push(n);
      }
    }
    // Orient the component outward: signed volume must be positive.
    let vol = 0;
    for (const t of comp) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      vol += positions[a * 3] * (positions[b * 3 + 1] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3 + 1])
           - positions[a * 3 + 1] * (positions[b * 3] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3])
           + positions[a * 3 + 2] * (positions[b * 3] * positions[c * 3 + 1] - positions[b * 3 + 1] * positions[c * 3]);
    }
    // Only closed components have a meaningful signed volume; open sheets keep BFS orientation.
    const closed = comp.every((t) => { for (let e = 0; e < 3; e++) { const a = idx[t * 3 + e], b = idx[t * 3 + ((e + 1) % 3)]; const k = a < b ? a * 4294967296 + b : b * 4294967296 + a; if (em.get(k).length !== 2) return false; } return true; });
    if (closed && vol < 0) { for (const t of comp) flip(t); flipped -= comp.length * 2; flipped += comp.length; }
  }
  return { indices: idx, flipped: Math.max(0, flipped), nonManifold, boundary };
}

// Feature-preserving decimation: collapse edges whose adjacent faces are nearly
// coplanar AND whose endpoints are not on any feature edge. This removes
// redundant tessellation on flat regions (what agents tend to over-produce)
// while leaving silhouettes, creases and bevels untouched.
export function decimateFlat(positions, indices, uvs, o) {
  const nV = positions.length / 3;
  const pos = Float32Array.from(positions);
  let idx = Array.from(indices);
  const cosFlat = Math.cos((o.flatAngle * Math.PI) / 180);
  const cosFeature = Math.cos((o.featureAngle * Math.PI) / 180);
  const n1 = [0, 0, 0], n2 = [0, 0, 0];

  const em = edgeMap(Uint32Array.from(idx));
  const featureVert = new Uint8Array(nV); let protectedEdges = 0;
  const dihedral = new Map();
  for (const [key, faces] of em) {
    const a = Math.floor(key / 4294967296), b = key % 4294967296;
    if (faces.length !== 2) { featureVert[a] = featureVert[b] = 1; protectedEdges++; continue; }
    faceNormal(pos, idx[faces[0] * 3], idx[faces[0] * 3 + 1], idx[faces[0] * 3 + 2], n1);
    faceNormal(pos, idx[faces[1] * 3], idx[faces[1] * 3 + 1], idx[faces[1] * 3 + 2], n2);
    const d = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    dihedral.set(key, d);
    if (d < cosFeature) { featureVert[a] = featureVert[b] = 1; protectedEdges++; }
  }
  // UV seams are features too (collapsing across one tears the atlas).
  if (uvs) {
    // vertices were welded with UV in the key, so a position shared by two
    // vertex indices is a seam. Mark them.
    const byPos = new Map();
    for (let i = 0; i < nV; i++) { const k = `${pos[i * 3].toFixed(4)},${pos[i * 3 + 1].toFixed(4)},${pos[i * 3 + 2].toFixed(4)}`; if (byPos.has(k)) { featureVert[i] = 1; featureVert[byPos.get(k)] = 1; } else byPos.set(k, i); }
  }

  const budget = Math.floor((idx.length / 3) * o.decimateMaxRatio);
  const remap = new Uint32Array(nV); for (let i = 0; i < nV; i++) remap[i] = i;
  const find = (i) => { while (remap[i] !== i) { remap[i] = remap[remap[i]]; i = remap[i]; } return i; };
  const dead = new Uint8Array(nV);
  let collapsed = 0;
  // Candidates: flat edges, shortest first.
  const cands = [];
  for (const [key, d] of dihedral) {
    if (d < cosFlat) continue;
    const a = Math.floor(key / 4294967296), b = key % 4294967296;
    if (featureVert[a] || featureVert[b]) continue;
    cands.push([Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]), a, b]);
  }
  cands.sort((x, y) => x[0] - y[0]);
  for (const [, a0, b0] of cands) {
    if (collapsed >= budget) break;
    const a = find(a0), b = find(b0);
    if (a === b || dead[a] || dead[b]) continue;
    // Collapse b into a (keep a's position; both lie in a flat region so midpoint is unnecessary).
    remap[b] = a; dead[b] = 1; collapsed++;
  }
  if (!collapsed) return { positions, indices, uvs, collapsed: 0, protectedEdges };

  // Rebuild index list, dropping collapsed triangles, then compact vertices.
  const outIdx = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]);
    if (a === b || b === c || a === c) continue;
    outIdx.push(a, b, c);
  }
  const used = new Int32Array(nV).fill(-1); const outPos = [], outUV = []; let n = 0;
  for (let i = 0; i < outIdx.length; i++) {
    const v = outIdx[i];
    if (used[v] < 0) { used[v] = n++; outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); if (uvs) outUV.push(uvs[v * 2], uvs[v * 2 + 1]); }
    outIdx[i] = used[v];
  }
  const removedTris = idx.length / 3 - outIdx.length / 3;
  return { positions: Float32Array.from(outPos), indices: Uint32Array.from(outIdx), uvs: uvs ? Float32Array.from(outUV) : null, collapsed: removedTris, protectedEdges };
}

// UV distortion per face: compare 3D edge-length ratios with UV edge-length
// ratios (conformal stretch) and area scale consistency across the mesh.
export function uvDistortion(positions, indices, uvs) {
  const nTri = indices.length / 3;
  if (!nTri) return { mean: 0, max: 0 };
  const scales = new Float64Array(nTri); const stretch = new Float64Array(nTri);
  let totalArea3 = 0, totalAreaUV = 0;
  for (let t = 0; t < nTri; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const A3 = triArea(positions, a, b, c);
    const ux = uvs[b * 2] - uvs[a * 2], uy = uvs[b * 2 + 1] - uvs[a * 2 + 1];
    const vx = uvs[c * 2] - uvs[a * 2], vy = uvs[c * 2 + 1] - uvs[a * 2 + 1];
    const AUV = 0.5 * Math.abs(ux * vy - uy * vx);
    totalArea3 += A3; totalAreaUV += AUV;
    scales[t] = A3 > 1e-12 ? AUV / A3 : 0;
    // conformal: ratio of the two longest edge ratios
    const e3 = [edgeLen(positions, a, b, 3), edgeLen(positions, b, c, 3), edgeLen(positions, c, a, 3)];
    const eu = [edgeLen(uvs, a, b, 2), edgeLen(uvs, b, c, 2), edgeLen(uvs, c, a, 2)];
    const r = e3.map((l, i) => (l > 1e-9 ? eu[i] / l : 0));
    const mx = Math.max(...r), mn = Math.min(...r);
    stretch[t] = mx > 1e-9 && mn > 1e-9 ? mx / mn - 1 : 1; // 0 = conformal
  }
  const meanScale = totalArea3 > 0 ? totalAreaUV / totalArea3 : 0;
  let sum = 0, max = 0;
  for (let t = 0; t < nTri; t++) {
    const areaDev = meanScale > 0 ? Math.abs(scales[t] / meanScale - 1) : 1;
    const d = Math.min(3, 0.5 * stretch[t] + 0.5 * areaDev);
    sum += d; if (d > max) max = d;
  }
  return { mean: sum / nTri, max };
}

function edgeLen(arr, a, b, stride) {
  let s = 0; for (let k = 0; k < stride; k++) { const d = arr[b * stride + k] - arr[a * stride + k]; s += d * d; } return Math.sqrt(s);
}

// Smart box projection: each face projects along its dominant normal axis.
// Faces sharing a vertex but different projection axes get the vertex
// duplicated (a seam), so this returns new positions+indices as well.
export function boxProjectUV(positions, indices, scale = 1) {
  const nTri = indices.length / 3;
  const uv = new Float32Array((positions.length / 3) * 2);
  const assigned = new Int8Array(positions.length / 3).fill(-1);
  const n = [0, 0, 0];
  // compute bbox for normalisation into [0,1]
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]); }
  const ext = max.map((m, k) => Math.max(1e-6, m - min[k]));
  const size = Math.max(...ext);
  for (let t = 0; t < nTri; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    faceNormal(positions, a, b, c, n);
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const [u, v] = ax === 0 ? [2, 1] : ax === 1 ? [0, 2] : [0, 1];
    for (const i of [a, b, c]) {
      // conflicting axis on a shared vertex: we can't split here (would change
      // indices), so first assignment wins; welding kept seams where UVs differed.
      if (assigned[i] >= 0 && assigned[i] !== ax) continue;
      assigned[i] = ax;
      uv[i * 2] = ((positions[i * 3 + u] - min[u]) / size) * scale;
      uv[i * 2 + 1] = ((positions[i * 3 + v] - min[v]) / size) * scale;
    }
  }
  return uv;
}

// Angle-weighted vertex normals; edges sharper than `featureAngle` stay hard by
// *not* averaging across them. Because the mesh is indexed, a hard edge whose
// vertices are shared would still blend — so we return per-vertex normals and
// let the caller split; for the viewport we approximate by weighting faces
// whose normal is within the feature cone of the vertex's dominant face.
export function featureNormals(positions, indices, featureAngle) {
  const nV = positions.length / 3; const nTri = indices.length / 3;
  const fn = new Float32Array(nTri * 3); const n = [0, 0, 0];
  const vertFaces = Array.from({ length: nV }, () => []);
  for (let t = 0; t < nTri; t++) {
    faceNormal(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2], n);
    fn[t * 3] = n[0]; fn[t * 3 + 1] = n[1]; fn[t * 3 + 2] = n[2];
    for (let e = 0; e < 3; e++) vertFaces[indices[t * 3 + e]].push(t);
  }
  const cosF = Math.cos((featureAngle * Math.PI) / 180);
  const out = new Float32Array(nV * 3);
  for (let v = 0; v < nV; v++) {
    const faces = vertFaces[v]; if (!faces.length) continue;
    // dominant face = largest area
    let dom = faces[0], best = -1;
    for (const t of faces) { const A = triArea(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]); if (A > best) { best = A; dom = t; } }
    let x = 0, y = 0, z = 0;
    for (const t of faces) {
      const d = fn[t * 3] * fn[dom * 3] + fn[t * 3 + 1] * fn[dom * 3 + 1] + fn[t * 3 + 2] * fn[dom * 3 + 2];
      if (d < cosF) continue; // across a feature edge: don't smooth
      const A = triArea(positions, indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
      x += fn[t * 3] * A; y += fn[t * 3 + 1] * A; z += fn[t * 3 + 2] * A;
    }
    const l = Math.hypot(x, y, z) || 1; out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l;
  }
  return out;
}

// Single scalar in [0,1] used as the RL reward's geometry term.
export function qualityScore(report, orient) {
  const uvStage = report.stages.find((s) => s.name === "uv");
  const uvTerm = uvStage?.after == null ? 0.6 : Math.max(0, 1 - uvStage.after);
  const manifoldTerm = orient.nonManifold === 0 ? 1 : Math.max(0, 1 - orient.nonManifold / Math.max(1, report.after.triangles) * 20);
  const degenerate = report.stages.find((s) => s.name === "clean");
  const cleanTerm = Math.max(0, 1 - (degenerate.degenerate + degenerate.duplicates) / Math.max(1, report.before.triangles) * 5);
  const budgetTerm = report.after.triangles <= 20000 ? 1 : Math.max(0, 1 - (report.after.triangles - 20000) / 80000);
  return +(0.4 * uvTerm + 0.3 * manifoldTerm + 0.15 * cleanTerm + 0.15 * budgetTerm).toFixed(3);
}
