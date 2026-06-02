import { Vertex, ParsedDXF } from './parser';

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface WallSegment {
  longAxis: 'X' | 'Y';
  centerline: number;
  endpointMin: number;
  endpointMax: number;
}

export interface ClassifiedWall {
  id: number;
  layer: string;
  bearing: boolean;
  vertices: Vertex[];
  bbox: BBox | null;
  segments: WallSegment[];
}

export function bboxOf(points: Vertex[]): BBox | null {
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

export function bboxesMatch(b1: BBox | null, b2: BBox | null, tol: number = 1.0): boolean {
  if (!b1 || !b2) return false;
  return Math.abs(b1.minX - b2.minX) < tol &&
         Math.abs(b1.maxX - b2.maxX) < tol &&
         Math.abs(b1.minY - b2.minY) < tol &&
         Math.abs(b1.maxY - b2.maxY) < tol;
}

// Shoelace formula for polygon area
export function polygonArea(vertices: Vertex[]): number {
  if (!vertices || vertices.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

interface Edge {
  runs: 'X' | 'Y';
  perp: number;
  parMin: number;
  parMax: number;
}

export function findWallSegments(vertices: Vertex[]): WallSegment[] {
  const WALL_THICKNESS_MAX = 12; // inches
  const MERGE_TOL = 0.5;          // centerline matching tolerance, inches
  const MIN_OVERLAP = 1;          // minimum parallel overlap to count as a segment, inches

  // 1. Extract axis-aligned edges
  const edges: Edge[] = [];
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
  const rawSegments: WallSegment[] = [];
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
  const groups: { [key: string]: WallSegment[] } = {};
  for (const s of rawSegments) {
    const cKey = Math.round(s.centerline / MERGE_TOL) * MERGE_TOL;
    const key = `${s.longAxis}_${cKey.toFixed(2)}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  const merged: WallSegment[] = [];
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

export function processWalls(parsed: ParsedDXF): ClassifiedWall[] {
  const wallLayerHint = (name: string) => /wall/i.test(name);
  const wallPolylines = parsed.polylines.filter(p => wallLayerHint(p.layer));
  const wallHatches = parsed.hatches.filter(h => wallLayerHint(h.layer));
  const hatchBboxes = wallHatches.map(h => bboxOf(h.boundaryPoints)).filter((bb): bb is BBox => bb !== null);

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
