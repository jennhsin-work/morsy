import { SceneDocument, buildGeometry, toOBJ, PRIMITIVES, MODIFIERS, primitiveDefaults, defaultPart, DEFAULT_PROFILE } from "./scene-model.js";
import { Viewport } from "./viewport.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { transformToMatrix, matrixToTransform, identityTransform } from "./scene-model.js";
import { OptimizerPool } from "./geometry/optimizer-client.js";
import { Orchestrator } from "./agents/orchestrator.js";
import { Policy, computeReward } from "./rl/policy.js";
import { TrajectoryStore, replayEpisode, STEP_LABELS } from "./rl/trajectory.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const logEl = $("#log");
const log = (msg) => { logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; logEl.scrollTop = logEl.scrollHeight; };
const help = (msg) => { $("#helpline").textContent = msg; };
const cmdResult = (msg, bad = false) => { const el = $("#cmd-result"); el.textContent = msg; el.style.color = bad ? "var(--bad)" : ""; };

// ---- document + persistence ---------------------------------------------------
const doc = new SceneDocument();
const SCENE_KEY = "morsy.scene.v2";
try { const saved = localStorage.getItem(SCENE_KEY) ?? localStorage.getItem("morsy.scene.v1") ?? localStorage.getItem("forge3d.scene.v1"); if (saved) doc.restore(JSON.parse(saved)); } catch {}
let saveTimer;
doc.onChange(() => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(SCENE_KEY, JSON.stringify(doc.snapshot())); } catch (e) { log(`scene not saved: ${e.message}`); } }, 300); });

const policy = new Policy();
const optimizer = new OptimizerPool();
const viewport = new Viewport($("#viewport"), doc, {
  onSelect: (selection, live) => renderSelection(selection, live),
  onStats: ({ components, parts, tris, verts }) => { $("#hud-stats").innerHTML = `Components: ${components}<br>Parts: ${parts}<br>Tris: ${tris.toLocaleString()}<br>Verts: ${verts.toLocaleString()}`; },
  helperEl: $("#view-helper"),
});
const trajectory = new TrajectoryStore();
const orchestrator = new Orchestrator({ doc, policy, optimizer, buildGeometry, log, trajectory, captureViews: () => viewport.captureViews() });

// ---- backend status ------------------------------------------------------------
async function refreshBackendStatus() {
  const ok = await orchestrator.checkBackend();
  const el = $("#backend-status");
  el.textContent = ok ? "● AI" : "○ AI"; el.title = ok ? `AI backend connected (${orchestrator.backendModel})` : "AI backend offline — a simple rule-based modeler fills in";
  el.style.color = ok ? "var(--ok)" : "var(--warn)";
}
refreshBackendStatus();
setInterval(refreshBackendStatus, 10000);

// ---- selection helpers ----------------------------------------------------------
const selection = () => viewport.selection;
const selPart = () => (selection()?.type === "part" ? doc.get(selection().id) : null);
const selComp = () => (selection()?.type === "component" ? doc.getComponent(selection().id) : null);
// Every part covered by the selection set (parts directly, or all parts of selected components).
const selectedParts = () => viewport.selectionSet().flatMap((s) => (s.type === "part" ? [doc.get(s.id)] : doc.partsOf(s.id))).filter(Boolean);
const partWorld = (p) => { const c = doc.getComponent(p.componentId); const m = transformToMatrix(p.transform); return c ? transformToMatrix(c.transform).multiply(m) : m; };

