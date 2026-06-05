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
  patternName?: string;
}

export interface LineEntity {
  layer: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface InsertEntity {
  layer: string;
  blockName: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

export interface TextEntity {
  layer: string;
  text: string;
  x: number;
  y: number;
  height: number;
  isMText: boolean;
}

export interface ParsedDXF {
  polylines: Polyline[];
  hatches: Hatch[];
  lineEntities: LineEntity[];
  inserts: InsertEntity[];
  textEntities: TextEntity[];
  unitScale: number;
  unitName: string;
  insunits: number;
  measurement: number;
}

interface PendingVertex extends Vertex {
  _pending?: boolean;
}

// Map $INSUNITS to scale factor relative to target unit (inches)
// 1 = inches, 2 = feet, 4 = mm, 5 = cm, 6 = m
function getUnitScale(insunits: number, measurement?: number): { scale: number; name: string } {
  if (insunits === 0 || isNaN(insunits)) {
    // Fallback to measurement: 0 = English (inches), 1 = Metric (millimeters)
    if (measurement === 1) {
      return { scale: 1.0 / 25.4, name: 'millimeters (derived from measurement)' };
    } else {
      return { scale: 1.0, name: 'inches (derived from measurement/default)' };
    }
  }
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
  const inserts: InsertEntity[] = [];
  const textEntities: TextEntity[] = [];

  let entityType: 'POLYLINE' | 'LWPOLYLINE' | 'VERTEX' | 'HATCH' | 'LINE' | 'INSERT' | 'TEXT' | 'MTEXT' | null = null;
  let currentEntity: any = null;
  let currentPolyline: Polyline | null = null;
  let hatchInBoundary = false;
  
  let insunits = 1;
  let measurement = 0;
  let expectingInsunitsValue = false;
  let expectingMeasurementValue = false;

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

    if (code === 9 && value === '$MEASUREMENT') {
      expectingMeasurementValue = true;
      continue;
    }
    if (expectingMeasurementValue && code === 70) {
      measurement = parseInt(value, 10);
      expectingMeasurementValue = false;
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
        currentEntity = { layer: '', boundaryPoints: [], patternName: '' };
        hatches.push(currentEntity);
        entityType = 'HATCH';
        hatchInBoundary = false;
      } else if (value === 'LINE') {
        currentEntity = { layer: '', x1: 0, y1: 0, x2: 0, y2: 0 };
        lineEntities.push(currentEntity);
        entityType = 'LINE';
      } else if (value === 'INSERT') {
        currentEntity = { layer: '', blockName: '', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
        inserts.push(currentEntity);
        entityType = 'INSERT';
      } else if (value === 'TEXT' || value === 'MTEXT') {
        currentEntity = { layer: '', text: '', x: 0, y: 0, height: 0, isMText: value === 'MTEXT' };
        textEntities.push(currentEntity);
        entityType = value === 'TEXT' ? 'TEXT' : 'MTEXT';
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
    } else if (entityType === 'INSERT') {
      if (code === 2) currentEntity.blockName = value;
      else if (code === 10) currentEntity.x = parseFloat(value);
      else if (code === 20) currentEntity.y = parseFloat(value);
      else if (code === 50) currentEntity.rotation = parseFloat(value);
      else if (code === 41) currentEntity.scaleX = parseFloat(value);
      else if (code === 42) currentEntity.scaleY = parseFloat(value);
    } else if (entityType === 'TEXT' || entityType === 'MTEXT') {
      if (code === 1) {
        currentEntity.text = value;
      } else if (code === 3 && entityType === 'MTEXT') {
        // MTEXT text can be split across group codes 1 and 3 if long; prepend code 3 values
        currentEntity.text = value + currentEntity.text;
      } else if (code === 10) {
        currentEntity.x = parseFloat(value);
      } else if (code === 20) {
        currentEntity.y = parseFloat(value);
      } else if (code === 40) {
        currentEntity.height = parseFloat(value);
      }
    } else if (entityType === 'HATCH') {
      if (code === 2) {
        currentEntity.patternName = value;
      } else if (code === 92) {
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
  const { scale, name: unitName } = getUnitScale(insunits, measurement);
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
    inserts.forEach(ins => {
      ins.x *= scale;
      ins.y *= scale;
      // Note: we don't scale scaleX/scaleY directly as they represent block scaling factors,
      // but their translation coordinates x, y must be scaled to the drawing's native unit.
    });
    textEntities.forEach(txt => {
      txt.x *= scale;
      txt.y *= scale;
      txt.height *= scale;
    });
  }

  return {
    polylines,
    hatches,
    lineEntities,
    inserts,
    textEntities,
    unitScale: scale,
    unitName,
    insunits,
    measurement
  };
}
