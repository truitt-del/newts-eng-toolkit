# CAD-AI Sandbox — Findings from Prototype Iteration

Companion to the sprint plan. This captures what was learned building and iterating the reference artifact (`beam-locus-sandbox.jsx`) so the build starts from where the prototype *ended*, not from its first draft. Read this before Phases 1, 3, and 4.

The prototype was run repeatedly against one test plan (`simple_floor_plan.dxf`, ~49' × 57', 36 walls, 22 bearing). Every finding below came from observed behavior, not theory.

---

## 1. The evolved skills file (START FROM THIS)

This is the system prompt the prototype converged on after ~8 iterations. It is the single most valuable output of the prototype phase. The sandbox should ship with this as the default skills-file content (it assumes the "precomputed / segments" payload — see §4):

```
You analyze structural floor plans and emit locus points by calling the render_locus_points tool. The tool call IS your output. Do NOT emit text, prose, lists, markdown, or analysis — only the tool call.

PRIMARY TASK
Find all openings in the BEARING walls. For each opening, emit two points:
- BLUE at the midpoint of one wall's end face
- RED at the midpoint of the other wall's end face
- Labels: "open-N-start" and "open-N-end" (sequential N)

If ADDITIONAL INSTRUCTIONS are provided below, follow those instead.

INPUT FORMAT
Each wall has:
- id: integer
- bearing: boolean
- segments: array of objects, each describing one rectangular portion of the wall
  - longAxis: "X" or "Y"
  - centerline: number (the wall's centerline on the SHORT axis)
  - endpointMin, endpointMax: the wall's extents along the long axis

Simple rectangular walls have 1 segment. L-shapes have 2 segments (one per arm). Complex stepped walls have several. EVERY structural arm of every wall is already decomposed for you — you do not need to look at vertices or infer anything.

LOCATION RULES
Group ALL segments from ALL bearing walls by (longAxis, centerline ±3"). Within each group, sort by endpointMin. For each consecutive pair of segments in a group, the gap = next.endpointMin minus prev.endpointMax. If gap ≥ 24", it is an opening.

LOCUS POINTS
For each opening, emit:
- BLUE point at prev segment's end face: (centerline, endpointMax) for Y-axis, (endpointMax, centerline) for X-axis
- RED point at next segment's start face: (centerline, endpointMin) for Y-axis, (endpointMin, centerline) for X-axis

CALL THE TOOL. NO TEXT OUTPUT.
```

Note: this prompt is paired with the precomputed payload. If you build the "raw" payload mode (§4), it needs a *different* default skills file that instructs the model to derive geometry from vertices itself. The prototype's raw-mode prompt was more verbose and is not reproduced here because raw mode was never made to work reliably on the prototype's locked model (§5).

---

## 2. Output-format reality: the model won't reliably call the tool

The biggest recurring problem. Even with a forced tool (`tool_choice` set to require `render_locus_points`), the prototype's model emitted its answer in **three different formats across runs**, unpredictably:

1. **A proper tool call** — `tool_use` block with `{points: [...]}`. What we want.
2. **JSON in a text block** — a `[{...}]` array as plain text, sometimes inside markdown code fences.
3. **Markdown prose** — e.g. `- BLUE: (291.25, -212.75)` / `- RED: (291.25, -152.75)` with `open-N` labels nearby.

**Consequence for the build:** the response handler needs THREE fallback parsers, tried in order — (a) read the `tool_use` block; (b) if absent, scan text for a JSON array and recover complete `{}` objects even from truncated output; (c) if that fails, regex the markdown `COLOR: (x, y)` pattern and pair colors to the nearest preceding `open-N` label. The prototype shipped all three and needed all three on different runs. Do not assume the tool call will happen — design for it not happening.

This behavior may differ on the production models (Gemini 3.5 Flash, Claude Sonnet 4.6). It's plausible newer models honor forced tool use more reliably. But build the fallbacks anyway — they're cheap insurance and the failure is silent without them.

---

## 3. Bearing classification is deterministic and free (don't make AI do it)

