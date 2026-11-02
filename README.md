# Morsy

**One model system. Two ways to create.** Maya-style tools when you want to be hands-on; a conversational AI when you want to describe. Both surfaces write the same document ops, so anything the agents build you can grab with the gizmo, and anything you move the agents see on their next pass.

An AI-native 3D modeling workspace with a Maya-style interface. Agents create and edit parametric models from text or image references, work on components in parallel, and hand every mesh to a geometry optimization engine. Every run is logged as an RL trajectory with a weighted reward (task accuracy · constraint preservation · geometry quality · efficiency), annotated by the user, replayable, and exportable as JSONL.

```
┌─ browser (Vite + three.js) ────────────────────────────────────────────────┐
│ Maya-style UI: menu bar · shelf · toolbox · outliner · viewport · channel   │
│ box / attribute editor / AI agents dock · command line · help line         │
│                                                                             │
│  Document = assembly hierarchy                                              │
│    Model → Component {transform} → Part {primitive, modifiers, transform}  │
│    world(part) = M_component · M_part · (modifier stack ∘ primitive)        │
│                                                                             │
│  prompt/image → Orchestrator                                                │
│      │  RL Policy (Thompson-sampling bandit) picks strategy                 │
│      ├─ Planner agent         → component plan (regions, roles)            │
│      ├─ Component agent ×N    → parts; each component is COMMITTED the     │
│      │     │                    moment its agent finishes (progressive)     │
│      │     └─ OptimizerPool   → Web Workers: weld / clean / orient /        │
│      │                          feature-preserving decimate / UV / normals; │
│      │                          optimized mesh swaps in per part            │
│      └─ Editor agent          → targeted ops on parts OR components        │
│  whole run = ONE undo transaction                                           │
│                                                                             │
│  Trajectory: step{intent, ops, before/after digest, result, error}          │
│  Reward = 0.45·task + 0.25·constraints + 0.2·geometry + 0.1·efficiency      │
│           (critical constraint violation ⇒ 0)                               │
│  Annotation: episode success/partial/failure · step correct/incorrect/…     │
│  Export JSONL · deterministic replay with checkpoint verification           │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ /api/plan /api/component /api/edit
┌─ server/index.js (Node, holds the credential) ──────────────────────────────┐
│ Claude Opus 5.5 · streaming · zod-validated JSON                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Run

```bash
npm install
```

Backend (reads `.env` → `ANTHROPIC_API_KEY`, or an `ant auth login` profile; `MORSY_MODEL` overrides the model):

```bash
npm run server
```

UI:

```bash
npm run dev
```

Open http://localhost:5173. Without the backend the app still works: a rule-based offline planner stands in for the LLM agents.

## Using it

- **Command line** (bottom): type a request, press Enter. The planner splits it into components; agents model them in parallel and each component appears as soon as it's done.
- **Picking**: click = select the component (the boat, an oar); click again or double-click = the part under the cursor; ↑ = back to the parent. `pick` in the status line switches to part-first picking.
- **Channel Box** shows Translate/Rotate/Scale of whatever is selected (component or part) plus the primitive's INPUTS; the Move/Rotate/Scale gizmo drives the same level.
- **Shelf → Polygons** creates primitives, including **Lathe** (revolved profile) and **Extrude** (outline + depth); **Deform** adds modifiers incl. **subdivide** (Loop subdivision).
- **✦ AI dock** (Meshy-style, conversational): the agents narrate what they do ("Planned 4 components…", "Modeled wheels — 8 parts"), then **review their own result** — Morsy renders the model from four angles, asks Claude to critique it against the request, and applies the fixes (up to 2 rounds) before saying done; the thumbnails it looked at appear inline. Follow-ups go in the same box.
- **✦ AI dock** layout: *Text to 3D* / *Image to 3D* / *Edit* tabs, prompt, Style and Detail chips, Generate, a progress strip showing components as they finish, 👍/👎 on the result, and a History of generations with thumbnails (click one to restore it).
- **Windows → Developer** opens the hidden internals panel: optimizer report, episode annotation, reward breakdown, constraint checks, per-step labels, Export JSONL, Verify replay, RL policy, log.
- **Selection**: click = component, click again = part, ↑ = parent; **Shift+click** adds/removes; **⌘A** selects all; the gizmo moves/rotates/scales the whole set around its centre. **⌘G** groups selected parts into a new component, **⇧⌘G** ungroups; Modify → Freeze Transformations bakes a component's transform into its parts.
- **Export**: File → Export GLB (glTF binary, components become nodes) or OBJ.
- Layout: editing tools (Channel Box / Attribute Editor) and the ✦ AI panel are separate docks — side by side on wide screens, stacked on narrower ones.
- Hotkeys: Q W E R tools · 4 5 6 shading · F/A frame · G grid · X snap · ⌘Z/⇧⌘Z · ⌘D · ⌘A · ⌘G/⇧⌘G · ⌫ · Space persp.

## Layout

| path | what |
|---|---|
| `src/scene-model.js` | component/part document, ops + transactions, transform math, geometry generation (incl. lathe/extrude), OBJ export (one object, group per component) |
| `src/geometry/optimizer.js` | pure optimization engine (`tests/optimizer.test.js`) |
| `src/geometry/subdivide.js` | Loop subdivision (`tests/subdivide.test.js`) |
| `src/geometry/optimizer.worker.js` / `optimizer-client.js` | worker pool |
| `src/viewport.js` | three.js scene graph mirroring the hierarchy, picking at both levels, Maya navigation, shading modes |
| `src/agents/orchestrator.js` | plan → parallel component agents → progressive commit → optimizer swap-in; trajectory steps |
| `src/agents/schema.js` | zod contracts shared by browser and server |
| `src/agents/local-planner.js` | offline rule-based fallback agents |
| `src/rl/policy.js` | contextual bandit over modeling decisions; weighted reward |
| `src/rl/constraints.js` | constraint evaluator (above-ground critical; region, height, connectivity soft) |
| `src/rl/trajectory.js` | trajectory recorder, annotation, JSONL export, deterministic replay (`tests/rl.test.js`) |
| `server/index.js` | Claude backend |

```bash
npm test
```