// ---- commands (menus, shelf, toolbox, hotkeys all route here) ------------------
const TOOL_HELP = {
  select: "Select Tool: click a component, click again for its part (↑ back), Shift+click to add, ⌘A all, ⌘G group. Alt+LMB orbit · Alt+MMB pan · wheel zoom · F frame · A frame all",
  translate: "Move Tool: drag the arrows (X red, Y green, Z blue). Moves the whole component or just the part, whichever is selected.",
  rotate: "Rotate Tool: drag a ring to rotate about that axis. Snap gives 15° steps.",
  scale: "Scale Tool: drag an axis cube for non-uniform scale, the center cube for uniform.",
};
const commands = {
  new: () => { if (doc.parts.size && !confirm("Clear the scene?")) return; doc.applyOps([{ op: "clear" }]); cmdResult("New scene"); },
  export: () => {
    const blob = new Blob([toOBJ(doc, viewport.meshes)], { type: "text/plain" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "morsy.obj" }); a.click();
    cmdResult(`Exported 1 object · ${doc.components.size} groups · ${doc.parts.size} parts → morsy.obj`);
  },
  "export-glb": async () => {
    // glTF binary: the de-facto interchange for web/game engines. The scene graph
    // (model → component groups → part meshes) is exported as-is, so component
    // names survive as node names.
    const glb = await new GLTFExporter().parseAsync(viewport.model, { binary: true });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" })), download: "morsy.glb" }); a.click();
    cmdResult(`Exported morsy.glb · ${doc.components.size} nodes · ${(glb.byteLength / 1024).toFixed(0)} KB`);
  },
  "import-image": () => { showDock("agents"); setAiMode("image"); $("#image-input").click(); },
  // Bake each component's transform into its parts (component becomes identity),
  // like Maya's Freeze Transformations on a group.
  freeze: () => {
    const comps = selComp() ? [selComp()] : selPart() ? [doc.componentOf(selPart().id)] : doc.listComponents();
    doc.transaction(() => {
      for (const c of comps) {
        const M = transformToMatrix(c.transform);
        doc.applyOps([
          ...doc.partsOf(c.id).map((p) => ({ op: "update", id: p.id, patch: { transform: matrixToTransform(M.clone().multiply(transformToMatrix(p.transform))) } })),
          { op: "updateComponent", id: c.id, patch: { transform: identityTransform() } },
        ]);
      }
    });
    cmdResult(`Froze transformations on ${comps.length} component(s)`);
  },
  // ⌘G: group the selected parts into a new component; Ungroup: one component per part.
  group: () => {
    const parts = selectedParts(); if (!parts.length) { cmdResult("Select parts to group (Shift+click)", true); return; }
    const comp = { name: `group${doc.components.size + 1}` };
    doc.transaction(() => {
      doc.applyOps([{ op: "addComponent", component: comp }]);
      const id = doc.listComponents().at(-1).id;
      // keep world placement: new component is identity, so part transforms become their world transforms
      doc.applyOps(parts.map((p) => ({ op: "update", id: p.id, patch: { componentId: id, transform: matrixToTransform(partWorld(p)) } })));
      viewport.select({ type: "component", id });
    });
    cmdResult(`Grouped ${parts.length} part(s)`);
  },
  ungroup: () => {
    const c = selComp(); if (!c) { cmdResult("Select a component to ungroup", true); return; }
    doc.transaction(() => {
      for (const p of doc.partsOf(c.id)) {
        doc.applyOps([{ op: "addComponent", component: { name: p.name.replace(/^.*?:\s*/, "") || p.name } }]);
        const id = doc.listComponents().at(-1).id;
        doc.applyOps([{ op: "update", id: p.id, patch: { componentId: id, transform: matrixToTransform(partWorld(p)) } }]);
      }
      viewport.select(null);
    });
    cmdResult(`Ungrouped ${c.name}`);
  },
  undo: () => doc.undo(), redo: () => doc.redo(),
  duplicate: () => {
    const p = selPart(), c = selComp(); if (!p && !c) return;
    if (p) { const copy = JSON.parse(JSON.stringify(p)); delete copy.id; copy.name += "_copy"; copy.transform.position[0] += 0.5; const [id] = doc.applyOps([{ op: "add", part: copy }]); viewport.select({ type: "part", id }); return; }
    const comp = JSON.parse(JSON.stringify(c)); delete comp.id; comp.name += "_copy"; comp.transform.position[0] += 0.5;
    doc.transaction(() => { const [cid] = [doc.applyOps([{ op: "addComponent", component: comp }]), comp.id][1] ? [comp.id] : []; const newId = doc.listComponents().at(-1).id;
      doc.applyOps(doc.partsOf(c.id).map((part) => { const cp = JSON.parse(JSON.stringify(part)); delete cp.id; cp.componentId = newId; return { op: "add", part: cp }; }));
      viewport.select({ type: "component", id: newId }); });
  },
  delete: () => { const set = viewport.selectionSet(); if (!set.length) return; doc.applyOps(set.map((s) => (s.type === "part" ? { op: "remove", id: s.id } : { op: "removeComponent", id: s.id }))); cmdResult(`Deleted ${set.length} item(s)`); },
  "select-parent": () => viewport.selectParent(),
  "select-all": () => { viewport.selectAll(viewport.selection?.type ?? (viewport.selectMode === "part" ? "part" : "component")); cmdResult(`Selected ${viewport.selectionSet().length} item(s) — Shift+click to add or remove`); },
  "center-pivot": () => { const o = viewport.selectedObject(); const s = selection(); if (!o) return; const box = new (Object.getPrototypeOf(viewport.selBox.box).constructor)().setFromObject(o, true); const dy = -box.min.y; const t = (s.type === "part" ? selPart() : selComp()).transform; const transform = { position: [t.position[0], t.position[1] + dy, t.position[2]] }; doc.applyOps([s.type === "part" ? { op: "update", id: s.id, patch: { transform } } : { op: "updateComponent", id: s.id, patch: { transform } }]); },
  "optimize-sel": async () => {
    const parts = selPart() ? [selPart()] : selComp() ? doc.partsOf(selComp().id) : []; if (!parts.length) return;
    showDock("agents"); const reports = [];
    await doc.transaction(() => Promise.all(parts.map(async (p) => { const r = await orchestrator.optimizePart(p, {}); if (r) { reports.push(r.report); doc.applyOps([{ op: "update", id: p.id, patch: { optimized: r.payload } }]); } })));
    renderReport(reports);
  },
  optimize: async () => { showDock("agents"); const reports = await orchestrator.optimizeAll("standard"); renderReport(reports); },
  "shade-wire": () => setShading("wire"), "shade-smooth": () => setShading("smooth"), "shade-uv": () => setShading("uv"),
  "toggle-grid": () => { const on = viewport.toggleGrid(); $$('[data-cmd="toggle-grid"]').forEach((b) => b.classList.toggle("active", on)); },
  "frame-all": () => viewport.frameAll(), "frame-sel": () => viewport.frameSelected(),
  "dock-channel": () => showDock("channel"), "dock-attr": () => showDock("attr"), "dock-agents": () => showDock("agents"),
  "dock-dev": () => { $('#right-dock [data-dock="dev"]').classList.remove("hidden"); showDock("dev"); },
  help: () => alert(`Morsy hotkeys\n\nQ W E R  select / move / rotate / scale\n4 5 6     wireframe / shaded / UV stress\nF / A     frame selected / all\n↑         select parent component\nG         toggle grid\nX         snap toggle\n⌘Z ⇧⌘Z   undo / redo\n⌘D        duplicate\n⌫         delete\nEnter     focus the command line\n\nClick: select component · click again / double-click: select part\nAlt+LMB orbit · Alt+MMB pan · Alt+RMB / wheel zoom · Space: persp view`),
};
function runCmd(name) { commands[name]?.(); }
document.addEventListener("click", (e) => { const b = e.target.closest("[data-cmd]"); if (b) { runCmd(b.dataset.cmd); closeMenus(); } });

// menus
function closeMenus() { $$(".menu.open").forEach((m) => m.classList.remove("open")); }
for (const m of $$(".menu")) {
  m.querySelector(":scope > button").onclick = (e) => { e.stopPropagation(); const open = m.classList.contains("open"); closeMenus(); if (!open) m.classList.add("open"); };
  m.onmouseenter = () => { if ($(".menu.open") && !m.classList.contains("open")) { closeMenus(); m.classList.add("open"); } };
}
document.addEventListener("click", closeMenus);

