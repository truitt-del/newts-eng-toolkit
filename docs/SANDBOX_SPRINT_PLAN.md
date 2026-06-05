# CAD-AI Sandbox — Sprint Plan (V2.2)

A web-based testbed for iterating on AI-assisted CAD analysis. Load a DXF, run it against different AI models with an editable skills file, see the results rendered on the plan, and compare token usage and latency. The first concrete task is bearing-wall opening detection.

---

## The Mental Model

There are **two transformation layers** between a raw DXF and dots on the screen. Keep them separate at all times.

**Deterministic layer (code).** Same input → same output, always. This is: DXF parsing (including `POLYLINE` and `LWPOLYLINE` support), automatic unit scaling, bearing/non-bearing classification (matching bounding boxes to hatches), and geometric preprocessing (segment decomposition, centerline computation).

**Probabilistic layer (AI).** Same input → possibly different output. Applies judgment. This is the model reading the payload and deciding what's a real opening. You tweak this by editing the *skills file* (system prompt) in the browser.

**The toggle** (raw vs precomputed) is a dial that moves the line between the two layers. 
* "Raw" = code does the minimum (passes layer name and vertices), AI does all geometry and spatial judgment.
* "Precomputed" = code decomposes walls into rectangular segments first, AI just groups segments and finds the gaps. 

The toggle exists so you can measure, per model, where that boundary belongs based on accuracy, token usage, and latency.

---

## Architecture & Tech Stack

- **Framework:** Next.js (App Router)
- **Language:** Full TypeScript (`.ts` and `.tsx` files; no mixed JavaScript)
- **Backend:** One Route Handler at `app/api/run/route.ts` configured with `export const maxDuration = 60;` (Vercel Pro timeout bypass). Takes `{provider, model, system, userPrompt, walls}`, calls the provider SDK, normalizes the response, and returns `{points, usage, raw}`.
- **Storage:** Client-side only. Prompts and skills files persist in standard browser `localStorage`.
- **Auth:** Vercel native deployment-level password protection (configured in the Vercel dashboard).
- **Hosting:** Vercel (repo on GitHub).

---

## Reference Material

