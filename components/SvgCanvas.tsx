'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Vertex, LineEntity } from '@/lib/dxf/parser';
import { ClassifiedWall, bboxOf } from '@/lib/dxf/analyzer';

export interface LocusPoint {
  x: number;
  y: number;
  color: string;
  label?: string;
}

interface SvgCanvasProps {
  walls: ClassifiedWall[];
  lineEntities: LineEntity[];
  points?: LocusPoint[];
  hoveredWallId: number | null;
  onHoverWall: (id: number | null) => void;
  showCenterlines?: boolean;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function SvgCanvas({
  walls,
  lineEntities,
  points = [],
  hoveredWallId,
  onHoverWall,
  showCenterlines = false,
}: SvgCanvasProps) {
  const [viewBox, setViewBox] = useState<ViewBox | null>(null);
  const [originalViewBox, setOriginalViewBox] = useState<ViewBox | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const dragStart = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);

  // Filter extra lines
  const wallLines = useMemo(() => {
    return lineEntities.filter(l => /wall/i.test(l.layer));
  }, [lineEntities]);

  // Compute view box on load or when walls change
  useEffect(() => {
    if (walls.length === 0) {
      setViewBox(null);
      setOriginalViewBox(null);
      return;
    }

    const allVertices = walls.flatMap(wall => wall.vertices);
    wallLines.forEach(l => {
      allVertices.push({ x: l.x1, y: l.y1 });
      allVertices.push({ x: l.x2, y: l.y2 });
    });

    const bb = bboxOf(allVertices);
    if (bb) {
      const padX = (bb.maxX - bb.minX) * 0.08 || 20;
      const padY = (bb.maxY - bb.minY) * 0.08 || 20;
      // Flip Y: SVG y = -world y
      const vb = {
        x: bb.minX - padX,
        y: -bb.maxY - padY,
        w: (bb.maxX - bb.minX) + padX * 2,
        h: (bb.maxY - bb.minY) + padY * 2,
      };
      setViewBox(vb);
      setOriginalViewBox(vb);
    } else {
      setViewBox(null);
      setOriginalViewBox(null);
    }
  }, [walls, wallLines]);

  const resetView = useCallback(() => {
    if (originalViewBox) {
      setViewBox(originalViewBox);
    }
  }, [originalViewBox]);

  const zoom = useCallback((factor: number) => {
    setViewBox(prev => {
      if (!prev) return null;
      const newW = prev.w * factor;
      const newH = prev.h * factor;
      const newX = prev.x + (prev.w - newW) / 2;
      const newY = prev.y + (prev.h - newH) / 2;
      return { x: newX, y: newY, w: newW, h: newH };
    });
  }, []);

