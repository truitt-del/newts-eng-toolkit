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

console.log('=== LINES ON 1-WALL IN GARAGE REGION ===');
const wallLinesInGarage = parsed.lineEntities.filter(l => 
  l.layer === '1-WALL' &&
  (
    (l.x1 >= 100 && l.x1 <= 400 && l.y1 >= -350 && l.y1 <= 100) ||
    (l.x2 >= 100 && l.x2 <= 400 && l.y2 >= -350 && l.y2 <= 100)
  )
);

console.log(`Found ${wallLinesInGarage.length} wall lines in the garage region:`);
wallLinesInGarage.forEach((l, idx) => {
  console.log(`Line ${idx}: (${l.x1.toFixed(1)}, ${l.y1.toFixed(1)}) -> (${l.x2.toFixed(1)}, ${l.y2.toFixed(1)})`);
});

// Let's also check if there are any Polylines on 1-WALL in the garage region
console.log('\n=== POLYLINES ON 1-WALL IN GARAGE REGION ===');
const wallPolylinesInGarage = parsed.polylines.filter(p => 
  p.layer === '1-WALL' &&
  p.vertices.some(v => v.x >= 100 && v.x <= 400 && v.y >= -350 && v.y <= 100)
);
console.log(`Found ${wallPolylinesInGarage.length} wall polylines in the garage region.`);
wallPolylinesInGarage.forEach((p, idx) => {
  console.log(`Polyline ${idx}: vertices=${p.vertices.length}`);
  console.log(`  Vertices: ${p.vertices.map(v => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)})`).join(' -> ')}`);
});
