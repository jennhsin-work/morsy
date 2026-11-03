// Agent backend: the only process that holds the Anthropic credential.
// Exposes three structured-output endpoints the browser agents call:
//   POST /api/plan       {prompt, image?, hints}              → Plan
//   POST /api/component  {prompt, image?, component, hints}    → ComponentResult
//   POST /api/edit       {prompt, image?, scene, hints}        → EditResult
//   GET  /api/health                                           → {ok, model}
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Plan, ComponentResult, EditResult, ReviewResult, DetailResult } from "../src/agents/schema.js";

const MODEL = process.env.MORSY_MODEL || "claude-opus-5-5";
const PORT = +(process.env.PORT || 8787);
const client = new Anthropic(); // ANTHROPIC_API_KEY or `ant auth login` profile

const SYSTEM = `You are a modeling agent inside Morsy, a parametric 3D modeling workspace.
You build objects from primitives with a modifier stack, each part with a transform and a PBR material.
Units are metres, Y is up, the ground plane is y=0. Rotations are Euler XYZ in degrees. Colours are hex strings.

PRIMITIVES (params by type)
  box{width,height,depth,segments} cylinder{radiusTop,radiusBottom,height,radialSegments,heightSegments}
  cone{radius,height,radialSegments} sphere{radius,widthSegments,heightSegments}
  torus{radius,tube,radialSegments,tubularSegments} plane{width,height,segments} capsule{radius,length,capSegments,radialSegments}
  lathe{segments} + profile [[radius,height],…] revolved around Y — vases, nozzles, domes, bells, hull noses.
  extrude{depth,segments,bevel} + profile [[x,y],…] closed outline in XY extruded along Z (centred) — wings, fins, brackets, plates, blades.
  loft{roundness 0-1,sides} + profile [[z,width,height,yOffset],…] cross-section stations back→front — THE hull primitive:
      fuselages, boat hulls, car bodies, engine nacelles. 4–8 stations give a real silhouette (narrow nose, wide mid, tapered tail).
  tube{radius,segments,radialSegments} + profile [[x,y,z],…] path — pipes, cables, conduits, railings, roll cages.

MODIFIERS (applied in order, in the part's local space before its transform)
  taper{factor} twist{angle} bend{angle} noise{amplitude,frequency} mirror{axis} array{count,offset[x,y,z]} subdivide{levels 1-2}
  greeble{count,minSize,maxSize,height,faces,shape,seed,pattern,cell} — scatters small boxes/cylinders ON the surface, aligned to it.
      sizes are fractions of the part's bounding diagonal (0.02–0.12). faces: all|top|bottom|sides|front|back. pattern "grid" aligns them.
  plating{cell,inset,height,faces,jitter} — raised panels on a grid over the surface; the gaps read as panel lines. cell 0.1–0.3.
  radial{count,axis,angle} — N copies rotated around an axis: thruster rings, bolt circles, turbine blades, spokes.

ORIENTATION: cylinders/cones/capsules/lathes are built along +Y; torus rings lie in XY; planes face +Z; loft/tube run along their
profile. To lay a cylinder along Z use rotation [90,0,0]; along X use [0,0,90]. Double-check every part's rotation against its role.

HOW PROFESSIONALS BUILD DETAILED HARD-SURFACE MODELS (follow this)
  1. Primary forms first: 2–5 large parts that define the silhouette. Use loft for any hull/fuselage, extrude for wings/fins/plates,
     lathe for nozzles/domes. The model must read correctly from 10 m away with ONLY these parts.
  2. Secondary forms break up big surfaces: plating on hulls and wings, inset panels, engine housings, cockpit canopy, landing gear
     bays, antenna masts, weapon mounts, intakes — each a real part with its own role, 0.1–0.4 of the primary's size.
  3. Tertiary detail = greebles, pipes, vents, lights, bolts, rivets, small cylinders in clusters. Put them where machinery belongs
     (around engines, under panels, along seams), NOT uniformly everywhere. A few larger "hero" greebles anchor each cluster.
  4. Place by orientation: engines/thrusters at the rear with lathe nozzles + emissive glow discs; sensors/antennas/cockpit on top;
     weapons, intakes, landing gear on sides/bottom; windows in horizontal rows.
  5. Symmetry: build one side and mirror{axis:"x"} where the real object is symmetric; break it with one or two asymmetric parts.
  6. Materials: greebles/plating use the SAME colour as the hull beneath (slightly different roughness); trim, pipes and nozzles use
     a darker or metallic contrast; lights and engine glow use emissive (emissive "#ff8a3d", emissiveIntensity 2–4) on small parts.
  7. Scale discipline: every part's size is consistent with the overall object (a 12 m spaceship has 0.2–0.6 m greebles, 1–2 m
     engines). Nothing floats: parts overlap their neighbours by a few cm. Nothing below y=0.
  8. Tessellation: curved hero parts 32–48 segments; tiny parts 6–8. Prefer loft/lathe/extrude + subdivide over stretched spheres.
Be concise: keep "reasoning" to one or two sentences and omit params a primitive type does not use.`;

