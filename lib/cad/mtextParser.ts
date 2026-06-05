/**
 * Clean AutoCAD and Vectorworks MTEXT formatting codes.
 * Strips font families, text heights, nesting braces, colors, and paragraph codes.
 */
export function cleanMText(raw: string): string {
  let s = raw;

  // Replace paragraph code \P with a standard newline
  s = s.replace(/\\P/g, '\n');

  // Replace non-breaking spaces \~ with regular spaces
  s = s.replace(/\\~/g, ' ');

  // Handle stacked text fractions: \S1/2^; or \S1/2; -> 1/2
  s = s.replace(/\\S([^;^]*)(?:\^([^;]*))?;/g, (_, p1, p2) => {
    return p2 ? `${p1}/${p2}` : p1;
  });

  // Remove common prefix switches like \fArial|b1|i0|c0|p34; or \H0.75x; or \C2;
  // Form: \ + (f, H, C, A, W, T, Q, p) + anything up to ';'
  s = s.replace(/\\[fHCAWTQp][^;]*;/gi, '');

  // Remove formatting toggles: \L (underline on), \l (underline off), \O (overline on), \o (overline off)
  s = s.replace(/\\[L|l|O|o]/g, '');

  // Remove nesting group braces: { and }
  s = s.replace(/[{}]/g, '');

  // Standardize whitespace line-by-line
  return s
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim();
}

export interface ParsedRoomLabel {
  roomName: string;
  dimensions: string | null;
  ceilingHeight: string | null;
}

/**
 * Split clean MTEXT lines into Room Name, Dimensions, and Ceiling Height.
 */
export function parseRoomLabel(rawText: string): ParsedRoomLabel {
  const cleaned = cleanMText(rawText);
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

  let roomName = '';
  let dimensions: string | null = null;
  let ceilingHeight: string | null = null;

  for (const line of lines) {
    const isClg = /clg|ceiling|height|hgt/i.test(line) || /['-]\d+"?\s*c/i.test(line);
    const isDim = /\d+['-]/i.test(line) && (line.toLowerCase().includes('x') || line.toLowerCase().includes('×') || /\d+\s*\*/.test(line));

    if (isClg) {
      // Extract clean ceiling height or use line as is
      ceilingHeight = line;
    } else if (isDim) {
      dimensions = line;
    } else {
      if (!roomName) {
        roomName = line;
      } else {
        // If it has numbers but we didn't match isDim, treat as dimensions fallback
        if (/\d+/.test(line) && !dimensions) {
          dimensions = line;
        } else {
          roomName += ' ' + line;
        }
      }
    }
  }

  // Fallback if we have lines but roomName is empty
  if (!roomName && lines.length > 0) {
    roomName = lines[0];
  }

  return {
    roomName: roomName.toUpperCase().replace(/\s+/g, ' ').trim(),
    dimensions: dimensions ? dimensions.trim() : null,
    ceilingHeight: ceilingHeight ? ceilingHeight.trim() : null
  };
}
export function parseMText(raw: string): string {
  return cleanMText(raw);
}
