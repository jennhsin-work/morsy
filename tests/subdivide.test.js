import { test } from "node:test";
import assert from "node:assert/strict";
import { loopSubdivide } from "../src/geometry/subdivide.js";

// Octahedron as a triangle soup (8 faces), radius 1.
function octahedron() {
  const v = { px: [1, 0, 0], nx: [-1, 0, 0], py: [0, 1, 0], ny: [0, -1, 0], pz: [0, 0, 1], nz: [0, 0, -1] };
  const faces = [["py", "pz", "px"], ["py", "px", "nz"], ["py", "nz", "nx"], ["py", "nx", "pz"], ["ny", "px", "pz"], ["ny", "nz", "px"], ["ny", "nx", "nz"], ["ny", "pz", "nx"]];
  return Float32Array.from(faces.flatMap((f) => f.flatMap((k) => v[k])));
}

test("one Loop level quadruples faces and keeps the mesh closed", () => {
  const { positions } = loopSubdivide(octahedron(), null, 1);
  assert.equal(positions.length / 9, 32);
  // every edge must still be shared by exactly two faces (closed surface)
  const key = (i) => positions.slice(i * 3, i * 3 + 3).map((x) => x.toFixed(5)).join(",");
  const edges = new Map();
  for (let t = 0; t < 32; t++) for (let e = 0; e < 3; e++) { const a = key(t * 3 + e), b = key(t * 3 + ((e + 1) % 3)); const k = [a, b].sort().join("|"); edges.set(k, (edges.get(k) ?? 0) + 1); }
  for (const n of edges.values()) assert.equal(n, 2);
});

test("subdivision pulls the cage toward a sphere (vertices move inward, variance shrinks)", () => {
  const radii = (pos) => { const r = []; for (let i = 0; i < pos.length; i += 3) r.push(Math.hypot(pos[i], pos[i + 1], pos[i + 2])); return r; };
  const spread = (r) => Math.max(...r) - Math.min(...r);
  const l1 = loopSubdivide(octahedron(), null, 1).positions;
  const l2 = loopSubdivide(octahedron(), null, 2).positions;
  assert.ok(Math.max(...radii(l1)) < 1); // original corners are smoothed inward
  assert.ok(spread(radii(l2)) < spread(radii(l1))); // converging to a round limit surface
});

test("UVs are interpolated per corner", () => {
  const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uv = Float32Array.from([0, 0, 1, 0, 0, 1]);
  const out = loopSubdivide(pos, uv, 1);
  assert.equal(out.uvs.length / 6, 4);
  // the centre triangle's uvs are the edge midpoints
  const last = Array.from(out.uvs.slice(-6));
  assert.deepEqual(last, [0.5, 0, 0.5, 0.5, 0, 0.5]);
});
