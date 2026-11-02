// Loop subdivision on a triangle soup (non-indexed positions + optional UVs).
// Pure typed-array math so it runs anywhere. Each level quadruples the face
// count and smooths toward the limit surface; sharp creases are not preserved
// (use the optimizer's feature angle after subdivision to re-harden normals).
//
//   even (existing) vertex:  v' = (1 - n·β) v + β Σ neighbours,  β = Warren's (3/16 for n=3, 3/(8n) otherwise)
//   odd (edge) vertex:       e' = 3/8 (a + b) + 1/8 (c + d)       c, d = opposite corners of the two faces
//   boundary:                v' = 3/4 v + 1/8 (left + right),  e' = (a + b) / 2

export function loopSubdivide(positions, uvs, levels = 1) {
  let pos = Float32Array.from(positions);
  let uv = uvs ? Float32Array.from(uvs) : null;
  for (let l = 0; l < Math.min(4, levels); l++) ({ pos, uv } = subdivideOnce(pos, uv));
  return { positions: pos, uvs: uv };
}

function subdivideOnce(pos, uv) {
  const nV = pos.length / 3, nTri = nV / 3;
  // weld by position so smoothing sees shared vertices
  const key = (i) => `${Math.round(pos[i * 3] * 1e5)},${Math.round(pos[i * 3 + 1] * 1e5)},${Math.round(pos[i * 3 + 2] * 1e5)}`;
  const idx = new Uint32Array(nV); const uniq = []; const map = new Map();
  for (let i = 0; i < nV; i++) { const k = key(i); let j = map.get(k); if (j === undefined) { j = uniq.length; map.set(k, j); uniq.push(i); } idx[i] = j; }
  const nU = uniq.length;
  const P = (j) => [pos[uniq[j] * 3], pos[uniq[j] * 3 + 1], pos[uniq[j] * 3 + 2]];

  // edges: key a<b → { faces:[t...], opp:[c...] }
  const edges = new Map(); const ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const neighbours = Array.from({ length: nU }, () => new Set());
  for (let t = 0; t < nTri; t++) {
    const c = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const a = c[e], b = c[(e + 1) % 3], o = c[(e + 2) % 3];
      let E = edges.get(ek(a, b)); if (!E) { E = { opp: [] }; edges.set(ek(a, b), E); }
      E.opp.push(o); neighbours[a].add(b); neighbours[b].add(a);
    }
  }
  const boundaryNb = Array.from({ length: nU }, () => []);
  for (const [k, E] of edges) if (E.opp.length === 1) { const a = Math.floor(k / 4294967296), b = k % 4294967296; boundaryNb[a].push(b); boundaryNb[b].push(a); }

  // even vertices
  const even = new Float32Array(nU * 3);
  for (let v = 0; v < nU; v++) {
    const p = P(v); const bn = boundaryNb[v];
    if (bn.length >= 2) { const l = P(bn[0]), r = P(bn[1]); for (let k = 0; k < 3; k++) even[v * 3 + k] = 0.75 * p[k] + 0.125 * (l[k] + r[k]); continue; }
    const nb = [...neighbours[v]]; const n = nb.length;
    if (n < 3) { for (let k = 0; k < 3; k++) even[v * 3 + k] = p[k]; continue; }
    const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
    const s = [0, 0, 0]; for (const u of nb) { const q = P(u); for (let k = 0; k < 3; k++) s[k] += q[k]; }
    for (let k = 0; k < 3; k++) even[v * 3 + k] = (1 - n * beta) * p[k] + beta * s[k];
  }
  // odd (edge) vertices
  const odd = new Map();
  for (const [k, E] of edges) {
    const a = Math.floor(k / 4294967296), b = k % 4294967296; const pa = P(a), pb = P(b); const out = [0, 0, 0];
    if (E.opp.length >= 2) { const pc = P(E.opp[0]), pd = P(E.opp[1]); for (let i = 0; i < 3; i++) out[i] = 0.375 * (pa[i] + pb[i]) + 0.125 * (pc[i] + pd[i]); }
    else for (let i = 0; i < 3; i++) out[i] = 0.5 * (pa[i] + pb[i]);
    odd.set(k, out);
  }

  // emit 4 faces per face; UVs interpolated per corner (seams preserved)
  const outPos = new Float32Array(nTri * 4 * 9); const outUV = uv ? new Float32Array(nTri * 4 * 6) : null;
  let o = 0, ou = 0;
  const push = (p, u) => { outPos.set(p, o); o += 3; if (outUV) { outUV.set(u, ou); ou += 2; } };
  for (let t = 0; t < nTri; t++) {
    const ci = [t * 3, t * 3 + 1, t * 3 + 2]; const cv = ci.map((i) => idx[i]);
    const V = cv.map((v) => [even[v * 3], even[v * 3 + 1], even[v * 3 + 2]]);
    const Eo = [odd.get(ek(cv[0], cv[1])), odd.get(ek(cv[1], cv[2])), odd.get(ek(cv[2], cv[0]))];
    const U = uv ? ci.map((i) => [uv[i * 2], uv[i * 2 + 1]]) : [[0, 0], [0, 0], [0, 0]];
    const Eu = [mid(U[0], U[1]), mid(U[1], U[2]), mid(U[2], U[0])];
    push(V[0], U[0]); push(Eo[0], Eu[0]); push(Eo[2], Eu[2]);
    push(Eo[0], Eu[0]); push(V[1], U[1]); push(Eo[1], Eu[1]);
    push(Eo[2], Eu[2]); push(Eo[1], Eu[1]); push(V[2], U[2]);
    push(Eo[0], Eu[0]); push(Eo[1], Eu[1]); push(Eo[2], Eu[2]);
  }
  return { pos: outPos, uv: outUV };
}
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