  // Mouse wheel zoom
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!viewBox) return;
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;

    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;

    const ctm = svg.getScreenCTM();
    if (!ctm) return;

    const svgPt = pt.matrixTransform(ctm.inverse());
    const factor = e.deltaY < 0 ? 0.85 : 1.18;

    const newW = viewBox.w * factor;
    const newH = viewBox.h * factor;
    const newX = svgPt.x - (svgPt.x - viewBox.x) * factor;
    const newY = svgPt.y - (svgPt.y - viewBox.y) * factor;

    setViewBox({ x: newX, y: newY, w: newW, h: newH });
  };

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!viewBox) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, vb: { ...viewBox } };
  };

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;

    // Track mouse coordinates in CAD space
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const svgPt = pt.matrixTransform(ctm.inverse());
      setMousePos({ x: svgPt.x, y: -svgPt.y });
    }

    if (!dragging || !dragStart.current || !viewBox) return;

    const rect = svg.getBoundingClientRect();
    const scaleX = viewBox.w / rect.width;
    const scaleY = viewBox.h / rect.height;
    const dx = (e.clientX - dragStart.current.x) * scaleX;
    const dy = (e.clientY - dragStart.current.y) * scaleY;

    setViewBox({
      x: dragStart.current.vb.x - dx,
      y: dragStart.current.vb.y - dy,
      w: dragStart.current.vb.w,
      h: dragStart.current.vb.h,
    });
  };

  const onMouseUp = () => {
    setDragging(false);
    dragStart.current = null;
  };

  // Helper values for dynamic sizing
  const dotRadius = viewBox ? Math.max(1.8, viewBox.w / 160) : 4;
  const strokeWidth = viewBox ? Math.max(0.4, viewBox.w / 700) : 0.6;
  const highlightWidth = strokeWidth * 2.5;

  if (walls.length === 0 && wallLines.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--ink-muted)',
        textAlign: 'center',
        padding: '2rem'
      }}>
        <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>No wall geometry detected.</p>
        <p className="mono" style={{ fontSize: '0.75rem', color: 'var(--ink-disabled)' }}>
          Check that layers in your DXF contain the word &quot;wall&quot;.
        </p>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <svg
          ref={svgRef}
          viewBox={viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}` : '0 0 100 100'}
          style={{
            width: '100%',
            height: '100%',
            cursor: dragging ? 'grabbing' : 'grab',
            display: 'block',
            touchAction: 'none',
          }}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Grid Pattern */}
          <defs>
            <pattern id="canvas-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(42,38,31,0.03)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect
            x={viewBox ? viewBox.x - viewBox.w : -10000}
            y={viewBox ? viewBox.y - viewBox.h : -10000}
            width={viewBox ? viewBox.w * 3 : 20000}
            height={viewBox ? viewBox.h * 3 : 20000}
            fill="url(#canvas-grid)"
            style={{ pointerEvents: 'none' }}
          />

          {/* Render Wall Polygons */}
          {walls.map((w) => {
            const isHovered = hoveredWallId === w.id;
            return (
              <polygon
                key={`w-${w.id}`}
                points={w.vertices.map(v => `${v.x},${-v.y}`).join(' ')}
                fill={w.bearing ? '#c8c4b5' : 'none'}
                fillOpacity={w.bearing ? 0.75 : 0}
                stroke={isHovered ? 'var(--accent)' : 'var(--accent-dark)'}
                strokeWidth={isHovered ? highlightWidth : strokeWidth}
                vectorEffect="non-scaling-stroke"
                style={{
                  transition: 'fill-opacity 0.2s, stroke 0.1s',
                  cursor: 'pointer'
                }}
                onMouseEnter={() => onHoverWall(w.id)}
                onMouseLeave={() => onHoverWall(null)}
              />
            );
          })}

          {/* Render Centerlines/Segments Overlay if toggled */}
          {showCenterlines && walls.map((w) => {
            const isHovered = hoveredWallId === w.id;
            return w.segments.map((seg, sIdx) => {
              const runsX = seg.longAxis === 'X';
              const x1 = runsX ? seg.endpointMin : seg.centerline;
              const y1 = runsX ? seg.centerline : seg.endpointMin;
              const x2 = runsX ? seg.endpointMax : seg.centerline;
              const y2 = runsX ? seg.centerline : seg.endpointMax;

              return (
                <g key={`w-${w.id}-seg-${sIdx}`} style={{ pointerEvents: 'none' }}>
                  {/* Glowing line for segment centerline */}
                  <line
                    x1={x1}
                    y1={-y1}
                    x2={x2}
                    y2={-y2}
                    stroke="var(--accent)"
                    strokeWidth={strokeWidth * 2}
                    strokeOpacity={isHovered ? 0.9 : 0.6}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Endcaps for centerline */}
                  <circle cx={x1} cy={-y1} r={strokeWidth * 2.5} fill="var(--accent)" vectorEffect="non-scaling-stroke" />
                  <circle cx={x2} cy={-y2} r={strokeWidth * 2.5} fill="var(--accent)" vectorEffect="non-scaling-stroke" />
                </g>
              );
            });
          })}

          {/* Render Extra Lines */}
          {wallLines.map((l, id) => (
            <line
              key={`l-${id}`}
              x1={l.x1}
              y1={-l.y1}
              x2={l.x2}
              y2={-l.y2}
              stroke="var(--accent-dark)"
              strokeWidth={strokeWidth}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              style={{ opacity: 0.5 }}
            />
          ))}

          {/* AI Locus Points */}
          {points.map((p, id) => (
            <g key={`p-${id}`}>
              <circle
                cx={p.x}
                cy={-p.y}
                r={dotRadius}
                fill={p.color || 'var(--accent)'}
                stroke="var(--foreground)"
                strokeWidth={strokeWidth * 0.8}
                vectorEffect="non-scaling-stroke"
              />
              {p.label && (
                <text
                  x={p.x + dotRadius * 1.4}
                  y={-p.y - dotRadius * 0.8}
                  fontSize={dotRadius * 1.5}
                  fill="var(--foreground)"
                  style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontWeight: 600,
                    pointerEvents: 'none',
                    userSelect: 'none',
                  }}
                >
                  {p.label}
                </text>
              )}
            </g>
          ))}
        </svg>

        {/* Floating Tooltips & Controls Overlay */}
        <div style={{
          position: 'absolute',
          bottom: '1rem',
          left: '1rem',
          backgroundColor: 'var(--paper-light)',
          border: '1px solid var(--foreground)',
          padding: '0.65rem 0.9rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
          pointerEvents: 'none',
          maxWidth: '260px'
        }}>
          {hoveredWallId !== null && walls[hoveredWallId] ? (
            (() => {
              const w = walls[hoveredWallId];
              return (
                <>
                  <div className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 600 }}>
                    Wall #{w.id} ({w.bearing ? 'Bearing' : 'Non-bearing'})
                  </div>
                  <div className="mono" style={{ fontSize: '0.75rem', fontWeight: 600, wordBreak: 'break-all' }}>
                    {w.layer}
                  </div>
                  <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-muted)' }}>
                    Vertices: {w.vertices.length} · Segments: {w.segments.length}
                  </div>
                  {w.bbox && (
                    <div style={{ borderTop: '1px solid rgba(42,38,31,0.1)', paddingTop: '0.25rem', marginTop: '0.1rem' }}>
                      <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-disabled)' }}>Bounding Box:</div>
                      <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--foreground)' }}>
                        X: [{w.bbox.minX.toFixed(1)}, {w.bbox.maxX.toFixed(1)}]
                      </div>
                      <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--foreground)' }}>
                        Y: [{w.bbox.minY.toFixed(1)}, {w.bbox.maxY.toFixed(1)}]
                      </div>
                    </div>
                  )}
                </>
              );
            })()
          ) : (
            <>
              <div className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--ink-disabled)' }}>
                Navigation
              </div>
              <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
                Scroll to Zoom · Drag to Pan
              </div>
            </>
          )}

          {mousePos && (
            <div style={{ borderTop: '1px solid rgba(42,38,31,0.1)', paddingTop: '0.25rem', marginTop: '0.1rem' }}>
              <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-disabled)' }}>
                Coordinates (in)
              </div>
              <div className="mono" style={{ fontSize: '0.7rem', color: 'var(--foreground)' }}>
                X: {mousePos.x.toFixed(2)} Y: {mousePos.y.toFixed(2)}
              </div>
            </div>
          )}
        </div>

        {/* Floating Zoom Toolbar */}
        <div style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.35rem',
          backgroundColor: 'var(--paper-light)',
          border: '1px solid var(--foreground)',
          padding: '0.35rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
        }}>
          <button
            onClick={() => zoom(0.8)}
            title="Zoom In"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--foreground)',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--paper-dark)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={() => zoom(1.25)}
            title="Zoom Out"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--foreground)',
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--paper-dark)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={resetView}
            title="Reset View"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--foreground)',
              transition: 'background 0.1s',
              borderTop: '1px solid rgba(42,38,31,0.1)'
            }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--paper-dark)')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            <svg width="14" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
        </div>
      </div>

      {/* Legend / Canvas Footer */}
      <div style={{
        padding: '0.65rem 1rem',
        borderTop: '1px solid var(--foreground)',
        backgroundColor: 'var(--paper-dark)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '1rem',
        fontSize: '0.72rem'
      }}>
        <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ display: 'inline-block', width: '14px', height: '10px', backgroundColor: '#c8c4b5', border: '1px solid var(--accent-dark)' }} />
            <span className="mono" style={{ color: 'var(--ink-muted)' }}>Classified Bearing Wall</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ display: 'inline-block', width: '14px', height: '10px', border: '1px solid var(--accent-dark)' }} />
            <span className="mono" style={{ color: 'var(--ink-muted)' }}>Non-Bearing Wall Boundary</span>
          </div>
          {showCenterlines && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span style={{ display: 'inline-block', width: '14px', height: '2px', backgroundColor: 'var(--accent)' }} />
              <span className="mono" style={{ color: 'var(--ink-muted)' }}>Precomputed Centerline Segment</span>
            </div>
          )}
        </div>
        <div className="mono" style={{ color: 'var(--ink-disabled)' }}>
          Scale: 1 unit = 1 inch · Y: UP (flipped for SVG)
        </div>
      </div>
    </div>
  );
}
