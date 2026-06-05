import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';
import { buildDefaultMappings } from '../lib/cad/assembler';

const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
const dxfPath = path.resolve(relativePath);

const text = fs.readFileSync(dxfPath, 'utf-8');
const parsed = parseDXF(text);
const mappings = buildDefaultMappings(parsed);

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: string;
}

const wallSegments: Segment[] = [];
parsed.lineEntities.forEach(l => {
  const m = mappings[`layer:${l.layer}`];
  if (m && m.canonicalCategory === 'WALL') {
    wallSegments.push({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, layer: l.layer });
  }
});
parsed.polylines.forEach(p => {
  const m = mappings[`layer:${p.layer}`];
  if (m && m.canonicalCategory === 'WALL') {
    for (let i = 0; i + 1 < p.vertices.length; i++) {
      wallSegments.push({ x1: p.vertices[i].x, y1: p.vertices[i].y, x2: p.vertices[i + 1].x, y2: p.vertices[i + 1].y, layer: p.layer });
    }
  }
});

// Dedup function
function deduplicateSegments(segments: Segment[]): Segment[] {
  const seen = new Set<string>();
  const unique: Segment[] = [];

  for (const s of segments) {
    // Normalise so x1, y1 is the lexicographically smaller endpoint
    let x_1 = s.x1, y_1 = s.y1, x_2 = s.x2, y_2 = s.y2;
    if (x_1 > x_2 || (Math.abs(x_1 - x_2) < 1e-3 && y_1 > y_2)) {
      x_1 = s.x2; y_1 = s.y2;
      x_2 = s.x1; y_2 = s.y1;
    }
    const key = `${x_1.toFixed(3)},${y_1.toFixed(3)}->${x_2.toFixed(3)},${y_2.toFixed(3)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(s);
    }
  }
  return unique;
}

// Replicate the pipeline helper functions
function snapEndpoints(segments: Segment[], T_snap: number): Segment[] {
  const points: { x: number; y: number; segIdx: number; end: 1 | 2 }[] = [];
  segments.forEach((seg, idx) => {
    points.push({ x: seg.x1, y: seg.y1, segIdx: idx, end: 1 });
    points.push({ x: seg.x2, y: seg.y2, segIdx: idx, end: 2 });
  });

  const clusters: { x: number; y: number }[] = [];
  const ptToClusterIdx = new Map<number, number>();

  points.forEach((p, pIdx) => {
    let clusterIdx = -1;
    for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
      const c = clusters[cIdx];
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= T_snap) {
        clusterIdx = cIdx;
        break;
      }
    }
    if (clusterIdx === -1) {
      clusterIdx = clusters.length;
      clusters.push({ x: p.x, y: p.y });
    }
    ptToClusterIdx.set(pIdx, clusterIdx);
  });

  const snapped = segments.map(seg => ({ ...seg }));
  points.forEach((p, pIdx) => {
    const cIdx = ptToClusterIdx.get(pIdx)!;
    const c = clusters[cIdx];
    if (p.end === 1) {
      snapped[p.segIdx].x1 = c.x;
      snapped[p.segIdx].y1 = c.y;
    } else {
      snapped[p.segIdx].x2 = c.x;
      snapped[p.segIdx].y2 = c.y;
    }
  });

  return snapped.filter(seg => {
    const len = Math.sqrt((seg.x1 - seg.x2) ** 2 + (seg.y1 - seg.y2) ** 2);
    return len > 1e-3;
  });
}

function splitSegmentsAtIntersections(segments: Segment[]): Segment[] {
  const splits: Record<number, number[]> = {};
  for (let i = 0; i < segments.length; i++) {
    splits[i] = [];
  }

  for (let i = 0; i < segments.length; i++) {
    const s1 = segments[i];
    const dx1 = s1.x2 - s1.x1;
    const dy1 = s1.y2 - s1.y1;

    for (let j = i + 1; j < segments.length; j++) {
      const s2 = segments[j];
      const dx2 = s2.x2 - s2.x1;
      const dy2 = s2.y2 - s2.y1;

      const det = dx1 * dy2 - dy1 * dx2;
      if (Math.abs(det) < 1e-8) continue; // Parallel or collinear

      const t = ((s2.x1 - s1.x1) * dy2 - (s2.y1 - s1.y1) * dx2) / det;
      const u = ((s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1) / det;

      const eps = 1e-3;
      if (t >= eps && t <= 1 - eps && u >= eps && u <= 1 - eps) {
        splits[i].push(t);
        splits[j].push(u);
      }
    }
  }

  const result: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const tValues = splits[i];
    if (tValues.length === 0) {
      result.push(s);
    } else {
      tValues.sort((a, b) => a - b);
      const uniqueT: number[] = [];
      for (const t of tValues) {
        if (uniqueT.length === 0 || t - uniqueT[uniqueT.length - 1] > 1e-3) {
          uniqueT.push(t);
        }
      }

      let lastX = s.x1;
      let lastY = s.y1;
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;

      for (const t of uniqueT) {
        const nextX = s.x1 + t * dx;
        const nextY = s.y1 + t * dy;
        result.push({
          x1: lastX,
          y1: lastY,
          x2: nextX,
          y2: nextY,
          layer: s.layer
        });
        lastX = nextX;
        lastY = nextY;
      }
      result.push({
        x1: lastX,
        y1: lastY,
        x2: s.x2,
        y2: s.y2,
        layer: s.layer
      });
    }
  }

  return result;
}

function pruneDanglingEdges(segments: Segment[], T_prune: number): Segment[] {
  let active = segments.map(s => ({ ...s }));
  let changed = true;

  while (changed) {
    changed = false;
    const coordKey = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
    const degrees: Record<string, number> = {};

    for (const s of active) {
      const k1 = coordKey(s.x1, s.y1);
      const k2 = coordKey(s.x2, s.y2);
      degrees[k1] = (degrees[k1] || 0) + 1;
      degrees[k2] = (degrees[k2] || 0) + 1;
    }

    const nextActive: Segment[] = [];
    for (const s of active) {
      const k1 = coordKey(s.x1, s.y1);
      const k2 = coordKey(s.x2, s.y2);
      const deg1 = degrees[k1];
      const deg2 = degrees[k2];

      const len = Math.sqrt((s.x1 - s.x2) ** 2 + (s.y1 - s.y2) ** 2);

      if ((deg1 === 1 || deg2 === 1) && len < T_prune) {
        changed = true;
      } else {
        nextActive.push(s);
      }
    }
    active = nextActive;
  }

  return active;
}

function addJambClosures(segments: Segment[], W_min: number, W_max: number): Segment[] {
  const coordKey = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
  const degrees: Record<string, number> = {};

  for (const s of segments) {
    const k1 = coordKey(s.x1, s.y1);
    const k2 = coordKey(s.x2, s.y2);
    degrees[k1] = (degrees[k1] || 0) + 1;
    degrees[k2] = (degrees[k2] || 0) + 1;
  }

  interface DanglingPoint {
    x: number;
    y: number;
    key: string;
    seg: Segment;
  }

  const dangling: DanglingPoint[] = [];
  for (const s of segments) {
    const k1 = coordKey(s.x1, s.y1);
    const k2 = coordKey(s.x2, s.y2);
    if (degrees[k1] === 1) dangling.push({ x: s.x1, y: s.y1, key: k1, seg: s });
    if (degrees[k2] === 1) dangling.push({ x: s.x2, y: s.y2, key: k2, seg: s });
  }

  const closures: Segment[] = [];
  const used = new Set<string>();

  for (let i = 0; i < dangling.length; i++) {
    const p1 = dangling[i];
    if (used.has(p1.key)) continue;

    let bestP2: DanglingPoint | null = null;
    let bestDist = Infinity;

    for (let j = 0; j < dangling.length; j++) {
      if (i === j) continue;
      const p2 = dangling[j];
      if (used.has(p2.key)) continue;

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist >= W_min && dist <= W_max) {
        const s1 = p1.seg;
        const dx1 = s1.x2 - s1.x1;
        const dy1 = s1.y2 - s1.y1;
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

        const dot = (dx * dx1 + dy * dy1) / (dist * len1);
        if (Math.abs(dot) < 0.75) {
          if (dist < bestDist) {
            bestDist = dist;
            bestP2 = p2;
          }
        }
      }
    }

    if (bestP2) {
      closures.push({
        x1: p1.x,
        y1: p1.y,
        x2: bestP2.x,
        y2: bestP2.y,
        layer: p1.seg.layer
      });
      used.add(p1.key);
      used.add(bestP2.key);
    }
  }

  return [...segments, ...closures];
}

interface GraphVertex {
  id: number;
  x: number;
  y: number;
  key: string;
  edges: HalfEdge[];
}

interface HalfEdge {
  from: GraphVertex;
  to: GraphVertex;
  angle: number;
  visited: boolean;
  twin: HalfEdge;
  layer: string;
}

function extractPlanarCycles(segments: Segment[]): { vertices: { x: number; y: number }[]; layer: string }[] {
  const coordKey = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`;
  const verticesMap = new Map<string, GraphVertex>();
  let vertexIdSeq = 0;

  const getOrCreateVertex = (x: number, y: number): GraphVertex => {
    const key = coordKey(x, y);
    if (!verticesMap.has(key)) {
      verticesMap.set(key, {
        id: vertexIdSeq++,
        x,
        y,
        key,
        edges: []
      });
    }
    return verticesMap.get(key)!;
  };

  const halfEdges: HalfEdge[] = [];

  for (const s of segments) {
    const v1 = getOrCreateVertex(s.x1, s.y1);
    const v2 = getOrCreateVertex(s.x2, s.y2);

    const he1: Partial<HalfEdge> = {
      from: v1,
      to: v2,
      angle: Math.atan2(v2.y - v1.y, v2.x - v1.x),
      visited: false,
      layer: s.layer
    };
    const he2: Partial<HalfEdge> = {
      from: v2,
      to: v1,
      angle: Math.atan2(v1.y - v2.y, v1.x - v2.x),
      visited: false,
      layer: s.layer
    };

    const h1 = he1 as HalfEdge;
    const h2 = he2 as HalfEdge;
    h1.twin = h2;
    h2.twin = h1;

    v1.edges.push(h1);
    v2.edges.push(h2);

    halfEdges.push(h1, h2);
  }

  for (const v of verticesMap.values()) {
    v.edges.sort((a, b) => a.angle - b.angle);
  }

  const findEdgeIndex = (v: GraphVertex, edge: HalfEdge): number => {
    return v.edges.findIndex(e => e === edge);
  };

  const cycles: { vertices: { x: number; y: number }[]; layer: string }[] = [];

  for (const startEdge of halfEdges) {
    if (startEdge.visited) continue;

    const cycleEdges: HalfEdge[] = [];
    let curr = startEdge;

    while (!curr.visited) {
      curr.visited = true;
      cycleEdges.push(curr);

      const nextV = curr.to;
      const twin = curr.twin;
      const idx = findEdgeIndex(nextV, twin);
      if (idx === -1) break;

      const nextEdge = nextV.edges[(idx + 1) % nextV.edges.length];
      curr = nextEdge;
    }

    if (cycleEdges.length >= 3) {
      const polyVertices = cycleEdges.map(e => ({ x: e.from.x, y: e.from.y }));

      let areaSum = 0;
      for (let i = 0; i < polyVertices.length; i++) {
        const p1 = polyVertices[i];
        const p2 = polyVertices[(i + 1) % polyVertices.length];
        areaSum += p1.x * p2.y - p2.x * p1.y;
      }
      const signedArea = areaSum / 2;

      if (signedArea > 1e-3) {
        const layerCounts: Record<string, number> = {};
        for (const e of cycleEdges) {
          layerCounts[e.layer] = (layerCounts[e.layer] || 0) + 1;
        }
        let bestLayer = startEdge.layer;
        let maxCount = 0;
        for (const [lyr, count] of Object.entries(layerCounts)) {
          if (count > maxCount) {
            maxCount = count;
            bestLayer = lyr;
          }
        }

        cycles.push({
          vertices: polyVertices,
          layer: bestLayer
        });
      }
    }
  }

  return cycles;
}

const tolerances = {
  snap: 1.5,
  prune: 2.0,
  wMin: 3.0,
  wMax: 12.0
};

console.log('--- TESTING WITH DEDUPLICATION ---');
let deduped = deduplicateSegments(wallSegments);
console.log(`Original segments: ${wallSegments.length}, Deduped: ${deduped.length}`);

let processed = snapEndpoints(deduped, tolerances.snap);
processed = splitSegmentsAtIntersections(processed);
processed = snapEndpoints(processed, tolerances.snap);
processed = pruneDanglingEdges(processed, tolerances.prune);
processed = addJambClosures(processed, tolerances.wMin, tolerances.wMax);
processed = snapEndpoints(processed, tolerances.snap);

// Final dedup step on the cleaned segments to make absolutely sure no duplicates got introduced via snaps/closures
processed = deduplicateSegments(processed);

const cycles = extractPlanarCycles(processed);
console.log(`\nTotal extracted cycles with dedup: ${cycles.length}`);

const garageCycles = cycles.filter(cyc => 
  cyc.vertices.some(v => v.x > 150 && v.y < 50)
);
console.log(`Garage region cycles found: ${garageCycles.length}`);
garageCycles.forEach((cyc, idx) => {
  let areaSum = 0;
  for (let i = 0; i < cyc.vertices.length; i++) {
    const p1 = cyc.vertices[i];
    const p2 = cyc.vertices[(i + 1) % cyc.vertices.length];
    areaSum += p1.x * p2.y - p2.x * p1.y;
  }
  const area = Math.abs(areaSum / 2);

  let perimeter = 0;
  for (let i = 0; i < cyc.vertices.length; i++) {
    const p1 = cyc.vertices[i];
    const p2 = cyc.vertices[(i + 1) % cyc.vertices.length];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }

  const thickness = (2 * area) / perimeter;
  const areaSqFt = (area / 144);

  console.log(`\nCycle ${idx}:`);
  console.log(`  Layer: "${cyc.layer}"`);
  console.log(`  Vertices count: ${cyc.vertices.length}`);
  console.log(`  Area: ${area.toFixed(1)} sq in (${areaSqFt.toFixed(2)} sq ft)`);
  console.log(`  Perimeter: ${perimeter.toFixed(1)} in`);
  console.log(`  Hydraulic Thickness: ${thickness.toFixed(2)} in`);
  console.log(`  Vertices: ${JSON.stringify(cyc.vertices.map(v => [parseFloat(v.x.toFixed(1)), parseFloat(v.y.toFixed(1))]))}`);
});
