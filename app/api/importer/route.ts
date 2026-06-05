import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export const maxDuration = 300; // 5 minutes

export async function POST(req: NextRequest) {
  try {
    const { layers, blocks } = await req.json();

    if (!layers || !Array.isArray(layers)) {
      return NextResponse.json({ error: 'Missing raw layers array' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY is not configured.' }, { status: 500 });
    }

    const ai = new GoogleGenAI({ apiKey });

    const systemInstruction = `You are a professional structural drafting assistant. You analyze AutoCAD and Vectorworks CAD layer names and block definitions to map them to a canonical taxonomy.

CANONICAL TAXONOMY:
1. WALL: Load-bearing and partition walls (e.g. 1-WALL, WALL_EXT, STRUCTURAL_WALL, BRK_WALL).
2. POCHE: Solid fills, hatch patterns, or layers representing concrete/wood poché cores (e.g. 1-POCHE, HATCH-DENSE, SOLID_FILL).
3. FIX: Bathroom and kitchen fixtures, appliances, plumbing (e.g. 1-FIX, TOILET_BLOCK, PLUMBING, TUB, SINK).
4. DOOR: Interior and exterior door elements and panels (e.g. 1-DOOR, DR_36, EXT_ENTRY_DOOR).
5. WIN: Glazing, window frames, mullions (e.g. 1-WIN, WINDOW_SASH, GLAZING).
6. RMNAME: Room text labels, labels containing name annotations, floor finishes, areas (e.g. 1-RMNAME, ROOM-LABEL, ROOM_NAMES). Exclude general notes/annotations unless they identify specific rooms.
7. STAIR: Stairs, step treads, risers, handrails, stoops, ramps (e.g. 1-STAIR, ST_STEP_UP, TREADS, PORCH_STEPS).
8. ROOF: Roof layout, ridges, rafters, truss layouts (e.g. 1-ROOF, TRUSS_BEAMS).
9. GRID: Column grids, grid line witnesses, structural column blocks (e.g. 1-GRID, COLUMN_GRID, COL_C1).
10. JUNK: Drafting frames, title blocks, defpoints, viewports, borders (e.g. 0, DEFPOINTS, BOR-BORDER, SHEET_TITLE).
11. REVIEW: Anything else that is unclassified or needs manual human inspection (e.g. 1-MISC, 1-TEXT, 1-DIM).

RULES:
- Be highly precise.
- For layer/block name patterns, default to REVIEW if there is no strong indicator.
- Never map general annotation/text layers (like '1-TEXT', '1-TXT', '1-ANNO') to RMNAME; map them to REVIEW instead, because they are generic text. Room-specific name labels go to RMNAME.
- Return a structured JSON list containing classifications for each layer and block.`;

    const userPrompt = `Classify these unique layer names and block definitions found in the imported CAD file:

LAYERS:
${layers.map((l: string) => `- ${l}`).join('\n')}

BLOCKS/INSERTS:
${(blocks || []).map((b: string) => `- ${b}`).join('\n')}

Analyze their naming patterns and output appropriate mappings.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            mappings: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  sourceType: { type: 'STRING', enum: ['layer', 'block'] },
                  sourceName: { type: 'STRING' },
                  canonicalCategory: {
                    type: 'STRING',
                    enum: ['WALL', 'POCHE', 'FIX', 'DOOR', 'WIN', 'RMNAME', 'STAIR', 'JUNK', 'ROOF', 'GRID', 'REVIEW']
                  },
                  confidence: { type: 'NUMBER' },
                  reasoning: { type: 'STRING' }
                },
                required: ['sourceType', 'sourceName', 'canonicalCategory', 'confidence', 'reasoning']
              }
            }
          },
          required: ['mappings']
        }
      }
    });

    const text = response.text || '';
    const parsed = JSON.parse(text);

    return NextResponse.json(parsed);
  } catch (err: any) {
    console.error('AI Classifier API Error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
