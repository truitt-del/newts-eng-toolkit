# Archs Importer — Sandbox Findings

> Context document for the Archs Importer module. This is *what we learned* from
> working real files by hand in a sandbox. It is reference material, not a task
> list. A companion document (`ARCHS_IMPORTER_BRIEF.md`) states which decisions
> are locked and which are open.

---

## 1. What this module is

Archs Importer is a new tab in the existing engineering-toolkit web app. It takes
a messy architectural CAD file and turns it into a clean, structured set of
building elements — primarily **closed-polygon walls with bearing and material
attributes, plus openings, fixtures, room names, and steps** — that downstream
modules (starting with the existing Beam Framer) can consume.

It sits first in a four-stage long-term vision:

```
Archs Importer  →  Beam Framer  →  Lateral Layout  →  Vectorworks draft script
   (new)            (exists)         (new, later)        (new, later)
```

A human sign-off gate sits between every stage. Those gates are load-bearing:
they stop classification/extraction error from compounding down the chain. This
document only covers stage 1.

DWG is the architects' most common format but is **out of scope for now** — DXF
is the internal contract. DWG→DXF conversion (e.g. ODA File Converter) is a
front-end to bolt on later; it must not leak into the module core.

---

## 2. The files we studied

Two real artifacts from one residential permit set (NRB Drafting; single-story
wood-frame SFD, Type VB; `$INSUNITS = 1`, i.e. inches):

- **`full_archs.dxf`** — the raw base file: **351,307 code pairs, 14,729
  graphical entities, 32 layers.**
- **`slightly_cleaned_archs.dxf`** — the same file after the architect deleted
  dead design options: **1,544 entities, one ~85′×62′ footprint.** A 90%
  reduction.
- **`full_archs.pdf`** — the plotted permit set (cover, floor plan, sections,
  elevations). Used as a visual/semantic reference, **not** a coordinate source.

This single sample is residential wood-frame. Commercial / masonry / CMU were
explicitly deferred; some targets below (fine material, column grids) simply do
not occur in this building type.

---

## 3. The two surprises that shaped the design

**Surprise 1 — a raw base file is not "a floor plan."** `full_archs.dxf`'s
modelspace held roughly eight stacked copies of the building (OPTION A,
PROPOSED 8/24/21, CURRENT, 8/4/21, plus dimension/electrical/etc. overlays),
~1,290 ft tall, each with its own viewport crop. The walls appeared ~8 times
over. **Decision that fell out of this:** the human is responsible for deleting
dead options and delivering a single-scheme file. Picking "which option is
current" is design intent that lives in the architect's head, not the geometry —
it is the worst possible job to automate, and the cleanup is a ~30-second
Vectorworks operation that removed an entire pipeline stage (the 90% drop above).
The importer therefore *assumes a cleaned, single-scheme file* and bounces files
that clearly aren't (see the completeness/intake notes in the brief).

**Surprise 2 — the layer name can lie, and it cost us.** The `1-STAIR` layer was
empty, so a naive presence-check reported "no stairs." But the building has front
*and* back steps — drawn on the catch-all `1-MISC` layer. Worse, step tread
geometry (parallel, evenly-spaced, equal-length lines) is **geometrically
identical to dimension witness lines** on `1-DIM`. So: layer membership is the
usual discriminator, but when a firm dumps real elements on a misc layer, neither
layer name nor pure geometry is sufficient — steps need *signature + context
(near an exterior door / a PORCH/DECK label) + active disambiguation from
dimension lines.* This is the single best argument in the whole project for why
the AI/judgment layer exists. It is documented as a failure mode in §7.

---

## 4. Layer and block reality

This firm uses a consistent **Vectorworks-style `1-` prefix** convention — NOT
AIA/NCS. Meaningful layers seen: `1-WALL`, `1-POCHE` (wall fill), `1-FIX` /
`1-FIX-F` (fixtures), `1-DOOR`, `1-WIN`, `1-RMNAME` (room names), `1-CAB`,
`1-STAIR`, `1-SOFFIT`, `1-AREA`, `1-SECT`, `1-FAU`, `1-MISC`, `1-DIM`, `1-TEXT`.
Junk: layer `0` (the dumping ground), `DEFPOINTS`, `BOR`/`BOR-TEXT` (titleblock),
plus annotation blocks (`VW_SLASH`, `_Dot`, `DETAIL TICK`, `PHA-KEY`/`PHA-DET`/
`pha-sec`, `Refer`) and `Group-NN` anonymous groups placed at (0,0).

**The critical implication:** you work with thousands of architects, so this one
convention is worthless as a hardcoded table. Every firm differs (AIA `A-WALL`,
this firm's `1-WALL`, someone else's `WALLS-NEW`, someone else dumping on `0`).
The module therefore needs a **canonical taxonomy + a mapping layer**, not a
per-firm lookup. See the brief.

**Disposition split** (canonical router applied, cleaned file):
~24% keep / ~34% review / ~42% junk. The deterministic router clears the keep and
junk for free; the ~34% "review" is almost entirely layer `0` and loose text —
that is the AI's job, and nothing else's.

---

## 5. Per-target findings (against the full target list)

