'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { parseDXF, ParsedDXF, LineEntity } from '@/lib/dxf/parser';
import { processWalls, ClassifiedWall } from '@/lib/dxf/analyzer';
import SvgCanvas, { LocusPoint } from '@/components/SvgCanvas';

// Default prompts matching the prototype learnings
const DEFAULT_SYSTEM_PROMPT = `You analyze structural floor plans and emit locus points by calling the render_locus_points tool. The tool call IS your output. Do NOT emit text, prose, lists, markdown, or analysis — only the tool call.

PRIMARY TASK
Find all openings in the BEARING walls. For each opening, emit two points:
- BLUE at the midpoint of one wall's end face
- RED at the midpoint of the other wall's end face
- Labels: "open-N-start" and "open-N-end" (sequential N)

If ADDITIONAL INSTRUCTIONS are provided below, follow those instead.

INPUT FORMAT
Each wall has:
- id: integer
- bearing: boolean
- segments: array of objects, each describing one rectangular portion of the wall
  - longAxis: "X" or "Y"
  - centerline: number (the wall's centerline on the SHORT axis)
  - endpointMin, endpointMax: the wall's extents along the long axis

Simple rectangular walls have 1 segment. L-shapes have 2 segments (one per arm). Complex stepped walls have several. EVERY structural arm of every wall is already decomposed for you — you do not need to look at vertices or infer anything.

LOCATION RULES
1. FILTER OUT TINY WALL STUBS: Before grouping, ignore any segment that is a square or smaller. Assume a standard wall thickness of 6" to 8"; therefore, ignore any segment whose length (endpointMax - endpointMin) is less than or equal to 6" (or 8" max). Any segment longer than 8" (such as 10", 11", or 12") is longer than its thickness, so it is NOT a square and must NOT be ignored (an 11" wall should always count as support). Treat the space occupied by ignored stubs as open space.
2. Group ALL remaining segments from ALL bearing walls by (longAxis, centerline ±3"). Within each group, sort by endpointMin. For each consecutive pair of segments in a group, the gap = next.endpointMin minus prev.endpointMax. If gap ≥ 24", it is an opening.

LOCUS POINTS
For each opening, emit:
- BLUE point at prev segment's end face: (centerline, endpointMax) for Y-axis, (endpointMax, centerline) for X-axis
- RED point at next segment's start face: (centerline, endpointMin) for Y-axis, (endpointMin, centerline) for X-axis

CALL THE TOOL. NO TEXT OUTPUT.`;

const MODEL_DETAILS: Record<string, { title: string; badge: string; desc: string; latency: string }> = {
  'gemini-3.5-flash': {
    title: 'Frontier Flash (v3.5)',
    badge: 'Recommended Default',
    desc: 'Advanced reasoning and excellent formatting stability. Recommended for the most complex spatial layouts.',
    latency: 'Medium (~1.6s)'
  },
  'gemini-2.5-flash': {
    title: 'Balanced Standard (v2.5)',
    badge: 'Very Stable',
    desc: 'Extremely mature, highly cost-efficient, and over 2x faster than v3.5-flash in tests. Perfect for general layout tasks.',
    latency: 'Fast (~750ms)'
  },
  'gemini-3.1-flash-lite': {
    title: 'Lightweight Explorer (v3.1)',
    badge: 'Cost-Efficient',
    desc: 'Superb speed and high efficiency. Ideal when using the "Precomputed Segments" boundary where heavy math is handled by code.',
    latency: 'Very Fast (~690ms)'
  },
  'gemini-2.5-flash-lite': {
    title: 'Ultra-Fast Lite (v2.5)',
    badge: 'Maximum Speed',
    desc: 'Lowest latency option. Extremely fast for interactive editing, prototyping, or light rule adjustments.',
    latency: 'Blazing Fast (~430ms)'
  },
  'gemini-3.1-pro-preview': {
    title: 'Heavy Reasoner (v3.1 Pro)',
    badge: 'Paid Tier Only',
    desc: 'Highest logical capacity. Note: Requires Google AI Studio Pay-As-You-Go billing enabled; fails on Free Tier.',
    latency: 'Slow / Heavy'
  }
};