// Create menu + shelf
const PRIM_LABEL = { box: "Cube", cylinder: "Cylinder", sphere: "Sphere", cone: "Cone", torus: "Torus", plane: "Plane", capsule: "Capsule", lathe: "Lathe", extrude: "Extrude" };
const PRIM_ICON = {
  box: `<svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4-8 4z"/><path d="M4 8v8l8 4 8-4V8"/><path d="M12 12v8"/></svg>`,
  cylinder: `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/></svg>`,
  sphere: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/><ellipse cx="12" cy="12" rx="3" ry="8"/></svg>`,
  cone: `<svg viewBox="0 0 24 24"><path d="M12 3l7 15H5z"/><ellipse cx="12" cy="18" rx="7" ry="2.5"/></svg>`,
  torus: `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="9" ry="5"/><ellipse cx="12" cy="12" rx="3.5" ry="1.8"/></svg>`,
  plane: `<svg viewBox="0 0 24 24"><path d="M3 16l6-8h12l-6 8z"/><path d="M6 12h12M9 10l-1.5 2M15 10l1.5 2"/></svg>`,
  capsule: `<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="5"/></svg>`,
  lathe: `<svg viewBox="0 0 24 24"><path d="M9 3c4 0 6 2 6 5s-3 4-3 7 3 3 3 6H9c0-3 3-3 3-6S9 11 9 8s2-5 0-5z"/><path d="M12 3v18" stroke-dasharray="2 2"/></svg>`,
  extrude: `<svg viewBox="0 0 24 24"><path d="M4 16l4-4h8l-4 4z"/><path d="M4 16v4l4-4M16 12v4l-4 4v-4M8 12V8h8v4"/></svg>`,
};
const createMenu = $("#create-menu");
for (const t of PRIMITIVES) { const b = document.createElement("button"); b.textContent = `Polygon ${PRIM_LABEL[t]}`; b.onclick = () => createPrimitive(t); createMenu.appendChild(b); }
function createPrimitive(type) {
  const name = `${PRIM_LABEL[type].toLowerCase()}${doc.parts.size + 1}`;
  const part = defaultPart({ name, primitive: { type, params: primitiveDefaults(type), ...(DEFAULT_PROFILE[type] ? { profile: DEFAULT_PROFILE[type] } : {}) } });
  const g = buildGeometry(part); g.computeBoundingBox(); part.transform.position = [0, -g.boundingBox.min.y, 0]; g.dispose();
  // New loose primitives go into the selected component if there is one, else their own.
  const c = selComp() ?? (selPart() && doc.componentOf(selPart().id));
  if (c) part.componentId = c.id; else part.name = name; // ensureComponentFor() groups it by name
  const [id] = doc.applyOps([{ op: "add", part }]); viewport.select({ type: "part", id }); setTool("translate");
  cmdResult(`Created ${part.name}`);
}
const SHELVES = {
  polygons: () => [...PRIMITIVES.map((t) => ({ icon: PRIM_ICON[t], title: `Polygon ${PRIM_LABEL[t]}`, run: () => createPrimitive(t) })), { sep: true },
    { label: "Optimize", title: "Run the geometry optimizer on the scene", run: () => runCmd("optimize") },
    { label: "Export GLB", title: "Export glTF binary (components become nodes)", run: () => runCmd("export-glb") },
    { label: "OBJ", title: "Export OBJ (one object, a group per component)", run: () => runCmd("export") }],
  deform: () => MODIFIERS.map((m) => ({ label: m, title: `Add ${m} modifier to the selected part`, run: () => addModifier(m) })),
  ai: () => [
    { label: "✦ Text to 3D", title: "Create an object from a text prompt", run: () => { showDock("agents"); setAiMode("create"); $("#prompt").focus(); } },
    { label: "✦ Image to 3D", title: "Create an object from a reference image", run: () => { showDock("agents"); setAiMode("image"); $("#image-input").click(); } },
    { label: "✎ Edit", title: "Change the current model from a text prompt", run: () => { showDock("agents"); setAiMode("edit"); $("#prompt").focus(); } },
  ],
};
const MOD_DEFAULT = { taper: { factor: 0.5 }, twist: { angle: 45 }, bend: { angle: 30 }, noise: { amplitude: 0.05, frequency: 3 }, mirror: { axis: "x" }, array: { count: 3, offset: [1.2, 0, 0] }, subdivide: { levels: 1 } };
function addModifier(type) { const p = selPart(); if (!p) { cmdResult("Select a part first (click a component, then click again to pick the part)", true); return; } doc.applyOps([{ op: "update", id: p.id, patch: { modifiers: [...p.modifiers, { type, ...MOD_DEFAULT[type] }], optimized: null } }]); showDock("attr"); }
function renderShelf(name) {
  $$(".shelf-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.shelf === name));
  const row = $("#shelf-row"); row.innerHTML = "";
  for (const item of SHELVES[name]()) {
    if (item.sep) { const s = document.createElement("span"); s.className = "sep"; row.appendChild(s); continue; }
    const b = document.createElement("button"); b.title = item.title; if (item.icon) b.innerHTML = item.icon; else { b.textContent = item.label; b.className = "wide"; }
    b.onclick = item.run; b.onmouseenter = () => help(item.title); row.appendChild(b);
  }
}
$$(".shelf-tabs button").forEach((b) => (b.onclick = () => renderShelf(b.dataset.shelf)));
renderShelf("polygons");

// toolbox + layout + selection mode
function setTool(t) { $$("#toolbox [data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t)); viewport.setTool(t); help(TOOL_HELP[t]); }
$$("#toolbox [data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$$("#toolbox [data-layout]").forEach((b) => (b.onclick = () => { $$("#toolbox [data-layout]").forEach((x) => x.classList.toggle("active", x === b)); $("#app").classList.toggle("layout-single", b.dataset.layout === "single"); }));
$("#snap-grid").onchange = (e) => viewport.setSnap(e.target.checked);
$("#select-mode").onchange = (e) => { viewport.setSelectMode(e.target.value); help(e.target.value === "component" ? "Component mode: a click selects the whole component (the boat, an oar). Click again to drill into a part." : "Part mode: a click selects the individual part under the cursor."); };
function setShading(mode) { viewport.setShading(mode); $$(".panel-icons [data-cmd^='shade-']").forEach((b) => b.classList.toggle("active", b.dataset.cmd === `shade-${mode}`)); }
$("#mode-select").onchange = (e) => { if (e.target.value === "AI") $("#prompt").focus(); else showDock("channel"); };

// editing dock tabs (Channel Box / Attribute Editor / Developer). The AI panel has
// its own dock and is always visible, so "agents" just scrolls it into view.
function showDock(name) {
  if (name === "agents") { $("#ai-dock").scrollIntoView({ block: "nearest" }); return; }
  $$("#right-dock .dock-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.dock === name));
  $$("#right-dock [data-dock-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.dockPanel !== name));
}
$$("#right-dock .dock-tabs button").forEach((b) => (b.onclick = () => showDock(b.dataset.dock)));

// hotkeys
window.addEventListener("keydown", (e) => {
  if (e.target?.matches?.("input, textarea, select")) { if (e.key === "Escape") e.target.blur(); return; }
  const k = e.key.toLowerCase(); const mod = e.metaKey || e.ctrlKey;
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? doc.redo() : doc.undo(); }
  else if (mod && k === "d") { e.preventDefault(); runCmd("duplicate"); }
  else if (mod && k === "a") { e.preventDefault(); runCmd("select-all"); }
  else if (mod && k === "g") { e.preventDefault(); runCmd(e.shiftKey ? "ungroup" : "group"); }
  else if (mod && k === "n") { e.preventDefault(); runCmd("new"); }
  else if (k === "q") setTool("select"); else if (k === "w") setTool("translate"); else if (k === "e") setTool("rotate"); else if (k === "r") setTool("scale");
  else if (k === "4") setShading("wire"); else if (k === "5") setShading("smooth"); else if (k === "6") setShading("uv");
  else if (k === "f") viewport.frameSelected(); else if (k === "a") viewport.frameAll();
  else if (k === "g") runCmd("toggle-grid");
  else if (k === "x") { const c = $("#snap-grid"); c.checked = !c.checked; viewport.setSnap(c.checked); }
  else if (k === "arrowup") { e.preventDefault(); viewport.selectParent(); }
  else if (k === " ") { e.preventDefault(); viewport.setView("persp"); }
  else if (k === "delete" || k === "backspace") runCmd("delete");
  else if (k === "enter") $("#cmd-input").focus();
  else if (k === "escape") viewport.select(null);
});

// ---- outliner (hierarchy) ----------------------------------------------------------
let outlinerFilter = "";
const collapsed = new Set();
$("#outliner-filter").oninput = (e) => { outlinerFilter = e.target.value.toLowerCase(); renderOutliner(); };
doc.onChange(() => { renderOutliner(); renderSelection(viewport.selection); });
function renderOutliner() {
  const ul = $("#outliner-list"); ul.innerHTML = "";
  const s = viewport.selection;
  for (const c of doc.listComponents()) {
    const parts = doc.partsOf(c.id).filter((p) => !outlinerFilter || p.name.toLowerCase().includes(outlinerFilter) || c.name.toLowerCase().includes(outlinerFilter));
    if (outlinerFilter && !parts.length && !c.name.toLowerCase().includes(outlinerFilter)) continue;
    const isCol = collapsed.has(c.id);
    const set = viewport.selectionSet();
    const li = document.createElement("li"); li.className = "group" + (set.some((x) => x.type === "component" && x.id === c.id) ? " selected" : "");
    li.innerHTML = `<span class="vis arrow">${isCol ? "▸" : "▾"}</span><span class="node-ico comp"></span><span>${esc(c.name)}</span><span class="tri">${parts.length}</span>`;
    li.title = c.meta?.agent ? `component · modeled by ${c.meta.agent}` : "component";
    li.querySelector(".arrow").onclick = (e) => { e.stopPropagation(); isCol ? collapsed.delete(c.id) : collapsed.add(c.id); renderOutliner(); };
    li.onclick = (e) => viewport.select({ type: "component", id: c.id }, { add: e.shiftKey || e.metaKey });
    li.ondblclick = () => { viewport.select({ type: "component", id: c.id }); viewport.frameSelected(); };
    ul.appendChild(li);
    if (isCol) continue;
    for (const p of parts) {
      const row = document.createElement("li"); row.className = "child" + (set.some((x) => x.type === "part" && x.id === p.id) ? " selected" : "");
      const label = p.name.startsWith(c.name + ":") ? p.name.slice(c.name.length + 1).trim() : p.name;
      const tris = p.optimized ? p.optimized.indices.length / 3 : "…";
      row.innerHTML = `<span class="vis" title="Toggle visibility">${p.visible === false ? "○" : "●"}</span><span class="node-ico"></span><span>${esc(label)}</span><span class="tri">${tris}△</span>`;
      row.title = `${p.primitive.type}${p.modifiers.length ? " + " + p.modifiers.map((m) => m.type).join(", ") : ""}`;
      row.querySelector(".vis").onclick = (e) => { e.stopPropagation(); doc.applyOps([{ op: "update", id: p.id, patch: { visible: p.visible === false } }], { record: false }); };
      row.onclick = (e) => viewport.select({ type: "part", id: p.id }, { add: e.shiftKey || e.metaKey });
      row.ondblclick = () => { viewport.select({ type: "part", id: p.id }); viewport.frameSelected(); };
      ul.appendChild(row);
    }
  }
}

// ---- channel box + attribute editor ----------------------------------------------
function renderSelection(s, live = false) {
  if (!live) renderOutliner();
  renderChannelBox(s, live); if (!live) renderAttributeEditor(s);
}
function renderChannelBox(s, live) {
  const el = $("#channel-box");
  const node = s?.type === "part" ? doc.get(s.id) : s?.type === "component" ? doc.getComponent(s.id) : null;
  if (!node) { el.innerHTML = `<em class="muted">Nothing selected</em>`; return; }
  const extra = viewport.extra.length;
  const obj = viewport.selectedObject();
  const t = live && obj ? { position: obj.position.toArray(), rotation: obj.rotation.toArray().slice(0, 3).map((r) => (r * 180) / Math.PI), scale: obj.scale.toArray() } : node.transform;
  const row = (label, cls, path, v, step = 0.01) => `<div class="cb-row"><label class="${cls}">${label}</label><input type="number" step="${step}" data-path="${path}" value="${+(+v).toFixed(3)}"></div>`;
  const xyz = (name, key, arr) => ["X", "Y", "Z"].map((ax, i) => row(`${name} ${ax}`, ax.toLowerCase(), `transform.${key}.${i}`, arr[i], key === "rotation" ? 1 : 0.01)).join("");
  let html = `<div class="cb-name">${esc(node.name)} <span class="muted">(${s.type}${extra ? ` +${extra} more` : ""})</span></div>${xyz("Translate", "position", t.position)}${xyz("Rotate", "rotation", t.rotation)}${xyz("Scale", "scale", t.scale)}
    <div class="cb-row"><label>Visibility</label><input type="number" step="1" min="0" max="1" data-path="visible" value="${node.visible === false ? 0 : 1}"></div>`;
  if (s.type === "part") {
    const params = Object.keys(primitiveDefaults(node.primitive.type)).map((k) => row(k, "", `primitive.params.${k}`, node.primitive.params[k] ?? 0, /segments/i.test(k) ? 1 : 0.01)).join("");
    html += `<div class="cb-title">INPUTS</div><div class="cb-name">${esc(node.primitive.type)}Shape</div>${params}`;
  } else {
    const parts = doc.partsOf(node.id);
    html += `<div class="cb-title">CHILDREN</div>${parts.map((p) => `<div class="cb-row cb-link" data-part="${p.id}"><label>${esc(p.name.replace(node.name + ":", "").trim())}</label><span class="muted">${p.primitive.type}</span></div>`).join("")}`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".cb-link").forEach((r) => (r.onclick = () => viewport.select({ type: "part", id: r.dataset.part })));
  bindInputs(el, s, node);
}
function renderAttributeEditor(s) {
  const el = $("#properties");
  if (!s) { el.innerHTML = `<em class="muted">Nothing selected</em>`; return; }
  if (s.type === "component") {
    const c = doc.getComponent(s.id); if (!c) return;
    el.innerHTML = `<div class="section">${esc(c.name)} <span class="muted">component</span></div>
      <label>name<input data-path="name" value="${esc(c.name)}"></label>
      <label>role<span class="muted">${esc(c.meta?.role || "–")}</span></label>
      <label>modeled by<span>${esc(c.meta?.agent ?? "you")}</span></label>
      <label>parts<span>${doc.partsOf(c.id).length}</span></label>
      <div class="row"><button data-cmd="optimize-sel">Re-optimize</button><button data-cmd="duplicate">Duplicate</button><button data-cmd="delete">Delete</button></div>`;
    bindInputs(el, s, c); return;
  }
  const p = doc.get(s.id); if (!p) return;
  const hasProfile = p.primitive.type === "lathe" || p.primitive.type === "extrude";
  el.innerHTML = `
    <div class="section">${esc(p.name)} <span class="muted">part of ${esc(doc.componentOf(p.id)?.name ?? "")}</span></div>
    <label>name<input data-path="name" value="${esc(p.name)}"></label>
    <label>type<select data-path="primitive.type">${PRIMITIVES.map((t) => `<option ${t === p.primitive.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    ${hasProfile ? `<label>profile<input data-path="primitive.profile" value='${esc(JSON.stringify(p.primitive.profile ?? DEFAULT_PROFILE[p.primitive.type]))}' title="${p.primitive.type === "lathe" ? "[[radius, height], …] revolved around Y" : "[[x, y], …] outline, extruded along Z"}"></label>` : ""}
    <div class="section">Material</div>
    <label>color<input type="color" data-path="material.color" value="${p.material.color}"></label>
    <label>roughness<input type="range" min="0" max="1" step="0.05" data-path="material.roughness" value="${p.material.roughness}"></label>
    <label>metalness<input type="range" min="0" max="1" step="0.05" data-path="material.metalness" value="${p.material.metalness}"></label>
    <div class="section">Modifiers</div>
    <label>stack<input data-path="modifiers" value='${esc(JSON.stringify(p.modifiers))}' title="JSON array, e.g. [{&quot;type&quot;:&quot;subdivide&quot;,&quot;levels&quot;:2}]"></label>
    <div class="section">Agent</div>
    <label>modeled by<span>${esc(p.meta?.agent ?? "you")}</span></label>
    <label>strategy<span class="muted">${p.meta?.strategy ? esc(Object.values(p.meta.strategy).join(" · ")) : "–"}</span></label>
    <div class="row"><button data-cmd="optimize-sel">Re-optimize</button><button data-cmd="duplicate">Duplicate</button><button data-cmd="select-parent">↑ Component</button></div>`;
  bindInputs(el, s, p);
}
function bindInputs(el, s, node) {
  for (const input of el.querySelectorAll("[data-path]")) input.onchange = () => {
    const path = input.dataset.path.split(".");
    let val = input.type === "number" || input.type === "range" ? +input.value : input.value;
    if (path[0] === "modifiers" || path[1] === "profile") { try { val = JSON.parse(val); } catch { cmdResult("Expected a JSON array", true); return; } }
    if (path[0] === "visible") val = !!val;
    const patch = {}; let cur = patch;
    for (let i = 0; i < path.length - 1; i++) { cur[path[i]] = /^\d+$/.test(path[i + 1]) ? [...(getPath(node, path.slice(0, i + 1)) ?? [])] : {}; cur = cur[path[i]]; }
    cur[path.at(-1)] = val;
    if (s.type === "component") { doc.applyOps([{ op: "updateComponent", id: s.id, patch }]); return; }
    if (path[0] === "primitive" && path[1] === "type") { patch.primitive.params = primitiveDefaults(val); if (DEFAULT_PROFILE[val] && !node.primitive.profile) patch.primitive.profile = DEFAULT_PROFILE[val]; }
    if (path[0] === "primitive" || path[0] === "modifiers") patch.optimized = null;
    doc.applyOps([{ op: "update", id: s.id, patch }]);
  };
}
const getPath = (o, path) => path.reduce((a, k) => a?.[k], o);

// ---- AI panel ------------------------------------------------------------------------
let image = null, aiMode = "create", styleChoice = "", tessChoice = "";
const PLACEHOLDER = {
  create: "Describe what to create… e.g. 'a low-poly wooden chair with a tall back'",
  image: "Optional: describe the object in the image, or what to emphasise…",
  edit: "Describe the change… e.g. 'make the legs thicker and paint the seat white'",
};
function setAiMode(m) {
  aiMode = m;
  $$(".ai-modes button").forEach((b) => b.classList.toggle("active", b.dataset.aiMode === m));
  $("#image-drop").classList.toggle("hidden", m !== "image");
  $("#prompt").placeholder = PLACEHOLDER[m];
  $("#btn-run").textContent = m === "edit" ? "✦ Apply edit" : "✦ Generate";
  help(m === "edit" ? "Edit: describe a change; only the parts it mentions are touched." : m === "image" ? "Image to 3D: pick a reference image, add a short description, Generate." : "Text to 3D: describe the object, pick a style, Generate. Click any component afterwards to adjust it with the Maya tools.");
}
$$(".ai-modes button").forEach((b) => (b.onclick = () => setAiMode(b.dataset.aiMode)));
const chip = (sel, key, set) => $$(sel + " button").forEach((b) => (b.onclick = () => { set(b.dataset[key]); $$(sel + " button").forEach((x) => x.classList.toggle("active", x === b)); }));
chip("#style-chips", "style", (v) => (styleChoice = v)); chip("#detail-chips", "tess", (v) => (tessChoice = v));
$("#style-chips button").classList.add("active"); $("#detail-chips button").classList.add("active");
$("#image-input").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) { image = null; $("#image-preview").hidden = true; $("#image-name").textContent = "Click to choose a reference image"; return; }
  image = { mediaType: "image/jpeg", data: await resizeImage(f, 1024) };
  const prev = $("#image-preview"); prev.src = `data:image/jpeg;base64,${image.data}`; prev.hidden = false; $("#image-name").textContent = f.name;
  if (aiMode !== "image") setAiMode("image");
};

