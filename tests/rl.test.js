import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReward, efficiencyScore, REWARD_WEIGHTS } from "../src/rl/policy.js";
import { TrajectoryStore, replayEpisode, digest } from "../src/rl/trajectory.js";
import { SceneDocument } from "../src/scene-model.js";

const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };

test("reward is the weighted sum and a critical violation zeroes it", () => {
  const r = computeReward({ human: 1, geometryScore: 1, constraintScore: 1, efficiency: 1 });
  assert.equal(r.total, 1);
  assert.ok(Math.abs(Object.values(REWARD_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const half = computeReward({ human: 0, geometryScore: 0.5, constraintScore: 0.5, efficiency: 0.5 });
  assert.equal(half.total, 0.5);
  const failed = computeReward({ human: 1, geometryScore: 1, constraintScore: 1, efficiency: 1, criticalViolations: ["above_ground"] });
  assert.equal(failed.total, 0); assert.ok(failed.failed);
});

test("efficiency rewards fewer ops and less time per part", () => {
  assert.ok(efficiencyScore({ ms: 1000, ops: 10, parts: 10 }) > efficiencyScore({ ms: 200000, ops: 80, parts: 10 }));
});

test("trajectory records steps with digests and replays deterministically", () => {
  const store = new TrajectoryStore(memStorage());
  const doc = new SceneDocument();
  store.begin({ instruction: "a cube", context: "generic:mid", choice: {}, scene: doc.snapshot(), mode: "create" });
  const commit = (ops, agent, intent) => { const before = doc.snapshot(); doc.applyOps(ops); store.step({ agent, intent, ops, before, after: doc.snapshot() }); };
  commit([{ op: "addComponent", component: { id: "comp_a", name: "core" } }, { op: "add", part: { id: "p1", componentId: "comp_a", name: "core: box" } }], "core", "model core");
  commit([{ op: "update", id: "p1", patch: { transform: { position: [0, 1, 0] } } }], "Editor", "raise");
  const ep = store.finish({ reward: 0.8, breakdown: {}, violations: [], criticalViolations: [], finalScene: doc.snapshot(), ms: 10 });
  assert.equal(ep.steps.length, 2);
  assert.notEqual(ep.steps[0].beforeDigest, ep.steps[0].afterDigest);
  const r = replayEpisode(ep, () => new SceneDocument());
  assert.ok(r.ok, JSON.stringify(r.mismatches));
  assert.deepEqual(r.doc.get("p1").transform.position, [0, 1, 0]);
  // tampering with a logged op breaks the checkpoint
  ep.steps[1].ops[0].patch.transform.position = [0, 2, 0];
  assert.ok(!replayEpisode(ep, () => new SceneDocument()).ok);
});

test("digest is order-independent for object keys", () => {
  assert.equal(digest({ a: 1, b: [1, 2] }), digest({ b: [1, 2], a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test("annotation labels persist on episodes and steps", () => {
  const store = new TrajectoryStore(memStorage());
  const doc = new SceneDocument();
  store.begin({ instruction: "x", context: "c", choice: {}, scene: doc.snapshot(), mode: "create" });
  store.step({ agent: "a", intent: "i", ops: [], before: doc.snapshot(), after: doc.snapshot() });
  const ep = store.finish({ reward: 0, breakdown: {}, violations: [], criticalViolations: [], finalScene: doc.snapshot(), ms: 0 });
  store.labelEpisode(ep.id, "partial"); store.labelStep(ep.id, 0, "unnecessary"); store.labelStep(ep.id, 0, "bogus");
  const reloaded = new TrajectoryStore(store.storage);
  assert.equal(reloaded.last().label, "partial");
  assert.equal(reloaded.last().steps[0].label, "unnecessary");
  assert.ok(reloaded.exportJSONL().trim().split("\n").length === 1);
});