export default function Home() {
  const [fileStats, setFileStats] = useState<ParsedDXF | null>(null);
  const [walls, setWalls] = useState<ClassifiedWall[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<boolean>(false);

  // Layout states
  const [activeTab, setActiveTab] = useState<'prompts' | 'payload' | 'inspector'>('prompts');
  const [showCenterlines, setShowCenterlines] = useState<boolean>(true);

  const provider = 'google';
  const [model, setModel] = useState<string>('gemini-3.5-flash');
  const [payloadMode, setPayloadMode] = useState<'raw' | 'precomputed'>('precomputed');

  const modelInfo = MODEL_DETAILS[model] || {
    title: model,
    badge: 'Custom',
    desc: 'Custom model endpoint.',
    latency: 'N/A'
  };

  // Prompts states
  const [systemPrompt, setSystemPrompt] = useState<string>(DEFAULT_SYSTEM_PROMPT);
  const [resetArmed, setResetArmed] = useState<{ system: boolean; factory: boolean }>({ system: false, factory: false });
  const [saveDefaultSuccess, setSaveDefaultSuccess] = useState<boolean>(false);

  // Execution states
  const [runLoading, setRunLoading] = useState<boolean>(false);
  const [points, setPoints] = useState<LocusPoint[]>([]);
  const [rawResponse, setRawResponse] = useState<string>('');
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const [metrics, setMetrics] = useState<{ inputTokens: number; outputTokens: number; latency: number } | null>(null);

  // Dual hover synchronization state
  const [hoveredWallId, setHoveredWallId] = useState<number | null>(null);

  // Auto load saved settings on mount
  useEffect(() => {
    try {
      const savedModel = localStorage.getItem('model');
      const savedPayloadMode = localStorage.getItem('payloadMode');
      const savedSystem = localStorage.getItem('systemPrompt');
      const savedShowCenterlines = localStorage.getItem('showCenterlines');

      const VALID_MODELS = [
        'gemini-3.5-flash',
        'gemini-2.5-flash',
        'gemini-3.1-flash-lite',
        'gemini-2.5-flash-lite',
        'gemini-3.1-pro-preview'
      ];
      if (savedModel && VALID_MODELS.includes(savedModel)) {
        setModel(savedModel);
      } else {
        setModel('gemini-3.5-flash');
        localStorage.setItem('model', 'gemini-3.5-flash');
      }
      if (savedPayloadMode) setPayloadMode(savedPayloadMode as any);
      if (savedSystem) setSystemPrompt(savedSystem);
      if (savedShowCenterlines !== null) setShowCenterlines(savedShowCenterlines === 'true');
    } catch (e) {
      console.warn('Failed to load storage values on mount:', e);
    }
  }, []);

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    localStorage.setItem('model', newModel);
  };

  const handlePayloadModeChange = (newMode: 'raw' | 'precomputed') => {
    setPayloadMode(newMode);
    localStorage.setItem('payloadMode', newMode);
  };

  const handleSaveAsDefault = () => {
    try {
      localStorage.setItem('customDefaultSystemPrompt', systemPrompt);
      setSaveDefaultSuccess(true);
      setTimeout(() => setSaveDefaultSuccess(false), 2000);
    } catch (e) {
      console.error('Failed to save custom default prompt:', e);
    }
  };

  const handleResetDefault = () => {
    try {
      const customDefault = localStorage.getItem('customDefaultSystemPrompt');
      if (customDefault) {
        setSystemPrompt(customDefault);
      } else {
        setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
      }
    } catch (e) {
      console.error('Failed to reset system prompt to custom default:', e);
      setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
    }
  };

  // Debounced prompt persistence
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem('systemPrompt', systemPrompt);
    }, 400);
    return () => clearTimeout(t);
  }, [systemPrompt]);


  useEffect(() => {
    localStorage.setItem('showCenterlines', String(showCenterlines));
  }, [showCenterlines]);

  const handleDXFText = useCallback((text: string, name: string) => {
    setLoading(true);
    setError(null);
    setPoints([]);
    setRawResponse('');
    setMetrics(null);
    try {
      const parsed = parseDXF(text);
      const classifiedWalls = processWalls(parsed);

      setFileStats(parsed);
      setWalls(classifiedWalls);
      setFileName(name);
    } catch (e: any) {
      setError(e.message || 'Failed to parse DXF file.');
      setFileStats(null);
      setWalls([]);
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

  const runAIEngine = async () => {
    if (walls.length === 0) return;
    setRunLoading(true);
    setError(null);
    setPoints([]);
    setRawResponse('');
    setMetrics(null);

    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model,
          system: systemPrompt,
          userPrompt: '',
          walls,
          payloadMode,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP error ${response.status}`);
      }

      if (data.usage && data.latency != null) {
        setMetrics({
          inputTokens: data.usage.input,
          outputTokens: data.usage.output,
          latency: data.latency,
        });
      }

      setRawResponse(data.rawResponse || '');
      
      if (data.points && data.points.length > 0) {
        setPoints(data.points);
      } else {
        setError('No locus points could be recovered from the model output. Review raw response details below.');
        setShowRaw(true);
      }
    } catch (e: any) {
      console.error(e);
      setError(e.message || String(e));
    } finally {
      setRunLoading(false);
    }
  };

  // Precomputed statistics
  const stats = useMemo(() => {
    const bearing = walls.filter(w => w.bearing).length;
    return {
      total: walls.length,
      bearing,
      nonBearing: walls.length - bearing,
    };
  }, [walls]);

  // Preview of actual payload passed to backend
  const payloadPreview = useMemo(() => {
    if (walls.length === 0) return '[]';
    const sample = walls.slice(0, 2).map(w => {
      if (payloadMode === 'raw') {
        return {
          id: w.id,
          layer: w.layer,
          bearing: w.bearing,
          vertices: w.vertices.slice(0, 3), // truncate vertices for preview
        };
      } else {
        return {
          id: w.id,
          bearing: w.bearing,
          segments: w.segments,
        };
      }
    });
    return JSON.stringify(sample, null, 2);
  }, [walls, payloadMode]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: 'var(--background)',
      color: 'var(--foreground)'
    }}>
      {/* HEADER */}
      <header style={{
        borderBottom: '1px solid var(--ink-disabled)',
        backgroundColor: 'var(--paper-dark)',
        padding: '1rem 2rem',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.18em', color: 'var(--accent-light)', fontWeight: 800 }}>
              NEWT'S TOOLKIT | STRUCTURAL SUITE
            </div>
            <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', marginTop: '0.15rem' }}>
              Bearing Line Framer Sandbox
            </h1>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <label style={{
              backgroundColor: 'var(--foreground)',
              color: 'var(--background)',
              border: '1px solid var(--foreground)',
              padding: '0.45rem 1rem',
              fontSize: '0.7rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontWeight: 600,
              transition: 'background-color 0.15s'
            }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = 'var(--foreground)'}
            >
              {loading ? 'Reading...' : fileName ? 'Replace DXF' : 'Load DXF'}
              <input
                type="file"
                accept=".dxf"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
            </label>
          </div>
        </div>
      </header>

      {/* NO PLAN LOADED - DROPZONE INTERFACE */}
      {walls.length === 0 ? (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2.5rem'
        }}>
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--ink-disabled)'}`,
              backgroundColor: dragging ? 'var(--paper-dark)' : 'var(--paper-light)',
              padding: '6rem 3rem',
              textAlign: 'center',
              cursor: 'pointer',
              maxWidth: '750px',
              width: '100%',
              boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
              transition: 'all 0.15s ease-in-out',
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
              <div className="mono" style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: '1rem', letterSpacing: '0.12em', fontWeight: 600 }}>
                {loading ? 'Initializing Parser Engine...' : 'DXF Core Sandbox'}
              </div>
              <p style={{ fontSize: '1.4rem', marginBottom: '0.65rem', color: 'var(--foreground)', fontWeight: 500 }}>
                Drag and drop your engineering DXF here, or browse
              </p>
              <p className="mono" style={{ fontSize: '0.72rem', color: 'var(--ink-disabled)' }}>
                Accepts older R12 standard polylines & modern lightweight LWPOLYLINE layers
              </p>
            </label>
          </div>

          {error && (
            <div style={{
              marginTop: '1.5rem',
              maxWidth: '750px',
              width: '100%',
              border: '1px solid var(--accent)',
              backgroundColor: 'var(--paper-light)',
              padding: '1rem 1.5rem',
              color: 'var(--accent)'
            }}>
              <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.2rem' }}>Core Parsing Failure</h4>
              <p className="mono" style={{ fontSize: '0.75rem' }}>{error}</p>
            </div>
          )}
        </div>
      ) : (
        /* DUAL WORKSPACE LAYOUT (PLAN ACTIVE) */
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '460px minmax(0, 1fr)',
          overflow: 'hidden',
          backgroundColor: 'var(--background)'
        }}>
          {/* SIDE PANEL: CONTROLS & DIAGNOSTICS */}
          <aside style={{
            borderRight: '1px solid var(--ink-disabled)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: 'var(--paper-light)'
          }}>
            {/* PARAMETERS CONFIG */}
            <div style={{
              padding: '1.25rem 1.5rem',
              borderBottom: '1px solid var(--ink-disabled)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
              backgroundColor: 'var(--paper-dark)',
              flexShrink: 0
            }}>
              {/* MODEL SELECTORS */}
              <div>
                <label className="mono" style={{ fontSize: '0.62rem', textTransform: 'uppercase', color: 'var(--ink-muted)', display: 'block', marginBottom: '0.3rem', fontWeight: 600 }}>Model ID</label>
                <select
                  value={model}
                  onChange={(e) => handleModelChange(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: 'var(--paper-light)',
                    border: '1px solid var(--ink-disabled)',
                    color: 'var(--foreground)',
                    padding: '0.4rem 0.5rem',
                    fontFamily: 'inherit',
                    fontSize: '0.75rem',
                    outline: 'none',
                  }}
                >
                  <option value="gemini-3.5-flash">gemini-3.5-flash (Fast & Frontier)</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash (Balanced Standard)</option>
                  <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (Lightweight Explorer)</option>
                  <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (Ultra-Fast Speed)</option>
                  <option value="gemini-3.1-pro-preview">gemini-3.1-pro (Deep Reasoner / Heavy)</option>
                </select>
                
                {/* Dynamically updated model description box */}
                <div style={{
                  marginTop: '0.5rem',
                  backgroundColor: 'var(--background)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  padding: '0.45rem 0.65rem',
                  fontSize: '0.65rem',
                  lineHeight: '1.35'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
                    <strong style={{ color: 'var(--accent-light)' }}>{modelInfo.title}</strong>
                    <span className="mono" style={{
                      backgroundColor: modelInfo.badge === 'Paid Tier Only' ? 'var(--accent)' : 'rgba(255,255,255,0.12)',
                      color: '#fff',
                      padding: '0.05rem 0.25rem',
                      fontSize: '0.55rem',
                      fontWeight: 600
                    }}>{modelInfo.badge}</span>
                  </div>
                  <p style={{ color: 'var(--ink-muted)', margin: 0 }}>{modelInfo.desc}</p>
                  <div style={{ marginTop: '0.35rem', fontSize: '0.58rem', color: 'var(--ink-disabled)' }} className="mono">
                    Latency Profile: {modelInfo.latency}
                  </div>
                </div>
              </div>

              {/* TOGGLE OPTIONS GROUP */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', marginTop: '0.2rem' }}>
                {/* Precomputed Segments Toggle */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  <label style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontSize: '0.72rem',
                    cursor: 'pointer',
                    userSelect: 'none',
                    fontWeight: 600
                  }}>
                    <input
                      type="checkbox"
                      checked={payloadMode === 'precomputed'}
                      onChange={(e) => handlePayloadModeChange(e.target.checked ? 'precomputed' : 'raw')}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span className="mono" style={{ color: 'var(--foreground)' }}>Use Precomputed Wall Segments</span>
                  </label>
                  <span style={{ fontSize: '0.6rem', color: 'var(--ink-muted)', paddingLeft: '1.15rem', lineHeight: 1.3 }}>
                    Simplifies calculations by sending pre-decomposed rectangular segments. (Uncheck to send raw DXF vertices).
                  </span>
                </div>

                {/* Show Centerlines Toggle */}
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontSize: '0.72rem',
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontWeight: 600,
                  marginTop: '0.2rem'
                }}>
                  <input
                    type="checkbox"
                    checked={showCenterlines}
                    onChange={(e) => setShowCenterlines(e.target.checked)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="mono" style={{ color: 'var(--foreground)' }}>Show Centerlines of Precomputed Segments</span>
                </label>
              </div>

              {/* ACTION ROW */}
              <div style={{ display: 'flex', gap: '0.65rem', borderTop: '1px solid rgba(255, 255, 255, 0.12)', paddingTop: '0.75rem', marginTop: '0.2rem' }}>
                <button
                  onClick={runAIEngine}
                  disabled={runLoading}
                  style={{
                    flex: 1,
                    backgroundColor: runLoading ? 'var(--ink-disabled)' : 'var(--accent)',
                    color: 'var(--paper-light)',
                    border: 'none',
                    padding: '0.65rem',
                    fontSize: '0.72rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    fontWeight: 600,
                    cursor: runLoading ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={e => { if(!runLoading) e.currentTarget.style.backgroundColor = '#3d8c38'; }}
                  onMouseLeave={e => { if(!runLoading) e.currentTarget.style.backgroundColor = 'var(--accent)'; }}
                >
                  {runLoading ? 'Newt is Analyzing the Geometry...' : 'Ask Newt to Draw the Beams'}
                </button>

                {points.length > 0 && (
                  <button
                    onClick={() => {
                      setPoints([]);
                      setRawResponse('');
                      setMetrics(null);
                    }}
                    className="mono"
                    style={{
                      backgroundColor: 'transparent',
                      border: '1px solid var(--foreground)',
                      color: 'var(--foreground)',
                      padding: '0 0.75rem',
                      fontSize: '0.7rem',
                      cursor: 'pointer'
                    }}
                  >
                    Clear Points
                  </button>
                )}
              </div>
            </div>

            {/* TAB CONTAINER */}
            <div style={{
              display: 'flex',
              borderBottom: '1px solid var(--foreground)',
              backgroundColor: 'var(--paper-dark)',
              flexShrink: 0
            }}>
              <button
                onClick={() => setActiveTab('prompts')}
                className="mono"
                style={{
                  flex: 1,
                  padding: '0.65rem 0.5rem',
                  fontSize: '0.68rem',
                  textTransform: 'uppercase',
                  border: 'none',
                  borderRight: '1px solid var(--foreground)',
                  backgroundColor: activeTab === 'prompts' ? 'var(--paper-light)' : 'transparent',
                  color: activeTab === 'prompts' ? 'var(--foreground)' : 'var(--ink-muted)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'prompts' ? 600 : 400
                }}
              >
                Prompts / Skills
              </button>
              <button
                onClick={() => setActiveTab('payload')}
                className="mono"
                style={{
                  flex: 1,
                  padding: '0.65rem 0.5rem',
                  fontSize: '0.68rem',
                  textTransform: 'uppercase',
                  border: 'none',
                  borderRight: '1px solid var(--foreground)',
                  backgroundColor: activeTab === 'payload' ? 'var(--paper-light)' : 'transparent',
                  color: activeTab === 'payload' ? 'var(--foreground)' : 'var(--ink-muted)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'payload' ? 600 : 400
                }}
              >
                Payload Preview
              </button>
              <button
                onClick={() => setActiveTab('inspector')}
                className="mono"
                style={{
                  flex: 1,
                  padding: '0.65rem 0.5rem',
                  fontSize: '0.68rem',
                  textTransform: 'uppercase',
                  border: 'none',
                  backgroundColor: activeTab === 'inspector' ? 'var(--paper-light)' : 'transparent',
                  color: activeTab === 'inspector' ? 'var(--foreground)' : 'var(--ink-muted)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'inspector' ? 600 : 400
                }}
              >
                Wall Inspector ({walls.length})
              </button>
            </div>

            {/* TAB PANELS CONTAINER */}
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              
              {/* TAB: PROMPTS AND SYSTEM SKILLS */}
              {activeTab === 'prompts' && (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%' }}>
                  {/* System Prompt Box */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    <div style={{
                      padding: '0.4rem 1rem',
                      backgroundColor: 'var(--paper-dark)',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexShrink: 0
                    }}>
                      <span className="mono" style={{ fontSize: '0.62rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 600 }}>System Prompt (Skills File)</span>
                      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                        {/* Save Current as Default Button */}
                        <button
                          onClick={handleSaveAsDefault}
                          className="mono"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: saveDefaultSuccess ? '#10b981' : 'var(--accent)',
                            fontSize: '0.6rem',
                            cursor: 'pointer',
                            textDecoration: 'none',
                            fontWeight: saveDefaultSuccess ? 700 : 'normal',
                            transition: 'color 0.2s ease'
                          }}
                        >
                          {saveDefaultSuccess ? '✓ Saved!' : 'Make This Default'}
                        </button>

                        <span style={{ color: 'rgba(255, 255, 255, 0.15)', fontSize: '0.6rem' }}>|</span>

                        {/* Reset to Custom Default Button */}
                        <button
                          onClick={() => {
                            if (resetArmed.system) {
                              handleResetDefault();
                              setResetArmed(s => ({ ...s, system: false }));
                            } else {
                              setResetArmed(s => ({ ...s, system: true, factory: false }));
                              setTimeout(() => setResetArmed(s => ({ ...s, system: false })), 3000);
                            }
                          }}
                          className="mono"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: resetArmed.system ? 'var(--accent)' : 'var(--ink-muted)',
                            fontSize: '0.6rem',
                            cursor: 'pointer',
                            textDecoration: 'underline'
                          }}
                        >
                          {resetArmed.system ? 'Confirm Reset?' : 'Reset to Default'}
                        </button>

                        <span style={{ color: 'rgba(255, 255, 255, 0.15)', fontSize: '0.6rem' }}>|</span>

                        {/* Reset to Factory Default Button */}
                        <button
                          onClick={() => {
                            if (resetArmed.factory) {
                              setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
                              setResetArmed(s => ({ ...s, factory: false }));
                            } else {
                              setResetArmed(s => ({ ...s, factory: true, system: false }));
                              setTimeout(() => setResetArmed(s => ({ ...s, factory: false })), 3000);
                            }
                          }}
                          className="mono"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: resetArmed.factory ? 'var(--accent)' : 'var(--ink-muted)',
                            fontSize: '0.6rem',
                            cursor: 'pointer',
                            textDecoration: 'underline'
                          }}
                        >
                          {resetArmed.factory ? 'Confirm Factory?' : 'Reset Factory'}
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      style={{
                        flex: 1,
                        width: '100%',
                        padding: '1rem',
                        fontSize: '0.7rem',
                        lineHeight: 1.5,
                        backgroundColor: 'transparent',
                        color: 'var(--foreground)',
                        border: 'none',
                        resize: 'none',
                        outline: 'none',
                        overflowY: 'auto'
                      }}
                      spellCheck={false}
                    />
                  </div>
                </div>
              )}

              {/* TAB: PAYLOAD PREVIEW */}
              {activeTab === 'payload' && (
                <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <p style={{ fontSize: '0.75rem', lineHeight: 1.4, color: 'var(--ink-muted)' }}>
                      Below is a preview of the structured payload format compiled by the deterministic code layers. Based on your active <strong>Use Precomputed Wall Segments</strong> option, this raw data structure will be embedded into the model prompt.
                    </p>
                  </div>
                  <div>
                    <div className="mono" style={{ fontSize: '0.62rem', textTransform: 'uppercase', color: 'var(--ink-disabled)', marginBottom: '0.4rem', fontWeight: 600 }}>Compiled Wall Payload Sample (First 2 walls)</div>
                    <pre className="mono" style={{
                      backgroundColor: 'var(--background)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      padding: '1rem',
                      fontSize: '0.68rem',
                      overflowX: 'auto',
                      lineHeight: 1.4,
                      color: 'var(--foreground)',
                      maxHeight: '380px'
                    }}>{payloadPreview}</pre>
                  </div>
                </div>
              )}

              {/* TAB: WALL INSPECTOR LIST (DOUBLE HOVER SYNCED) */}
              {activeTab === 'inspector' && (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255, 255, 255, 0.12)', backgroundColor: 'var(--paper-dark)' }}>
                    <p style={{ fontSize: '0.7rem', lineHeight: 1.4, color: 'var(--ink-muted)' }}>
                      Scroll and inspect parsed walls. Hovering a row highlights its exact boundary on the drawing. Solid filled walls are classified as <strong>Bearing</strong>.
                    </p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {walls.map((w) => {
                      const isHovered = hoveredWallId === w.id;
                      return (
                        <div
                          key={`row-${w.id}`}
                          onMouseEnter={() => setHoveredWallId(w.id)}
                          onMouseLeave={() => setHoveredWallId(null)}
                          style={{
                            padding: '0.75rem 1.25rem',
                            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                            backgroundColor: isHovered ? 'var(--paper-dark)' : 'transparent',
                            transition: 'background-color 0.1s ease',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.3rem'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="mono" style={{ fontSize: '0.75rem', fontWeight: 600, color: isHovered ? 'var(--accent)' : 'var(--foreground)' }}>
                              Wall #{w.id}
                            </span>
                            <span className="mono" style={{
                              fontSize: '0.62rem',
                              textTransform: 'uppercase',
                              padding: '0.15rem 0.4rem',
                              backgroundColor: w.bearing ? 'var(--foreground)' : 'transparent',
                              border: `1px solid ${w.bearing ? 'var(--foreground)' : 'var(--ink-disabled)'}`,
                              color: w.bearing ? 'var(--background)' : 'var(--ink-muted)',
                              fontWeight: 600
                            }}>
                              {w.bearing ? 'Bearing' : 'Non-bearing'}
                            </span>
                          </div>
                          
                          <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-muted)' }}>
                            Layer: {w.layer}
                          </div>

                          {w.bbox && (
                            <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-disabled)' }}>
                              BBox: X [{w.bbox.minX.toFixed(1)}, {w.bbox.maxX.toFixed(1)}] · Y [{w.bbox.minY.toFixed(1)}, {w.bbox.maxY.toFixed(1)}]
                            </div>
                          )}

                          {w.segments.length > 0 && (
                            <div style={{ marginTop: '0.2rem', padding: '0.3rem 0.5rem', backgroundColor: 'rgba(255, 255, 255, 0.03)', border: '1px dashed rgba(150, 208, 164, 0.2)' }}>
                              <div className="mono" style={{ fontSize: '0.6rem', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 600, marginBottom: '0.15rem' }}>
                                Precomputed Segments ({w.segments.length})
                              </div>
                              {w.segments.map((seg, idx) => (
                                <div key={idx} className="mono" style={{ fontSize: '0.62rem', color: 'var(--ink-muted)' }}>
                                  [{seg.longAxis}] centerline: {seg.centerline.toFixed(1)} · range: [{seg.endpointMin.toFixed(1)}, {seg.endpointMax.toFixed(1)}]
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ERROR DISPLAY AREA */}
            {error && (
              <div style={{
                padding: '0.75rem 1.25rem',
                borderTop: '1px solid var(--accent)',
                backgroundColor: 'var(--paper-light)',
                color: 'var(--accent)',
                flexShrink: 0
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                  <span className="mono text-xs" style={{ fontWeight: 600, textTransform: 'uppercase' }}>System Alert</span>
                </div>
                <p className="mono" style={{ fontSize: '0.68rem', lineHeight: 1.4 }}>{error}</p>
              </div>
            )}

            {/* AI METRICS BOTTOM FOOTER */}
            {metrics && (
              <div style={{
                padding: '0.75rem 1.25rem',
                borderTop: '1px solid var(--foreground)',
                backgroundColor: 'var(--paper-dark)',
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 1fr',
                gap: '0.5rem',
                flexShrink: 0
              }}>
                <div>
                  <div className="mono" style={{ fontSize: '0.58rem', textTransform: 'uppercase', color: 'var(--ink-disabled)' }}>Latency</div>
                  <div className="mono" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--foreground)' }}>{(metrics.latency / 1000).toFixed(2)}s</div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: '0.58rem', textTransform: 'uppercase', color: 'var(--ink-disabled)' }}>Prompt Tokens</div>
                  <div className="mono" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--foreground)' }}>{metrics.inputTokens.toLocaleString()}</div>
                </div>
                <div>
                  <div className="mono" style={{ fontSize: '0.58rem', textTransform: 'uppercase', color: 'var(--ink-disabled)' }}>Output Tokens</div>
                  <div className="mono" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent)' }}>{metrics.outputTokens.toLocaleString()}</div>
                </div>
              </div>
            )}
          </aside>

          {/* ACTIVE CANVAS DISPLAY PANEL */}
          <main style={{
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative'
          }}>
            {/* SUB-HEADER STATS OVERVIEW */}
            <div style={{
              borderBottom: '1px solid var(--foreground)',
              padding: '0.5rem 1.5rem',
              display: 'flex',
              gap: '1.5rem',
              alignItems: 'center',
              backgroundColor: 'var(--paper-dark)',
              fontSize: '0.7rem',
              flexShrink: 0
            }}>
              <span className="mono">Drawing: <strong style={{ color: 'var(--accent)' }}>{fileName}</strong></span>
              <span className="mono">Total Walls: <strong>{stats.total}</strong></span>
              <span className="mono">Bearing Solid Hatch: <strong>{stats.bearing}</strong></span>
              <span className="mono">Non-Bearing Outlines: <strong>{stats.nonBearing}</strong></span>
              {points.length > 0 && <span className="mono" style={{ color: 'var(--accent)' }}>Returned Points: <strong>{points.length}</strong></span>}
            </div>

            {/* RAW RESPONSE MODAL/PANEL ACCORDION */}
            {rawResponse && (
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 10,
                borderBottom: '1px solid var(--foreground)',
                backgroundColor: 'var(--paper-light)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: showRaw ? '60%' : '35px',
                transition: 'max-height 0.25s ease-in-out',
                overflow: 'hidden'
              }}>
                <div
                  onClick={() => setShowRaw(!showRaw)}
                  style={{
                    padding: '0.4rem 1.5rem',
                    backgroundColor: 'var(--paper-dark)',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    userSelect: 'none',
                    flexShrink: 0
                  }}
                >
                  <span className="mono" style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 600 }}>Raw Engine Response Payload</span>
                  <span className="mono" style={{ fontSize: '0.62rem', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 600 }}>
                    {showRaw ? '[Collapse Viewer ▲]' : '[Click to Expand Raw Log ▼]'}
                  </span>
                </div>
                <div style={{ flex: 1, padding: '1rem', overflowY: 'auto', borderTop: '1px solid rgba(255, 255, 255, 0.12)' }}>
                  <pre className="mono" style={{
                    fontSize: '0.65rem',
                    lineHeight: 1.45,
                    whiteSpace: 'pre-wrap',
                    color: 'var(--foreground)'
                  }}>{rawResponse}</pre>
                </div>
              </div>
            )}

            {/* THE VISUAL CANVAS SPACE */}
            <div style={{
              flex: 1,
              backgroundColor: 'var(--background)'
            }}>
              <SvgCanvas
                walls={walls}
                lineEntities={fileStats?.lineEntities || []}
                points={points}
                hoveredWallId={hoveredWallId}
                onHoverWall={setHoveredWallId}
                showCenterlines={showCenterlines}
              />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
