import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { loftGeometry, tubeGeometry, greeble, plating, radialArray } from "../src/geometry/detail.js";

const triCount = (g) => g.attributes.position.count / 3;

test("loft builds a closed hull from stations", () => {
  const g = loftGeometry([[-1, 0.5, 0.4, 0], [0, 1, 0.8, 0.1], [1, 0.3, 0.2, 0.2]], { sides: 12 });
  assert.equal(triCount(g), 2 * 12 * 2 + 12 * 2); // 2 bands of quads + 2 caps
  g.computeBoundingBox();
  assert.ok(Math.abs(g.boundingBox.min.z + 1) < 1e-6 && Math.abs(g.boundingBox.max.z - 1) < 1e-6);
  assert.ok(Math.abs(g.boundingBox.max.x - 0.5) < 1e-6); // widest station is 1.0 wide
});

test("loft roundness: 1 → ellipse, 0 → near-rectangle", () => {
  const round = loftGeometry([[0, 1, 1, 0], [1, 1, 1, 0]], { roundness: 1, sides: 32 });
  const sharp = loftGeometry([[0, 1, 1, 0], [1, 1, 1, 0]], { roundness: 0, sides: 32 });
  const corner = (g) => { let m = 0; const p = g.attributes.position.array; for (let i = 0; i < p.length; i += 3) m = Math.max(m, Math.abs(p[i]) + Math.abs(p[i + 1])); return m; };
  assert.ok(corner(round) < 0.8); // ellipse never reaches the corner
  assert.ok(corner(sharp) > 0.9); // superellipse with high exponent fills the corner
});

test("tube follows a path", () => {
  const g = tubeGeometry([[0, 0, 0], [1, 0, 0], [2, 1, 0]], { radius: 0.1, segments: 8, radialSegments: 6 });
  assert.ok(g.attributes.position.count > 0);
  g.computeBoundingBox();
  assert.ok(g.boundingBox.max.x > 1.9 && g.boundingBox.max.y > 0.9);
});

test("greebles sit on the surface, respect the face filter and are deterministic", () => {
  const box = new THREE.BoxGeometry(2, 1, 1).toNonIndexed();
  const top = greeble(box, { count: 20, faces: "top", seed: 5 });
  assert.equal(top.length, 20);
  for (const g of top) { g.computeBoundingBox(); assert.ok(g.boundingBox.min.y > 0.49, "greeble on the top face starts at the surface"); }
  const again = greeble(box, { count: 20, faces: "top", seed: 5 });
  assert.deepEqual(Array.from(top[3].attributes.position.array), Array.from(again[3].attributes.position.array));
  assert.equal(greeble(box, { count: 10, faces: "top", seed: 6 })[0].attributes.position.array[0] === top[0].attributes.position.array[0], false);
});

test("plating produces a grid of plates, one per cell", () => {
  const box = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  // cell is a fraction of the box's geometric-mean size (2 m): 0.12 → 0.24 m cells → ~8×8 on a 2 m face
  const plates = plating(box, { cell: 0.12, faces: "top", jitter: 0 });
  assert.ok(plates.length >= 30 && plates.length <= 110, `got ${plates.length}`);
  // all on the top face
  for (const g of plates) { g.computeBoundingBox(); assert.ok(g.boundingBox.min.y > 0.99); }
});

test("detail stays small on a large hull (absolute clamps)", () => {
  const hull = new THREE.BoxGeometry(14, 3, 3).toNonIndexed();
  for (const g of greeble(hull, { count: 10, minSize: 0.25, maxSize: 0.3, seed: 2 })) { g.computeBoundingBox(); const s = g.boundingBox.getSize(new THREE.Vector3()); assert.ok(Math.max(s.x, s.y, s.z) <= 0.8 * Math.SQRT2 + 0.01, `greeble too big: ${s.toArray()}`); } // ≤ 0.8 m box, possibly spun 45°
  const plates = plating(hull, { cell: 0.25, faces: "top", jitter: 0 });
  assert.ok(plates.length >= 20, `only ${plates.length} plates on a 14 m deck`);
});

test("radial array makes N-1 rotated copies", () => {
  const cyl = new THREE.CylinderGeometry(0.1, 0.1, 1, 6).toNonIndexed(); cyl.translate(1, 0, 0);
  const copies = radialArray(cyl, { count: 8, axis: "y" });
  assert.equal(copies.length, 7);
  copies[3].computeBoundingBox(); const c = copies[3].boundingBox.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(Math.hypot(c.x, c.z) - 1) < 1e-6, "copies stay on the ring");
});
