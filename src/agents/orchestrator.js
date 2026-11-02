// Orchestrator: one request → planner → N component agents in parallel →
// per-part geometry optimization (also parallel, in workers) → commit.
//
// Rendering is progressive: each component is committed to the document the
// moment its agent returns (parts appear immediately with their parametric
// geometry), then each part is swapped for its optimized mesh as the worker
// finishes it. The whole run is wrapped in one document transaction so a
// single undo removes everything the run produced.

import { normalisePart, normaliseComponent, uid, buildGeometry, partWorldMatrix } from "../scene-model.js";
import { localPlan, localComponent, localEdit } from "./local-planner.js";
import { contextFor, computeReward, efficiencyScore } from "../rl/policy.js";
import { evaluateConstraints } from "../rl/constraints.js";

const CLEANUP = {
  gentle: { decimate: false, uvDistortionThreshold: 0.6, featureAngle: 20 },
  standard: {},
  aggressive: { decimateMaxRatio: 0.6, flatAngle: 8, uvDistortionThreshold: 0.2, featureAngle: 40 },
};

export class Orchestrator {
  constructor({ doc, policy, optimizer, buildGeometry, log, trajectory = null, captureViews = null, maxReviewRounds = 2 }) {
    Object.assign(this, { doc, policy, optimizer, buildGeometry, log, trajectory, captureViews, maxReviewRounds });
    this.agents = []; this.listeners = new Set(); this.backendOk = null; this.lastEpisode = null; this.plan = null;
    // Conversational transcript the UI shows: what the agents are doing, in plain words.
    this.transcript = []; this.transcriptListeners = new Set();
  }
  onTranscript(fn) { this.transcriptListeners.add(fn); return () => this.transcriptListeners.delete(fn); }
  say(text, { role = "agent", detail = "", images = null, kind = "" } = {}) {
    const entry = { role, text, detail, images, kind, t: Date.now() };
    this.transcript.push(entry); for (const fn of this.transcriptListeners) fn(this.transcript); return entry;
  }
  // Replace the trailing status line (e.g. "Modeling… 12 s") without growing the transcript.
  status(text) {
    const last = this.transcript.at(-1);
    if (last?.role === "status") { last.text = text; last.t = Date.now(); } else this.transcript.push({ role: "status", text, t: Date.now() });
    for (const fn of this.transcriptListeners) fn(this.transcript);
  }
  endStatus() { if (this.transcript.at(-1)?.role === "status") this.transcript.pop(); for (const fn of this.transcriptListeners) fn(this.transcript); }

