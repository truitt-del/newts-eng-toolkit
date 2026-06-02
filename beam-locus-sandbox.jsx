import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Upload, Play, Loader2, RotateCcw, FileText, AlertCircle, Eye, EyeOff } from 'lucide-react';

// ============================================================
// DXF PARSER
// ============================================================
function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    const code = parseInt(codeStr, 10);
    if (isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }

  const polylines = [];
  const hatches = [];
  const lineEntities = [];

  let entityType = null;
  let currentEntity = null;
  let currentPolyline = null;
  let hatchInBoundary = false;

  for (let i = 0; i < pairs.length; i++) {
    const [code, valueRaw] = pairs[i];
    const value = valueRaw == null ? '' : valueRaw;

    if (code === 0) {
      const v = value.trim();

      if (v === 'POLYLINE') {
        currentPolyline = { layer: '', vertices: [] };
        polylines.push(currentPolyline);
        entityType = 'POLYLINE';
        currentEntity = currentPolyline;
      } else if (v === 'VERTEX' && currentPolyline) {
        currentEntity = { x: 0, y: 0 };
        currentPolyline.vertices.push(currentEntity);
        entityType = 'VERTEX';
      } else if (v === 'SEQEND') {
        currentPolyline = null;
        currentEntity = null;
        entityType = null;
      } else if (v === 'HATCH') {
        currentEntity = { layer: '', boundaryPoints: [] };
        hatches.push(currentEntity);
        entityType = 'HATCH';
        hatchInBoundary = false;
      } else if (v === 'LINE') {
        currentEntity = { layer: '', x1: 0, y1: 0, x2: 0, y2: 0 };
        lineEntities.push(currentEntity);
        entityType = 'LINE';
      } else {
        currentEntity = null;
        entityType = null;
        currentPolyline = null;
      }
      continue;
    }

    if (!currentEntity) continue;

    if (code === 8) {
      currentEntity.layer = value.trim();
      continue;
    }

    if (entityType === 'VERTEX') {
      if (code === 10) currentEntity.x = parseFloat(value);
      else if (code === 20) currentEntity.y = parseFloat(value);
    } else if (entityType === 'LINE') {
      if (code === 10) currentEntity.x1 = parseFloat(value);
      else if (code === 20) currentEntity.y1 = parseFloat(value);
      else if (code === 11) currentEntity.x2 = parseFloat(value);
      else if (code === 21) currentEntity.y2 = parseFloat(value);
    } else if (entityType === 'HATCH') {
      // Group code 92 = boundary path type flag (start of boundary edge data).
      // Group code 97 = number of source objects (marks END of boundary edges;
      // anything after is pattern/seed-point data we must skip).
      if (code === 92) {
        hatchInBoundary = true;
      } else if (code === 97 || code === 75 || code === 76 || code === 98) {
        hatchInBoundary = false;
      } else if (hatchInBoundary) {
        if (code === 10) {
          currentEntity.boundaryPoints.push({ x: parseFloat(value), y: 0, _pending: true });
        } else if (code === 20) {
          const last = currentEntity.boundaryPoints[currentEntity.boundaryPoints.length - 1];
          if (last && last._pending) {
            last.y = parseFloat(value);
            delete last._pending;
          }
        } else if (code === 11) {
          currentEntity.boundaryPoints.push({ x: parseFloat(value), y: 0, _pending: true });
        } else if (code === 21) {
          const last = currentEntity.boundaryPoints[currentEntity.boundaryPoints.length - 1];
          if (last && last._pending) {
            last.y = parseFloat(value);
            delete last._pending;
          }
        }
      }
    }
  }

  return { polylines, hatches, lineEntities };
}