- **[beam-locus-sandbox.jsx](file:///C:/Software%20Projects/Newts%20Engineering%20Toolkit/beam-locus-sandbox.jsx)** — Working reference for the DXF parser, SVG renderer, bearing classification, and segment decomposition. Port from this, but apply the gaps noted in the findings doc (`LWPOLYLINE` support, standard synchronous `localStorage` instead of custom `window.storage`, retaining `extraLines` in the parser output, and automatic unit scaling).
- **[SANDBOX_FINDINGS.md](file:///C:/Software%20Projects/Newts%20Engineering%20Toolkit/SANDBOX_FINDINGS.md)** — **REQUIRED READING before Phases 1, 3, and 4.** Contains: the evolved default skills file (ship it as the default system prompt), the three-output-format problem and why all three fallback parsers are needed, the raw-vs-precomputed history, the current decomposition tuning constants, the known false-positive details, and model behavior notes.

---

## Phases

### Phase 0 — Scaffold + Deploy Skeleton
* **Goal:** A live, password-protected "Hello World" Next.js app on Vercel, wired to GitHub.
* **Tasks:**
  * Initialize a Next.js App Router project in TypeScript.
  * Push to a new GitHub repository, connect to Vercel, and deploy.
  * Enable Vercel native password protection in the Vercel dashboard.
* **Gate:** Open the Vercel URL, authenticate with the password, and see the placeholder page. Confirm auto-deploy on push.

### Phase 1 — Basic DXF Parser & Upload UI
* **Goal:** A DXF parsing module that extracts raw polylines, hatches, and line entities with automatic unit scaling.
* **Tasks:**
  * Port `parseDXF` from the reference JSX into a TypeScript module `lib/dxf/parser.ts`.
  * Add support for `LWPOLYLINE` entities (extracting vertex group codes `10` and `20` sequentially).
  * Implement automatic unit scaling by scanning the DXF header for `$INSUNITS` (e.g., if code is `2` [feet], multiply coordinates by `12` to normalize all output coordinates to inches).
  * Extract `extraLines` (dashed/dotted walls) from the DXF.
  * Create a basic frontend file upload dropzone.
* **Gate:** Upload the test DXF. Browser console logs confirm successful extraction of wall polylines (standard and lightweight) and `extraLines` normalized to inches.

### Phase 2 — Canvas UI (SVG Renderer, Y-Flip, Pan/Zoom)
* **Goal:** Visual display of raw, unclassified wall lines in correct orientation and position.
* **Tasks:**
  * Port the SVG canvas renderer, Y-flip coordinates (-y in SVG space), bounding box auto-centering, and mouse-wheel pan/zoom logic from the JSX.
  * Render the parsed raw wall outlines and `extraLines`.
* **Gate:** Uploading the test DXF renders the outlines matching the Vectorworks drawing's orientation. Pan/zoom is smooth, and strokes do not scale up when zooming.

### Phase 3 — Bearing Classification & Segment Decomposition
* **Goal:** Classify bearing walls and decompose complex polygons into rectangular segments.
* **Tasks:**
  * Port `processWalls`, `findWallSegments` (parallel-edge axis-aligned pairing), and bounding box helpers. 
  * Add shaded fills to classified bearing walls.
  * *Note: Skip diagonal edges in segment decomposition for now (deferred for post-v1 iteration).*
* **Gate:** Uploading the test DXF correctly shades the 22 bearing walls gray. Bounding box coordinates and precomputed segments are inspectable and aligned.

### Phase 4 — Relay Backend (Gemini First)
* **Goal:** Full execution loop using Google AI Studio.
* **Tasks:**
  * Create Route Handler `app/api/run/route.ts` with Vercel Pro configuration (`export const maxDuration = 60;`).
  * Implement the Gemini pathway using the `@google/genai` SDK and the `GEMINI_API_KEY` environment variable.
  * Default to `gemini-3.5-flash` model ID.
  * Port response normalization and the three fallback parsers (tool extraction, JSON scan, markdown regex) to the backend.
  * Wire the frontend "Run AI" button to this route.
* **Gate:** Upload the DXF, hit "Run AI", and verify that locus points return from Gemini and render in the correct spots on the plan.

### Phase 5 — Add Claude Support & Model Selector
* **Goal:** Integrate Anthropic models and a selector dropdown.
* **Tasks:**
  * Add the Anthropic pathway to `app/api/run/route.ts` using `@anthropic-ai/sdk` and `ANTHROPIC_API_KEY`.
  * Support model IDs `claude-sonnet-4-6` and `claude-opus-4-8`.
  * Add a model selector dropdown to the frontend: `gemini-3.5-flash`, `gemini-3.1-pro`, `claude-sonnet-4-6`, `claude-opus-4-8`.
* **Gate:** Swapping models successfully queries the correct provider backend, handles different tool-calling payload shapes, and renders points.

### Phase 6 — Raw/Precomputed Toggle, Metrics, & Prompt Storage
* **Goal:** Toggle between raw/precomputed payloads, display latency/tokens, and persist prompt modifications.
* **Tasks:**
  * Build the payload-builder supporting both "Raw" (wall vertices only) and "Precomputed" (pre-segmented wall structures) modes.
  * Display input tokens, output tokens, and wall-clock API latency per run.
  * Replace the JSX async storage hooks with standard synchronous browser `localStorage` to persist custom system and user prompts.
* **Gate:** Verify that toggling between modes changes the request payload in the network tab. Latency and token metrics update correctly, and custom prompts persist across page refreshes.

---

## Out of Scope for v1

- Multi-panel side-by-side comparison panes (keep to a single active plan view).
- Database storage or sharing runs via URL.
