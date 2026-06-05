import { ParsedDXF, LineEntity } from '../dxf/parser';
import { StairInstance, MappingDictionary } from './sessionStore';

interface StairLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  len: number;
  mx: number;
  my: number;
  angle: number; // in [0, PI)
  layer: string;
}

/**
 * Detects staircases and shallow stoop steps from line segments and text/insert contexts.
 */
export function detectStairs(
  dxf: ParsedDXF,
  mappings: MappingDictionary,
  T_snap: number = 1.5
): StairInstance[] {
  const stairLines: StairLine[] = [];

  const isStairLayer = (lyrName: string): boolean => {
    const key = `layer:${lyrName}`;
    const m = mappings[key];
    return m ? m.canonicalCategory === 'STAIR' : false;
  };

  // Extract all lines belonging to STAIR layers
  dxf.lineEntities.forEach(l => {
    if (isStairLayer(l.layer)) {
      const dx = l.x2 - l.x1;
      const dy = l.y2 - l.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1.0) return; // Ignore tiny noise lines

      // Normalize angle to [0, PI)
      let angle = Math.atan2(dy, dx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI - 1e-4) angle = 0;

      stairLines.push({
        x1: l.x1,
        y1: l.y1,
        x2: l.x2,
        y2: l.y2,
        len,
        mx: (l.x1 + l.x2) / 2,
        my: (l.y1 + l.y2) / 2,
        angle,
        layer: l.layer
      });
    }
  });

  // Extract line segments from STAIR polylines too!
  dxf.polylines.forEach(p => {
    if (isStairLayer(p.layer)) {
      for (let i = 0; i + 1 < p.vertices.length; i++) {
        const p1 = p.vertices[i];
        const p2 = p.vertices[i + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1.0) continue;

        let angle = Math.atan2(dy, dx);
        if (angle < 0) angle += Math.PI;
        if (angle >= Math.PI - 1e-4) angle = 0;

        stairLines.push({
          x1: p1.x,
          y1: p1.y,
          x2: p2.x,
          y2: p2.y,
          len,
          mx: (p1.x + p2.x) / 2,
          my: (p1.y + p2.y) / 2,
          angle,
          layer: p.layer
        });
      }
    }
  });

  if (stairLines.length === 0) return [];

  // Group parallel lines into stair tread components
  const parent = Array.from({ length: stairLines.length }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (root !== parent[root]) root = parent[root];
    let curr = i;
    while (curr !== root) {
      const nxt = parent[curr];
      parent[curr] = root;
      curr = nxt;
    }
    return root;
  };
  const union = (i: number, j: number) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      parent[rootI] = rootJ;
    }
  };

  for (let i = 0; i < stairLines.length; i++) {
    const l1 = stairLines[i];
    for (let j = i + 1; j < stairLines.length; j++) {
      const l2 = stairLines[j];

      // 1. Check if angle is parallel (within 5 degrees)
      let dAngle = Math.abs(l1.angle - l2.angle);
      if (dAngle > Math.PI / 2) dAngle = Math.PI - dAngle;

      if (dAngle < 0.087) { // ~5 degrees
        // 2. Check tread depth spacing in perpendicular direction
        // Normal vector: (-sin angle, cos angle)
        const nx = -Math.sin(l1.angle);
        const ny = Math.cos(l1.angle);

        // Midpoint displacement vector
        const dx = l2.mx - l1.mx;
        const dy = l2.my - l1.my;

        const dPerp = Math.abs(dx * nx + dy * ny);

        // Spaced between 8" and 14.5" (standard treads are 9" - 12.5")
        if (dPerp >= 8.0 && dPerp <= 14.5) {
          // 3. Check lateral overlap along the tangent
          const tx = Math.cos(l1.angle);
          const ty = Math.sin(l1.angle);
          const dTang = Math.abs(dx * tx + dy * ty);

          // Centers must be aligned (tangent offset is less than half the smaller length)
          const minLen = Math.min(l1.len, l2.len);
          if (dTang < minLen * 0.75) {
            // 4. Tread lengths must be similar (within 35%)
            const maxLen = Math.max(l1.len, l2.len);
            if (minLen / maxLen > 0.65) {
              union(i, j);
            }
          }
        }
      }
    }
  }

  // Group into component buckets
  const components: Record<number, StairLine[]> = {};
  for (let i = 0; i < stairLines.length; i++) {
    const root = find(i);
    if (!components[root]) components[root] = [];
    components[root].push(stairLines[i]);
  }

  const results: StairInstance[] = [];
  let stairIdSeq = 1;

  Object.values(components).forEach(group => {
    if (group.length < 2) return; // A single line cannot be a staircase component

    // Determine bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let sumLen = 0;

    group.forEach(line => {
      minX = Math.min(minX, line.x1, line.x2);
      maxX = Math.max(maxX, line.x1, line.x2);
      minY = Math.min(minY, line.y1, line.y2);
      maxY = Math.max(maxY, line.y1, line.y2);
      sumLen += line.len;
    });

    const width = sumLen / group.length; // Average width (tread length)
    const bounds = { minX, maxX, minY, maxY };
    const x = (minX + maxX) / 2;
    const y = (minY + maxY) / 2;

    const numTreads = group.length - 1;

    // Calculate length (distance from first tread to last tread along the normal direction of the first line)
    const refLine = group[0];
    const nx = -Math.sin(refLine.angle);
    const ny = Math.cos(refLine.angle);

    let minProj = Infinity, maxProj = -Infinity;
    group.forEach(line => {
      const proj = line.mx * nx + line.my * ny;
      minProj = Math.min(minProj, proj);
      maxProj = Math.max(maxProj, proj);
    });
    const length = maxProj - minProj;

    // Proximity helpers
    const isNearExteriorDoor = (): boolean => {
      // Find door inserts nearby
      for (const ins of dxf.inserts) {
        const insKey = `block:${ins.blockName}`;
        const map = mappings[insKey] || mappings[`layer:${ins.layer}`];
        if (map && map.canonicalCategory === 'DOOR') {
          // Check proximity to stair bbox
          const dx = ins.x - x;
          const dy = ins.y - y;
          if (Math.sqrt(dx * dx + dy * dy) < 72.0) { // within 6 feet
            return true;
          }
        }
      }
      return false;
    };

    const isNearStoopLabel = (): boolean => {
      // Check room text labels or notes nearby
      for (const ent of dxf.textEntities) {
        const text = ent.text.toUpperCase();
        if (text.includes('STOOP') || text.includes('PORCH') || text.includes('DECK') || text.includes('PATIO') || text.includes('ENTRY')) {
          const dx = ent.x - x;
          const dy = ent.y - y;
          if (Math.sqrt(dx * dx + dy * dy) < 96.0) { // within 8 feet
            return true;
          }
        }
      }
      return false;
    };

    // Classify Confidence and Type
    let confidence: StairInstance['confidence'] = 'low';

    if (numTreads >= 3) {
      // Deep staircase: naturally high confidence if clean parallel spacing is detected
      confidence = 'high';
    } else {
      // Shallow step (1 or 2 treads): assess spatiosemantic proximity
      if (isNearExteriorDoor() || isNearStoopLabel()) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }
    }

    results.push({
      id: stairIdSeq++,
      x,
      y,
      treads: numTreads,
      width,
      length,
      bounds,
      confidence
    });
  });

  return results;
}
