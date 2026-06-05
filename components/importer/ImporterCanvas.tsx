'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Vertex, LineEntity, Polyline, InsertEntity, TextEntity } from '@/lib/dxf/parser';
import { ImporterSession } from '@/lib/cad/sessionStore';
import { getSvgTransformMatrixString } from '@/lib/cad/calibration';

interface ImporterCanvasProps {
  polylines: Polyline[];
  lineEntities: LineEntity[];
  inserts?: InsertEntity[];
  textEntities?: TextEntity[];
  tolerances: {
    snap: number;
    prune: number;
    wMin: number;
    wMax: number;
  };
  unitName: string;
  unitScale: number;
  pdfData?: ImporterSession['pdfData'];
  pdfOpacity?: number;
  calibrationStep?: number;
  calibDxfPt1?: { x: number; y: number } | null;
  calibDxfPt2?: { x: number; y: number } | null;
  onDxfClick?: (x: number, y: number) => void;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function ImporterCanvas({
  polylines,
  lineEntities,
  inserts = [],
  textEntities = [],
  tolerances,
  unitName,
  unitScale,
  pdfData,
  pdfOpacity = 0.5,
  calibrationStep = 0,
  calibDxfPt1 = null,
  calibDxfPt2 = null,
  onDxfClick,
}: ImporterCanvasProps) {
  const [viewBox, setViewBox] = useState<ViewBox | null>(null);
  const [originalViewBox, setOriginalViewBox] = useState<ViewBox | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const dragStart = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);

  // Compute overall bounds and initialize ViewBox
  useEffect(() => {
    if (polylines.length === 0 && lineEntities.length === 0) {
      setViewBox(null);
      setOriginalViewBox(null);
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    const checkPoint = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };

    lineEntities.forEach(l => {
      checkPoint(l.x1, l.y1);
      checkPoint(l.x2, l.y2);
    });

    polylines.forEach(p => {
      p.vertices.forEach(v => {
        checkPoint(v.x, v.y);
      });
    });

    if (minX === Infinity) {
      setViewBox(null);
      setOriginalViewBox(null);
      return;
    }

    const padX = (maxX - minX) * 0.1 || 50;
    const padY = (maxY - minY) * 0.1 || 50;

    // AutoCAD Y is up, SVG Y is down. Flip Y coords in rendering: svg_y = -cad_y
    const vb = {
      x: minX - padX,
      y: -maxY - padY,
      w: (maxX - minX) + padX * 2,
      h: (maxY - minY) + padY * 2,
    };

    setViewBox(vb);
    setOriginalViewBox(vb);
  }, [polylines, lineEntities]);

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

