import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';
import { buildDefaultMappings, assembleWalls } from '../lib/cad/assembler';

function runSyntheticTests() {
  console.log('==================================================');
  console.log('RUNNING SYNTHETIC GEOMETRY TESTS');
  console.log('==================================================');

  // Test 1: L-Junction Corner Wall with gaps (snapping) & tails (pruning)
  console.log('\n--- Test 1: Wall Segment with Snapping, Pruning, and Split Intersections ---');
  
  // We want to form a closed wall polygon of 100" x 6"
  // Outer segment: (0,0) -> (100,0)
  // Inner segment: (0,6) -> (100,6)
  // Left Cap: (0,0) -> (0,6)
  // Right Cap: has a 1.2" gap at the top: (100,0) -> (100, 4.8) (T_snap is 1.5", so should snap to (100,6))
  // Dangling tail: (100,0) -> (101.5, 0) (length 1.5" < T_prune 2.0", should be deleted)
  // Crossing line: (50, -10) -> (50, 10) (should be split, and then its dangling parts pruned because they are tails)
  
  const syntheticSegments = [
    { x1: 0, y1: 0, x2: 100, y2: 0, layer: 'A-WALL' },
    { x1: 0, y1: 6, x2: 100, y2: 6, layer: 'A-WALL' },
    { x1: 0, y1: 0, x2: 0, y2: 6, layer: 'A-WALL' },
    { x1: 100, y1: 0, x2: 100, y2: 4.8, layer: 'A-WALL' }, // Gap of 1.2" to (100,6)
    { x1: 100, y1: 0, x2: 101.5, y2: 0, layer: 'A-WALL' }, // Dangling tail of 1.5"
    { x1: 50, y1: -4, x2: 50, y2: 10, layer: 'A-WALL' } // Intersecting line crossing wall
  ];

  // We construct a mock ParsedDXF to feed into our assembler
  const mockDxf = {
    polylines: [],
    hatches: [],
    lineEntities: syntheticSegments,
    inserts: [],
    textEntities: [],
    unitScale: 1.0,
    unitName: 'inches',
    insunits: 1,
    measurement: 0
  };

  const tolerances = {
    snap: 1.5,
    prune: 5.0, // Set prune large enough to clear the crossing line tails
    wMin: 3.0,
    wMax: 12.0,
    maxBBoxFt: 400,
    maxWallVertices: 30,
    maxWallAreaSqFt: 50
  };

  const mappings = {
    'layer:A-WALL': {
      sourceType: 'layer' as const,
      sourceName: 'A-WALL',
      canonicalCategory: 'WALL' as const,
      provenance: 'deterministic' as const,
      scope: 'global' as const,
      timestamp: Date.now()
    }
  };

  const { walls } = assembleWalls(mockDxf, tolerances, mappings);

  console.log(`Expected: 1 closed wall polygon of approx. 100" x 6" (Area ~ 600 sq in)`);
  console.log(`Assembled walls count: ${walls.length}`);
  
  if (walls.length > 0) {
    const w = walls[0];
    console.log(`Wall 1 ID: ${w.id}`);
    console.log(`Wall 1 Vertices Count: ${w.vertices.length}`);
    console.log(`Wall 1 Area: ${w.area.toFixed(2)} sq in (Expected ~600)`);
    console.log(`Wall 1 Perimeter: ${w.perimeter.toFixed(2)} in (Expected ~212)`);
    console.log(`Wall 1 Thickness: ${w.thickness.toFixed(2)} in (Expected ~5.66)`);
    console.log('Wall 1 Vertices:', JSON.stringify(w.vertices));
    
    const isSuccess = Math.abs(w.area - 600) < 15;
    console.log(`Test Result: ${isSuccess ? 'PASS' : 'FAIL'}`);
  } else {
    console.log('Test Result: FAIL (No walls assembled)');
  }
}

