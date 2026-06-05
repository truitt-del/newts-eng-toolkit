'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Vertex, LineEntity, Polyline, InsertEntity, TextEntity } from '@/lib/dxf/parser';
import { ImporterSession, ClosedWallPolygon, ExplicitOpening, Fixture, RoomInstance, StairInstance, ExceptionItem } from '@/lib/cad/sessionStore';
import { getSvgTransformMatrixString } from '@/lib/cad/calibration';
import { cleanMText } from '@/lib/cad/mtextParser';

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
  // Extra features for compiled layers
  walls?: ClosedWallPolygon[];
  openings?: ExplicitOpening[];
  fixtures?: Fixture[];
  rooms?: RoomInstance[];
  stairs?: StairInstance[];
  exceptions?: ExceptionItem[];
  focusedCoordinates?: { x: number; y: number } | null;
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
  walls = [],
  openings = [],
  fixtures = [],
  rooms = [],
  stairs = [],
  exceptions = [],
  focusedCoordinates = null
}: ImporterCanvasProps) {
  const [viewBox, setViewBox] = useState<ViewBox | null>(null);
  const [originalViewBox, setOriginalViewBox] = useState<ViewBox | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  // Focus effect to center and zoom onto specific coordinates
  useEffect(() => {
    if (focusedCoordinates && viewBox) {
      const zoomWindowSize = 300; // Physical width/height window size in native units
      setViewBox({
        x: focusedCoordinates.x - zoomWindowSize / 2,
        y: -focusedCoordinates.y - zoomWindowSize / 2, // Flip Y for SVG space
        w: zoomWindowSize,
        h: zoomWindowSize
      });
    }
  }, [focusedCoordinates]);
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
                stroke={isWallLayer ? 'rgba(154, 178, 199, 0.3)' : 'rgba(154, 178, 199, 0.2)'}
                strokeWidth={isWallLayer ? strokeWidth * 1.2 : strokeWidth}
                strokeOpacity={0.4}
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
                stroke={isWallLayer ? 'rgba(154, 178, 199, 0.3)' : 'rgba(154, 178, 199, 0.2)'}
                strokeWidth={isWallLayer ? strokeWidth * 1.5 : strokeWidth}
                strokeOpacity={0.4}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* Render Assembled Closed Wall Polygons with Poché attributes */}
          {walls.map((w) => {
            const pts = w.vertices.map(v => `${v.x},${-v.y}`).join(' ');
            const fill = w.bearing ? 'rgba(75, 160, 70, 0.35)' : 'rgba(33, 150, 243, 0.18)';
            const stroke = w.bearing ? 'rgba(75, 160, 70, 0.9)' : 'rgba(33, 150, 243, 0.8)';
            return (
              <polygon
                key={`wall-poly-${w.id}`}
                points={pts}
                fill={fill}
                stroke={stroke}
                strokeWidth={strokeWidth * 1.6}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'pointer' }}
              >
                <title>{`Wall ${w.id} (${w.thickness.toFixed(1)}" thickness, bearing: ${w.bearing})`}</title>
              </polygon>
            );
          })}

          {/* Render Stair Group Boundaries */}
          {stairs.map((s) => {
            const isHigh = s.confidence === 'high';
            return (
              <g key={`stair-${s.id}`}>
                <rect
                  x={s.bounds.minX}
                  y={-s.bounds.maxY}
                  width={s.bounds.maxX - s.bounds.minX}
                  height={s.bounds.maxY - s.bounds.minY}
                  fill="rgba(255, 193, 7, 0.1)"
                  stroke={isHigh ? '#ffc107' : 'rgba(255, 152, 0, 0.7)'}
                  strokeWidth={strokeWidth * 1.5}
                  strokeDasharray={isHigh ? undefined : '3 3'}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={(s.bounds.minX + s.bounds.maxX) / 2}
                  y={-(s.bounds.minY + s.bounds.maxY) / 2}
                  fontSize={labelSize * 0.7}
                  fill="#ffc107"
                  textAnchor="middle"
                  style={{ fontFamily: 'var(--font-mono), monospace', fontWeight: 'bold' }}
                >
                  STAIRS ({s.treads} Tr)
                </text>
              </g>
            );
          })}

          {/* Render Door and Window Openings */}
          {openings.map((o) => {
            const isDoor = o.type === 'door';
            const color = isDoor ? '#ff2a2a' : '#03a9f4';
            return (
              <g key={`opening-node-${o.id}`}>
                {/* Visual marker line representing the opening lateral run */}
                <circle
                  cx={o.x}
                  cy={-o.y}
                  r={Math.max(4, o.width / 2)}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth * 2.5}
                  strokeDasharray={isDoor ? undefined : '2 2'}
                  vectorEffect="non-scaling-stroke"
                  opacity={0.8}
                />
                <text
                  x={o.x}
                  y={-o.y - 6}
                  fontSize={labelSize * 0.6}
                  fill={color}
                  textAnchor="middle"
                  style={{ fontFamily: 'var(--font-mono), monospace', fontWeight: 600 }}
                >
                  {isDoor ? 'DOOR' : 'WIN'} {Math.round(o.width)}&quot;
                </text>
              </g>
            );
          })}

          {/* Render Plumbing Fixtures */}
          {fixtures.map((f) => {
            let color = '#9c27b0'; // purple (other)
            if (f.type === 'toilet') color = '#2196f3'; // blue
            if (f.type === 'sink') color = '#00bcd4'; // cyan
            if (f.type === 'tub') color = '#ff5722'; // orange-red for tubs/showers
            return (
              <g key={`fixture-svg-${f.id}`}>
                <circle
                  cx={f.x}
                  cy={-f.y}
                  r={Math.max(4, viewBox ? viewBox.w / 120 : 6)}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={strokeWidth}
                  style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.3))' }}
                />
                <text
                  x={f.x}
                  y={-f.y + (viewBox ? viewBox.w / 100 : 8) + 2}
                  fontSize={labelSize * 0.65}
                  fill={color}
                  textAnchor="middle"
                  style={{ fontFamily: 'var(--font-mono), monospace', fontWeight: 'bold' }}
                >
                  {f.type.toUpperCase()}
                </text>
              </g>
            );
          })}

          {/* Render Parsed Room Labels */}
          {rooms.map((r) => (
            <g key={`room-label-svg-${r.id}`} style={{ pointerEvents: 'none' }}>
              <rect
                x={r.x - 45}
                y={-r.y - labelSize * 0.8}
                width="90"
                height={labelSize * 1.8}
                fill="rgba(17, 33, 50, 0.75)"
                rx="2"
                style={{ pointerEvents: 'none' }}
              />
              <text
                x={r.x}
                y={-r.y}
                fontSize={labelSize * 0.9}
                fill="#ffeb3b"
                textAnchor="middle"
                style={{
                  fontFamily: "'Syne', sans-serif",
                  fontWeight: 800,
                  filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))'
                }}
              >
                {r.name}
              </text>
              {r.dimensions && (
                <text
                  x={r.x}
                  y={-r.y + labelSize * 0.75}
                  fontSize={labelSize * 0.6}
                  fill="var(--ink-muted)"
                  textAnchor="middle"
                  style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontWeight: 500,
                  }}
                >
                  {r.dimensions}
                </text>
              )}
            </g>
          ))}

          {/* Render Pulsing Exception Markers */}
          {exceptions.filter(e => !e.resolved && e.location).map((e) => (
            <g key={`exc-ring-${e.id}`}>
              <circle
                cx={e.location!.x}
                cy={-e.location!.y}
                r="16"
                fill="rgba(244, 67, 54, 0.15)"
                stroke="#f44336"
                strokeWidth="2"
              >
                <animate attributeName="r" values="10;20;10" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.6s" repeatCount="indefinite" />
              </circle>
              <circle
                cx={e.location!.x}
                cy={-e.location!.y}
                r="4"
                fill="#f44336"
              />
            </g>
          ))}

          {/* Render Text Entities as subtle nodes (from unclassified review layers) */}
          {textEntities.filter(t => {
            const key = `layer:${t.layer}`;
            // If the layer is already mapped to RMNAME, we don't double render it here
            return !t.layer.toLowerCase().includes('rmname') && !t.layer.toLowerCase().includes('room');
          }).map((t, idx) => {
            const cleanText = cleanMText(t.text);
            if (!cleanText) return null;
            const lines = cleanText.split('\n');
            return (
              <g key={`text-${idx}`} style={{ pointerEvents: 'none' }}>
                <text
                  x={t.x}
                  y={-t.y}
                  fontSize={labelSize * 0.75}
                  fill="rgba(154, 178, 199, 0.6)"
                  fillOpacity={0.7}
                  style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontWeight: 500,
                  }}
                >
                  {lines.map((line, lIdx) => (
                    <tspan key={lIdx} x={t.x} dy={lIdx === 0 ? 0 : labelSize * 1.0}>
                      {line}
                    </tspan>
                  ))}
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
