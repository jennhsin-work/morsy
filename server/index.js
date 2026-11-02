// Agent backend: the only process that holds the Anthropic credential.
// Exposes three structured-output endpoints the browser agents call:
//   POST /api/plan       {prompt, image?, hints}              → Plan
//   POST /api/component  {prompt, image?, component, hints}    → ComponentResult
//   POST /api/edit       {prompt, image?, scene, hints}        → EditResult
//   GET  /api/health                                           → {ok, model}
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Plan, ComponentResult, EditResult, ReviewResult } from "../src/agents/schema.js";

const MODEL = process.env.MORSY_MODEL || "claude-opus-5-5";
const PORT = +(process.env.PORT || 8787);
const client = new Anthropic(); // ANTHROPIC_API_KEY or `ant auth login` profile

const SYSTEM = `You are a modeling agent inside Morsy, a parametric 3D modeling workspace.
You build objects from primitives (box, cylinder, sphere, cone, torus, plane, capsule, lathe, extrude) with a
modifier stack (taper, twist, bend, noise, mirror, array, subdivide), each with a transform and a PBR material.
Units are metres, Y is up, the ground plane is y=0. Rotations are Euler XYZ in degrees.
Primitive params by type:
  box{width,height,depth,segments} cylinder{radiusTop,radiusBottom,height,radialSegments,heightSegments}
  cone{radius,height,radialSegments} sphere{radius,widthSegments,heightSegments}
  torus{radius,tube,radialSegments,tubularSegments} plane{width,height,segments} capsule{radius,length,capSegments,radialSegments}
  lathe{segments} + profile [[radius,height],…] revolved around Y — use for vases, hulls (rotate afterwards), bottles, bowls, lamp shades.
  extrude{depth,segments} + profile [[x,y],…] closed outline in XY, extruded along Z (centred) — use for paddle blades, brackets, roofs, letters, any flat shape with thickness.
Precision: a "subdivide" modifier {levels:1-2} smooths a coarse cage into a curved surface — a 6-point lathe
profile + subdivide 1 gives a smooth hull; a box with segments 2 + subdivide 2 gives a rounded pebble.
Prefer lathe/extrude + subdivide over stretched spheres and cylinders whenever the real object is curved or flat-profiled.
Keep tessellation proportional to the fidelity hint; a downstream geometry optimizer will weld,
clean, decimate flat areas and fix UVs, so prefer clean, slightly over-built geometry over clever tricks.
Colours are hex strings. Never place parts below y=0.
Orientation: cylinders, cones and capsules are built along the +Y axis; the torus ring lies in the XY plane;
planes face +Z. To lay a cylinder along Z use rotation [90,0,0]; along X use [0,0,90]. A boat hull, log or
pipe that runs along Z therefore needs a rotated primitive, not an upright one. Double-check every part's
rotation against the role it plays before answering.
Be concise: keep "reasoning" to one or two sentences and omit params a primitive type does not use.`;

const FIDELITY = {
  low: "Low tessellation: radialSegments 8-12, sphere segments 8-10, box segments 1.",
  medium: "Medium tessellation: radialSegments 16-24, sphere segments 16-24, box segments 1-2.",
  high: "High tessellation: radialSegments 32-48, sphere segments 32-48, box segments 2-4 where curved modifiers are used.",
};
const STYLE = {
  blocky: "Style: blocky, chunky silhouettes, few parts, strong readable shapes.",
  smooth: "Style: smooth, rounded, use capsules/spheres and taper, avoid harsh corners.",
  detailed: "Style: detailed, add secondary elements (trim, bolts, panels) as small parts.",
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
async function structured(schema, text, image, { effort = "low", maxTokens = 32000, grammar = true } = {}) {
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
Each component gets a world-space bounding region; regions should tile the object sensibly and not overlap much.
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
  const m = req.url?.match(/^\/api\/(plan|component|edit|review)$/);
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
