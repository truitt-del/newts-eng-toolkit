export interface Vertex {
  x: number;
  y: number;
}

export interface Polyline {
  layer: string;
  vertices: Vertex[];
}

export interface Hatch {
  layer: string;
  boundaryPoints: Vertex[];
}

export interface LineEntity {
  layer: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ParsedDXF {
  polylines: Polyline[];
  hatches: Hatch[];
  lineEntities: LineEntity[];
  unitScale: number;
  unitName: string;
}

interface PendingVertex extends Vertex {
  _pending?: boolean;
}

// Map $INSUNITS to scale factor relative to target unit (inches)
// 1 = inches, 2 = feet, 4 = mm, 5 = cm, 6 = m
function getUnitScale(insunits: number): { scale: number; name: string } {
  switch (insunits) {
    case 1:
      return { scale: 1.0, name: 'inches' };
    case 2:
      return { scale: 12.0, name: 'feet' };
    case 4:
      return { scale: 1.0 / 25.4, name: 'millimeters' };
    case 5:
      return { scale: 10.0 / 25.4, name: 'centimeters' };
    case 6:
      return { scale: 1000.0 / 25.4, name: 'meters' };
    default:
      return { scale: 1.0, name: 'inches (unspecified/default)' };
  }
}

export function parseDXF(text: string): ParsedDXF {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    const code = parseInt(codeStr, 10);
    if (isNaN(code)) continue;
    pairs.push([code, lines[i + 1]]);
  }

  const polylines: Polyline[] = [];
  const hatches: Hatch[] = [];
  const lineEntities: LineEntity[] = [];

  let entityType: 'POLYLINE' | 'LWPOLYLINE' | 'VERTEX' | 'HATCH' | 'LINE' | null = null;
  let currentEntity: any = null;
  let currentPolyline: Polyline | null = null;
  let hatchInBoundary = false;
  let insunits = 1;
  let expectingInsunitsValue = false;

  for (let i = 0; i < pairs.length; i++) {
    const [code, valueRaw] = pairs[i];
    const value = valueRaw == null ? '' : valueRaw.trim();

    // 1. Detect unit settings in HEADER
    if (code === 9 && value === '$INSUNITS') {
      expectingInsunitsValue = true;
      continue;
    }
    if (expectingInsunitsValue && code === 70) {
      insunits = parseInt(value, 10);
      expectingInsunitsValue = false;
      continue;
    }

    // 2. Identify new entity blocks
    if (code === 0) {
      if (value === 'POLYLINE') {
        currentPolyline = { layer: '', vertices: [] };
        polylines.push(currentPolyline);
        entityType = 'POLYLINE';
        currentEntity = currentPolyline;
      } else if (value === 'LWPOLYLINE') {
        currentEntity = { layer: '', vertices: [] };
        polylines.push(currentEntity);
        entityType = 'LWPOLYLINE';
        currentPolyline = null;
      } else if (value === 'VERTEX' && currentPolyline) {
        currentEntity = { x: 0, y: 0 } as PendingVertex;
        currentPolyline.vertices.push(currentEntity);
        entityType = 'VERTEX';
      } else if (value === 'SEQEND') {
        currentPolyline = null;
        currentEntity = null;
        entityType = null;
      } else if (value === 'HATCH') {
        currentEntity = { layer: '', boundaryPoints: [] };
        hatches.push(currentEntity);
        entityType = 'HATCH';
        hatchInBoundary = false;
      } else if (value === 'LINE') {
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

    // 3. Extract layer info (code 8)
    if (code === 8) {
      currentEntity.layer = value;
      continue;
    }

    // 4. Parse entity specific coordinate values
    if (entityType === 'VERTEX') {
      if (code === 10) currentEntity.x = parseFloat(value);
      else if (code === 20) currentEntity.y = parseFloat(value);
    } else if (entityType === 'LWPOLYLINE') {
      // Lightweight polylines list vertices sequentially in a single entity block
      if (code === 10) {
        currentEntity.vertices.push({ x: parseFloat(value), y: 0, _pending: true } as PendingVertex);
      } else if (code === 20) {
        const last = currentEntity.vertices[currentEntity.vertices.length - 1] as PendingVertex | undefined;
        if (last && last._pending) {
          last.y = parseFloat(value);
          delete last._pending;
        }
      }
    } else if (entityType === 'LINE') {
      if (code === 10) currentEntity.x1 = parseFloat(value);
      else if (code === 20) currentEntity.y1 = parseFloat(value);
      else if (code === 11) currentEntity.x2 = parseFloat(value);
      else if (code === 21) currentEntity.y2 = parseFloat(value);
    } else if (entityType === 'HATCH') {
      // Limit hatch edge boundary parsing between code 92 (start) and codes 97/75/76/98 (end)
      // to avoid capturing stray internal seed-points.
      if (code === 92) {
        hatchInBoundary = true;
      } else if (code === 97 || code === 75 || code === 76 || code === 98) {
        hatchInBoundary = false;
      } else if (hatchInBoundary) {
        if (code === 10) {
          currentEntity.boundaryPoints.push({ x: parseFloat(value), y: 0, _pending: true } as PendingVertex);
        } else if (code === 20) {
          const last = currentEntity.boundaryPoints[currentEntity.boundaryPoints.length - 1] as PendingVertex | undefined;
          if (last && last._pending) {
            last.y = parseFloat(value);
            delete last._pending;
          }
        } else if (code === 11) {
          currentEntity.boundaryPoints.push({ x: parseFloat(value), y: 0, _pending: true } as PendingVertex);
        } else if (code === 21) {
          const last = currentEntity.boundaryPoints[currentEntity.boundaryPoints.length - 1] as PendingVertex | undefined;
          if (last && last._pending) {
            last.y = parseFloat(value);
            delete last._pending;
          }
        }
      }
    }
  }

  // 5. Apply Unit Scaling
  const { scale, name: unitName } = getUnitScale(insunits);
  if (scale !== 1.0) {
    polylines.forEach(p => {
      p.vertices.forEach(v => {
        v.x *= scale;
        v.y *= scale;
      });
    });
    hatches.forEach(h => {
      h.boundaryPoints.forEach(v => {
        v.x *= scale;
        v.y *= scale;
      });
    });
    lineEntities.forEach(l => {
      l.x1 *= scale;
      l.y1 *= scale;
      l.x2 *= scale;
      l.y2 *= scale;
    });
  }

  return {
    polylines,
    hatches,
    lineEntities,
    unitScale: scale,
    unitName
  };
}
