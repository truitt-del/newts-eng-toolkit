import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';
import { buildDefaultMappings, isPointInPolygon } from '../lib/cad/assembler';

const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
const dxfPath = path.resolve(relativePath);

if (!fs.existsSync(dxfPath)) {
  console.error(`Error: Could not find dxf file at path: ${dxfPath}`);
  process.exit(1);
}

const text = fs.readFileSync(dxfPath, 'utf-8');
const parsed = parseDXF(text);
const mappings = buildDefaultMappings(parsed);

console.log('=== ANALYZING ALL POCHE HATCHES IN THE DXF ===');
console.log(`Total hatches in DXF: ${parsed.hatches.length}`);
parsed.hatches.forEach((h, idx) => {
  const mKey = `layer:${h.layer}`;
  const m = mappings[mKey];
  console.log(`Hatch ${idx}: Layer="${h.layer}" (Category=${m?.canonicalCategory}), Pattern="${h.patternName}", BoundaryPointsCount=${h.boundaryPoints.length}`);
  if (h.boundaryPoints.length > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    h.boundaryPoints.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    console.log(`  Bounding Box: (${minX.toFixed(1)}, ${minY.toFixed(1)}) to (${maxX.toFixed(1)}, ${maxY.toFixed(1)})`);
  }
});

console.log('\n=== RUNNING POCHE OVERLAP OVER EACH ASSEMBLED WALL ===');
import { assembleWalls } from '../lib/cad/assembler';
const tolerances = {
  snap: 1.5,
  prune: 2.0,
  wMin: 3.0,
  wMax: 12.0,
  maxBBoxFt: 400,
  maxWallVertices: 60, // set to 60 as requested
  maxWallAreaSqFt: 50
};

const { walls } = assembleWalls(parsed, tolerances, mappings);

walls.forEach(w => {
  console.log(`\nWall ID: ${w.id} | Layer: "${w.layer}" | Vertices: ${w.vertices.length} | Thickness: ${w.thickness.toFixed(2)} in | Area: ${(w.area / 144).toFixed(2)} sq ft`);
  
  // Calculate bounding box of this wall
  let wMinX = Infinity, wMaxX = -Infinity, wMinY = Infinity, wMaxY = -Infinity;
  w.vertices.forEach(v => {
    if (v.x < wMinX) wMinX = v.x;
    if (v.x > wMaxX) wMaxX = v.x;
    if (v.y < wMinY) wMinY = v.y;
    if (v.y > wMaxY) wMaxY = v.y;
  });

  const cols = 10;
  const rows = 10;
  const dx = (wMaxX - wMinX) / (cols + 1);
  const dy = (wMaxY - wMinY) / (rows + 1);

  let totalWallSamples = 0;
  let overlappingSamples = 0;
  const matches: { hatchIdx: number, layer: string, pattern: string, count: number }[] = [];

  for (let r = 1; r <= rows; r++) {
    const py = wMinY + r * dy;
    for (let c = 1; c <= cols; c++) {
      const px = wMinX + c * dx;
      const pt = { x: px, y: py };

      if (isPointInPolygon(pt, w.vertices)) {
        totalWallSamples++;
        
        parsed.hatches.forEach((hatch, hIdx) => {
          const hKey = `layer:${hatch.layer}`;
          const hMap = mappings[hKey];
          if (hMap && hMap.canonicalCategory === 'POCHE') {
            if (hatch.boundaryPoints.length >= 3 && isPointInPolygon(pt, hatch.boundaryPoints)) {
              overlappingSamples++;
              let match = matches.find(m => m.hatchIdx === hIdx);
              if (!match) {
                match = { hatchIdx: hIdx, layer: hatch.layer, pattern: hatch.patternName || 'SOLID', count: 0 };
                matches.push(match);
              }
              match.count++;
            }
          }
        });
      }
    }
  }

  const ratio = totalWallSamples > 0 ? (overlappingSamples / totalWallSamples) : 0;
  console.log(`  Total samples inside wall: ${totalWallSamples}`);
  console.log(`  Overlapping samples: ${overlappingSamples} (Ratio: ${(ratio * 100).toFixed(1)}%)`);
  console.log(`  Matched Hatches:`);
  matches.forEach(m => {
    console.log(`    - Hatch ${m.hatchIdx} (Layer: "${m.layer}", Pattern: "${m.pattern}"): ${m.count} samples`);
  });
  console.log(`  -> Final Bearing Classification: ${w.bearing ? 'BEARING' : 'NON-BEARING'}`);
});