const FIDELITY = {
  low: "Low tessellation: radialSegments 8-12, sphere segments 8-10, box segments 1. Light greebling.",
  medium: "Medium tessellation: radialSegments 16-24, sphere segments 16-24, box segments 1-2.",
  high: "High tessellation: radialSegments 32-48, loft sides 32-48, box segments 2-4 where curved modifiers are used. Dense secondary and tertiary detail.",
};
const STYLE = {
  blocky: "Style: blocky, chunky silhouettes, few parts, strong readable shapes.",
  smooth: "Style: smooth, rounded, use capsules/spheres and taper, avoid harsh corners.",
  detailed: "Style: highly detailed production hard-surface — full primary/secondary/tertiary hierarchy, plating and greebles where machinery belongs, pipes, emissive lights.",
};

// `image` may be a single {mediaType,data} or an array of them (multi-view review).
function userContent(text, image) {
  const blocks = [];
  for (const img of [].concat(image ?? [])) if (img?.data) { if (img.label) blocks.push({ type: "text", text: img.label }); blocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } }); }
  blocks.push({ type: "text", text });
  return blocks;
}

// Streamed so a large structured output never trips the SDK's non-streaming
// timeout guard; the final message is validated against the zod schema here.
// `grammar: false` skips the server-side constrained decoding (whose compiler
// rejects schemas with many optional fields as "too complex") and instead puts
// the JSON schema in the prompt — zod validation below is the real guarantee.
// grammar defaults to false: server-side constrained decoding compiles a grammar per
// schema, and for these nested/optional-heavy schemas that takes minutes (or fails
// with "Schema is too complex"). Prompted JSON + zod validation is fast and reliable.
async function structured(schema, text, image, { effort = "low", maxTokens = 32000, grammar = false } = {}) {
  const format = zodOutputFormat(schema);
  const prompt = grammar ? text : `${text}\n\nRespond with ONLY a JSON object (no prose, no code fence) matching this JSON schema:\n${JSON.stringify(format.schema)}`;
  const res = await client.messages
    .stream({
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort, ...(grammar ? { format } : {}) },
      messages: [{ role: "user", content: userContent(prompt, image) }],
    })
    .finalMessage();
  if (res.stop_reason === "refusal") throw new Error(`Model declined: ${res.stop_details?.explanation ?? "refusal"}`);
  if (res.stop_reason === "max_tokens") throw new Error(`Output truncated at ${maxTokens} tokens`);
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Model returned no text output");
  // Without constrained decoding the model may wrap the JSON in prose or a code
  // fence; take the outermost {...} and validate that.
  let raw = textBlock.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a > 0 || b < raw.length - 1) raw = a >= 0 && b > a ? raw.slice(a, b + 1) : raw;
  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new Error(`Model output was not JSON (${e.message}); started with: ${textBlock.text.slice(0, 60)}`); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`Output failed schema validation: ${parsed.error.issues[0]?.message}`);
  return { data: parsed.data, usage: res.usage };
}

