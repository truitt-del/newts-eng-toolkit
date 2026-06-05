import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';

const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
const dxfPath = path.resolve(relativePath);

const text = fs.readFileSync(dxfPath, 'utf-8');
const parsed = parseDXF(text);

console.log('=== SEARCHING FOR ANY LINES/POLYLINES NEAR y = -204 OR y = -198 ===');
parsed.lineEntities.filter(l => 
  (Math.abs(l.y1 + 204.1) < 1.0 || Math.abs(l.y2 + 204.1) < 1.0 ||
   Math.abs(l.y1 + 198.6) < 1.0 || Math.abs(l.y2 + 198.6) < 1.0)
).forEach(l => {
  console.log(`Line on layer "${l.layer}": (${l.x1.toFixed(1)}, ${l.y1.toFixed(1)}) -> (${l.x2.toFixed(1)}, ${l.y2.toFixed(1)})`);
});

parsed.polylines.filter(p =>
  p.vertices.some(v => Math.abs(v.y + 204.1) < 1.0 || Math.abs(v.y + 198.6) < 1.0)
).forEach(p => {
  console.log(`Polyline on layer "${p.layer}"`);
  console.log(`  Vertices: ${p.vertices.map(v => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`).join(' -> ')}`);
});
