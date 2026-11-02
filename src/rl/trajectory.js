// Trajectory recorder (spec: trajectory logging, replay, annotation).
//
// An episode = one agent run. Each step records the action intent, the
// executed tool call (document ops), before/after snapshot digests, result or
// error, and later the reward breakdown and annotation labels. Episodes are
// persisted in localStorage, exportable as JSONL, and replayable: `replay`
// re-executes the logged ops on the logged starting scene and verifies the
// after-digests match (deterministic replay check).

const STORAGE_KEY = "morsy.trajectories.v1";
const VERSION = { env: "morsy-web-0.2", schema: 1 };

export const STEP_LABELS = ["unlabeled", "correct", "incorrect", "unnecessary", "uncertain"];
export const EPISODE_LABELS = ["unlabeled", "success", "partial", "failure"];

export class TrajectoryStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage; this.episodes = []; this.current = null; this.load();
  }
  load() { try { const raw = this.storage?.getItem(STORAGE_KEY); if (raw) this.episodes = JSON.parse(raw); } catch {} }
  // Episodes carry full optimized meshes (needed for exact replay), so only a
  // handful fit in localStorage; export JSONL to keep more.
  save() { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.episodes.slice(-6))); } catch { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.episodes.slice(-2))); } catch {} } }

  begin({ instruction, context, choice, scene, mode }) {
    this.current = { id: `ep_${Date.now().toString(36)}`, t: Date.now(), instruction, mode, context, policy: choice, version: VERSION, startScene: scene, steps: [], reward: null, label: "unlabeled", corrections: [] };
    return this.current;
  }
  // before/after are scene snapshots ({components, parts}); only digests are kept per step to stay small.
  step({ agent, intent, ops, before, after, result = null, error = null, ms = 0 }) {
    if (!this.current) return null;
    const s = { i: this.current.steps.length, t: Date.now(), agent, intent, ops: compactOps(ops), beforeDigest: digest(before), afterDigest: digest(after), result, error, ms, label: "unlabeled" };
    this.current.steps.push(s); return s;
  }
  finish({ reward, breakdown, violations, criticalViolations, finalScene, ms }) {
    if (!this.current) return null;
    Object.assign(this.current, { reward, breakdown, violations, criticalViolations, finalDigest: digest(finalScene), ms, steps: this.current.steps.map((s) => ({ ...s })) });
    this.episodes.push(this.current); const ep = this.current; this.current = null; this.save(); return ep;
  }
  setReward(id, reward, breakdown) { const ep = this.episodes.find((e) => e.id === id); if (ep) { ep.reward = reward; ep.breakdown = breakdown; this.save(); } }
  labelEpisode(id, label) { const ep = this.episodes.find((e) => e.id === id); if (ep && EPISODE_LABELS.includes(label)) { ep.label = label; this.save(); } }
  labelStep(id, i, label) { const ep = this.episodes.find((e) => e.id === id); const s = ep?.steps[i]; if (s && STEP_LABELS.includes(label)) { s.label = label; this.save(); } }
  addCorrection(id, note) { const ep = this.episodes.find((e) => e.id === id); if (ep) { ep.corrections.push({ t: Date.now(), note }); this.save(); } }
  last() { return this.episodes.at(-1) ?? null; }
  clear() { this.episodes = []; this.save(); }

  exportJSONL() { return this.episodes.map((e) => JSON.stringify(e)).join("\n") + "\n"; }
}

// Deterministic replay: rebuild the document from the episode's start scene,
// re-apply every step's ops, and compare digests at each checkpoint.
export function replayEpisode(ep, makeDoc) {
  const doc = makeDoc(); doc.restore(ep.startScene);
  const mismatches = [];
  for (const s of ep.steps) {
    if (digest(doc.snapshot()) !== s.beforeDigest) mismatches.push({ step: s.i, at: "before" });
    doc.applyOps(expandOps(s.ops), { record: false });
    if (digest(doc.snapshot()) !== s.afterDigest) mismatches.push({ step: s.i, at: "after" });
  }
  return { ok: mismatches.length === 0 && digest(doc.snapshot()) === ep.finalDigest, mismatches, doc };
}

// Ops carry full parts (incl. optimized meshes) — keep them so replay is exact,
// but strip nothing else. Optimized payloads dominate size; they're kept because
// the after-digest includes them and replay must reproduce the same document.
function compactOps(ops) { return JSON.parse(JSON.stringify(ops ?? [])); }
function expandOps(ops) { return ops; }

// FNV-1a over the canonical JSON of the snapshot (stable key order).
export function digest(obj) {
  const str = canonical(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0") + ":" + str.length.toString(36);
}
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