async function runAgents(prompt, modeOverride = null) {
  // The tab the user picked is authoritative; only the command line guesses ("auto").
  const mode = modeOverride ?? (aiMode === "edit" ? "edit" : "create");
  if (!prompt.trim() && !(aiMode === "image" && image)) return;
  if (aiMode === "image" && !image) { cmdResult("Choose a reference image first", true); return; }
  const text = prompt.trim() || "the object in the reference image";
  showDock("agents"); $("#prompt").value = prompt;
  $("#btn-run").disabled = true; $("#cmd-input").disabled = true;
  $("#ai-progress").classList.remove("hidden"); $("#ai-result").classList.add("hidden"); $("#ai-progress-text").textContent = "Planning…"; $("#ai-progress-bar").style.width = "4%";
  if (mode !== "edit" && aiMode !== "edit") orchestrator.transcript.length = 0; // a new model starts a fresh conversation
  $("#opt-report").innerHTML = "<em>running…</em>"; cmdResult("Generating…");
  try {
    const ep = await orchestrator.run({ prompt: text, image: aiMode === "image" || aiMode === "edit" ? image : null, mode, overrides: { style: styleChoice, tessellation: tessChoice } });
    renderReport(ep.reports); viewport.frameAll(); renderPolicy(ep.context); renderTrajectory();
    const summary = ep.partIds.length ? `${doc.components.size} components · ${doc.parts.size} parts` : "edit applied";
    $("#ai-result-text").textContent = `${summary} · ${(ep.ms / 1000).toFixed(0)} s`;
    $$(".ai-rate button").forEach((b) => b.classList.remove("active"));
    $("#ai-result").classList.remove("hidden"); $("#ai-progress").classList.add("hidden");
    addHistory({ prompt: text, mode: ep.partIds.length ? "create" : "edit", thumb: viewport.thumbnail(), snapshot: doc.snapshot() });
    cmdResult(`${summary} — click a component to adjust it, or rate the result`);
    // Conversational follow-ups: once a model exists, the box becomes "describe a change".
    if (aiMode !== "image") setAiMode("edit"); $("#prompt").value = "";
  } catch (err) { log(`run failed: ${err.message}`); cmdResult(`Failed: ${err.message}`, true); $("#ai-progress").classList.add("hidden"); console.error(err); }
  finally { $("#btn-run").disabled = false; $("#cmd-input").disabled = false; }
}
$("#agent-form").onsubmit = (e) => { e.preventDefault(); runAgents($("#prompt").value); };
$("#cmd-input").onkeydown = (e) => { if (e.key === "Enter") { const v = e.target.value; e.target.value = ""; runAgents(v, "auto"); } };
$("#cmd-input").onfocus = () => help("Command line: describe what to create or change, press Enter.");

