# Archs Importer — Brief for Antigravity

> This is context for *your* planning, not a task list. It marks the decisions
> that are **locked** (the human and the assistant deliberated these on real
> data — keep them) and the areas that are **open** (your call — design them).
> Read `ARCHS_IMPORTER_FINDINGS.md` first; it's the evidence behind everything
> here. Where this brief is quiet on *how*, that silence is intentional.

---

## The job

Build **Archs Importer**: a new tab in the existing Next.js engineering-toolkit
app that ingests a cleaned single-scheme architectural **DXF** and produces a
structured building model (closed-polygon walls + bearing/material attributes,
openings, fixtures, room names, steps) for the existing **Beam Framer** to
consume. First of an eventual four stages (Importer → Beam Framer → Lateral
Layout → Vectorworks draft script), each separated by a human sign-off gate.

The existing Beam Framer is good and must not regress. Protecting it is a hard
constraint.

---

## LOCKED — keep these (decided deliberately, on real data)

**Placement & shape**
- One new top-level tab, **Archs Importer**, alongside Beam Framer.
- The pipeline is an **internal stepper inside that one tab**, not multiple
  top-level tabs. Three ordered, stateful steps:
  **1) Intake gate → 2) AI recognition → 3) Completeness sign-off.**
  (Tabs are for independent tools; these steps are ordered for one job.)

**Processing model**
- **AI is not in the deterministic stage.** Three distinct kinds of processing:
  deterministic name-routing, deterministic geometry heuristics, and a separate
  downstream AI recognition stage. The first two are pure code.
- The human owns deleting dead design options upstream. The importer **assumes a
  cleaned single-scheme file** and does not attempt to choose the current option.

**Intake gate**
- **Hard reject** genuinely unusable input *before* real work (e.g. multiple
  stacked plans / multiple titleblocks / extents far larger than one building /
  no identifiable wall geometry). Reject messages must be **specific, teaching,
  and actionable** ("I see N stacked layouts… isolate the current scheme onto one
  design layer and re-upload"), never a generic error.
- That is distinct from **soft flag** (file is usable, something expected is
  thin/absent) — which is handled at step 3, not by rejection.

**Classification = taxonomy + mapping, never a per-firm hardcode**
- A **canonical taxonomy** (WALL, POCHE, FIX, DOOR, WIN, RMNAME, STAIR, CAB,
  JUNK, …) plus a **mapping layer** that resolves any firm's layer/block names
  into it.
- **One mapping resolver, four stages, in order:** exact-match dict → regex/alias
  → AI classify (with the PDF as visual context) → human confirm.
- Confirmed results **promote upward into the dictionary** with a **provenance
  tag** (deterministic / AI-suggested / human-confirmed) and a **scope** (global
  vs. per-firm). This caching flywheel is the point — the AI does less per firm
  over time.
- **Mappings are data, not code.** They live in editable skills/config, with
  per-firm overlays.

**Code vs skills split**
- *In code (buried, deterministic):* tokenizer, geometry math, wall-assembly &
  closure engine, exact dict lookup, running the gate, calling the model.
- *In skills (surfaced, editable):* the taxonomy, mapping rules/aliases, the
  poché-pattern→attribute dictionary, the AI classification prompt, confidence
  thresholds, plausibility rules, per-firm overrides, and the intake reject
  thresholds + messages.
- **Per-stage skills files (plural):** an intake skills file, a recognition
  skills file, and the mapping dictionary as its own data artifact.

**Wall topology**
- Wall assembly must output **closed polygons** suitable for a fill script. It
  must **flag any region it cannot close** rather than emit a broken polygon.
- Sub-8″ jamb-return stubs are dropped from the human's *view* but kept in the
  *topology* — they're how regions close.

**Completeness gate (step 3)**
- Three layers: **presence** (OK / SPARSE / MISSING), **category-aware
  expectation** (missing roof/grid is normal on a floor-plan sheet; missing walls
  is critical), and **cross-check / plausibility** (annotation-vs-geometry;
  relational like sink-implies-toilet; topological like won't-close; coverage
  like unnamed regions).
- **Nothing flagged passes without an explicit human choice:** *elsewhere /
  genuinely absent / here it is.*
- The user can **add a DXF** (e.g. a roof sheet) to satisfy a flagged-missing
  category. Reprocessing is **stateless / idempotent — full reprocess of the file
  set, never incremental object merging.** Adding a file triggers a clean redo.

**Recognition review (step 2)**
- **Exception-driven, not exhaustive.** Humans review only low-confidence calls,
  plausibility failures, and won't-close regions — rendered visually, grouped by
  category, with one-tap confirm / correct / point-to-it. The worklist shrinks as
  corrections cache.

**The PDF**
- Optional, brought in **up front**. Two uses: **visual context** for AI
  recognition, and a **completeness oracle** at the gate (it shows what *should*
  exist). It is a plot — **not a coordinate source**; geometry is always rendered
  from the DXF. Degrade gracefully if no PDF is provided.

**Handoff to Beam Framer**
- A **one-way data contract** shaped to the Beam Framer's *existing* input
  (closed walls + bearing + **explicit openings from door/window inserts**). The
  Beam Framer takes zero code changes — it just receives a payload it already
  understands. Openings-from-inserts lets the framer retire its gap-inference.
- Handoff is a **button**, enabled only after step-3 sign-off, that hands the
  contract over and switches to the framer tab. **Not** auto-advance.

**Isolation**
- Separate route, separate lib (e.g. `lib/cad/`), separate API route, separate
  skills. Only shared surfaces: the app shell/layout and the data contract.
  Fork now; refactor toward a shared parser later, once both modules are stable.

---

## OPEN — your call (design these; we deliberately did not)

- **Wall-assembly algorithm.** Given the constraints above (loose `LINE`s, many
  sub-8″ stubs, gaps/overshoots, must close), choose the approach: snap
  tolerances, face pairing, gap bridging, corner resolution. This is the core
  engineering problem and we want your design, not ours.
- **Step/tread detector.** Constraints: parallel-even-line signature, must be
  disambiguated from `1-DIM` witness lines, should use proximity to exterior
  doors / PORCH-DECK labels as context.
- **MTEXT parsing** to split room name from its stacked dimension/ceiling tag.
- **Job/state model & persistence**, stepper implementation, and the exception-
  queue UI.
- **Mapping dictionary file format / schema** (honor the provenance + scope +
  promotion semantics; the shape is yours).
- **How the PDF is rendered/displayed** alongside the canvas.
- **Confidence thresholds** and exactly which cases route to the exception queue.
- **Open question we did not settle:** whether to offer a "show me everything"
  review mode alongside the exception-driven default. Propose what you think is
  right.
- Anything not named in LOCKED, within the established Next.js stack.

---

## Definition of done (v1)

A user uploads a cleaned single-scheme DXF (optionally a PDF), the intake gate
either rejects with actionable guidance or admits the file, deterministic routing
+ geometry handles the bulk, AI recognition resolves the remainder and surfaces
only exceptions, the completeness gate forces a human OK on everything
flagged/missing, and on sign-off a button hands a valid closed-polygon contract
to the unchanged Beam Framer. Mappings confirmed during the session are cached
with provenance and scope. The Beam Framer still works exactly as before.

## How to use the findings doc

`ARCHS_IMPORTER_FINDINGS.md` has the real numbers, the layer/block reality, the
per-target table, and — importantly — the **failure modes we already hit** (§7).
Treat those as known traps, not hypotheticals. The residential wood-frame sample
is one data point; design for the convention *variety* described, not for this
one firm.
