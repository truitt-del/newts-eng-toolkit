import * as fs from 'fs';
import * as path from 'path';
import { cleanMText, parseRoomLabel } from '../lib/cad/mtextParser';
import { parseDXF } from '../lib/dxf/parser';

function runSyntheticMTextTests() {
  console.log('==================================================');
  console.log('RUNNING SYNTHETIC MTEXT PARSER TESTS');
  console.log('==================================================');

  const testCases = [
    {
      name: 'Standard AutoCAD format with Font and Height switches',
      raw: `{\\fArial|b1|i0;BEDROOM 1}\\P{\\fArial|b0|i0;\\H0.7x;12'-0" x 14'-6"}\\P{\\fArial|b0|i0;\\H0.5x;8'-0" CLG}`,
      expectedClean: "BEDROOM 1\n12'-0\" x 14'-6\"\n8'-0\" CLG",
      expectedLabel: {
        roomName: 'BEDROOM 1',
        dimensions: "12'-0\" x 14'-6\"",
        ceilingHeight: "8'-0\" CLG"
      }
    },
    {
      name: 'Vectorworks formatting with color and alignment switches',
      raw: `\\A1;\\C2;{\\fCalibri|b0|i1;KITCHEN}\\P{\\H4.5;10'-6" x 11'-0"}\\P9'-0" CLG`,
      expectedClean: "KITCHEN\n10'-6\" x 11'-0\"\n9'-0\" CLG",
      expectedLabel: {
        roomName: 'KITCHEN',
        dimensions: "10'-6\" x 11'-0\"",
        ceilingHeight: "9'-0\" CLG"
      }
    },
    {
      name: 'Simple string with newline and fraction stacked text',
      raw: `DINING\\P12\\S1/2; x 14\\P8'-6" CLG`,
      expectedClean: "DINING\n121/2 x 14\n8'-6\" CLG",
      expectedLabel: {
        roomName: 'DINING',
        dimensions: "121/2 x 14",
        ceilingHeight: "8'-6\" CLG"
      }
    },
    {
      name: 'Single line room label',
      raw: `{\\fArial|b0;POWDER ROOM}`,
      expectedClean: 'POWDER ROOM',
      expectedLabel: {
        roomName: 'POWDER ROOM',
        dimensions: null,
        ceilingHeight: null
      }
    }
  ];

  let failed = 0;

  testCases.forEach((tc, index) => {
    console.log(`\nTest #${index + 1}: ${tc.name}`);
    const actualClean = cleanMText(tc.raw);
    const actualLabel = parseRoomLabel(tc.raw);

    console.log(`Raw MTEXT:      "${tc.raw}"`);
    console.log(`Cleaned Text:\n${actualClean.replace(/^/gm, '  > ')}`);
    console.log(`Parsed Label:    Name="${actualLabel.roomName}" | Dim="${actualLabel.dimensions}" | Clg="${actualLabel.ceilingHeight}"`);

    const cleanMatch = actualClean === tc.expectedClean;
    const nameMatch = actualLabel.roomName === tc.expectedLabel.roomName;
    const dimMatch = actualLabel.dimensions === tc.expectedLabel.dimensions;
    const clgMatch = actualLabel.ceilingHeight === tc.expectedLabel.ceilingHeight;

    if (cleanMatch && nameMatch && dimMatch && clgMatch) {
      console.log('Result: PASS');
    } else {
      console.log('Result: FAIL');
      if (!cleanMatch) console.log(`  - Cleaned text mismatch. Expected: "${tc.expectedClean}"`);
      if (!nameMatch) console.log(`  - Room Name mismatch. Expected: "${tc.expectedLabel.roomName}"`);
      if (!dimMatch) console.log(`  - Dimensions mismatch. Expected: "${tc.expectedLabel.dimensions}"`);
      if (!clgMatch) console.log(`  - Ceiling Height mismatch. Expected: "${tc.expectedLabel.ceilingHeight}"`);
      failed++;
    }
  });

  console.log(`\nSynthetic Summary: ${testCases.length - failed} passed, ${failed} failed`);
  return failed === 0;
}

function runRealDxfMTextTests() {
  console.log('\n==================================================');
  console.log('RUNNING REAL DXF MTEXT TESTS');
  console.log('==================================================');

  const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
  const dxfPath = path.resolve(relativePath);

  if (!fs.existsSync(dxfPath)) {
    console.error(`Error: Could not find dxf file at path: ${dxfPath}`);
    return;
  }

  const text = fs.readFileSync(dxfPath, 'utf-8');
  const parsed = parseDXF(text);

  console.log(`Real DXF Loaded. Total Text Entities: ${parsed.textEntities.length}`);
  
  // Let's filter for text entities that are MTEXT and contain formatting symbols or room label indicators
  const formattedEntities = parsed.textEntities.filter(e => {
    return e.isMText && (e.text.includes('\\') || e.text.includes('{') || e.text.includes('CLG') || e.text.includes('x') || e.text.includes('X'));
  });

  console.log(`Found ${formattedEntities.length} formatted/multi-line text candidates.`);
  
  console.log('\nShowing 10 parsed room/dimension labels from slightly_cleaned_archs.dxf:');
  formattedEntities.slice(0, 10).forEach((ent, index) => {
    const cleaned = cleanMText(ent.text);
    const parsedLabel = parseRoomLabel(ent.text);
    console.log(`\n  [${index + 1}] Layer: "${ent.layer}" | Pos: (${ent.x.toFixed(1)}, ${ent.y.toFixed(1)})`);
    console.log(`      Raw:     "${ent.text}"`);
    console.log(`      Cleaned: "${cleaned.replace(/\n/g, ' \\P ')}"`);
    console.log(`      Parsed:  Name="${parsedLabel.roomName}" | Dim="${parsedLabel.dimensions}" | Clg="${parsedLabel.ceilingHeight}"`);
  });
}

const synthOk = runSyntheticMTextTests();
runRealDxfMTextTests();
if (!synthOk) {
  process.exit(1);
}