orchestrator.onTranscript(renderTranscript);
function renderTranscript(entries) {
  const el = $("#transcript"); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const img = (im, cls = "") => `<img class="${cls}" src="data:${im.mediaType};base64,${im.data}" title="${esc(im.name ?? "reference")}" alt="">`;
  el.innerHTML = entries.map((e) => {
    if (e.role === "user") return `<div class="msg user">${esc(e.text)}${e.images ? `<div class="thumbs">${e.images.map((i) => img(i, "ref")).join("")}</div>` : ""}</div>`;
    if (e.role === "status") return `<div class="msg status"><span>${esc(e.text)}</span></div>`;
    return `<div class="msg agent ${e.kind}"><div>${esc(e.text)}${e.detail ? `<div class="detail">${esc(e.detail)}</div>` : ""}${e.images ? `<div class="thumbs">${e.images.map((i) => img(i)).join("")}</div>` : ""}</div></div>`;
  }).join("");
  el.querySelectorAll(".thumbs img").forEach((i) => (i.onclick = () => window.open(i.src, "_blank")));
  if (atBottom || entries.at(-1)?.role === "user") el.scrollTop = el.scrollHeight;
}
orchestrator.onChange(renderAgents);
function renderAgents(agents) {
  const running = agents.filter((a) => a.state === "running").length, done = agents.filter((a) => a.state !== "running" && a.state !== "queued").length;
  $("#ai-badge").textContent = running ? `${running}` : "";
  const comps = agents.filter((a) => a.name !== "Planner");
  const planner = agents.find((a) => a.name === "Planner");
  $("#ai-progress-text").textContent = planner?.state === "running" ? "Planning the model…" : comps.length ? `Building ${comps.length} components — ${comps.filter((c) => c.state === "done").length} done` : agents[0]?.name === "Editor" ? "Applying edit…" : "Working…";
  const prog = agents.length ? agents.reduce((s, a) => s + a.progress, 0) / agents.length : 0;
  $("#ai-progress-bar").style.width = `${Math.max(4, Math.round(prog * 100))}%`;
  $("#agent-count").textContent = agents.length ? `${done}/${agents.length}` : "";
  $("#agent-list").innerHTML = comps.map((a) => `<li class="${a.state}" title="${esc(a.role)}${a.detail ? " — " + esc(a.detail) : ""}">${esc(a.name)}</li>`).join("");
}

