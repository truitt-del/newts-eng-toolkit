import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';

const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
const dxfPath = path.resolve(relativePath);

if (!fs.existsSync(dxfPath)) {
  console.error(`Error: Could not find dxf file at path: ${dxfPath}`);
  process.exit(1);
}

const text = fs.readFileSync(dxfPath, 'utf-8');
const parsed = parseDXF(text);

console.log('=== ANALYZING LAYER "1-WALL" ENTITIES ALONG THE DIVIDING BOUNDARY ===');
console.log('Searching for lines/polylines near the dividing wall (x around 30 to 110, y from -260 to 90)...');

// Filter lines in the range
const boundaryLines = parsed.lineEntities.filter(l => 
  l.layer === '1-WALL' &&
  (
    (l.x1 >= 30 && l.x1 <= 120 && l.y1 >= -260 && l.y1 <= 100) ||
    (l.x2 >= 30 && l.x2 <= 120 && l.y2 >= -260 && l.y2 <= 100)
  )
);

console.log(`\nFound ${boundaryLines.length} line entities:`);
boundaryLines.forEach((l, idx) => {
  console.log(`Line ${idx}: (${l.x1.toFixed(3)}, ${l.y1.toFixed(3)}) -> (${l.x2.toFixed(3)}, ${l.y2.toFixed(3)})`);
});

const boundaryPolylines = parsed.polylines.filter(p => 
  p.layer === '1-WALL' &&
  p.vertices.some(v => v.x >= 30 && v.x <= 120 && v.y >= -260 && v.y <= 100)
);

console.log(`\nFound ${boundaryPolylines.length} polyline entities:`);
boundaryPolylines.forEach((p, idx) => {
  console.log(`Polyline ${idx}: vertices=${p.vertices.length}`);
  console.log(`  Vertices: ${p.vertices.map(v => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)})`).join(' -> ')}`);
});
