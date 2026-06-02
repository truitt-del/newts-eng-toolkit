import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export const maxDuration = 60; // Vercel Pro timeout bypass

// Helper function to extract points from markdown-style prose
function extractPointsFromMarkdown(text: string): any[] {
  if (!text) return [];
  const colorRe = /\b(blue|red|green|orange|purple|yellow|black|cyan|magenta)\b\s*[:=]?\s*\(?\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)?/gi;
  const openRe = /open[-_\s]*(\d+)/gi;

  const opens: { index: number; n: string }[] = [];
  let m;
  while ((m = openRe.exec(text)) !== null) {
    opens.push({ index: m.index, n: m[1] });
  }

  const points: any[] = [];
  colorRe.lastIndex = 0; // reset
  while ((m = colorRe.exec(text)) !== null) {
    const color = m[1].toLowerCase();
    const x = parseFloat(m[2]);
    const y = parseFloat(m[3]);
    if (!isFinite(x) || !isFinite(y)) continue;

    let openN: string | null = null;
    for (let i = opens.length - 1; i >= 0; i--) {
      if (opens[i].index < m.index) {
        openN = opens[i].n;
        break;
      }
    }
    const role = (color === 'blue' || color === 'green') ? 'start' : 'end';
    const label = openN ? `open-${openN}-${role}` : `${color}-${points.length}`;
    points.push({ x, y, color, label });
  }
  return points;
}

// Robust JSON point extractor
function extractPointsFromJSON(rawText: string): any[] {
  if (!rawText) return [];
  let text = rawText.replace(/```json|```/g, '');

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(text.substring(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) {
        return parsed.filter(p => typeof p?.x === 'number' && typeof p?.y === 'number');
      }
    } catch (e) { /* fall through */ }
  }

  const objects: any[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const obj = JSON.parse(text.substring(objStart, i + 1));
          if (typeof obj?.x === 'number' && typeof obj?.y === 'number') {
            objects.push(obj);
          }
        } catch (e) { /* skip */ }
          objStart = -1;
      }
    }
  }
  return objects;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { provider, model, system, userPrompt, walls, payloadMode } = body;

    if (!provider || !model || !system || !walls) {
      return NextResponse.json({ error: 'Missing required parameters: provider, model, system, or walls.' }, { status: 400 });
    }

    // Build the payload sent to the model based on payloadMode
    // Raw Mode: Send raw vertices and layer
    // Precomputed Mode: Send deterministic rectangular segments and bearing flag
    const wallsPayload = walls.map((w: any) => {
      if (payloadMode === 'raw') {
        return {
          id: w.id,
          layer: w.layer,
          bearing: w.bearing,
          vertices: w.vertices,
        };
      } else {
        return {
          id: w.id,
          bearing: w.bearing,
          segments: w.segments,
        };
      }
    });

    const trimmedUserPrompt = (userPrompt || '').trim();
    const formattedUserPrompt = trimmedUserPrompt
      ? `WALL DATA (coordinates in inches):\n${JSON.stringify(wallsPayload, null, 2)}\n\nADDITIONAL INSTRUCTIONS:\n${trimmedUserPrompt}\n\nNow call render_locus_points with all locus points.`
      : `WALL DATA (coordinates in inches):\n${JSON.stringify(wallsPayload, null, 2)}\n\nNow call render_locus_points with all locus points.`;

    const startTime = performance.now();

    let points: any[] = [];
    let rawResponse = '';
    let tokensIn = 0;
    let tokensOut = 0;

    if (provider === 'google') {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: 'GEMINI_API_KEY environment variable is not configured.' }, { status: 500 });
      }

      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model: model,
        contents: formattedUserPrompt,
        config: {
          systemInstruction: system,
          tools: [{
            functionDeclarations: [{
              name: 'render_locus_points',
              description: 'Render the locus points you have identified onto the floor plan view. Call this with the complete list of points.',
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  points: {
                    type: 'array',
                    description: 'Array of locus points to display on the plan',
                    items: {
                      type: 'object',
                      properties: {
                        x: { type: 'number', description: 'X coordinate in inches' },
                        y: { type: 'number', description: 'Y coordinate in inches' },
                        color: { type: 'string', description: 'CSS color name or hex code' },
                        label: { type: 'string', description: 'Brief label, under 24 chars' },
                      },
                      required: ['x', 'y', 'color', 'label'],
                    },
                  },
                },
                required: ['points'],
              },
            }],
          }],
          toolConfig: {
            functionCallingConfig: {
              mode: 'ANY' as any, // Forces tool call
              allowedFunctionNames: ['render_locus_points'],
            },
          },
        },
      });

      // Token usage extraction
      if (response.usageMetadata) {
        tokensIn = response.usageMetadata.promptTokenCount || 0;
        tokensOut = response.usageMetadata.candidatesTokenCount || 0;
      }

      // Points and response text extraction
      if (response.functionCalls && response.functionCalls.length > 0) {
        const call = response.functionCalls[0];
        if (call.name === 'render_locus_points') {
          const args = call.args as any;
          if (args && args.points && Array.isArray(args.points)) {
            points = args.points;
            rawResponse = `[tool_use: render_locus_points]\n${JSON.stringify(args, null, 2)}`;
          }
        }
      }

      if (points.length === 0) {
        const text = response.text || '';
        rawResponse = text;
        points = extractPointsFromJSON(text);
        if (points.length === 0) {
          points = extractPointsFromMarkdown(text);
        }
      }

    } else {
      return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });
    }

    const endTime = performance.now();
    const latency = Math.round(endTime - startTime);

    return NextResponse.json({
      points,
      rawResponse,
      usage: {
        input: tokensIn,
        output: tokensOut,
      },
      latency,
    });

  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