// ---- generation history ------------------------------------------------------------
const history = []; let currentHistory = null;
function addHistory(entry) {
  entry.id = `h_${Date.now().toString(36)}`; entry.t = Date.now();
  history.unshift(entry); if (history.length > 12) history.pop();
  currentHistory = entry.id; renderHistory();
}
function renderHistory() {
  const el = $("#history");
  if (!history.length) { el.innerHTML = `<em class="muted">Generations appear here</em>`; return; }
  el.innerHTML = history.map((h) => `<div class="item ${h.id === currentHistory ? "current" : ""}" data-h="${h.id}" title="${esc(h.prompt)} — click to restore this version"><img src="${h.thumb}" alt=""><div class="cap">${h.mode === "edit" ? "✎ " : ""}${esc(h.prompt)}</div></div>`).join("");
  el.querySelectorAll(".item").forEach((it) => (it.onclick = () => {
    const h = history.find((x) => x.id === it.dataset.h); if (!h) return;
    doc.transaction(() => doc.restore(JSON.parse(JSON.stringify(h.snapshot))));
    currentHistory = h.id; renderHistory(); viewport.frameAll(); cmdResult(`Restored "${h.prompt.slice(0, 50)}" (⌘Z to go back)`);
  }));
}
function renderReport(reports) {
  const el = $("#opt-report");
  if (!reports?.length) { el.innerHTML = "<em>No geometry produced</em>"; return; }
  const sum = (f) => reports.reduce((n, r) => n + f(r), 0);
  const stage = (r, n) => r.stages.find((s) => s.name === n) ?? {};
  const uvB = sum((r) => stage(r, "uv").before ?? 0) / reports.length, uvA = sum((r) => stage(r, "uv").after ?? 0) / reports.length;
  const score = sum((r) => r.score) / reports.length;
  const cls = (v, good, warn) => (v <= good ? "good" : v <= warn ? "warn" : "bad");
  el.innerHTML = `
    <div class="meter"><i style="width:${Math.round(score * 100)}%"></i></div>
    <table>
      <tr><td>quality score</td><td class="${score > 0.75 ? "good" : score > 0.5 ? "warn" : "bad"}">${score.toFixed(2)}</td></tr>
      <tr><td>parts</td><td>${reports.length}</td></tr>
      <tr><td>triangles</td><td>${sum((r) => r.before.triangles)} → ${sum((r) => r.after.triangles)}</td></tr>
      <tr><td>vertices welded</td><td>${sum((r) => stage(r, "weld").merged ?? 0)}</td></tr>
      <tr><td>degenerate/dup faces removed</td><td>${sum((r) => (stage(r, "clean").degenerate ?? 0) + (stage(r, "clean").duplicates ?? 0))}</td></tr>
      <tr><td>faces re-wound</td><td>${sum((r) => stage(r, "orient").flipped ?? 0)}</td></tr>
      <tr><td>non-manifold edges</td><td class="${sum((r) => stage(r, "orient").nonManifoldEdges ?? 0) ? "bad" : "good"}">${sum((r) => stage(r, "orient").nonManifoldEdges ?? 0)}</td></tr>
      <tr><td>flat faces decimated</td><td>${sum((r) => stage(r, "decimate").collapsed ?? 0)}</td></tr>
      <tr><td>feature edges protected</td><td>${sum((r) => stage(r, "decimate").protectedEdges ?? 0)}</td></tr>
      <tr><td>UV distortion (mean)</td><td class="${cls(uvA, 0.15, 0.35)}">${uvB.toFixed(3)} → ${uvA.toFixed(3)}</td></tr>
      <tr><td>UV re-projected</td><td>${sum((r) => (stage(r, "uv").reprojected ? 1 : 0))} part(s)</td></tr>
      <tr><td>time</td><td>${sum((r) => r.ms)} ms</td></tr>
    </table>`;
}

