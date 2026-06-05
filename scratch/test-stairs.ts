import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';
import { buildDefaultMappings } from '../lib/cad/assembler';
import { detectStairs } from '../lib/cad/stairDetector';

function runSyntheticStairTests() {
  console.log('==================================================');
  console.log('RUNNING SYNTHETIC STAIR / STEP DETECTOR TESTS');
  console.log('==================================================');

  // Test 1: Ideal parallel treads (4 lines, 3 treads, spaced 10" apart, 36" width)
  console.log('\n--- Test 1: Ideal Deep Staircase (4 parallel lines, 10" spacing) ---');
  const deepStairLines = [
    { x1: 0, y1: 0, x2: 36, y2: 0, layer: 'A-STAIR' },
    { x1: 0, y1: 10, x2: 36, y2: 10, layer: 'A-STAIR' },
    { x1: 0, y1: 20, x2: 36, y2: 20, layer: 'A-STAIR' },
    { x1: 0, y1: 30, x2: 36, y2: 30, layer: 'A-STAIR' }
  ];

  const mockDxf1 = {
    polylines: [],
    hatches: [],
    lineEntities: deepStairLines,
    inserts: [],
    textEntities: [],
    unitScale: 1.0,
    unitName: 'inches',
    insunits: 1,
    measurement: 0
  };

  const mappings = {
    'layer:A-STAIR': {
      sourceType: 'layer' as const,
      sourceName: 'A-STAIR',
      canonicalCategory: 'STAIR' as const,
      provenance: 'deterministic' as const,
      scope: 'global' as const,
      timestamp: Date.now()
    }
  };

  const stairs1 = detectStairs(mockDxf1, mappings);
  console.log(`Expected: 1 deep staircase with 3 treads, width = 36", length = 30", confidence = "high"`);
  console.log(`Detected stairs count: ${stairs1.length}`);

  if (stairs1.length > 0) {
    const s = stairs1[0];
    console.log(`  - Stair ID: ${s.id}`);
    console.log(`  - Treads: ${s.treads}`);
    console.log(`  - Width: ${s.width.toFixed(1)}"`);
    console.log(`  - Length: ${s.length.toFixed(1)}"`);
    console.log(`  - BBox: (${s.bounds.minX}, ${s.bounds.minY}) to (${s.bounds.maxX}, ${s.bounds.maxY})`);
    console.log(`  - Center: (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
    console.log(`  - Confidence: ${s.confidence}`);

    const ok = s.treads === 3 && Math.abs(s.width - 36) < 1e-2 && Math.abs(s.length - 30) < 1e-2 && s.confidence === 'high';
    console.log(`Test Result: ${ok ? 'PASS' : 'FAIL'}`);
  } else {
    console.log('Test Result: FAIL');
  }

  // Test 2: Shallow Step near Door vs. isolated
  console.log('\n--- Test 2: Shallow Step (2 parallel lines, 1 tread) near Exterior Door ---');
  const shallowStepLines = [
    { x1: 100, y1: 100, x2: 148, y2: 100, layer: 'A-STAIR' },
    { x1: 100, y1: 111, x2: 148, y2: 111, layer: 'A-STAIR' } // Spacing = 11"
  ];

  // Dummy door insert at (124, 96), very close to the step center (124, 105.5)
  const dummyInserts = [
    { layer: 'A-DOOR', blockName: 'DOOR-36', x: 124, y: 96, rotation: 0, scaleX: 1, scaleY: 1 }
  ];

  const mockDxf2 = {
    polylines: [],
    hatches: [],
    lineEntities: shallowStepLines,
    inserts: dummyInserts,
    textEntities: [],
    unitScale: 1.0,
    unitName: 'inches',
    insunits: 1,
    measurement: 0
  };

  const mappingsWithDoor = {
    'layer:A-STAIR': {
      sourceType: 'layer' as const,
      sourceName: 'A-STAIR',
      canonicalCategory: 'STAIR' as const,
      provenance: 'deterministic' as const,
      scope: 'global' as const,
      timestamp: Date.now()
    },
    'block:DOOR-36': {
      sourceType: 'block' as const,
      sourceName: 'DOOR-36',
      canonicalCategory: 'DOOR' as const,
      provenance: 'deterministic' as const,
      scope: 'global' as const,
      timestamp: Date.now()
    }
  };

  const stairs2 = detectStairs(mockDxf2, mappingsWithDoor);
  console.log(`Expected: 1 shallow step, treads = 1, confidence = "medium" (because it is near an exterior door)`);
  console.log(`Detected stairs count: ${stairs2.length}`);

  if (stairs2.length > 0) {
    const s = stairs2[0];
    console.log(`  - Stair ID: ${s.id}`);
    console.log(`  - Treads: ${s.treads}`);
    console.log(`  - Spacing length: ${s.length.toFixed(1)}"`);
    console.log(`  - Confidence: ${s.confidence}`);
    const ok = s.treads === 1 && s.confidence === 'medium';
    console.log(`Test Result: ${ok ? 'PASS' : 'FAIL'}`);
  } else {
    console.log('Test Result: FAIL');
  }

  // Test 3: Lines too far apart (invalid spacing)
  console.log('\n--- Test 3: Invalid Spacing (spacing = 25" - should NOT group) ---');
  const invalidStairLines = [
    { x1: 0, y1: 0, x2: 36, y2: 0, layer: 'A-STAIR' },
    { x1: 0, y1: 25, x2: 36, y2: 25, layer: 'A-STAIR' }
  ];

  const mockDxf3 = {
    polylines: [],
    hatches: [],
    lineEntities: invalidStairLines,
    inserts: [],
    textEntities: [],
    unitScale: 1.0,
    unitName: 'inches',
    insunits: 1,
    measurement: 0
  };

  const stairs3 = detectStairs(mockDxf3, mappings);
  console.log(`Expected: 0 stairs (spacing too wide)`);
  console.log(`Detected stairs count: ${stairs3.length}`);
  console.log(`Test Result: ${stairs3.length === 0 ? 'PASS' : 'FAIL'}`);
}

function runRealDxfStairTests() {
  console.log('\n==================================================');
  console.log('RUNNING REAL DXF STAIR DETECTOR TESTS');
  console.log('==================================================');

  const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
  const dxfPath = path.resolve(relativePath);

  if (!fs.existsSync(dxfPath)) {
    console.error(`Error: Could not find dxf file at path: ${dxfPath}`);
    return;
  }

  const text = fs.readFileSync(dxfPath, 'utf-8');
  const parsed = parseDXF(text);

  const mappings = buildDefaultMappings(parsed);

  // Check if any layer is mapped to STAIR
  const stairLayers = Object.values(mappings)
    .filter(m => m.sourceType === 'layer' && m.canonicalCategory === 'STAIR')
    .map(m => m.sourceName);

  console.log(`Stair layers identified in slightly_cleaned_archs.dxf:`, stairLayers);

  // Run detection
  const start = Date.now();
  const stairs = detectStairs(parsed, mappings);
  const duration = Date.now() - start;

  console.log(`Stair detection complete in ${duration}ms!`);
  console.log(`Total staircases / steps detected: ${stairs.length}`);

  if (stairs.length > 0) {
    stairs.forEach(s => {
      console.log(`\n  - Stair ID:      ${s.id}`);
      console.log(`    Location:      (${s.x.toFixed(1)}, ${s.y.toFixed(1)})`);
      console.log(`    Tread Count:   ${s.treads} treads (${s.treads + 1} lines)`);
      console.log(`    Stair Width:   ${s.width.toFixed(1)}"`);
      console.log(`    Stair Length:  ${s.length.toFixed(1)}"`);
      console.log(`    Confidence:    ${s.confidence.toUpperCase()}`);
    });
  } else {
    console.log('No staircases were detected on layers mapped to STAIR in slightly_cleaned_archs.dxf.');
    console.log('This is expected if the drawing does not have dedicated STAIR layers containing lines with parallel groups.');
  }
}

runSyntheticStairTests();
runRealDxfStairTests();