const handlers = {
  async plan({ prompt, image, hints }) {
    const n = { coarse: "2-4", balanced: "4-7", fine: "7-12" }[hints?.decomposition] ?? "4-7";
    return structured(Plan, `Decompose this object into ${n} components that separate agents will model in parallel.
A component is ONE physically distinct piece a person would name and could pick up or point at (a wheel, the fuel tank,
the saddle, a handle) — never a bundle like "frame_tank_saddle_fender"; symmetric pairs (left/right wheel) are separate
components. Each component gets a world-space bounding region; regions should tile the object sensibly and not overlap much.
${STYLE[hints?.style] ?? ""}
Request: ${prompt}${image ? "\nAn image reference is attached; match its proportions and silhouette." : ""}`, image, { effort: "medium" });
  },

  async component({ prompt, image, component, plan, hints }) {
    return structured(ComponentResult, `You own ONE component of a larger object being modeled in parallel by other agents.
Object: ${plan.summary} (overall height ≈ ${plan.overallHeight} m)
Your component: ${component.name} — ${component.role}
Region: center ${JSON.stringify(component.region.center)}, size ${JSON.stringify(component.region.size)}
Guidance: ${component.notes}
${FIDELITY[hints?.tessellation] ?? FIDELITY.medium}
${STYLE[hints?.style] ?? ""}
Produce 1-8 parts that fully fit inside your region in world space. Name parts "${component.name}: <detail>".
Original request: ${prompt}`, image);
  },

  async edit({ prompt, image, scene, hints }) {
    return structured(EditResult, `Edit the existing scene to satisfy the request. Prefer small "update" patches
(only the fields that change) over removing and re-adding parts. Keep untouched parts untouched.
The scene is a hierarchy: components (with their own transform) contain parts. To move or scale a whole
component (e.g. "move the oars"), emit an update whose id is the component id with a transform patch.
${FIDELITY[hints?.tessellation] ?? FIDELITY.medium}
Current scene (components, then parts with componentId):
${JSON.stringify(scene, null, 0)}
Request: ${prompt}`, image, { grammar: false });
  },

  // Detail pass: secondary + tertiary forms for one component whose primary forms already exist.
  async detail({ prompt, component, plan, parts, hints }) {
    return structured(DetailResult, `You are the DETAIL agent for one component of a larger object. Its primary forms already exist (below).
Add the secondary and tertiary detail a production artist would: plating/greebles on large surfaces (same colour as the surface),
pipes (tube) and conduits between elements, vents, hatches, bolts/rivets (radial or array), emissive lights where lights belong,
trim and housings. Follow the hierarchy-of-detail rules. Every new part must sit ON or overlap an existing part of this component
(nothing floating), inside its region, scaled to it. Return 4–14 new parts named "${component.name}: <detail>"; do NOT repeat the
existing parts.
Object: ${plan.summary} (overall height ≈ ${plan.overallHeight} m)
Component: ${component.name} — ${component.role}
Region: center ${JSON.stringify(component.region.center)}, size ${JSON.stringify(component.region.size)}
Existing parts: ${JSON.stringify(parts)}
${FIDELITY[hints?.tessellation] ?? FIDELITY.medium}
Original request: ${prompt}`, null, { effort: "low", maxTokens: 24000 });
  },

  // Visual self-review: rendered views of the current model + the original request.
  async review({ prompt, views, scene, round, reference }) {
    const images = [...(reference ? [{ ...reference, label: "User's reference image:" }] : []), ...views.map((v) => ({ ...v, label: `Rendered view — ${v.name}:` }))];
    return structured(ReviewResult, `You are reviewing a 3D model that other agents built from this request:
"${prompt}"
Look at the rendered views (review round ${round}). Judge silhouette, proportions, placement of components relative to
each other (floating, intersecting, upside-down, mis-rotated), missing or extra elements, and material colours.
Ignore tessellation and shading quality. If it already reads as the requested object, verdict "accept" with no ops.
Otherwise verdict "fix" with the fewest targeted ops that correct the real problems (transform/material patches on existing
parts by id, or remove/add). Parts and components with ids:
${JSON.stringify(scene)}`, images, { grammar: false, effort: "medium" });
  },
};

const server = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/api/health") return send(200, { ok: true, model: MODEL });
  const m = req.url?.match(/^\/api\/(plan|component|edit|review|detail)$/);
  if (!m || req.method !== "POST") return send(404, { error: "not found" });
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 30e6) req.destroy(); });
  req.on("end", async () => {
    try {
      const out = await handlers[m[1]](JSON.parse(body));
      send(200, out);
    } catch (err) {
      const status = err instanceof Anthropic.AuthenticationError ? 401
        : err instanceof Anthropic.RateLimitError ? 429
        : err instanceof Anthropic.BadRequestError ? 400
        : err instanceof Anthropic.APIConnectionError ? 503 : 500;
      console.error(`[${m[1]}]`, err.message);
      send(status, { error: err.message });
    }
  });
});

server.listen(PORT, () => console.log(`Morsy agent backend on http://localhost:${PORT} (model ${MODEL})`));