// ---- RL feedback + trajectory annotation -------------------------------------------
// human: 1 success · 0 partial · -1 failure (task-accuracy term of the weighted reward)
function feedback(human) {
  const ep = orchestrator.lastEpisode; if (!ep) { cmdResult("Nothing to rate yet — run the agents first", true); return; }
  const reward = computeReward({ human, geometryScore: ep.geometryScore, constraintScore: ep.constraints.score, criticalViolations: ep.constraints.criticalViolations, efficiency: ep.efficiency });
  ep.reward = reward;
  policy.update(ep.context, ep.choice, reward.total, ep.prompt);
  const label = human > 0 ? "success" : human < 0 ? "failure" : "partial";
  if (ep.trajectoryId) { trajectory.setReward(ep.trajectoryId, reward.total, reward.breakdown); trajectory.labelEpisode(ep.trajectoryId, label); }
  log(`episode ${label} → reward ${reward.total.toFixed(2)} ${JSON.stringify(reward.breakdown)}${reward.failed ? " (critical violation ⇒ 0)" : ""} → policy[${ep.context}] updated`);
  cmdResult(human > 0 ? "Thanks — Morsy will favour this approach for similar objects" : human < 0 ? "Thanks — Morsy will try a different approach next time" : "Noted");
  renderPolicy(ep.context); renderTrajectory();
  $$(".ai-rate button").forEach((b) => b.classList.toggle("active", (b.id === "btn-good") === (human > 0) && human !== 0));
}
$("#btn-good").onclick = () => feedback(1);
$("#btn-bad").onclick = () => feedback(-1);
$("#btn-dev-good").onclick = () => feedback(1);
$("#btn-partial").onclick = () => feedback(0);
$("#btn-dev-bad").onclick = () => feedback(-1);
$("#btn-export-traj").onclick = () => {
  if (!trajectory.episodes.length) { cmdResult("No episodes logged yet", true); return; }
  const blob = new Blob([trajectory.exportJSONL()], { type: "application/x-ndjson" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "morsy-trajectories.jsonl" }); a.click();
  cmdResult(`Exported ${trajectory.episodes.length} episode(s) as JSONL`);
};
$("#btn-replay").onclick = () => {
  const ep = trajectory.last(); if (!ep) { cmdResult("No episode to replay", true); return; }
  const t = performance.now(); const r = replayEpisode(ep, () => new SceneDocument());
  const msg = r.ok ? `Replay verified: ${ep.steps.length} steps re-executed deterministically, all checkpoints match (${Math.round(performance.now() - t)} ms)` : `Replay mismatch at ${r.mismatches.map((m) => `step ${m.step} (${m.at})`).join(", ")}`;
  log(msg); cmdResult(msg, !r.ok);
};
$("#btn-clear-traj").onclick = () => { trajectory.clear(); renderTrajectory(); };

