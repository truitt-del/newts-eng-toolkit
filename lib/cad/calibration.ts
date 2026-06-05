import { AffineTransform } from './sessionStore';

/**
 * Computes the similarity affine transform matrix from two points.
 * Maps PDF coordinates (px, py) to DXF coordinates (dx, dy).
 *
 * Transformation equations:
 * dx = A * px - B * py + tx
 * dy = B * px + A * py + ty
 */
export function calculateAffineTransform(
  dxfPt1: { x: number; y: number },
  pdfPt1: { x: number; y: number },
  dxfPt2: { x: number; y: number },
  pdfPt2: { x: number; y: number }
): AffineTransform {
  const pxDiff = pdfPt2.x - pdfPt1.x;
  const pyDiff = pdfPt2.y - pdfPt1.y;
  const Lpdf2 = pxDiff * pxDiff + pyDiff * pyDiff;

  if (Lpdf2 < 1e-4) {
    throw new Error('PDF reference points must be distinct. Please choose points that are further apart.');
  }

  const dxDiff = dxfPt2.x - dxfPt1.x;
  const dyDiff = dxfPt2.y - dxfPt1.y;

  const A = (dxDiff * pxDiff + dyDiff * pyDiff) / Lpdf2;
  const B = (dyDiff * pxDiff - dxDiff * pyDiff) / Lpdf2;

  const s = Math.sqrt(A * A + B * B);
  const theta = Math.atan2(B, A);

  const tx = dxfPt1.x - (A * pdfPt1.x - B * pdfPt1.y);
  const ty = dxfPt1.y - (B * pdfPt1.x + A * pdfPt1.y);

  return { s, theta, tx, ty };
}

/**
 * Reconstructs the 2D transform matrix components for SVG transform string.
 * Maps PDF pixel space (px, py) to SVG coordinate space (sx, sy) where:
 * sx = dx
 * sy = -dy
 *
 * SVG Matrix standard format: matrix(a, b, c, d, e, f)
 * sx = a * px + c * py + e
 * sy = b * px + d * py + f
 */
export function getSvgTransformMatrixString(t: AffineTransform): string {
  const A = t.s * Math.cos(t.theta);
  const B = t.s * Math.sin(t.theta);

  // sx = A * px - B * py + tx
  // sy = -B * px - A * py - ty
  const a = A.toFixed(6);
  const b = (-B).toFixed(6);
  const c = (-B).toFixed(6);
  const d = (-A).toFixed(6);
  const e = t.tx.toFixed(3);
  const f = (-t.ty).toFixed(3);

  return `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
}
