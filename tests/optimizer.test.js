import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeMesh, orientConsistently, uvDistortion } from "../src/geometry/optimizer.js";

// Non-indexed unit cube: 12 triangles, 36 vertices, all duplicated.
function cube() {
  const f = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d];
  const P = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const positions = [
    ...f(P[0], P[3], P[2], P[1]), // back  (z=0) outward -z
    ...f(P[4], P[5], P[6], P[7]), // front (z=1) outward +z
    ...f(P[0], P[1], P[5], P[4]), // bottom
    ...f(P[3], P[7], P[6], P[2]), // top
    ...f(P[0], P[4], P[7], P[3]), // left
    ...f(P[1], P[2], P[6], P[5]), // right
  ];
  return { positions: Float32Array.from(positions) };
}

test("welds duplicated vertices and keeps a watertight cube", () => {
  const { report } = optimizeMesh(cube(), { decimate: false });
  assert.equal(report.before.vertices, 36);
  assert.equal(report.after.vertices, 8);
  assert.equal(report.after.triangles, 12);
  const orient = report.stages.find((s) => s.name === "orient");
  assert.equal(orient.nonManifoldEdges, 0);
  assert.equal(orient.boundaryEdges, 0);
});

test("fixes inconsistently wound faces", () => {
  const c = cube();
  // flip the first triangle's winding
  const p = c.positions; for (let k = 0; k < 3; k++) { const t = p[3 + k]; p[3 + k] = p[6 + k]; p[6 + k] = t; }
  const { report, positions, indices } = optimizeMesh(c, { decimate: false });
  assert.ok(report.stages.find((s) => s.name === "orient").flipped >= 1);
  // signed volume must be positive (outward) after orientation
  let vol = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, cc] = [indices[i], indices[i + 1], indices[i + 2]];
    const A = positions.subarray(a * 3, a * 3 + 3), B = positions.subarray(b * 3, b * 3 + 3), C = positions.subarray(cc * 3, cc * 3 + 3);
    vol += A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
  }
  assert.ok(vol > 0);
});

test("removes degenerate triangles", () => {
  const c = cube();
  const positions = Float32Array.from([...c.positions, 0, 0, 0, 0, 0, 0, 1, 1, 1]); // zero-area sliver
  const { report } = optimizeMesh({ positions }, { decimate: false });
  assert.equal(report.stages.find((s) => s.name === "clean").degenerate, 1);
  assert.equal(report.after.triangles, 12);
});

test("decimates a flat over-tessellated quad but protects feature edges", () => {
  // 10x10 grid plane
  const N = 10, pos = [], idx = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(i / N, 0, j / N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
  const { report } = optimizeMesh({ positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }, { decimateMaxRatio: 0.5 });
  const dec = report.stages.find((s) => s.name === "decimate");
  assert.ok(dec.collapsed > 0, "interior flat edges should collapse");
  assert.ok(report.after.triangles < report.before.triangles);
  // cube has only 90° edges → nothing collapsible
  const cubeRes = optimizeMesh(cube(), {});
  assert.equal(cubeRes.report.after.triangles, 12);
});

test("uv distortion is ~0 for an undistorted projection and improves when re-projected", () => {
  const positions = Float32Array.from([0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0]);
  const goodUV = Float32Array.from([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]);
  const badUV = Float32Array.from([0,0, 1,0, 1,0.05, 0,0, 1,0.05, 0,0.05]); // squashed
  const idx = Uint32Array.from([0,1,2,3,4,5]);
  assert.ok(uvDistortion(positions, idx, goodUV).mean < 0.01);
  assert.ok(uvDistortion(positions, idx, badUV).mean > 0.5);
  const { report } = optimizeMesh({ positions, uvs: badUV, indices: idx }, { decimate: false });
  const uv = report.stages.find((s) => s.name === "uv");
  assert.ok(uv.reprojected);
  assert.ok(uv.after < uv.before);
});

test("orientConsistently reports non-manifold edges", () => {
  // three triangles sharing one edge (0-1)
  const positions = Float32Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,-1,0]);
  const indices = Uint32Array.from([0,1,2, 0,1,3, 0,1,4]);
  assert.equal(orientConsistently(positions, indices).nonManifold, 1);
});
