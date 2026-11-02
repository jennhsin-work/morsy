// Offline fallback used when the Claude backend is unreachable. It's a
// deliberately small rule-based modeler: it recognises a few object families
// and emits the same Plan / ComponentResult shapes the LLM agents do, so the
// orchestrator, optimizer and RL loop all run end-to-end without a key.

const PALETTE = { wood: "#8b5a2b", metal: "#9aa4b5", fabric: "#4a6fa5", dark: "#2f3340", accent: "#d9534f", light: "#e8e3d9" };

const seg = (t) => ({ low: 10, medium: 20, high: 36 }[t] ?? 20);

export function localPlan(prompt, hints) {
  const p = prompt.toLowerCase();
  const fam =
    /\b(chair|stool|bench)\b/.test(p) ? "chair"
    : /\b(table|desk)\b/.test(p) ? "table"
    : /\b(mug|cup)\b/.test(p) ? "mug"
    : /\b(lamp)\b/.test(p) ? "lamp"
    : /\b(house|hut|cabin)\b/.test(p) ? "house"
    : /\b(rocket)\b/.test(p) ? "rocket"
    : /\b(robot|character|person)\b/.test(p) ? "robot"
    : "generic";
  const comps = FAMILIES[fam](p, hints);
  return { summary: `${fam} (offline planner)`, overallHeight: comps.reduce((h, c) => Math.max(h, c.region.center[1] + c.region.size[1] / 2), 0), components: comps, family: fam };
}

export function localComponent(component, plan, hints) {
  const build = BUILDERS[plan.family]?.[component.name] ?? genericBuilder;
  return { reasoning: `offline: ${component.notes}`, parts: build(component, hints) };
}

export function localEdit(prompt, scene) {
  // Tiny verb grammar: "<make|scale> <name-ish> <bigger|smaller|taller|wider|thicker|red...>", "remove <name>", "color <name> <hex|name>".
  const p = prompt.toLowerCase(); const ops = [];
  const matches = scene.filter((s) => p.includes(s.name.toLowerCase().split(":")[0].trim()) || s.name.toLowerCase().split(/\W+/).some((w) => w.length > 2 && p.includes(w)));
  const targets = matches.length ? matches : scene;
  const f = /\b(much|way)\b/.test(p) ? 1.6 : 1.25;
  for (const s of targets) {
    const sc = [...s.transform.scale]; const patch = {};
    if (/\b(bigger|larger)\b/.test(p)) patch.transform = { scale: sc.map((v) => v * f) };
    else if (/\b(smaller)\b/.test(p)) patch.transform = { scale: sc.map((v) => v / f) };
    else if (/\b(taller|higher)\b/.test(p)) patch.transform = { scale: [sc[0], sc[1] * f, sc[2]] };
    else if (/\b(shorter|lower)\b/.test(p)) patch.transform = { scale: [sc[0], sc[1] / f, sc[2]] };
    else if (/\b(wider|thicker|fatter)\b/.test(p)) patch.transform = { scale: [sc[0] * f, sc[1], sc[2] * f] };
    else if (/\b(thinner|narrower|slimmer)\b/.test(p)) patch.transform = { scale: [sc[0] / f, sc[1], sc[2] / f] };
    const col = p.match(/\b(red|green|blue|yellow|white|black|orange|purple|brown|grey|gray|#[0-9a-f]{6})\b/);
    if (col) patch.material = { color: COLORS[col[1]] ?? col[1] };
    if (/\b(remove|delete)\b/.test(p) && matches.length) { ops.push({ op: "remove", id: s.id }); continue; }
    if (Object.keys(patch).length) ops.push({ op: "update", id: s.id, patch });
  }
  return { reasoning: `offline edit on ${targets.length} part(s)`, ops };
}

const COLORS = { red: "#d9534f", green: "#4fa36b", blue: "#4a6fa5", yellow: "#e2c044", white: "#f1f1f1", black: "#1e1e1e", orange: "#e0813d", purple: "#8a5fc1", brown: "#8b5a2b", grey: "#8c8c8c", gray: "#8c8c8c" };

const C = (name, role, center, size, notes) => ({ name, role, region: { center, size }, notes });

const FAMILIES = {
  chair: () => [
    C("seat", "seat", [0, 0.45, 0], [0.5, 0.06, 0.5], "flat slab"),
    C("back", "backrest", [0, 0.8, -0.22], [0.5, 0.6, 0.06], "upright slab or slats"),
    C("legs", "four legs", [0, 0.21, 0], [0.5, 0.42, 0.5], "four posts at corners"),
  ],
  table: () => [
    C("top", "table top", [0, 0.74, 0], [1.4, 0.05, 0.8], "slab"),
    C("legs", "four legs", [0, 0.36, 0], [1.3, 0.72, 0.7], "four posts"),
  ],
  mug: () => [
    C("body", "mug body", [0, 0.05, 0], [0.09, 0.1, 0.09], "open cylinder"),
    C("handle", "handle", [0.06, 0.05, 0], [0.04, 0.07, 0.02], "torus half"),
  ],
  lamp: () => [
    C("base", "base", [0, 0.015, 0], [0.24, 0.03, 0.24], "flat disc"),
    C("stem", "stem", [0, 0.25, 0], [0.03, 0.44, 0.03], "thin pole"),
    C("shade", "shade", [0, 0.56, 0], [0.3, 0.2, 0.3], "truncated cone"),
  ],
  house: () => [
    C("walls", "walls", [0, 1.25, 0], [4, 2.5, 3], "box"),
    C("roof", "roof", [0, 3.2, 0], [4.4, 1.4, 3.4], "pitched roof"),
    C("door", "door", [0, 0.9, 1.52], [0.8, 1.8, 0.06], "slab"),
    C("chimney", "chimney", [1.2, 3.6, 0.6], [0.4, 1.0, 0.4], "box"),
  ],
  rocket: () => [
    C("body", "fuselage", [0, 1.5, 0], [0.6, 2.4, 0.6], "cylinder"),
    C("nose", "nose cone", [0, 3.1, 0], [0.6, 0.8, 0.6], "cone"),
    C("fins", "fins", [0, 0.5, 0], [1.4, 0.8, 1.4], "four tapered fins"),
  ],
  robot: () => [
    C("torso", "torso", [0, 1.1, 0], [0.5, 0.6, 0.3], "box"),
    C("head", "head", [0, 1.6, 0], [0.3, 0.3, 0.3], "box/sphere"),
    C("arms", "arms", [0, 1.1, 0], [1.0, 0.6, 0.2], "two capsules"),
    C("legs", "legs", [0, 0.4, 0], [0.4, 0.8, 0.25], "two capsules"),
  ],
  generic: () => [
    C("core", "main mass", [0, 0.5, 0], [1, 1, 1], "primitive matching the request"),
    C("detail", "secondary detail", [0, 1.1, 0], [0.6, 0.3, 0.6], "smaller primitive on top"),
  ],
};

const part = (name, type, params, position, extra = {}) => ({
  name, primitive: { type, params }, transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1], ...(extra.transform ?? {}) },
  material: { color: PALETTE.wood, roughness: 0.7, metalness: 0.05, ...(extra.material ?? {}) }, modifiers: extra.modifiers ?? [],
});

