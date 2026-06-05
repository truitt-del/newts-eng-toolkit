import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';
import { buildDefaultMappings, assembleWalls } from '../lib/cad/assembler';

const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
const dxfPath = path.resolve(relativePath);

const text = fs.readFileSync(dxfPath, 'utf-8');
const parsed = parseDXF(text);
const mappings = buildDefaultMappings(parsed);

// Let's implement deduplicateSegments and patch the assembly pipeline
interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer: string;
}

function deduplicateSegments(segments: Segment[]): Segment[] {
  const seen = new Set<string>();
  const unique: Segment[] = [];

  for (const s of segments) {
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

// Replicate the whole assembleWalls with deduplicateSegments included
import { ClosedWallPolygon, ExplicitOpening, ExceptionItem } from '../lib/cad/sessionStore';

// Let's run a test where we modify the assembler code itself, or we run a local version of assembleWalls here.
// Let's run a local version here to get the exact counts before modifying assembler.ts.