    // If we are in calibration mode, register DXF clicks and prevent dragging
    if ((calibrationStep === 1 || calibrationStep === 3) && onDxfClick && mousePos) {
      onDxfClick(mousePos.x, mousePos.y);
      return;
    }

    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, vb: { ...viewBox } };
  };

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;

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

  // Helper values for line thicknesses in SVG based on view size
  const strokeWidth = viewBox ? Math.max(0.3, viewBox.w / 900) : 0.6;
  const labelSize = viewBox ? Math.max(6, viewBox.w / 120) : 10;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--paper-dark)' }}>
      {/* HUD Toolbar */}
      <div style={{
        position: 'absolute',
        top: '1rem',
        left: '1rem',
        zIndex: 10,
        backgroundColor: 'rgba(17, 33, 50, 0.85)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--ink-disabled)',
        padding: '0.5rem 0.85rem',
        borderRadius: '4px',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.15rem'
      }}>
        <div style={{ fontSize: '0.6rem', textTransform: 'uppercase', color: 'var(--accent-light)', fontWeight: 700, letterSpacing: '0.08em' }}>
          CAD Vector Engine [Step 1]
        </div>
        <div className="mono" style={{ fontSize: '0.75rem', fontWeight: 600, color: '#fff' }}>
          {polylines.length} polylines · {lineEntities.length} lines · {inserts.length} inserts
        </div>
      </div>

      {/* Floating Canvas Controls */}
      <div style={{
        position: 'absolute',
        top: '1rem',
        right: '1rem',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        backgroundColor: 'var(--paper-light)',
        border: '1px solid var(--ink-disabled)',
        padding: '0.35rem',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
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
            borderRadius: '2px',
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
            borderRadius: '2px',
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
            borderRadius: '2px',
            transition: 'background 0.1s',
            borderTop: '1px solid var(--ink-disabled)'
          }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--paper-dark)')}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          <svg width="14" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
        </button>
      </div>

      {/* SVG Canvas Workspace */}
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
          {/* Subtle engineering grid backplate */}
          <defs>
            <pattern id="importer-grid" width="48" height="448" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="rgba(255,255,255,0.03)" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect
            x={viewBox ? viewBox.x - viewBox.w : -20000}
            y={viewBox ? viewBox.y - viewBox.h : -20000}
            width={viewBox ? viewBox.w * 3 : 40000}
            height={viewBox ? viewBox.h * 3 : 40000}
            fill="url(#importer-grid)"
            style={{ pointerEvents: 'none' }}
          />

          {/* Render PDF Underlay */}
          {pdfData?.imageUri && pdfData.transformMatrix && (
            <image
              href={pdfData.imageUri}
              x="0"
              y="0"
              width={pdfData.width || 1200}
              height={pdfData.height || 1600}
              transform={getSvgTransformMatrixString(pdfData.transformMatrix)}
              opacity={pdfOpacity}
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Render DXF lines */}
          {lineEntities.map((l, idx) => {
            const isWallLayer = /wall/i.test(l.layer);
            return (
              <line
                key={`line-${idx}`}
                x1={l.x1}
                y1={-l.y1}
                x2={l.x2}
                y2={-l.y2}
                stroke={isWallLayer ? 'var(--accent)' : 'rgba(154, 178, 199, 0.4)'}
                strokeWidth={isWallLayer ? strokeWidth * 1.5 : strokeWidth}
                strokeOpacity={isWallLayer ? 0.9 : 0.5}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* Render DXF polylines */}
          {polylines.map((p, idx) => {
            const isWallLayer = /wall/i.test(p.layer);
            if (p.vertices.length < 2) return null;
            return (
              <polyline
                key={`poly-${idx}`}
                points={p.vertices.map(v => `${v.x},${-v.y}`).join(' ')}
                fill="none"
                stroke={isWallLayer ? 'var(--accent)' : 'rgba(154, 178, 199, 0.4)'}
                strokeWidth={isWallLayer ? strokeWidth * 1.8 : strokeWidth}
                strokeOpacity={isWallLayer ? 0.9 : 0.5}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* Render Text Entities as subtle nodes */}
          {textEntities.map((t, idx) => {
            const cleanText = t.text.replace(/[{}]|\\f[^;]+;|\\H[0-9.]+;/g, '').trim();
            if (!cleanText) return null;
            return (
              <g key={`text-${idx}`} style={{ pointerEvents: 'none' }}>
                <text
                  x={t.x}
                  y={-t.y}
                  fontSize={labelSize}
                  fill="var(--accent-light)"
                  fillOpacity={0.85}
                  style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontWeight: 500,
                  }}
                >
                  {cleanText}
                </text>
              </g>
            );
          })}

          {/* Render calibration point markers on SVG canvas */}
          {calibDxfPt1 && (
            <circle
              cx={calibDxfPt1.x}
              cy={-calibDxfPt1.y}
              r={Math.max(6, (viewBox?.w || 100) / 100)}
              fill="#4ba046"
              stroke="#fff"
              strokeWidth={strokeWidth * 2}
              style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))' }}
            />
          )}

          {calibDxfPt2 && (
            <circle
              cx={calibDxfPt2.x}
              cy={-calibDxfPt2.y}
              r={Math.max(6, (viewBox?.w || 100) / 100)}
              fill="#ff9800"
              stroke="#fff"
              strokeWidth={strokeWidth * 2}
              style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))' }}
            />
          )}
        </svg>

        {/* HUD Footbar for Coordinates tracking */}
        <div style={{
          position: 'absolute',
          bottom: '1rem',
          right: '1rem',
          backgroundColor: 'rgba(17, 33, 50, 0.85)',
          backdropFilter: 'blur(8px)',
          border: '1px solid var(--ink-disabled)',
          padding: '0.45rem 0.75rem',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          pointerEvents: 'none',
          display: 'flex',
          gap: '1rem'
        }}>
          {mousePos && (
            <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-muted)' }}>
              CAD: X: <span style={{ color: '#fff' }}>{mousePos.x.toFixed(1)}&quot;</span> Y: <span style={{ color: '#fff' }}>{mousePos.y.toFixed(1)}&quot;</span>
            </div>
          )}
          <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-disabled)' }}>
            Grid units: {unitName}
          </div>
        </div>
      </div>
    </div>
  );
}