function fourPosts(name, cx, cz, dx, dz, y, h, r, s, color) {
  return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) =>
    part(`${name}: post ${i + 1}`, "cylinder", { radiusTop: r, radiusBottom: r * 0.9, height: h, radialSegments: s, heightSegments: 1 }, [cx + sx * dx, y, cz + sz * dz], { material: { color } }));
}

const BUILDERS = {
  chair: {
    seat: (c, h) => [part("seat: slab", "box", { width: 0.5, height: 0.06, depth: 0.5, segments: 1 }, c.region.center, { material: { color: PALETTE.fabric, roughness: 0.9 } })],
    back: (c, h) => h.style === "detailed"
      ? [part("back: frame", "box", { width: 0.5, height: 0.6, depth: 0.04, segments: 1 }, c.region.center), ...[-0.15, 0, 0.15].map((x, i) => part(`back: slat ${i + 1}`, "box", { width: 0.08, height: 0.5, depth: 0.05, segments: 1 }, [x, 0.8, -0.2]))]
      : [part("back: slab", "box", { width: 0.5, height: 0.6, depth: 0.05, segments: 1 }, c.region.center, { modifiers: h.style === "smooth" ? [{ type: "bend", angle: 12 }] : [] })],
    legs: (c, h) => fourPosts("legs", 0, 0, 0.21, 0.21, 0.21, 0.42, 0.025, seg(h.tessellation), PALETTE.wood),
  },
  table: {
    top: (c) => [part("top: slab", "box", { width: 1.4, height: 0.05, depth: 0.8, segments: 1 }, c.region.center)],
    legs: (c, h) => fourPosts("legs", 0, 0, 0.6, 0.32, 0.36, 0.72, 0.035, seg(h.tessellation), PALETTE.dark),
  },
  mug: {
    body: (c, h) => [part("body: wall", "cylinder", { radiusTop: 0.045, radiusBottom: 0.04, height: 0.1, radialSegments: seg(h.tessellation), heightSegments: 1 }, c.region.center, { material: { color: PALETTE.light, roughness: 0.4 } })],
    handle: (c, h) => [part("handle: ring", "torus", { radius: 0.03, tube: 0.007, radialSegments: 8, tubularSegments: seg(h.tessellation) }, [0.05, 0.05, 0], { material: { color: PALETTE.light, roughness: 0.4 } })],
  },
  lamp: {
    base: (c, h) => [part("base: disc", "cylinder", { radiusTop: 0.12, radiusBottom: 0.12, height: 0.03, radialSegments: seg(h.tessellation), heightSegments: 1 }, c.region.center, { material: { color: PALETTE.metal, metalness: 0.6, roughness: 0.3 } })],
    stem: (c, h) => [part("stem: pole", "cylinder", { radiusTop: 0.012, radiusBottom: 0.015, height: 0.44, radialSegments: 12, heightSegments: 1 }, c.region.center, { material: { color: PALETTE.metal, metalness: 0.6, roughness: 0.3 } })],
    shade: (c, h) => [part("shade: cone", "cylinder", { radiusTop: 0.08, radiusBottom: 0.15, height: 0.2, radialSegments: seg(h.tessellation), heightSegments: 1 }, c.region.center, { material: { color: PALETTE.light, roughness: 0.9 } })],
  },
  house: {
    walls: (c) => [part("walls: box", "box", { width: 4, height: 2.5, depth: 3, segments: 1 }, c.region.center, { material: { color: PALETTE.light } })],
    roof: (c) => [part("roof: prism", "cylinder", { radiusTop: 0.001, radiusBottom: 2.4, height: 3.4, radialSegments: 4, heightSegments: 1 }, [0, 2.5, 0], { transform: { rotation: [90, 0, 0], scale: [1, 1, 0.6] }, material: { color: PALETTE.accent } })],
    door: (c) => [part("door: slab", "box", { width: 0.8, height: 1.8, depth: 0.06, segments: 1 }, c.region.center, { material: { color: PALETTE.wood } })],
    chimney: (c) => [part("chimney: box", "box", { width: 0.4, height: 1.0, depth: 0.4, segments: 1 }, c.region.center, { material: { color: PALETTE.dark } })],
  },
  rocket: {
    body: (c, h) => [part("body: tube", "cylinder", { radiusTop: 0.3, radiusBottom: 0.3, height: 2.4, radialSegments: seg(h.tessellation), heightSegments: 2 }, c.region.center, { material: { color: PALETTE.light, metalness: 0.3, roughness: 0.35 } })],
    nose: (c, h) => [part("nose: cone", "cone", { radius: 0.3, height: 0.8, radialSegments: seg(h.tessellation) }, c.region.center, { material: { color: PALETTE.accent } })],
    fins: (c) => [0, 90, 180, 270].map((a, i) => part(`fins: fin ${i + 1}`, "box", { width: 0.5, height: 0.8, depth: 0.04, segments: 2 }, [Math.cos((a * Math.PI) / 180) * 0.5, 0.5, Math.sin((a * Math.PI) / 180) * 0.5], { transform: { rotation: [0, -a, 0] }, modifiers: [{ type: "taper", factor: 0.3 }], material: { color: PALETTE.accent } })),
  },
  robot: {
    torso: (c) => [part("torso: box", "box", { width: 0.5, height: 0.6, depth: 0.3, segments: 1 }, c.region.center, { material: { color: PALETTE.metal, metalness: 0.7, roughness: 0.3 } })],
    head: (c, h) => [part("head: cube", "box", { width: 0.3, height: 0.3, depth: 0.3, segments: 1 }, c.region.center, { material: { color: PALETTE.metal, metalness: 0.7, roughness: 0.3 } }), part("head: eye", "sphere", { radius: 0.05, widthSegments: seg(h.tessellation), heightSegments: seg(h.tessellation) / 2 }, [0, 1.62, 0.15], { material: { color: PALETTE.accent, roughness: 0.2 } })],
    arms: (c, h) => [-1, 1].map((s) => part(`arms: ${s < 0 ? "left" : "right"}`, "capsule", { radius: 0.07, length: 0.45, capSegments: 4, radialSegments: seg(h.tessellation) }, [s * 0.36, 1.1, 0], { material: { color: PALETTE.dark } })),
    legs: (c, h) => [-1, 1].map((s) => part(`legs: ${s < 0 ? "left" : "right"}`, "capsule", { radius: 0.09, length: 0.6, capSegments: 4, radialSegments: seg(h.tessellation) }, [s * 0.14, 0.4, 0], { material: { color: PALETTE.dark } })),
  },
};

function genericBuilder(c, h) {
  const { center, size } = c.region; const s = seg(h.tessellation);
  const type = h.style === "smooth" ? "sphere" : h.style === "blocky" ? "box" : "cylinder";
  const params = type === "sphere" ? { radius: Math.min(...size) / 2, widthSegments: s, heightSegments: s / 2 }
    : type === "box" ? { width: size[0], height: size[1], depth: size[2], segments: 1 }
    : { radiusTop: size[0] / 2, radiusBottom: size[0] / 2, height: size[1], radialSegments: s, heightSegments: 1 };
  return [part(`${c.name}: ${type}`, type, params, center, { material: { color: PALETTE.metal } })];
}
