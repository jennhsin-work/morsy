// Shared contract between the browser agents and the Claude backend.
// Kept framework-free so both Vite (browser) and Node (server) import it.
import { z } from "zod";

// Fixed-length array rather than z.tuple: zod 4 serialises tuples with
// `items: false`, which the SDK's structured-output transformer rejects.
export const Vec3 = z.array(z.number()).min(3).max(3).describe("[x, y, z]");

// Explicit optional params instead of z.record: structured outputs need a
// closed object schema. Agents fill only the keys their primitive type uses.
const n = () => z.number().optional();
export const Primitive = z.object({
  type: z.enum(["box", "cylinder", "sphere", "cone", "torus", "plane", "capsule", "lathe", "extrude"]),
  params: z.object({
    width: n(), height: n(), depth: n(), segments: n(),
    radius: n(), radiusTop: n(), radiusBottom: n(), radialSegments: n(), heightSegments: n(),
    widthSegments: n(), tube: n(), tubularSegments: n(), length: n(), capSegments: n(),
  }),
  // lathe: [[radius, height], …] revolved around Y (3–24 points, bottom to top);
  // extrude: [[x, y], …] closed outline in the XY plane, extruded along Z by params.depth.
  profile: z.array(z.array(z.number()).min(2).max(2)).min(3).max(24).optional(),
});

export const Modifier = z.object({
  type: z.enum(["taper", "twist", "bend", "noise", "mirror", "array", "subdivide"]),
  factor: z.number().optional(),
  angle: z.number().optional(),
  amplitude: z.number().optional(),
  frequency: z.number().optional(),
  axis: z.enum(["x", "y", "z"]).optional(),
  count: z.number().optional(),
  offset: Vec3.optional(),
  levels: z.number().optional().describe("subdivide: 1–3 Loop subdivision levels"),
});

export const PartSpec = z.object({
  name: z.string(),
  primitive: Primitive,
  transform: z.object({ position: Vec3, rotation: Vec3, scale: Vec3 }),
  material: z.object({ color: z.string(), roughness: z.number(), metalness: z.number() }),
  modifiers: z.array(Modifier),
});

// Planner output: how to split the object into components that agents own.
export const Plan = z.object({
  summary: z.string(),
  overallHeight: z.number().describe("approximate total height in metres"),
  components: z.array(z.object({
    name: z.string(),
    role: z.string().describe("what this component is, e.g. 'seat', 'rear left leg'"),
    region: z.object({ center: Vec3, size: Vec3 }).describe("bounding region in world space the component should occupy"),
    notes: z.string().describe("modeling guidance for the component agent"),
  })).min(1).max(12),
});

// Component agent output: parts for one component, or edits to existing parts.
export const ComponentResult = z.object({
  reasoning: z.string().describe("one or two sentences on the modeling decisions"),
  parts: z.array(PartSpec).max(8),
});

// Edit agent output: targeted changes to existing parts. One flat op shape
// (no union, shallow optionals): the structured-output grammar compiler
// rejects a discriminated union over deep partials as "too complex".
const Patch = z.object({
  name: z.string().optional(),
  primitive: Primitive.optional(),
  transform: z.object({ position: Vec3.optional(), rotation: Vec3.optional(), scale: Vec3.optional() }).optional(),
  material: z.object({ color: z.string().optional(), roughness: z.number().optional(), metalness: z.number().optional() }).optional(),
  modifiers: z.array(Modifier).optional(),
});
// Reviewer output: a visual critique of rendered views against the request,
// with concrete fix-ups expressed as edit ops.
export const ReviewResult = z.object({
  verdict: z.enum(["accept", "fix"]).describe("accept = matches the request well enough; fix = apply the ops below"),
  summary: z.string().describe("one sentence a user would read, e.g. 'Looks right; the handles are a little thin.'"),
  issues: z.array(z.string()).max(8).describe("specific visual problems found, empty when accepting"),
  ops: z.array(z.object({
    op: z.enum(["update", "remove", "add"]),
    id: z.string().optional(),
    patch: z.object({
      name: z.string().optional(),
      primitive: Primitive.optional(),
      transform: z.object({ position: Vec3.optional(), rotation: Vec3.optional(), scale: Vec3.optional() }).optional(),
      material: z.object({ color: z.string().optional(), roughness: z.number().optional(), metalness: z.number().optional() }).optional(),
      modifiers: z.array(Modifier).optional(),
    }).optional(),
  })).max(20),
});

export const EditResult = z.object({
  reasoning: z.string(),
  ops: z.array(z.object({
    op: z.enum(["update", "remove", "add"]),
    id: z.string().optional().describe("required for update/remove"),
    patch: Patch.optional().describe("update: only the fields that change; add: a complete part (name, primitive, transform, material, modifiers)"),
  })).max(40),
});
