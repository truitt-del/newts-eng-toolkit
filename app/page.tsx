'use client';

import React, { useState, useCallback } from 'react';
import { parseDXF, ParsedDXF } from '@/lib/dxf/parser';
import SvgCanvas from '@/components/SvgCanvas';

export default function Home() {
  const [fileStats, setFileStats] = useState<ParsedDXF | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<boolean>(false);

  const handleDXFText = useCallback((text: string, name: string) => {
    setLoading(true);
    setError(null);
    try {
      const parsed = parseDXF(text);
      setFileStats(parsed);
      setFileName(name);
    } catch (e: any) {
      setError(e.message || 'Failed to parse DXF file.');
      setFileStats(null);
      setFileName('');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      handleDXFText(text, file.name);
    };
    reader.readAsText(file);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = () => {
    setDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.dxf')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        handleDXFText(text, file.name);
      };
      reader.readAsText(file);
    } else {
      setError('Please upload a valid .dxf file.');
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      backgroundColor: 'var(--background)'
    }}>
      {/* HEADER */}
      <header style={{
        borderBottom: '1px solid var(--foreground)',
        backgroundColor: 'var(--paper-dark)',
        padding: '1.25rem 2rem'
      }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="mono" style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--accent)' }}>
              CAD-AI Sandbox · Phase 2
            </div>
            <h1 style={{ fontSize: '1.75rem', fontWeight: 600, letterSpacing: '-0.02em', marginTop: '0.25rem' }}>
              Interactive Plan Canvas
            </h1>
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main style={{
        flex: 1,
        maxWidth: fileStats ? '1200px' : '800px',
        width: '100%',
        margin: '2.5rem auto',
        padding: '0 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '2rem',
        transition: 'max-width 0.3s ease-in-out'
      }}>
        
        {/* DROPZONE */}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          style={{
            border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--foreground)'}`,
            borderRadius: '0px',
            backgroundColor: dragging ? 'var(--paper-dark)' : 'var(--paper-light)',
            padding: '4rem 2rem',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.15s ease-in-out',
            boxShadow: '0 2px 8px rgba(42,38,31,0.05)'
          }}
        >
          <input
            type="file"
            accept=".dxf"
            onChange={handleFileChange}
            id="dxf-file-input"
            style={{ display: 'none' }}
          />
          <label htmlFor="dxf-file-input" style={{ cursor: 'pointer', display: 'block' }}>
            <div className="mono" style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '0.75rem', letterSpacing: '0.1em' }}>
              {loading ? 'Processing File...' : 'DXF Upload Panel'}
            </div>
            <p style={{ fontSize: '1.25rem', marginBottom: '0.5rem', color: 'var(--foreground)' }}>
              Drag and drop your test DXF here, or click to browse
            </p>
            <p className="mono" style={{ fontSize: '0.7rem', color: 'var(--ink-disabled)' }}>
              Supports standard and lightweight polylines (LWPOLYLINE)
            </p>
          </label>
        </div>

        {/* ERROR STATE */}
        {error && (
          <div style={{
            border: '1px solid var(--accent)',
            backgroundColor: 'var(--paper-light)',
            padding: '1rem 1.5rem',
            color: 'var(--accent)'
          }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Parsing Error</h3>
            <p className="mono" style={{ fontSize: '0.8rem' }}>{error}</p>
          </div>
        )}

        {/* PARSE DIAGNOSTIC PANELS */}
        {fileStats && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5rem',
            border: '1px solid var(--foreground)',
            backgroundColor: 'var(--paper-light)',
            padding: '1.5rem',
            boxShadow: '0 4px 12px rgba(42,38,31,0.06)'
          }}>
            <div style={{ borderBottom: '1px solid var(--paper-dark)', paddingBottom: '0.75rem' }}>
              <div className="mono" style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
                Active File
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 600 }}>{fileName}</h2>
            </div>

            {/* INTERACTIVE SVG PLAN CANVAS */}
            <div style={{
              height: '550px',
              border: '1px solid var(--foreground)',
              backgroundColor: 'var(--background)',
              position: 'relative',
              boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.03)',
              overflow: 'hidden'
            }}>
              <SvgCanvas
                polylines={fileStats.polylines}
                lineEntities={fileStats.lineEntities}
              />
            </div>

            {/* STATS GRID */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1.25rem' }}>
              <div style={{ backgroundColor: 'var(--background)', padding: '1rem', border: '1px solid var(--paper-dark)' }}>
                <div className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>Polylines</div>
                <div className="mono" style={{ fontSize: '1.75rem', fontWeight: 600, color: 'var(--accent)', marginTop: '0.25rem' }}>
                  {fileStats.polylines.length}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginTop: '0.25rem' }}>Wall candidates</p>
              </div>

              <div style={{ backgroundColor: 'var(--background)', padding: '1rem', border: '1px solid var(--paper-dark)' }}>
                <div className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>Hatches</div>
                <div className="mono" style={{ fontSize: '1.75rem', fontWeight: 600, color: 'var(--foreground)', marginTop: '0.25rem' }}>
                  {fileStats.hatches.length}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginTop: '0.25rem' }}>Solid fills (bearing layers)</p>
              </div>

              <div style={{ backgroundColor: 'var(--background)', padding: '1rem', border: '1px solid var(--paper-dark)' }}>
                <div className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>Extra Lines</div>
                <div className="mono" style={{ fontSize: '1.75rem', fontWeight: 600, color: 'var(--accent-dark)', marginTop: '0.25rem' }}>
                  {fileStats.lineEntities.length}
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginTop: '0.25rem' }}>Dashed/layout indicators</p>
              </div>

              <div style={{ backgroundColor: 'var(--background)', padding: '1rem', border: '1px solid var(--paper-dark)' }}>
                <div className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>Drawing Units</div>
                <div className="mono" style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--foreground)', marginTop: '0.5rem', textTransform: 'capitalize' }}>
                  {fileStats.unitName}
                </div>
                <p className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-disabled)', marginTop: '0.5rem' }}>
                  Scale Factor: {fileStats.unitScale.toFixed(4)}
                </p>
              </div>
            </div>

            {/* DETAILED SAMPLE LOG */}
            <div style={{ borderTop: '1px solid var(--paper-dark)', paddingTop: '1rem' }}>
              <div className="mono" style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.5rem' }}>
                First 3 Entities Sample Coordinates
              </div>
              <pre className="mono" style={{
                fontSize: '0.7rem',
                backgroundColor: 'var(--background)',
                padding: '1rem',
                border: '1px solid var(--paper-dark)',
                overflowX: 'auto',
                lineHeight: 1.4
              }}>
                {JSON.stringify({
                  firstPolylines: fileStats.polylines.slice(0, 3).map(p => ({
                    layer: p.layer,
                    vertexCount: p.vertices.length,
                    sampleVertices: p.vertices.slice(0, 2)
                  })),
                  firstHatches: fileStats.hatches.slice(0, 3).map(h => ({
                    layer: h.layer,
                    pointsCount: h.boundaryPoints.length,
                    samplePoints: h.boundaryPoints.slice(0, 2)
                  })),
                  firstLines: fileStats.lineEntities.slice(0, 3)
                }, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