  // Apply ops and record them as one trajectory step (before/after digests).
  commit(ops, { agent, intent, result = null, error = null, ms = 0 } = {}) {
    const before = this.trajectory ? this.doc.snapshot() : null;
    const touched = this.doc.applyOps(ops);
    if (this.trajectory) this.trajectory.step({ agent, intent, ops, before, after: this.doc.snapshot(), result, error, ms });
    return touched;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.agents); }

  async checkBackend() {
    try { const r = await fetch("/api/health"); const j = await r.json(); this.backendOk = !!j.ok; this.backendModel = j.model; }
    catch { this.backendOk = false; }
    return this.backendOk;
  }

  spawn(name, role) { const a = { id: uid("agent"), name, role, state: "queued", detail: "", progress: 0, ms: 0 }; this.agents.push(a); this.emit(); return a; }
  set(a, patch) { Object.assign(a, patch); this.emit(); }

  async call(path, body) {
    const r = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `${path} failed (${r.status})`);
    return j.data;
  }

  // Entry point. Returns the episode record used for RL feedback.
  // overrides: user-chosen strategy arms (e.g. {style:"smooth"}) that replace the policy's pick.
  async run({ prompt, image, mode, overrides = {} }) {
    this.agents = []; this.emit();
    const t0 = performance.now();
    const context = contextFor(prompt, !!image);
    const choice = { ...this.policy.choose(context), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v)) };
    this.log(`policy[${context}] → ${Object.entries(choice).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    await this.checkBackend();
    const useLLM = this.backendOk;
    if (!useLLM) this.log("backend offline — using local rule-based agents");

    const isEdit = mode === "edit" || (mode === "auto" && this.doc.parts.size > 0 && looksLikeEdit(prompt, this.doc));
    if (mode === "auto" && this.doc.parts.size > 0) this.log(`interpreting as ${isEdit ? "an EDIT of the current model" : "a NEW model (replaces the scene — ⌘Z to undo)"}`);
    const optOpts = CLEANUP[choice.cleanup] ?? {};
    const reports = []; let partIds = [], opCount = 0;
    if (!isEdit) this.plan = null;
    this.trajectory?.begin({ instruction: prompt, context, choice, scene: this.doc.snapshot(), mode: isEdit ? "edit" : "create" });
    this.say(prompt, { role: "user", images: image ? [image] : null });
    if (!useLLM) this.say("The AI backend is offline, so I'll use the built-in rule-based modeler.", { kind: "warn" });
    this.status(isEdit ? "Reading the current model…" : "Planning…");
    const ticker = setInterval(() => { const l = this.transcript.at(-1); if (l?.role === "status") this.status(l.text.replace(/ · \d+ s$/, "") + ` · ${Math.round((performance.now() - t0) / 1000)} s`); }, 1000);

    try {
      await this.doc.transaction(async () => {
        const res = isEdit ? await this.runEdit({ prompt, image, choice, useLLM, optOpts, reports }) : await this.runCreate({ prompt, image, choice, useLLM, optOpts, reports });
        partIds = res.partIds; opCount = res.opCount;
      });
    } finally { clearInterval(ticker); this.endStatus(); }

    // Automated reward components (spec): geometry quality, constraint preservation, efficiency.
    const ms = Math.round(performance.now() - t0);
    const geometryScore = reports.length ? reports.reduce((s, r) => s + r.score, 0) / reports.length : 0.5;
    const constraints = evaluateConstraints(this.doc, this.plan);
    const efficiency = efficiencyScore({ ms, ops: opCount, parts: Math.max(1, partIds.length || this.doc.parts.size) });
    const reward = computeReward({ human: null, geometryScore, constraintScore: constraints.score, criticalViolations: constraints.criticalViolations, efficiency });
    const traj = this.trajectory?.finish({ reward: reward.total, breakdown: reward.breakdown, violations: constraints.violations, criticalViolations: constraints.criticalViolations, finalScene: this.doc.snapshot(), ms });
    this.lastEpisode = { context, choice, geometryScore, constraints, efficiency, reward, reports, prompt, ms, partIds, trajectoryId: traj?.id ?? null };
    this.log(`done in ${ms} ms · ${opCount} ops · geometry ${geometryScore.toFixed(2)} · constraints ${constraints.score.toFixed(2)}${constraints.criticalViolations.length ? ` · CRITICAL: ${constraints.criticalViolations.join(", ")}` : ""} · efficiency ${efficiency.toFixed(2)}`);
    this.say(isEdit ? `Done — edit applied in ${(ms / 1000).toFixed(0)} s. Click any part to adjust it with the tools, or tell me what to change next.` : `Done in ${(ms / 1000).toFixed(0)} s — ${this.doc.components.size} components, ${this.doc.parts.size} parts. Click a component to adjust it, or tell me what to change.`, { kind: "done" });
    return this.lastEpisode;
  }

  async runCreate({ prompt, image, choice, useLLM, optOpts, reports }) {
    const planner = this.spawn("Planner", "decompose request into components");
    this.set(planner, { state: "running", detail: useLLM ? `asking ${this.backendModel}` : "offline planner" });
    const tp = performance.now();
    let plan;
    let planError = null;
    try {
      plan = useLLM ? await this.call("plan", { prompt, image, hints: choice }) : localPlan(prompt, choice);
      this.set(planner, { state: "done", detail: `${plan.components.length} components · ${plan.summary}`, progress: 1, ms: Math.round(performance.now() - tp) });
    } catch (err) {
      planError = err.message;
      this.set(planner, { state: "error", detail: err.message });
      this.log(`planner failed: ${err.message} — falling back to offline planner`);
      plan = localPlan(prompt, choice); useLLM = false;
    }
    this.plan = plan;
    this.commit([{ op: "clear" }], { agent: "Planner", intent: `decompose: ${prompt}`, result: { summary: plan.summary, components: plan.components.map((c) => c.name), overallHeight: plan.overallHeight }, error: planError, ms: Math.round(performance.now() - tp) });
    this.say(`Planned ${plan.components.length} components: ${plan.components.map((c) => c.name.replace(/_/g, " ")).join(", ")}.`, { detail: plan.summary });
    this.status(`Modeling ${plan.components.length} components in parallel…`);
    // Fan out: one agent per component; each commits itself as soon as it's done.
    const results = await Promise.all(plan.components.map((comp) => this.runComponent({ comp, plan, prompt, image, choice, useLLM, optOpts, reports })));
    // Post-process: rest the assembled model on the ground as one rigid unit.
    const before = this.doc.snapshot();
    const lift = groundSnap(this.doc);
    if (lift) { this.trajectory?.step({ agent: "Optimizer", intent: "ground snap: lift model to y=0", ops: this.doc.listComponents().map((c) => ({ op: "updateComponent", id: c.id, patch: { transform: { position: c.transform.position } } })), before, after: this.doc.snapshot(), result: { lift: +lift.toFixed(3) } }); this.log(`ground snap: lifted model ${lift.toFixed(3)} m`); this.say(`Rested the model on the ground (lifted ${(lift * 100).toFixed(0)} cm).`); }
    // Self-review: look at the result from several angles and fix what's off.
    let reviewOps = 0;
    if (useLLM && this.captureViews) reviewOps = await this.reviewLoop({ prompt, image, choice, optOpts, reports });
    return { partIds: results.flatMap((r) => r.partIds), opCount: results.reduce((n, r) => n + r.opCount, 0) + 1 + (lift ? 1 : 0) + reviewOps };
  }

  // The "look at it and fix it" loop: render → critique → apply fixes, up to maxReviewRounds.
  async reviewLoop({ prompt, image, choice, optOpts, reports }) {
    let applied = 0;
    for (let round = 1; round <= this.maxReviewRounds; round++) {
      const a = this.spawn("Reviewer", `visual check, round ${round}`);
      this.set(a, { state: "running", progress: 0.3 });
      this.status(`Looking at the result from 4 angles (review ${round}/${this.maxReviewRounds})…`);
      const t = performance.now();
      let views;
      try { views = this.captureViews(); } catch (err) { this.set(a, { state: "error", detail: err.message }); break; }
      if (!views.length) { this.set(a, { state: "done", detail: "nothing to review", progress: 1 }); break; }
      const scene = { components: this.doc.listComponents().map(({ id, name }) => ({ id, name })), parts: this.doc.list().map(({ id, componentId, name, primitive, transform, material }) => ({ id, componentId, name, type: primitive.type, transform, color: material.color })) };
      let res;
      try { res = await this.call("review", { prompt, views, scene, round, reference: image }); }
      catch (err) { this.set(a, { state: "error", detail: err.message, progress: 1 }); this.log(`review: ${err.message}`); this.say(`Couldn't run the visual check (${err.message}).`, { kind: "warn" }); break; }
      const thumbs = views.map((v) => ({ mediaType: v.mediaType, data: v.data, name: v.name }));
      if (res.verdict === "accept" || !res.ops.length) {
        this.set(a, { state: "done", progress: 1, ms: Math.round(performance.now() - t), detail: res.summary });
        this.say(`Checked the result: ${res.summary}`, { images: thumbs, kind: "review" }); break;
      }
      this.say(`Checked the result: ${res.summary}`, { detail: res.issues.join(" · "), images: thumbs, kind: "review" });
      this.status(`Applying ${res.ops.length} fix${res.ops.length === 1 ? "" : "es"}…`);
      const n = await this.applyEditOps(res.ops, { agent: "Reviewer", choice, optOpts, reports, error: null });
      applied += n;
      this.set(a, { state: "done", progress: 1, ms: Math.round(performance.now() - t), detail: `${res.summary} · ${n} fix(es)` });
      this.say(`Applied ${n} fix${n === 1 ? "" : "es"}: ${res.issues.slice(0, 3).join("; ")}${res.issues.length > 3 ? "…" : ""}`);
    }
    return applied;
  }

  async runComponent({ comp, plan, prompt, image, choice, useLLM, optOpts, reports }) {
    const a = this.spawn(comp.name, comp.role);
    this.set(a, { state: "running", detail: "modeling…", progress: 0.15 });
    const t = performance.now();
    let parts, reasoning = "", error = null;
    try {
      const res = useLLM ? await this.call("component", { prompt, image, component: comp, plan, hints: choice }) : localComponent(comp, plan, choice);
      parts = res.parts; reasoning = res.reasoning; this.set(a, { detail: res.reasoning, progress: 0.5 });
    } catch (err) {
      error = err.message;
      this.log(`${comp.name}: ${err.message} — offline fallback`);
      this.set(a, { state: "error", detail: `LLM failed (${err.message}); offline fallback`, progress: 0.5 });
      parts = localComponent(comp, { ...plan, family: plan.family ?? "generic" }, choice).parts;
    }
    // 1. Commit the component + raw parts now → they render immediately.
    const component = normaliseComponent({ name: comp.name, meta: { agent: a.name, role: comp.role, region: comp.region } });
    const normalised = parts.map((spec) => normalisePart({ ...spec, componentId: component.id, meta: { agent: a.name, strategy: choice } }));
    this.commit([{ op: "addComponent", component }, ...normalised.map((part) => ({ op: "add", part }))], { agent: a.name, intent: `model component "${comp.name}" (${comp.role})`, result: { reasoning, parts: normalised.map((p) => p.name) }, error, ms: Math.round(performance.now() - t) });
    // 2. Optimize each part in a worker; swap in results as they land.
    let done = 0;
    await Promise.all(normalised.map(async (part) => {
      const t1 = performance.now();
      const r = await this.optimizePart(part, optOpts);
      done++; this.set(a, { progress: 0.5 + 0.5 * (done / normalised.length) });
      if (!r) return;
      reports.push(r.report);
      if (this.doc.get(part.id)) this.commit([{ op: "update", id: part.id, patch: { optimized: r.payload } }], { agent: "Optimizer", intent: `optimize "${part.name}"`, result: { score: r.report.score, triangles: r.report.after.triangles, uv: r.report.stages.find((s) => s.name === "uv")?.after ?? null }, ms: Math.round(performance.now() - t1) });
    }));
    const mine = reports.filter((r) => normalised.some((p) => p.id === r.partId));
    const bad = mine.filter((r) => r.stages.find((s) => s.name === "orient")?.nonManifoldEdges > 0).length;
    this.set(a, { state: a.state === "error" ? "error" : "done", progress: 1, ms: Math.round(performance.now() - t), detail: `${normalised.length} part(s) · ${mine.reduce((n, r) => n + r.after.triangles, 0)} tris${bad ? ` · ${bad} non-manifold` : ""}` });
    const doneCount = this.agents.filter((x) => x.name !== "Planner" && x.state !== "running" && x.state !== "queued").length, total = this.agents.filter((x) => x.name !== "Planner").length;
    this.say(`Modeled ${comp.name.replace(/_/g, " ")} — ${normalised.length} part${normalised.length === 1 ? "" : "s"}${error ? " (fallback modeler)" : ""}.`, { detail: reasoning });
    this.status(`Modeling… ${doneCount}/${total} components done`);
    return { partIds: normalised.map((p) => p.id), opCount: normalised.length + 1 };
  }

  // Apply agent-produced edit ops (Editor or Reviewer): routes to parts/components,
  // re-optimizes geometry when it changed. Returns the number of ops applied.
  async applyEditOps(opsIn, { agent, choice, optOpts, reports, error }) {
    let n = 0;
    const step = (docOps, intent, result) => this.commit(docOps, { agent, intent, result, error });
    for (const o of opsIn) {
      const isComp = this.doc.getComponent(o.id);
      if (o.op === "add") {
        const part = normalisePart({ ...(o.part ?? o.patch), meta: { agent, strategy: choice } });
        step([{ op: "add", part }], `add part "${part.name}"`); n++;
        const r = await this.optimizePart(part, optOpts); if (r) { reports.push(r.report); this.commit([{ op: "update", id: part.id, patch: { optimized: r.payload } }], { agent: "Optimizer", intent: `optimize "${part.name}"`, result: { score: r.report.score } }); }
      } else if (o.op === "update" && isComp) {
        step([{ op: "updateComponent", id: o.id, patch: { transform: o.patch?.transform ?? {}, name: o.patch?.name ?? isComp.name } }], `update component "${isComp.name}"`, o.patch); n++;
      } else if (o.op === "update") {
        const cur = this.doc.get(o.id); if (!cur) continue;
        const patch = { ...o.patch };
        const geomChanged = o.patch?.primitive || o.patch?.modifiers;
        if (geomChanged) patch.optimized = null;
        step([{ op: "update", id: o.id, patch }], `update part "${cur.name}"`, o.patch); n++;
        if (geomChanged) { const merged = this.doc.get(o.id); const r = await this.optimizePart(merged, optOpts); if (r) { reports.push(r.report); this.commit([{ op: "update", id: o.id, patch: { optimized: r.payload } }], { agent: "Optimizer", intent: `optimize "${cur.name}"`, result: { score: r.report.score } }); } }
      } else if (o.op === "remove") {
        if (!isComp && !this.doc.get(o.id)) continue;
        step([isComp ? { op: "removeComponent", id: o.id } : { op: "remove", id: o.id }], `remove ${isComp ? "component" : "part"} ${o.id}`); n++;
      }
    }
    return n;
  }

  async runEdit({ prompt, image, choice, useLLM, optOpts, reports }) {
    const a = this.spawn("Editor", "apply targeted changes");
    this.set(a, { state: "running", detail: useLLM ? `asking ${this.backendModel}` : "offline edit grammar", progress: 0.2 });
    const t = performance.now();
    const scene = {
      components: this.doc.listComponents().map(({ id, name, transform }) => ({ id, name, transform })),
      parts: this.doc.list().map(({ id, componentId, name, primitive, transform, material, modifiers }) => ({ id, componentId, name, primitive, transform, material, modifiers })),
    };
    let res, failure = "";
    try { res = useLLM ? await this.call("edit", { prompt, image, scene, hints: choice }) : localEdit(prompt, scene.parts); }
    catch (err) { failure = `LLM failed (${err.message}); `; this.log(`edit agent: ${err.message}`); res = localEdit(prompt, scene.parts); this.say(`The edit agent hit an error (${err.message}); using the simple built-in editor instead.`, { kind: "warn" }); }
    this.status(`Applying ${res.ops.length} change${res.ops.length === 1 ? "" : "s"}…`);
    const partIdsBefore = new Set(this.doc.parts.keys());
    const n = await this.applyEditOps(res.ops, { agent: "Editor", choice, optOpts, reports, error: failure || null });
    const partIds = [...this.doc.parts.keys()].filter((id) => !partIdsBefore.has(id));
    this.set(a, { state: failure ? "error" : "done", progress: 1, ms: Math.round(performance.now() - t), detail: `${failure}${res.reasoning} · ${n} op(s)` });
    this.say(n ? `${res.reasoning}` : `I couldn't find anything to change for that — try naming the part (e.g. "the handles") or describing the change differently.`, { kind: n ? "" : "warn" });
    return { partIds: [], opCount: n, added: partIds };
  }

  async optimizePart(part, optOpts) {
    try {
      const g = this.buildGeometry(part);
      const { geometry, report } = await this.optimizer.optimizeGeometry(g, optOpts);
      g.dispose(); report.partId = part.id;
      return { payload: serializeGeometry(geometry), report };
    } catch (err) { this.log(`optimizer failed for ${part.name}: ${err.message}`); return null; }
  }

  // Re-run only the optimizer over the current scene (toolbar button).
  async optimizeAll(cleanup = "standard") {
    this.agents = []; this.emit();
    const parts = this.doc.list(); const reports = [];
    const a = this.spawn("Optimizer", `${parts.length} part(s) · ${cleanup}`);
    this.set(a, { state: "running", progress: 0.1 }); const t = performance.now();
    await this.doc.transaction(() => Promise.all(parts.map(async (p, i) => {
      const r = await this.optimizePart(p, CLEANUP[cleanup] ?? {});
      this.set(a, { progress: 0.1 + 0.9 * ((i + 1) / parts.length) });
      if (!r) return; reports.push(r.report); this.doc.applyOps([{ op: "update", id: p.id, patch: { optimized: r.payload } }]);
    })));
    this.set(a, { state: "done", progress: 1, ms: Math.round(performance.now() - t), detail: `${reports.reduce((n, r) => n + r.after.triangles, 0)} tris · mean UV distortion ${(reports.reduce((n, r) => n + (r.stages.find((s) => s.name === "uv").after ?? 0), 0) / Math.max(1, reports.length)).toFixed(3)}` });
    return reports;
  }
}

