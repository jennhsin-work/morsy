// Constraint evaluator (spec: "constraint preservation" reward component).
// Checks the document against the plan the agents were given. Each check
// returns { id, severity: "critical"|"soft", ok, detail }. A critical
// violation fails the episode regardless of the aggregate score.
import * as THREE from "three";
import { buildGeometry, partWorldMatrix } from "../scene-model.js";

const GROUND_TOL = 0.02; // metres below y=0 tolerated (numerical slop)

export function evaluateConstraints(doc, plan) {
  const checks = [];
  const bounds = new Map(); // partId → world Box3
  const all = new THREE.Box3();
  for (const p of doc.list()) {
    const g = buildGeometry(p); g.computeBoundingBox();
    const box = g.boundingBox.clone().applyMatrix4(partWorldMatrix(doc, p)); g.dispose();
    bounds.set(p.id, box); all.union(box);
  }

  // C1 (critical): nothing below the ground plane.
  const below = [...bounds].filter(([, b]) => b.min.y < -GROUND_TOL).map(([id]) => doc.get(id)?.name);
  checks.push({ id: "above_ground", severity: "critical", ok: !below.length, detail: below.length ? `${below.length} part(s) below y=0: ${below.slice(0, 3).join(", ")}` : "all parts rest on or above the ground" });

  if (plan?.components?.length) {
    // C2 (soft): each component stays inside the region the planner assigned it (with 25% slack).
    let outside = 0, checked = 0;
    for (const c of doc.listComponents()) {
      const region = c.meta?.region; if (!region) continue; checked++;
      const half = new THREE.Vector3(...region.size).multiplyScalar(0.5 * 1.25).addScalar(0.05);
      const centre = new THREE.Vector3(...region.center);
      const allowed = new THREE.Box3(centre.clone().sub(half), centre.clone().add(half));
      const cb = new THREE.Box3(); for (const p of doc.partsOf(c.id)) { const b = bounds.get(p.id); if (b) cb.union(b); }
      if (!cb.isEmpty() && !allowed.containsBox(cb)) outside++;
    }
    checks.push({ id: "within_region", severity: "soft", ok: outside === 0, score: checked ? 1 - outside / checked : 1, detail: `${checked - outside}/${checked} components inside their planned region` });

    // C3 (soft): overall height matches the plan within 30%.
    const h = all.isEmpty() ? 0 : all.max.y - Math.max(0, all.min.y);
    const target = plan.overallHeight || h; const err = target ? Math.abs(h - target) / target : 0;
    checks.push({ id: "overall_height", severity: "soft", ok: err <= 0.3, score: Math.max(0, 1 - err), detail: `height ${h.toFixed(2)} m vs planned ${target.toFixed(2)} m` });
  }

  // C4 (soft): no component is entirely disconnected from the rest (floating debris).
  const comps = doc.listComponents();
  if (comps.length > 1) {
    const cboxes = comps.map((c) => { const b = new THREE.Box3(); for (const p of doc.partsOf(c.id)) { const pb = bounds.get(p.id); if (pb) b.union(pb); } return b.expandByScalar(0.05); });
    let floating = 0;
    cboxes.forEach((b, i) => { if (!b.isEmpty() && !cboxes.some((o, j) => j !== i && !o.isEmpty() && b.intersectsBox(o))) floating++; });
    checks.push({ id: "connected", severity: "soft", ok: floating === 0, score: 1 - floating / comps.length, detail: floating ? `${floating} component(s) touch nothing else` : "every component touches another" });
  }

  const critical = checks.filter((c) => c.severity === "critical" && !c.ok);
  const soft = checks.filter((c) => c.severity === "soft");
  const score = critical.length ? 0 : soft.length ? soft.reduce((s, c) => s + (c.score ?? (c.ok ? 1 : 0)), 0) / soft.length : 1;
  return { checks, score: +score.toFixed(3), criticalViolations: critical.map((c) => c.id), violations: checks.filter((c) => !c.ok).map((c) => c.id) };
}