// ============================================================
// BEARING CLASSIFICATION
// ============================================================
function bboxOf(points) {
  if (!points || points.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

function bboxesMatch(b1, b2, tol = 1.0) {
  if (!b1 || !b2) return false;
  return Math.abs(b1.minX - b2.minX) < tol &&
         Math.abs(b1.maxX - b2.maxX) < tol &&
         Math.abs(b1.minY - b2.minY) < tol &&
         Math.abs(b1.maxY - b2.maxY) < tol;
}

// Shoelace formula for polygon area
function polygonArea(vertices) {
  if (!vertices || vertices.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

// Decompose a wall polygon into ALL of its rectangular segments by finding
// every pair of parallel axis-aligned edges that are close enough (within
// wall-thickness range) and have overlap along their parallel direction.
// Each pair defines a segment with a longAxis, centerline, and endpoint range.
// Then merges co-linear segments (same longAxis + centerline) that touch or overlap.
//
// This correctly handles:
//   - Simple rectangles → 1 segment
//   - L-shapes (e.g. corner walls) → 2 segments (one per arm)
//   - Stepped/complex walls → N segments
//   - Walls with collinear-marker vertices on long edges (VW exports often have these) → still merged correctly
//
// Diagonal walls are not yet supported — diagonal edges are skipped.
function findWallSegments(vertices) {
  const WALL_THICKNESS_MAX = 12; // inches
  const MERGE_TOL = 0.5;          // centerline matching tolerance, inches
  const MIN_OVERLAP = 1;          // minimum parallel overlap to count as a segment, inches

  // 1. Extract axis-aligned edges
  const edges = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
    if (Math.abs(dy) < 0.01) {
      // Horizontal edge — runs along X axis
      edges.push({ runs: 'X', perp: a.y, parMin: Math.min(a.x, b.x), parMax: Math.max(a.x, b.x) });
    } else if (Math.abs(dx) < 0.01) {
      // Vertical edge — runs along Y axis
      edges.push({ runs: 'Y', perp: a.x, parMin: Math.min(a.y, b.y), parMax: Math.max(a.y, b.y) });
    }
    // diagonal edges intentionally skipped (TODO: support diagonal walls)
  }

  // 2. Pair parallel edges within wall-thickness distance to find segments
  const rawSegments = [];
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e1 = edges[i], e2 = edges[j];
      if (e1.runs !== e2.runs) continue;
      const dist = Math.abs(e1.perp - e2.perp);
      if (dist < 0.5 || dist > WALL_THICKNESS_MAX) continue;
      const overlapMin = Math.max(e1.parMin, e2.parMin);
      const overlapMax = Math.min(e1.parMax, e2.parMax);
      if (overlapMax - overlapMin < MIN_OVERLAP) continue;
      rawSegments.push({
        longAxis: e1.runs,
        centerline: (e1.perp + e2.perp) / 2,
        endpointMin: overlapMin,
        endpointMax: overlapMax,
      });
    }
  }

  // 3. Group by (longAxis, centerline) and merge touching/overlapping intervals
  const groups = {};
  for (const s of rawSegments) {
    const cKey = Math.round(s.centerline / MERGE_TOL) * MERGE_TOL;
    const key = `${s.longAxis}_${cKey.toFixed(2)}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  const merged = [];
  for (const group of Object.values(groups)) {
    group.sort((a, b) => a.endpointMin - b.endpointMin);
    let current = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      if (group[i].endpointMin <= current.endpointMax + 0.1) {
        current.endpointMax = Math.max(current.endpointMax, group[i].endpointMax);
        // Use average centerline across merged segments
        current.centerline = (current.centerline + group[i].centerline) / 2;
      } else {
        merged.push(current);
        current = { ...group[i] };
      }
    }
    merged.push(current);
  }

  // 4. Round for clean output
  return merged.map(s => ({
    longAxis: s.longAxis,
    centerline: Math.round(s.centerline * 100) / 100,
    endpointMin: Math.round(s.endpointMin * 100) / 100,
    endpointMax: Math.round(s.endpointMax * 100) / 100,
  }));
}

function processWalls(parsed) {
  const wallLayerHint = (name) => /wall/i.test(name);
  const wallPolylines = parsed.polylines.filter(p => wallLayerHint(p.layer));
  const wallHatches = parsed.hatches.filter(h => wallLayerHint(h.layer));
  const hatchBboxes = wallHatches.map(h => bboxOf(h.boundaryPoints)).filter(Boolean);

  const walls = wallPolylines.map((p, i) => {
    const bbox = bboxOf(p.vertices);
    const bearing = hatchBboxes.some(hb => bboxesMatch(bbox, hb));
    const segments = findWallSegments(p.vertices);
    return {
      id: i,
      layer: p.layer,
      bearing,
      vertices: p.vertices.map(v => ({ x: v.x, y: v.y })),
      bbox,
      segments,
    };
  });

  return walls;
}

// Fallback: extract points from markdown-style prose like "- BLUE: (123, -45)"
// Used when the model emits a textual answer instead of calling the tool or
// returning a JSON array. Pairs colors with the nearest preceding "open-N" label.
function extractPointsFromMarkdown(text) {
  if (!text) return [];
  const colorRe = /\b(blue|red|green|orange|purple|yellow|black|cyan|magenta)\b\s*[:=]?\s*\(?\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)?/gi;
  const openRe = /open[-_\s]*(\d+)/gi;

  const opens = [];
  let m;
  while ((m = openRe.exec(text)) !== null) {
    opens.push({ index: m.index, n: m[1] });
  }

  const points = [];
  while ((m = colorRe.exec(text)) !== null) {
    const color = m[1].toLowerCase();
    const x = parseFloat(m[2]);
    const y = parseFloat(m[3]);
    if (!isFinite(x) || !isFinite(y)) continue;

    let openN = null;
    for (let i = opens.length - 1; i >= 0; i--) {
      if (opens[i].index < m.index) { openN = opens[i].n; break; }
    }
    const role = (color === 'blue' || color === 'green') ? 'start' : 'end';
    const label = openN ? `open-${openN}-${role}` : `${color}-${points.length}`;
    points.push({ x, y, color, label });
  }
  return points;
}

// ============================================================
// ROBUST JSON EXTRACTION
// ============================================================
// Handles: prefilled responses, markdown fences, truncated arrays,
// trailing prose. Recovers complete {...} objects even if the array
// was cut off mid-stream.
function extractPoints(rawText) {
  if (!rawText) return [];
  // Strip markdown fences just in case
  let text = rawText.replace(/```json|```/g, '');

  // Try direct full-array parse first
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(text.substring(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) {
        return parsed.filter(p => typeof p?.x === 'number' && typeof p?.y === 'number');
      }
    } catch (e) { /* fall through to recovery */ }
  }

  // Recovery: walk the text, extract every complete top-level {...} object.
  // Survives truncation, embedded prose, mismatched closing brackets.
  const objects = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(text.substring(objStart, i + 1));
          if (typeof obj?.x === 'number' && typeof obj?.y === 'number') {
            objects.push(obj);
          }
        } catch (e) { /* skip malformed */ }
        objStart = -1;
      }
    }
  }
  return objects;
}

// ============================================================
// DEFAULTS
// ============================================================
const DEFAULT_SYSTEM_PROMPT = `You analyze structural floor plans and emit locus points by calling the render_locus_points tool. The tool call IS your output. Do NOT emit text, prose, lists, markdown, or analysis — only the tool call.

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

CALL THE TOOL. NO TEXT OUTPUT.`;

const DEFAULT_USER_PROMPT = ``;

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function BeamLocusSandbox() {
  const [walls, setWalls] = useState([]);
  const [extraLines, setExtraLines] = useState([]);
  const [fileName, setFileName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [userPrompt, setUserPrompt] = useState(DEFAULT_USER_PROMPT);
  const [points, setPoints] = useState([]);
  const [rawResponse, setRawResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [resetArmed, setResetArmed] = useState({ system: false, user: false });
  const [usage, setUsage] = useState(null);
  const [viewBox, setViewBox] = useState(null);
  const [originalViewBox, setOriginalViewBox] = useState(null);
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef(null);
  const dragStart = useRef(null);

  // Load saved prompts on mount
  useEffect(() => {
    (async () => {
      try {
        if (window.storage) {
          const sp = await window.storage.get('systemPrompt').catch(() => null);
          if (sp?.value) setSystemPrompt(sp.value);
          const up = await window.storage.get('userPrompt').catch(() => null);
          if (up?.value) setUserPrompt(up.value);
        }
      } catch (e) { /* ignore */ }
    })();
  }, []);

  // Persist prompts (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      if (window.storage) {
        window.storage.set('systemPrompt', systemPrompt).catch(() => {});
      }
    }, 500);
    return () => clearTimeout(t);
  }, [systemPrompt]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (window.storage) {
        window.storage.set('userPrompt', userPrompt).catch(() => {});
      }
    }, 500);
    return () => clearTimeout(t);
  }, [userPrompt]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    setPoints([]);
    setRawResponse('');
    try {
      const text = await file.text();
      const parsed = parseDXF(text);
      const w = processWalls(parsed);
      if (w.length === 0) {
        setError('No walls found. Looking for polylines on a layer with "wall" in the name.');
        return;
      }
      setWalls(w);
      setExtraLines(parsed.lineEntities.filter(l => /wall/i.test(l.layer)));
      setFileName(file.name);

      // Compute view box from all geometry (flipped Y)
      const allPoints = w.flatMap(wall => wall.vertices);
      const bb = bboxOf(allPoints);
      if (bb) {
        const padX = (bb.maxX - bb.minX) * 0.08;
        const padY = (bb.maxY - bb.minY) * 0.08;
        // Flip Y: SVG y = -world y
        const vb = {
          x: bb.minX - padX,
          y: -bb.maxY - padY,
          w: (bb.maxX - bb.minX) + padX * 2,
          h: (bb.maxY - bb.minY) + padY * 2,
        };
        setViewBox(vb);
        setOriginalViewBox(vb);
      }
    } catch (e) {
      setError(`Failed to parse DXF: ${e.message}`);
    }
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const runAI = async () => {
    if (walls.length === 0) {
      setError('Load a DXF first.');
      return;
    }
    setLoading(true);
    setError(null);
    setPoints([]);
    setRawResponse('');
    setUsage(null);

    try {
      const wallData = walls.map(w => ({
        id: w.id,
        bearing: w.bearing,
        segments: w.segments,
      }));

      const trimmedUserPrompt = userPrompt.trim();
      const userContent = trimmedUserPrompt
        ? `WALL DATA (coordinates in inches):\n${JSON.stringify(wallData, null, 2)}\n\nADDITIONAL INSTRUCTIONS:\n${trimmedUserPrompt}\n\nNow call render_locus_points with all locus points.`
        : `WALL DATA (coordinates in inches):\n${JSON.stringify(wallData, null, 2)}\n\nNow call render_locus_points with all locus points.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8000,
          system: systemPrompt,
          tools: [{
            name: 'render_locus_points',
            description: 'Render the locus points you have identified onto the floor plan view. Call this with the complete list of points.',
            input_schema: {
              type: 'object',
              properties: {
                points: {
                  type: 'array',
                  description: 'Array of locus points to display on the plan',
                  items: {
                    type: 'object',
                    properties: {
                      x: { type: 'number', description: 'X coordinate in inches' },
                      y: { type: 'number', description: 'Y coordinate in inches' },
                      color: { type: 'string', description: 'CSS color name or hex code' },
                      label: { type: 'string', description: 'Brief label, under 24 chars' },
                    },
                    required: ['x', 'y', 'color', 'label'],
                  },
                },
              },
              required: ['points'],
            },
          }],
          tool_choice: { type: 'tool', name: 'render_locus_points' },
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      const data = await response.json();

      // Capture token usage for visibility
      if (data.usage) {
        setUsage({
          input: data.usage.input_tokens,
          output: data.usage.output_tokens,
          max: 8000,
        });
      }

      // Capture full response for debugging (text blocks + tool_use blocks)
      const debugText = (data.content || []).map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'tool_use') return `[tool_use: ${c.name}]\n${JSON.stringify(c.input, null, 2)}`;
        return `[${c.type} block]`;
      }).join('\n\n');
      setRawResponse(debugText);

      const stopReason = data.stop_reason;
      const truncated = stopReason === 'max_tokens';

      // Primary path: extract points from forced tool_use block
      const toolBlock = (data.content || []).find(c => c.type === 'tool_use' && c.name === 'render_locus_points');
      let extracted = [];
      let recoveryMethod = '';
      if (toolBlock?.input?.points && Array.isArray(toolBlock.input.points)) {
        extracted = toolBlock.input.points.filter(p => typeof p?.x === 'number' && typeof p?.y === 'number');
        recoveryMethod = 'tool_use';
      } else {
        // Fallback 1: try to recover JSON points from any text content
        const textContent = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
        extracted = extractPoints(textContent);
        if (extracted.length > 0) {
          recoveryMethod = 'json_in_text';
        } else {
          // Fallback 2: parse markdown-style "BLUE: (x, y)" patterns
          extracted = extractPointsFromMarkdown(textContent);
          if (extracted.length > 0) recoveryMethod = 'markdown';
        }
      }

      if (extracted.length > 0) {
        setPoints(extracted);
        if (truncated) {
          setError(`Response was truncated at max_tokens (${extracted.length} points recovered before cutoff). Reduce task scope or split into multiple runs.`);
        }
      } else {
        setError(truncated
          ? 'Response was truncated and no points could be recovered. Tighten the prompt or reduce scope.'
          : 'No points returned. See raw response below.');
        setShowRaw(true);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const resetView = () => {
    if (originalViewBox) setViewBox(originalViewBox);
  };

  const clearPoints = () => {
    setPoints([]);
    setRawResponse('');
    setError(null);
  };

  // Mouse wheel zoom
  const onWheel = (e) => {
    if (!viewBox) return;
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const factor = e.deltaY < 0 ? 0.85 : 1.18;
    const newW = viewBox.w * factor;
    const newH = viewBox.h * factor;
    const newX = svgPt.x - (svgPt.x - viewBox.x) * factor;
    const newY = svgPt.y - (svgPt.y - viewBox.y) * factor;
    setViewBox({ x: newX, y: newY, w: newW, h: newH });
  };

  const onMouseDown = (e) => {
    if (!viewBox) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, vb: { ...viewBox } };
  };

  const onMouseMove = (e) => {
    if (!dragging || !dragStart.current || !viewBox) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    const dx = (e.clientX - dragStart.current.x) * scaleX;
    const dy = (e.clientY - dragStart.current.y) * scaleY;
    setViewBox({
      x: dragStart.current.vb.x - dx,
      y: dragStart.current.vb.y - dy,
      w: dragStart.current.vb.w,
      h: dragStart.current.vb.h,
    });
  };

  const onMouseUp = () => {
    setDragging(false);
    dragStart.current = null;
  };

  const stats = useMemo(() => {
    const bearing = walls.filter(w => w.bearing).length;
    return { total: walls.length, bearing, nonBearing: walls.length - bearing };
  }, [walls]);

  // Dot radius scales with current viewBox so dots stay visible at any zoom
  const dotRadius = viewBox ? Math.max(1.5, viewBox.w / 180) : 4;
  const strokeWidth = viewBox ? Math.max(0.3, viewBox.w / 800) : 0.5;

  return (
    <div className="min-h-screen w-full" style={{
      background: '#f5f1e6',
      fontFamily: "'Fraunces', Georgia, serif",
      color: '#2a261f',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        textarea, input { font-family: 'JetBrains Mono', monospace; }
        .paper-shadow { box-shadow: 0 1px 0 rgba(42,38,31,0.04), 0 2px 8px rgba(42,38,31,0.06); }
        .grid-bg {
          background-image:
            linear-gradient(rgba(42,38,31,0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(42,38,31,0.04) 1px, transparent 1px);
          background-size: 24px 24px;
        }
        button:not(:disabled):active { transform: translateY(1px); }
        .ink-btn {
          background: #2a261f;
          color: #f5f1e6;
          border: 1px solid #2a261f;
          transition: background 0.15s;
        }
        .ink-btn:not(:disabled):hover { background: #a8442e; border-color: #a8442e; }
        .ink-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .ghost-btn {
          background: transparent;
          color: #2a261f;
          border: 1px solid #2a261f;
          transition: background 0.15s;
        }
        .ghost-btn:not(:disabled):hover { background: #2a261f; color: #f5f1e6; }
        .ghost-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .scrollbar-thin::-webkit-scrollbar { width: 8px; height: 8px; }
        .scrollbar-thin::-webkit-scrollbar-track { background: #ebe5d3; }
        .scrollbar-thin::-webkit-scrollbar-thumb { background: #a8442e; border-radius: 0; }
      `}</style>

      {/* HEADER */}
      <div className="border-b" style={{ borderColor: '#2a261f', background: '#ebe5d3' }}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <div className="mono text-xs uppercase tracking-widest" style={{ color: '#a8442e' }}>
              AV Engineering · Sandbox
            </div>
            <h1 className="text-2xl mt-1" style={{ fontWeight: 600, letterSpacing: '-0.02em' }}>
              Beam Locus Sandbox
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <label className="ink-btn px-4 py-2 mono text-xs uppercase tracking-wider cursor-pointer flex items-center gap-2">
              <Upload size={14} />
              {fileName ? 'Replace DXF' : 'Load DXF'}
              <input
                type="file"
                accept=".dxf"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </label>
            {walls.length > 0 && (
              <button onClick={resetView} className="ghost-btn px-3 py-2 mono text-xs uppercase tracking-wider flex items-center gap-2" title="Reset zoom">
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* MAIN GRID */}
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">

        {/* PLAN STATS */}
        {walls.length > 0 && (
          <div className="flex items-center gap-6 mono text-xs uppercase tracking-wider flex-wrap" style={{ color: '#5a5045' }}>
            <span>File: <span style={{ color: '#2a261f' }}>{fileName}</span></span>
            <span>Walls: <span style={{ color: '#2a261f' }}>{stats.total}</span></span>
            <span>Bearing: <span style={{ color: '#2a261f' }}>{stats.bearing}</span></span>
            <span>Non-bearing: <span style={{ color: '#2a261f' }}>{stats.nonBearing}</span></span>
            {points.length > 0 && <span>Locus points: <span style={{ color: '#a8442e' }}>{points.length}</span></span>}
            {usage && (
              <span>
                Tokens: <span style={{ color: '#2a261f' }}>{usage.input.toLocaleString()} in</span>
                {' · '}
                <span style={{ color: usage.output > usage.max * 0.85 ? '#a8442e' : '#2a261f' }}>
                  {usage.output.toLocaleString()} out
                </span>
                {' '}
                <span style={{ color: usage.output > usage.max * 0.85 ? '#a8442e' : '#8a7f6f' }}>
                  ({Math.round((usage.output / usage.max) * 100)}% of {usage.max.toLocaleString()})
                </span>
              </span>
            )}
          </div>
        )}

        {/* PLAN VIEW */}
        <div
          className="paper-shadow border relative"
          style={{ borderColor: '#2a261f', background: '#fbf8ef', height: '60vh', minHeight: 400 }}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          {walls.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center grid-bg">
              <div className="text-center">
                <FileText size={48} style={{ color: '#a8442e' }} className="mx-auto mb-3" />
                <div className="mono text-xs uppercase tracking-widest mb-2" style={{ color: '#5a5045' }}>
                  No plan loaded
                </div>
                <div className="text-lg" style={{ color: '#2a261f' }}>
                  Drop a DXF file here, or use Load DXF above
                </div>
                <div className="mono text-xs mt-3" style={{ color: '#8a7f6f' }}>
                  Export from Vectorworks: File → Export → Export DXF/DWG → Format: DXF (Text)
                </div>
              </div>
            </div>
          ) : (
            <>
              <svg
                ref={svgRef}
                viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : '0 0 100 100'}
                style={{ width: '100%', height: '100%', cursor: dragging ? 'grabbing' : 'grab', display: 'block' }}
                onWheel={onWheel}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                preserveAspectRatio="xMidYMid meet"
              >
                {/* All wall polygons (Y flipped) */}
                {walls.map(w => (
                  <polygon
                    key={`w-${w.id}`}
                    points={w.vertices.map(v => `${v.x},${-v.y}`).join(' ')}
                    fill={w.bearing ? '#c8c4b5' : 'none'}
                    fillOpacity={w.bearing ? 0.85 : 0}
                    stroke="#2e5238"
                    strokeWidth={strokeWidth}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {/* Extra lines (e.g., dashed indicators) */}
                {extraLines.map((l, i) => (
                  <line
                    key={`l-${i}`}
                    x1={l.x1} y1={-l.y1} x2={l.x2} y2={-l.y2}
                    stroke="#2e5238"
                    strokeWidth={strokeWidth}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {/* AI-returned locus points */}
                {points.map((p, i) => (
                  <g key={`p-${i}`}>
                    <circle
                      cx={p.x}
                      cy={-p.y}
                      r={dotRadius}
                      fill={p.color || '#a8442e'}
                      stroke="#2a261f"
                      strokeWidth={strokeWidth * 0.7}
                      vectorEffect="non-scaling-stroke"
                    />
                    {p.label && (
                      <text
                        x={p.x + dotRadius * 1.4}
                        y={-p.y - dotRadius * 0.8}
                        fontSize={dotRadius * 1.6}
                        fill="#2a261f"
                        style={{ fontFamily: 'JetBrains Mono, monospace', pointerEvents: 'none' }}
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
              <div className="absolute bottom-2 right-3 mono text-xs" style={{ color: '#8a7f6f' }}>
                scroll to zoom · drag to pan
              </div>
            </>
          )}
        </div>

        {/* PROMPT WORKSHOP */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="paper-shadow border" style={{ borderColor: '#2a261f', background: '#fbf8ef' }}>
            <div className="px-4 py-2 border-b mono text-xs uppercase tracking-wider flex items-center justify-between" style={{ borderColor: '#2a261f', background: '#ebe5d3' }}>
              <span>Skills File · system prompt (task baked in)</span>
              <div className="flex items-center gap-3">
                <span style={{ color: '#8a7f6f' }}>{systemPrompt.length} chars</span>
                <button
                  onClick={() => {
                    if (resetArmed.system) {
                      setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
                      setResetArmed(s => ({ ...s, system: false }));
                    } else {
                      setResetArmed(s => ({ ...s, system: true }));
                      setTimeout(() => setResetArmed(s => ({ ...s, system: false })), 3000);
                    }
                  }}
                  className="underline"
                  style={{ color: '#a8442e', fontSize: 10, fontWeight: resetArmed.system ? 600 : 400 }}
                >
                  {resetArmed.system ? 'click again to confirm' : 'reset'}
                </button>
              </div>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="w-full p-4 text-xs scrollbar-thin focus:outline-none"
              style={{ height: 280, background: '#fbf8ef', color: '#2a261f', resize: 'vertical', border: 'none', lineHeight: 1.55 }}
              spellCheck={false}
            />
          </div>
          <div className="paper-shadow border" style={{ borderColor: '#2a261f', background: '#fbf8ef' }}>
            <div className="px-4 py-2 border-b mono text-xs uppercase tracking-wider flex items-center justify-between" style={{ borderColor: '#2a261f', background: '#ebe5d3' }}>
              <span>Additional Instructions · optional, this run only</span>
              <div className="flex items-center gap-3">
                <span style={{ color: '#8a7f6f' }}>{userPrompt.length} chars</span>
                <button
                  onClick={() => {
                    if (resetArmed.user) {
                      setUserPrompt(DEFAULT_USER_PROMPT);
                      setResetArmed(s => ({ ...s, user: false }));
                    } else {
                      setResetArmed(s => ({ ...s, user: true }));
                      setTimeout(() => setResetArmed(s => ({ ...s, user: false })), 3000);
                    }
                  }}
                  className="underline"
                  style={{ color: '#a8442e', fontSize: 10, fontWeight: resetArmed.user ? 600 : 400 }}
                >
                  {resetArmed.user ? 'click again to confirm' : 'clear'}
                </button>
              </div>
            </div>
            <textarea
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              placeholder="(optional) override or modify the primary task for this run only — e.g., 'instead of two dots per opening, place one dot at the centerline midpoint of each opening'"
              className="w-full p-4 text-xs scrollbar-thin focus:outline-none"
              style={{ height: 280, background: '#fbf8ef', color: '#2a261f', resize: 'vertical', border: 'none', lineHeight: 1.55 }}
              spellCheck={false}
            />
          </div>
        </div>

        {/* CONTROLS */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={runAI}
            disabled={loading || walls.length === 0}
            className="ink-btn px-6 py-3 mono text-xs uppercase tracking-widest flex items-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {loading ? 'Asking Claude…' : 'Run AI'}
          </button>
          {points.length > 0 && (
            <button onClick={clearPoints} className="ghost-btn px-4 py-3 mono text-xs uppercase tracking-widest">
              Clear points
            </button>
          )}
          {rawResponse && (
            <button onClick={() => setShowRaw(!showRaw)} className="ghost-btn px-4 py-3 mono text-xs uppercase tracking-widest flex items-center gap-2">
              {showRaw ? <EyeOff size={14} /> : <Eye size={14} />}
              {showRaw ? 'Hide' : 'Show'} raw response
            </button>
          )}
        </div>

        {/* ERROR */}
        {error && (
          <div className="paper-shadow border p-4 flex items-start gap-3" style={{ borderColor: '#a8442e', background: '#fbf8ef' }}>
            <AlertCircle size={18} style={{ color: '#a8442e', flexShrink: 0, marginTop: 2 }} />
            <div className="mono text-xs" style={{ color: '#a8442e', lineHeight: 1.5 }}>{error}</div>
          </div>
        )}

        {/* RAW RESPONSE */}
        {showRaw && rawResponse && (
          <div className="paper-shadow border" style={{ borderColor: '#2a261f', background: '#fbf8ef' }}>
            <div className="px-4 py-2 border-b mono text-xs uppercase tracking-wider" style={{ borderColor: '#2a261f', background: '#ebe5d3' }}>
              Raw AI response
            </div>
            <pre className="p-4 mono text-xs overflow-auto scrollbar-thin" style={{ maxHeight: 300, lineHeight: 1.5, color: '#2a261f' }}>
{rawResponse}
            </pre>
          </div>
        )}

        {/* LEGEND / FOOTER */}
        <div className="pt-4 border-t mono text-xs flex items-center gap-6 flex-wrap" style={{ borderColor: '#2a261f', color: '#5a5045' }}>
          <span className="flex items-center gap-2">
            <span style={{ display: 'inline-block', width: 16, height: 10, background: '#c8c4b5', border: '1px solid #2e5238' }} />
            Bearing wall
          </span>
          <span className="flex items-center gap-2">
            <span style={{ display: 'inline-block', width: 16, height: 10, border: '1px solid #2e5238' }} />
            Non-bearing wall
          </span>
          <span className="ml-auto" style={{ color: '#8a7f6f' }}>
            Model: claude-sonnet-4 · units: inches · Y-axis: up
          </span>
        </div>
      </div>
    </div>
  );
}
