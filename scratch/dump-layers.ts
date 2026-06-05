import * as fs from 'fs';
import * as path from 'path';
import { parseDXF } from '../lib/dxf/parser';
import { buildDefaultMappings } from '../lib/cad/assembler';

const relativePath = path.join('simple floor plan-dxf', 'slightly cleaned archs-dxf', 'slightly cleaned archs.dxf');
const dxfPath = path.resolve(relativePath);

if (!fs.existsSync(dxfPath)) {
  console.error(`Error: Could not find dxf file at path: ${dxfPath}`);
  process.exit(1);
}

const text = fs.readFileSync(dxfPath, 'utf-8');
const parsed = parseDXF(text);
const mappings = buildDefaultMappings(parsed);

console.log('| Layer Name | Canonical Category | Disposition |');
console.log('|---|---|---|');

Object.values(mappings)
  .filter(m => m.sourceType === 'layer')
  .sort((a, b) => a.sourceName.localeCompare(b.sourceName))
  .forEach(m => {
    let disposition = 'REVIEW';
    if (m.canonicalCategory === 'JUNK') {
      disposition = 'JUNK';
    } else if (m.canonicalCategory !== 'REVIEW') {
      disposition = 'KEEP';
    }
    console.log(`| \`${m.sourceName}\` | \`${m.canonicalCategory}\` | **${disposition}** |`);
  });

