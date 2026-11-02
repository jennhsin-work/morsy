// Reinforcement learning over modeling decisions.
//
// Agents face a handful of discrete choices on every job (how to decompose the
// object, how densely to tessellate, how aggressively the optimizer should
// clean up, which modeling style to favour). We model each choice as a
// contextual multi-armed bandit: the context is a coarse bucket of the request
// (object class × fidelity hint), the arms are the options, and the reward is
//   r = 0.6 * human_feedback(−1..1 → 0..1)  +  0.4 * optimizer_quality(0..1)
// Thompson sampling over Beta posteriors picks arms; posteriors persist in
// localStorage so the workspace keeps learning across sessions.

export const DECISIONS = {
  decomposition: ["coarse", "balanced", "fine"],        // how many components to split into
  tessellation: ["low", "medium", "high"],              // segment counts handed to agents
  cleanup: ["gentle", "standard", "aggressive"],       // optimizer decimation + UV thresholds
  style: ["blocky", "smooth", "detailed"],              // modeling style hint in agent prompts
};

const STORAGE_KEY = "morsy.policy.v1";

export class Policy {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.table = {}; // key: `${context}|${decision}|${arm}` → {a, b, n}
    this.history = []; // last N episodes for the UI
    this.load();
  }

  load() {
    try { const raw = this.storage?.getItem(STORAGE_KEY); if (raw) Object.assign(this, JSON.parse(raw)); } catch {}
  }
  save() { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({ table: this.table, history: this.history.slice(-50) })); } catch {} }
  reset() { this.table = {}; this.history = []; this.save(); }

  posterior(context, decision, arm) {
    return this.table[`${context}|${decision}|${arm}`] ?? { a: 1, b: 1, n: 0 };
  }

  // Thompson sampling: draw from each arm's Beta(a,b), take the max.
  choose(context) {
    const choice = {};
    for (const [decision, arms] of Object.entries(DECISIONS)) {
      let best = null, bestSample = -1;
      for (const arm of arms) {
        const { a, b } = this.posterior(context, decision, arm);
        const s = sampleBeta(a, b);
        if (s > bestSample) { bestSample = s; best = arm; }
      }
      choice[decision] = best;
    }
    return choice;
  }

  // reward in [0,1]
  update(context, choice, reward, note = "") {
    const r = Math.max(0, Math.min(1, reward));
    for (const [decision, arm] of Object.entries(choice)) {
      const key = `${context}|${decision}|${arm}`;
      const p = this.table[key] ?? { a: 1, b: 1, n: 0 };
      // Fractional Bernoulli update keeps the Beta posterior well-defined for soft rewards.
      this.table[key] = { a: p.a + r, b: p.b + (1 - r), n: p.n + 1 };
    }
    this.history.push({ t: Date.now(), context, choice, reward: +r.toFixed(3), note });
    this.save();
  }

  // Human-readable summary for the UI: per decision, the arm with the highest mean.
  summary(context) {
    const out = [];
    for (const [decision, arms] of Object.entries(DECISIONS)) {
      const rows = arms.map((arm) => { const p = this.posterior(context, decision, arm); return { arm, mean: p.a / (p.a + p.b), n: p.n }; });
      rows.sort((x, y) => y.mean - x.mean);
      out.push({ decision, rows });
    }
    return out;
  }
}

// Weighted reward (spec: task accuracy · constraint preservation · geometry
// quality · efficiency; a critical constraint violation fails the episode
// regardless of the aggregate). Weights are configurable.
export const REWARD_WEIGHTS = { taskAccuracy: 0.45, constraints: 0.25, geometry: 0.2, efficiency: 0.1 };

export function computeReward({ human = null, geometryScore = 0.5, constraintScore = 1, criticalViolations = [], efficiency = 1, weights = REWARD_WEIGHTS }) {
  const task = human == null ? 0.5 : (human + 1) / 2; // -1..1 → 0..1, neutral when absent
  const breakdown = {
    taskAccuracy: +(weights.taskAccuracy * task).toFixed(3),
    constraints: +(weights.constraints * constraintScore).toFixed(3),
    geometry: +(weights.geometry * geometryScore).toFixed(3),
    efficiency: +(weights.efficiency * efficiency).toFixed(3),
  };
  const total = criticalViolations.length ? 0 : Math.max(0, Math.min(1, Object.values(breakdown).reduce((a, b) => a + b, 0)));
  return { total: +total.toFixed(3), breakdown, failed: criticalViolations.length > 0 };
}

// Efficiency in [0,1]: fewer ops and less wall-clock per part is better.
export function efficiencyScore({ ms, ops, parts }) {
  const perPart = ms / Math.max(1, parts);
  const timeTerm = Math.max(0, 1 - perPart / 30000); // 30 s per part → 0
  const opTerm = Math.max(0, 1 - Math.max(0, ops - parts * 2) / Math.max(1, parts * 4));
  return +(0.6 * timeTerm + 0.4 * opTerm).toFixed(3);
}

// Context bucket: object class from a few keyword families + a fidelity hint.
export function contextFor(prompt, hasImage) {
  const p = prompt.toLowerCase();
  // Vehicles first: "a boat with bench seats" is a vehicle, not furniture.
  const cls =
    /\b(car|truck|bike|ship|boat|plane|rocket|wheel|vehicle|tank)\b/.test(p) ? "vehicle"
    : /\b(chair|table|desk|sofa|couch|bed|shelf|cabinet|stool|bench|lamp)\b/.test(p) ? "furniture"
    : /\b(house|building|tower|castle|wall|door|window|bridge|roof|room)\b/.test(p) ? "architecture"
    : /\b(dog|cat|bird|fish|human|person|character|robot|creature|dragon|animal)\b/.test(p) ? "character"
    : /\b(cup|mug|bottle|vase|bowl|plate|pot|jar|glass)\b/.test(p) ? "vessel"
    : /\b(sword|gun|hammer|axe|tool|wrench|shield|bow)\b/.test(p) ? "prop"
    : "generic";
  const fidelity = /\b(low[- ]?poly|blocky|simple|minimal)\b/.test(p) ? "low" : /\b(detailed|high[- ]?poly|realistic|intricate)\b/.test(p) ? "high" : "mid";
  return `${cls}:${fidelity}${hasImage ? ":img" : ""}`;
}

// Marsaglia–Tsang gamma sampler → Beta via two gammas.
function sampleGamma(k) {
  if (k < 1) { const u = Math.random(); return sampleGamma(1 + k) * Math.pow(u, 1 / k); }
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gaussian(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function gaussian() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export function sampleBeta(a, b) { const x = sampleGamma(a), y = sampleGamma(b); return x / (x + y); }