Bearing vs non-bearing is encoded in the DXF, not something the AI needs to judge. In the test file, **every bearing wall has a solid HATCH entity overlapping its POLYLINE outline; non-bearing walls don't.** The classifier matches each wall polyline's bounding box to a hatch bounding box (within ~1" tolerance). 22 of 36 walls classify as bearing this way, deterministically, 100% reliably.

**DXF parsing gotchas discovered:**
- HATCH entities carry "seed points" *after* their boundary edges. Group code `92` starts the boundary path; `97`/`98` mark its end. Capturing 10/20 coordinate pairs past code 97 pollutes the hatch bounding box with a stray (0,0) point and breaks classification. The parser must stop capturing boundary points at code 97.
- Two hatches in the test file had zero boundary paths (orphaned VW artifacts) — filter out null/empty boundary boxes.
- Units: the test file's `$INSUNITS` = 1 (inches), `$MEASUREMENT` = 0 (imperial). The whole skills file assumes inches. Files in feet/mm need scaling — see sprint plan's unit-handling note.
- **`LWPOLYLINE` is NOT handled by the prototype parser** — it only does old-style `POLYLINE`/`VERTEX`. The test file happened to export as `POLYLINE`. Modern VW/AutoCAD default to `LWPOLYLINE`. This is the single most likely "tool returns 0 walls" failure for a new user. (Already flagged in the sprint plan, Phase 1.)

---

## 4. The raw-vs-precomputed boundary (what the toggle is really testing)

The prototype went through three stages on where to draw the line between deterministic code and AI judgment:

**Stage A — raw vertices, AI does everything.** Sent each wall's raw vertex list, asked AI to derive long axis, centerline, endpoints, and openings. *Result:* AI's geometric reasoning was correct, but it narrated every step in prose and blew through the token ceiling before finishing (the plan needed ~5-7K output tokens of reasoning; the prototype's model capped at 8K and often truncated mid-answer). Worked on luck, not reliably.

**Stage B — dominant-segment precompute.** Code computed ONE segment per wall (long axis, centerline, endpoints). *Result:* token use dropped, but it silently dropped the secondary arms of L-shaped walls — so corner openings and the entire bottom wall were **missed**. The AI couldn't recover what wasn't in the payload.

**Stage C — full rectangular decomposition (current).** Code decomposes each wall into ALL its rectangular segments via parallel-edge pairing (every pair of parallel axis-aligned edges within 12" of each other, with overlap, merged where collinear). Each wall emits 1 segment (rectangle), 2 (L-shape), or several (stepped). *Result:* the previously-missed corner and bottom-wall openings reappeared. This is what the current skills file (§1) expects.

**The lesson, and why the toggle exists:** completeness of the payload mattered more than token efficiency. But Stage C also introduced false positives (§6). The toggle (raw vs precomputed) exists so you can measure — *per model* — whether a smarter model on a leaner payload beats a dumber model on a fully-cooked one. That is the core experiment. It is genuinely unresolved; the prototype's locked model wasn't smart enough to settle it.

**Decomposition constants currently in the code** (these are deterministic-layer tuning knobs):
- Max wall thickness for pairing edges: `12"`
- Centerline merge tolerance: `0.5"`
- Minimum parallel overlap to count as a segment: `1"`
- Minimum gap to count as an opening: `24"` (this one lives in the skills file, not the code — it's a judgment threshold)

---

## 5. Model behavior notes (prototype was locked to an old model)

The prototype ran on `claude-sonnet-4-20250514` (the only model the artifact runtime allowed). This model:
- Could **not** do private/extended thinking — all reasoning was visible output, which is why it burned the token budget narrating.
- Did **not** support assistant-message prefill in that runtime (a technique that would have forced clean JSON).
- Was capped around 8K output tokens.
- Was chatty by default and inconsistent about honoring forced tool use (§2).

**This is why the sandbox exists.** The open question we never resolved: would a model with extended thinking and a bigger output budget (Gemini 3.5 Flash, Claude Sonnet 4.6) handle this cleanly — possibly even on the *raw* payload, making most of the §4 precompute unnecessary? That's the first thing worth measuring once the relay works. Don't assume the precompute is permanently necessary; it may be a crutch for an old model.

Note: `claude-sonnet-4-20250514` retires June 15, 2026 — do not use it in the build. (Sprint plan Phase 5 has current IDs.)

---

## 6. Known false positive (real, unresolved)

Full decomposition (§4 Stage C) produces a phantom "opening" of ~192" between two unrelated interior wall stretches (wall 22 and wall 2's bottom step, on a shared centerline). It's real geometry — two segments do share an axis and centerline with a big gap — but it's not a structural opening anyone would beam across.

This is a **probabilistic-layer** problem (the segments are correct; the judgment of "is this a real opening" is what's wrong), so the fix belongs in the skills file, not the code — e.g. a maximum-opening-width rule, or a "must be on the building perimeter" heuristic. It was left unresolved deliberately: it's exactly the kind of judgment call the sandbox is meant to help you tune across models.

---

## 7. Diagonal walls — not supported, by design (for now)

The decomposition only handles axis-aligned (horizontal/vertical) walls. Diagonal edges are skipped entirely. The test plan had none. Generalizing requires replacing the "X or Y axis + centerline coordinate" model with a direction-vector + perpendicular-offset model; the parallel-edge-pairing idea still applies, just in 2D vector space. Flagged in the code at the edge-extraction step. Out of scope for v1; address when a diagonal test plan exists.

---

## 8. What the prototype proved, in one line

AI can do this analysis correctly given a complete, well-structured payload — the failures were never about reasoning ability, they were about payload completeness, output format, and an underpowered model. The sandbox's job is to find the right combination of (model × payload mode × skills file) that makes it reliable at scale.