function renderTrajectory() {
  const el = $("#trajectory-view"); const ep = trajectory.last();
  if (!ep) { el.innerHTML = "<em>No episode yet</em>"; return; }
  const live = orchestrator.lastEpisode?.trajectoryId === ep.id ? orchestrator.lastEpisode : null;
  const checks = live?.constraints.checks ?? [];
  const bd = ep.breakdown ?? {};
  const bar = (k, v, w) => `<tr><td>${k}</td><td><span class="muted">${(v / w * 100).toFixed(0)}%</span> ${v.toFixed(2)}</td></tr>`;
  el.innerHTML = `
    <div><b>${esc(ep.id)}</b> · ${ep.mode} · <span class="${ep.label === "success" ? "good" : ep.label === "failure" ? "bad" : ep.label === "partial" ? "warn" : "muted"}">${ep.label}</span> · ${ep.steps.length} steps · ${(ep.ms / 1000).toFixed(1)} s</div>
    <div class="muted" style="margin:2px 0 6px">"${esc(ep.instruction)}"</div>
    <div class="meter"><i style="width:${Math.round((ep.reward ?? 0) * 100)}%"></i></div>
    <table>
      <tr><td><b>reward</b></td><td class="${ep.reward > 0.7 ? "good" : ep.reward > 0.4 ? "warn" : "bad"}"><b>${(ep.reward ?? 0).toFixed(2)}</b>${ep.criticalViolations?.length ? " (critical ⇒ 0)" : ""}</td></tr>
      ${bar("task accuracy", bd.taskAccuracy ?? 0, 0.45)}${bar("constraints", bd.constraints ?? 0, 0.25)}${bar("geometry", bd.geometry ?? 0, 0.2)}${bar("efficiency", bd.efficiency ?? 0, 0.1)}
    </table>
    ${checks.length ? `<div class="cb-title" style="margin:6px -6px 2px">CONSTRAINTS</div><table>${checks.map((c) => `<tr><td class="${c.ok ? "good" : c.severity === "critical" ? "bad" : "warn"}">${c.ok ? "✓" : c.severity === "critical" ? "✗" : "△"} ${c.id}</td><td class="muted" style="text-align:left">${esc(c.detail)}</td></tr>`).join("")}</table>` : ""}
    <div class="cb-title" style="margin:6px -6px 2px">STEPS</div>
    <table>${ep.steps.map((s) => `<tr><td><span class="muted">${s.i}</span> <b>${esc(s.agent)}</b> ${esc(s.intent.slice(0, 48))}${s.error ? ` <span class="bad">✗</span>` : ""}</td>
      <td><select data-step="${s.i}" class="step-label">${STEP_LABELS.map((l) => `<option ${l === s.label ? "selected" : ""}>${l}</option>`).join("")}</select></td></tr>`).join("")}</table>`;
  el.querySelectorAll(".step-label").forEach((sel) => (sel.onchange = () => trajectory.labelStep(ep.id, +sel.dataset.step, sel.value)));
}
$("#btn-reset-policy").onclick = () => { policy.reset(); renderPolicy(orchestrator.lastEpisode?.context ?? "generic:mid"); log("policy reset"); };
function renderPolicy(context) {
  const rows = policy.summary(context);
  $("#policy-view").innerHTML = `<div class="muted">context <b>${esc(context)}</b> · ${policy.history.length} episodes</div><table>${rows.map(({ decision, rows }) =>
    `<tr><td>${decision}</td><td>${rows.map((r, i) => `<span class="${i === 0 ? "good" : "muted"}" title="${r.n} trials">${r.arm} ${(r.mean * 100).toFixed(0)}%</span>`).join(" · ")}</td></tr>`).join("")}</table>`;
}

async function resizeImage(file, max) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

// ---- boot -------------------------------------------------------------------------
renderPolicy("generic:mid");
renderTrajectory();
renderOutliner();
setTool("select");
setAiMode("create");
showDock("channel");
if (doc.parts.size) { viewport.frameAll(); log(`restored ${doc.components.size} component(s), ${doc.parts.size} part(s) from the last session`); }
log("Morsy ready. Type a request in the command line below, or pick a primitive from the shelf.");