function runRealDxfTests() {
  console.log('\n==================================================');
  console.log('RUNNING REAL DXF PORTABILITY TESTS');
  console.log('==================================================');

  // Locate the file in the workspace
  const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
  const dxfPath = path.resolve(relativePath);

  if (!fs.existsSync(dxfPath)) {
    console.error(`Error: Could not find dxf file at path: ${dxfPath}`);
    return;
  }

  console.log(`Loading DXF: ${dxfPath}`);
  const text = fs.readFileSync(dxfPath, 'utf-8');
  
  console.log('Parsing DXF file...');
  const parsed = parseDXF(text);
  console.log(`Parsed successfully!`);
  console.log(`  - Lines: ${parsed.lineEntities.length}`);
  console.log(`  - Polylines: ${parsed.polylines.length}`);
  console.log(`  - Hatches: ${parsed.hatches.length}`);
  console.log(`  - Inserts: ${parsed.inserts.length}`);
  console.log(`  - Text/MText: ${parsed.textEntities.length}`);
  console.log(`  - INSUNITS Code: ${parsed.insunits} (${parsed.unitName})`);
  console.log(`  - Unit Scale to Inches: ${parsed.unitScale}`);

  console.log('\nAuto-classifying layers...');
  const mappings = buildDefaultMappings(parsed);

  const categorizedCount: Record<string, number> = {};
  Object.values(mappings).forEach(m => {
    categorizedCount[m.canonicalCategory] = (categorizedCount[m.canonicalCategory] || 0) + 1;
  });

  console.log('Layer Categorization Results:');
  Object.entries(categorizedCount).forEach(([cat, count]) => {
    console.log(`  - ${cat}: ${count} layers/patterns`);
  });

  // Display layers categorized as WALL and POCHE
  console.log('\nWALL layers discovered:');
  Object.values(mappings)
    .filter(m => m.sourceType === 'layer' && m.canonicalCategory === 'WALL')
    .forEach(m => console.log(`  - ${m.sourceName}`));

  console.log('\nPOCHE layers/patterns discovered:');
  Object.values(mappings)
    .filter(m => m.canonicalCategory === 'POCHE')
    .forEach(m => console.log(`  - [${m.sourceType}] ${m.sourceName}`));

  console.log('\nAssembling Walls from real DXF...');
  const tolerances = {
    snap: 1.5,
    prune: 2.0,
    wMin: 3.0,
    wMax: 12.0,
    maxBBoxFt: 400,
    maxWallVertices: 30,
    maxWallAreaSqFt: 50
  };

  const start = Date.now();
  const { walls, openings, exceptions } = assembleWalls(parsed, tolerances, mappings);
  const duration = Date.now() - start;

  console.log(`Assembly complete in ${duration}ms!`);
  console.log(`  - Assembled Wall Polygons: ${walls.length}`);
  console.log(`  - Extracted Door/Window Openings: ${openings.length}`);
  console.log(`  - Blocked/Excepted Loops: ${exceptions.length}`);

  if (walls.length > 0) {
    console.log('\n--- Wall Segments Listing ---');
    walls.forEach(w => {
      console.log(`  - Wall ID: ${w.id.toString().padStart(2, ' ')} | Vertices: ${w.vertices.length.toString().padStart(2, ' ')} | Area: ${(w.area / 144).toFixed(2).padStart(6, ' ')} sq ft | Thickness: ${w.thickness.toFixed(1).padStart(4, ' ')}" | Bearing: ${w.bearing ? 'YES (Poché)' : 'NO'}`);
      console.log(`    Vertices: ${JSON.stringify(w.vertices.map(v => [parseFloat(v.x.toFixed(1)), parseFloat(v.y.toFixed(1))]))}`);
    });

    console.log('\n--- Vertex-Count Distribution ---');
    const distribution: Record<number, number> = {};
    walls.forEach(w => {
      distribution[w.vertices.length] = (distribution[w.vertices.length] || 0) + 1;
    });
    Object.keys(distribution).map(Number).sort((a, b) => a - b).forEach(count => {
      console.log(`  - ${count} Vertices: ${distribution[count]} wall(s)`);
    });

    console.log('\n--- Bearing (Poché) Wall Statistics ---');
    const bearingWalls = walls.filter(w => w.bearing);
    console.log(`  - Total Walls: ${walls.length}`);
    console.log(`  - Bearing Walls: ${bearingWalls.length} (${((bearingWalls.length / walls.length) * 100).toFixed(1)}%)`);
    
    console.log('\n--- Sample Openings Associated with Walls ---');
    openings.slice(0, 5).forEach(op => {
      console.log(`  - Opening ID: ${op.id} | Type: ${op.type.toUpperCase()} | Loc: (${op.x.toFixed(1)}, ${op.y.toFixed(1)}) | Associated Wall ID: ${op.associatedWallId ?? 'None'}`);
    });
  } else {
    console.log('Warning: No walls were assembled. Double check layer mapping categories or tolerances.');
  }

  if (exceptions.length > 0) {
    console.log('\n--- Sanity Filter Exceptions ---');
    exceptions.forEach(ex => {
      console.log(`  - [${ex.type.toUpperCase()}] ${ex.title}: ${ex.description} at centroid (${ex.location?.x.toFixed(1)}, ${ex.location?.y.toFixed(1)})`);
    });
  }
}

runSyntheticTests();
runRealDxfTests();