// With a model already in the scene, treat the prompt as an edit unless it
// clearly asks for a new object ("a wooden chair", "create/build/model a …")
// and doesn't name anything that exists.
function looksLikeEdit(p, doc) {
  const text = p.toLowerCase();
  const names = [...new Set([...doc.listComponents().map((c) => c.name), ...doc.list().map((x) => x.name)].flatMap((n) => n.toLowerCase().split(/[:_\s]+/)).filter((w) => w.length > 3))];
  const words = new Set(text.split(/[^a-z]+/)); // whole words only: "handlebars" must not match "handle"
  const mentionsExisting = names.some((w) => words.has(w) || words.has(w + "s"));
  const editVerbs = /\b(make|change|move|rotate|scale|resize|remove|delete|recolor|color|colour|paint|bigger|smaller|taller|shorter|wider|thinner|thicker|shrink|enlarge|shorten|lengthen|fix|adjust|tweak|replace|add (a|an|another|some)|it|its|this|that|the|them|their)\b/.test(text);
  const createPhrase = /^(create|build|model|generate|design|draw|give me|i want|i need|new)\b|^(a|an)\s+\w/.test(text.trim());
  if (mentionsExisting) return true;
  if (createPhrase && !/\b(the|it|this|that|existing|current)\b/.test(text)) return false;
  return editVerbs;
}

// Lift the whole model as one unit so its lowest point rests on y=0.
// Preserves every relative placement; satisfies the critical above_ground
// constraint without per-part surgery. Returns the lift applied (metres).
function groundSnap(doc) {
  let minY = Infinity;
  for (const p of doc.list()) { const g = buildGeometry(p); g.computeBoundingBox(); const b = g.boundingBox.clone().applyMatrix4(partWorldMatrix(doc, p)); g.dispose(); minY = Math.min(minY, b.min.y); }
  if (!Number.isFinite(minY) || Math.abs(minY) < 0.01) return 0;
  const lift = -minY;
  doc.applyOps(doc.listComponents().map((c) => ({ op: "updateComponent", id: c.id, patch: { transform: { position: [c.transform.position[0], c.transform.position[1] + lift, c.transform.position[2]] } } })));
  return lift;
}

// Plain-object form so optimized geometry survives JSON snapshots (undo/redo).
export function serializeGeometry(g) {
  return {
    positions: Array.from(g.attributes.position.array),
    normals: Array.from(g.attributes.normal.array),
    uvs: g.attributes.uv ? Array.from(g.attributes.uv.array) : null,
    indices: Array.from(g.index.array),
  };
}