| Target | What's in the file | How to get it | Honest limit |
|---|---|---|---|
| **Walls** | 212 loose `LINE` segs, 0 polylines, 2″–264″, ~87 under 8″ | assemble loose lines → closed polygons | no "wall object" exists; assembly is the core engine |
| **Bearing / material** | `1-POCHE`: 27 HATCH + 2 SOLID | poché overlap = solid-vs-framed | fine material (wood/masonry/veneer) not in geometry on wood-frame sets |
| **Full vs half height** | not on the plan | — | lives in sections; always flag as "not derivable from plan" |
| **Toilets** | block `tp` ×2 (cryptic name) | block dict + context, then cache | dictionary misses it; needs context once, then free |
| **Plumbing fixtures** | 38 on `1-FIX`, semantic block names | block-name dictionary | reliable once blocks parsed |
| **Doors / windows** | explicit `INSERT`s on `1-DOOR`/`1-WIN` | read inserts directly | these *are* the openings (see §6) |
| **Room names** | 14 `MTEXT` on `1-RMNAME` | parse MTEXT, split name from dims | name + dimension/ceiling tag are stacked in one MTEXT |
| **Stairs / steps** | `1-STAIR` empty; real steps on `1-MISC`, front+back | signature + context + dim disambiguation | the §3 failure mode — cannot be layer-routed |
| **Roof lines** | none (different sheet) | — | absence is *normal* on a floor-plan sheet — don't alarm, flag for OK |
| **Grid lines** | none (residential has no column grid) | — | section bubbles (`A-2`, `B`) are *not* grid lines |

Key reusable insight: **doors/windows are explicit inserts**, which means the
importer can hand the Beam Framer *actual* openings instead of the framer
inferring them from wall gaps — retiring the framer's gap-inference heuristic and
its known phantom-opening bug.

---

## 6. The validated approach (proven by hand on real data)

**Three kinds of processing, and AI is only the third.** This separation is
deliberate and was a correction during the sandbox — do not blur it.

1. **Deterministic name-routing** — layer/block dictionary lookups. Pure code.
2. **Deterministic geometry heuristics** — wall assembly, snap/closure, the
   tread-signature detector, reading poché patterns. Pure code, no model.
3. **AI recognition** — a *separate downstream stage* that works only on what 1
   and 2 couldn't resolve, plus disambiguation and human-facing narration.

**The mapping resolver (one mechanism, many uses).** Layer→category,
block→category, poché-pattern→attribute, firm-names→canonical all flow through
the same four-stage fallback: **exact-match dict → regex/alias → AI classify
(with the PDF as visual context) → human confirm.** Results *promote upward*:
a confirmed mapping (e.g. `tp → toilet`) is written into the dictionary with a
**provenance tag** (deterministic / AI-suggested / human-confirmed) and a
**scope** (global vs. this-firm-only). Next file, it's a free exact match. This
is the flywheel: AI workload shrinks per firm over time, and the dictionary is
inspectable, editable data — not buried code.

**The completeness gate — three layers, not one.** This is the heart of the
"flag if not found" requirement, and §3's step miss proves all three matter:

1. *Presence* — per canonical category: OK / SPARSE / MISSING (three states; "2
   toilets" deserves a different response than "0").
2. *Category-aware expectation* — so it doesn't cry wolf. Missing walls is
   critical; missing roof/grid is normal on a floor-plan sheet.
3. *Cross-check & plausibility* — the valuable layer. Annotation-vs-geometry
   ("`CONC. STOOP` text exists but the stair layer is empty → locate the steps");
   relational ("3 bathroom sinks, 2 toilets → which bath is missing a WC");
   topological ("this wall region won't close"); coverage ("9 enclosed regions, 6
   room names → 3 unnamed rooms").

Nothing flagged passes silently. Every flag is an explicit human choice:
*it's elsewhere / genuinely absent / here, let me point to it.*

**Wall closure is a hard spec.** The eventual Vectorworks handoff needs valid
**closed polygons** (so a script can fill bearing walls). Architects' walls have
gaps, overshoots, and missed corners. The assembly engine must snap, bridge, and
close — and **flag any region it cannot close** rather than emit a broken
polygon. The sub-8″ jamb-return stubs that a human ignores are the connective
tissue the engine needs; they're dropped from the human's *view*, not the
*topology*.

**Poché pattern is a feature, not a flag.** Don't treat poché as binary
"present = bearing." Read the hatch *pattern*; different patterns encode
half-height vs full-height and material. This is firm-specific and learnable —
it belongs in editable skills data, not code.

---

## 7. Failure modes we actually hit in the sandbox (read this)

- **Declared steps missing when they existed.** The completeness check keyed on a
  layer *named* `stair`; the steps were on `1-MISC`. Lesson: the gate must hunt
  by *signature near exterior openings*, not by layer name alone.
- **Tread geometry ≈ dimension geometry.** A naive parallel-even-line detector
  returned 35 "step" clusters, mostly `1-DIM` witness lines. Layer + context
  disambiguate; pure geometry does not.
- **Room-name extraction mangled names.** Naively concatenating MTEXT codes
  fused/garbled names ("COVERED PORCH" → "'D PORCH") because the name and the
  dimension tag share one stacked MTEXT. Proper MTEXT structure parsing required.
- **A cryptic block name beat the dictionary.** The toilet is `tp`. No keyword
  match. Only context resolved it. This is the canonical case for the AI layer +
  caching, not a reason to expand the hardcoded dictionary.

These aren't reasons for caution so much as confirmation of *why* the
architecture has the shape it does. Expect more of them; the gate and the
human-confirm loop are how they surface safely.

---

## 8. Explicitly out of scope for v1

- DWG ingestion (DXF only; conversion is a separate front-end later).
- View-segmentation / picking the current design option (the human does this).
- Wall height (full/half) as a *derived* value (flag it; it's in the sections).
- Fine material beyond solid-vs-framed on wood-frame sets.
- Commercial / masonry / CMU building types.
- Anything downstream of the data contract (that's the Beam Framer, unchanged).
