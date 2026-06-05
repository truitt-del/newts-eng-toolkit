'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { parseDXF, ParsedDXF } from '@/lib/dxf/parser';
import {
  ImporterSession,
  saveSession,
  getActiveSession,
  clearSession,
  ClosedWallPolygon,
  ExplicitOpening,
  Fixture,
  RoomInstance,
  StairInstance,
  ExceptionItem,
  MappingDictionary
} from '@/lib/cad/sessionStore';
import ImporterCanvas from '@/components/importer/ImporterCanvas';
import { calculateAffineTransform } from '@/lib/cad/calibration';
import { buildDefaultMappings, assembleWalls } from '@/lib/cad/assembler';
import { detectStairs } from '@/lib/cad/stairDetector';
import { parseRoomLabel } from '@/lib/cad/mtextParser';
import { bboxOf, findWallSegments, ClassifiedWall } from '@/lib/dxf/analyzer';

// Helper to dynamically load PDF.js from cdnjs client-side
function loadPdfJs(): Promise<any> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('Window is not defined'));
      return;
    }
    if ((window as any).pdfjsLib) {
      resolve((window as any).pdfjsLib);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => {
      const pdfjsLib = (window as any).pdfjsLib;
      // Use CDN worker
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(pdfjsLib);
    };
    script.onerror = (err) => reject(new Error('Failed to load PDF.js library from CDN. Please check your internet connection.'));
    document.head.appendChild(script);
  });
}

// Client-side helper to read PDF file, load with PDF.js, and rasterize a specific page to base64
async function rasterizePdfPage(file: File, pageNum: number): Promise<{ imageUri: string; width: number; height: number; totalPages: number }> {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;
  const page = await pdfDoc.getPage(pageNum);
  
  // Render at 1.5x scale for clean, high-resolution background underlay
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context for PDF rasterizer.');
  }
  
  await page.render({ canvasContext: ctx, viewport }).promise;
  const imageUri = canvas.toDataURL('image/jpeg', 0.85);
  
  return {
    imageUri,
    width: canvas.width,
    height: canvas.height,
    totalPages: pdfDoc.numPages
  };
}

// Bounds checker returning physical dimensions in inches
function computeBounds(parsed: ParsedDXF) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  
  const checkPoint = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  parsed.lineEntities.forEach(l => {
    checkPoint(l.x1, l.y1);
    checkPoint(l.x2, l.y2);
  });

  parsed.polylines.forEach(p => {
    p.vertices.forEach(v => {
      checkPoint(v.x, v.y);
    });
  });

  if (minX === Infinity) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  }

  return {
    minX, maxX, minY, maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

export default function ImporterPage() {
  const [session, setSession] = useState<ImporterSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ title: string; desc: string; details?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pdfFileName, setPdfFileName] = useState<string | null>(null);

  // PDF & Calibration States
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfPageNum, setPdfPageNum] = useState(1);
  const [pdfOpacity, setPdfOpacity] = useState(0.5);

  const router = useRouter();
  const [focusedCoordinates, setFocusedCoordinates] = useState<{ x: number; y: number } | null>(null);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [signoffs, setSignoffs] = useState<Record<string, boolean>>({});

  const runCompilation = async (currentSession: ImporterSession, overrideMappings?: MappingDictionary) => {
    if (!currentSession.dxfData) return;

    let mappings = overrideMappings || currentSession.mappings;
    if (!mappings || Object.keys(mappings).length === 0) {
      mappings = buildDefaultMappings(currentSession.dxfData);
    }

    const tolerancesInput = {
      snap: currentSession.tolerances.snap,
      prune: currentSession.tolerances.prune,
      wMin: currentSession.tolerances.wMin,
      wMax: currentSession.tolerances.wMax,
      maxWallVertices: currentSession.tolerances.maxWallVertices,
      maxWallAreaSqFt: currentSession.tolerances.maxWallAreaSqFt
    };

    const { walls, openings, exceptions: baseExceptions } = assembleWalls(
      currentSession.dxfData,
      tolerancesInput,
      mappings
    );

    const stairs = detectStairs(
      currentSession.dxfData,
      mappings,
      currentSession.tolerances.snap
    );

    const exceptions = [...baseExceptions];
    stairs.forEach(stair => {
      if (stair.confidence === 'low') {
        exceptions.push({
          id: `exception_low_stair_${stair.id}`,
          type: 'unresolved-mapping',
          title: `Low Confidence Stair`,
          description: `Staircase at (${stair.x.toFixed(1)}, ${stair.y.toFixed(1)}) has low tread grouping confidence on layer "${stair.layer}". Please verify manually.`,
          location: { x: stair.x, y: stair.y },
          refId: stair.id,
          resolved: false
        });
      }
    });

    const rooms: RoomInstance[] = [];
    let roomIdSeq = 1;
    currentSession.dxfData.textEntities.forEach(t => {
      const key = `layer:${t.layer}`;
      const m = mappings[key];
      if (m && m.canonicalCategory === 'RMNAME') {
        const parsed = parseRoomLabel(t.text);
        rooms.push({
          id: roomIdSeq++,
          name: parsed.roomName,
          x: t.x,
          y: t.y,
          ceilingHeight: parsed.ceilingHeight || undefined,
          dimensions: parsed.dimensions || undefined
        });
      }
    });

    const fixtures: Fixture[] = [];
    let fixIdSeq = 1;
    currentSession.dxfData.inserts.forEach(ins => {
      const lKey = `layer:${ins.layer}`;
      const bKey = `block:${ins.blockName}`;
      const m = mappings[bKey] || mappings[lKey];
      if (m && m.canonicalCategory === 'FIX') {
        const n = (ins.blockName || ins.layer).toLowerCase();
        let type: Fixture['type'] = 'other';
        if (n.includes('toilet') || n.includes('wc') || n.includes('water_closet')) {
          type = 'toilet';
        } else if (n.includes('sink') || n.includes('lav') || n.includes('basin')) {
          type = 'sink';
        } else if (n.includes('tub') || n.includes('bath') || n.includes('shower')) {
          type = 'tub';
        }
        fixtures.push({
          id: fixIdSeq++,
          type,
          layer: ins.layer,
          x: ins.x,
          y: ins.y,
          blockName: ins.blockName
        });
      }
    });

    const missingToiletFixes = fixtures.filter(f => f.type === 'sink' || f.type === 'tub');
    const toiletFixes = fixtures.filter(f => f.type === 'toilet');
    const toiletlessClusters: typeof missingToiletFixes = [];
    missingToiletFixes.forEach(f => {
      const hasToiletNearby = toiletFixes.some(t => {
        const dist = Math.sqrt((f.x - t.x) ** 2 + (f.y - t.y) ** 2);
        return dist <= 180;
      });
      if (!hasToiletNearby) {
        const isNearExisting = toiletlessClusters.some(tc => {
          const dist = Math.sqrt((f.x - tc.x) ** 2 + (f.y - tc.y) ** 2);
          return dist <= 120;
        });
        if (!isNearExisting) {
          toiletlessClusters.push(f);
        }
      }
    });

    toiletlessClusters.forEach(f => {
      exceptions.push({
        id: `exception_missing_toilet_${f.id}`,
        type: 'missing-toilet',
        title: `Missing Toilet: Bathroom Audit Failure`,
        description: `A sink or tub fixture on layer "${f.layer}" (block "${f.blockName}") was detected at (${f.x.toFixed(1)}, ${f.y.toFixed(1)}) but no toilet was found within a 15-foot radius. Please verify bathroom layout.`,
        location: { x: f.x, y: f.y },
        refId: f.id,
        resolved: false
      });
    });

    const updatedSession: ImporterSession = {
      ...currentSession,
      mappings,
      elements: {
        walls,
        openings,
        fixtures,
        rooms,
        stairs
      },
      exceptions,
      lastUpdated: Date.now()
    };

    await saveSession(updatedSession);
    setSession(updatedSession);
  };

  const handleAiClassification = async () => {
    if (!session || !session.dxfData) return;
    setIsAiLoading(true);
    try {
      const layers = Array.from(new Set([
        ...session.dxfData.lineEntities.map(l => l.layer),
        ...session.dxfData.polylines.map(p => p.layer),
        ...session.dxfData.hatches.map(h => h.layer),
        ...session.dxfData.inserts.map(i => i.layer),
        ...session.dxfData.textEntities.map(t => t.layer)
      ])).filter(Boolean);

      const blocks = Array.from(new Set(
        session.dxfData.inserts.map(i => i.blockName)
      )).filter(Boolean);

      const response = await fetch('/api/importer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layers, blocks })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.mappings && Array.isArray(data.mappings)) {
        const nextMappings = { ...session.mappings };
        data.mappings.forEach((m: any) => {
          const key = m.sourceType === 'layer' ? `layer:${m.sourceName}` : `block:${m.sourceName}`;
          nextMappings[key] = {
            sourceType: m.sourceType,
            sourceName: m.sourceName,
            canonicalCategory: m.canonicalCategory,
            provenance: 'ai-suggested',
            scope: 'global',
            timestamp: Date.now()
          };
        });
        
        await runCompilation(session, nextMappings);
      }
    } catch (err: any) {
      console.error(err);
      alert('AI Classification failed: ' + err.message);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleMappingChange = async (sourceType: 'layer' | 'block', sourceName: string, newCategory: any) => {
    if (!session) return;
    const key = sourceType === 'layer' ? `layer:${sourceName}` : `block:${sourceName}`;
    const nextMappings = {
      ...session.mappings,
      [key]: {
        sourceType,
        sourceName,
        canonicalCategory: newCategory,
        provenance: 'human-confirmed' as const,
        scope: 'global' as const,
        timestamp: Date.now()
      }
    };
    await runCompilation(session, nextMappings);
  };

  const handleResolveException = async (excId: string) => {
    if (!session) return;
    const updatedExceptions = session.exceptions.map(e => {
      if (e.id === excId) {
        return { ...e, resolved: true };
      }
      return e;
    });
    const updated = { ...session, exceptions: updatedExceptions };
    await saveSession(updated);
    setSession(updated);
  };

  // Restore active session on mount
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState(0); // 0 (none), 1 (DXF 1), 2 (PDF 1), 3 (DXF 2), 4 (PDF 2)
  const [calibDxfPt1, setCalibDxfPt1] = useState<{ x: number; y: number } | null>(null);
  const [calibDxfPt2, setCalibDxfPt2] = useState<{ x: number; y: number } | null>(null);
  const [calibPdfPt1, setCalibPdfPt1] = useState<{ x: number; y: number } | null>(null);
  const [calibPdfPt2, setCalibPdfPt2] = useState<{ x: number; y: number } | null>(null);

  // Tolerances card state
  const [isTolerancesOpen, setIsTolerancesOpen] = useState(true);
  const [tolerances, setTolerances] = useState({
    snap: 1.5,
    prune: 2.0,
    wMin: 3.0,
    wMax: 12.0,
    maxBBoxFt: 400,
    maxWallVertices: 40,
    maxWallAreaSqFt: 50
  });

  // Restore active session on mount
  useEffect(() => {
    async function loadActiveSession() {
      const active = await getActiveSession();
      if (active) {
        setSession(active);
        setTolerances(active.tolerances);
        if (active.pdfData?.pdfFileName) {
          setPdfFileName(active.pdfData.pdfFileName);
        }
        if (active.signOffs) {
          setSignoffs(active.signOffs);
        }
      }
    }
    loadActiveSession();
  }, []);

  const handleDXFUpload = async (file: File) => {
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseDXF(text);

      // Scale-Aware Intake Gate Validation
      const bounds = computeBounds(parsed);
      const widthFt = bounds.width / 12;
      const heightFt = bounds.height / 12;
      
      const maxLimitFt = tolerances.maxBBoxFt;

      if (widthFt > maxLimitFt || heightFt > maxLimitFt) {
        // Trigger detailed educational scale gate rejection
        setError({
          title: 'Intake Rejection: Extreme Footprint or Stacked Plan Detected',
          desc: `The drawing's bounding box measures ${widthFt.toFixed(1)} ft × ${heightFt.toFixed(1)} ft, which exceeds Newt's standard engineering limit of ${maxLimitFt} ft.`,
          details: `This is usually caused by:
1. Stacked floorplans, detail blocks, or dynamic layouts saved side-by-side in AutoCAD/Vectorworks modelspace.
2. Wrong drawing scale units.
          
HOW TO RESOLVE THIS:
• Isolate your main floorplan to a single clean layer.
• Delete or move floating detail blocks and notes out of the active model space.
• Purge empty layers (command: PURGE) and export only the active layout scheme.
• Re-upload the isolated, cleaned CAD DXF file.`
        });
        setLoading(false);
        return;
      }

      // Valid drawing - Create new session
      const newSession: ImporterSession = {
        id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        fileName: file.name,
        lastUpdated: Date.now(),
        currentStep: 1,
        dxfData: parsed,
        pdfData: {
          imageUri: null,
          transformMatrix: null,
        },
        mappings: {},
        elements: {
          walls: [],
          openings: [],
          fixtures: [],
          rooms: [],
          stairs: [],
        },
        exceptions: [],
        signOffs: {},
        tolerances: { ...tolerances }
      };

      await saveSession(newSession);
      setSession(newSession);
    } catch (e: any) {
      console.error(e);
      setError({
        title: 'Parsing Error',
        desc: 'Failed to process DXF file. Ensure it is a valid ASCII format DXF.',
        details: e.message || String(e)
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !session) return;
    
    setLoading(true);
    setPdfFileName(file.name);
    setPdfFile(file);
    setPdfPageNum(1);
    
    try {
      const res = await rasterizePdfPage(file, 1);
      
      const updated = {
        ...session,
        pdfData: {
          imageUri: res.imageUri,
          transformMatrix: session.pdfData?.transformMatrix || null,
          width: res.width,
          height: res.height,
          totalPages: res.totalPages,
          pdfFileName: file.name
        }
      };
      
      await saveSession(updated);
      setSession(updated);
    } catch (err: any) {
      console.error(err);
      setError({
        title: 'PDF Rasterizer Error',
        desc: 'Failed to rasterize PDF page client-side.',
        details: err.message || String(err)
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = async (newPageNum: number) => {
    if (!pdfFile || !session || newPageNum < 1 || newPageNum > (session.pdfData?.totalPages || 1)) return;
    setLoading(true);
    try {
      const res = await rasterizePdfPage(pdfFile, newPageNum);
      const updated = {
        ...session,
        pdfData: {
          ...session.pdfData,
          imageUri: res.imageUri,
          width: res.width,
          height: res.height,
          totalPages: res.totalPages
        }
      };
      await saveSession(updated);
      setSession(updated);
      setPdfPageNum(newPageNum);
    } catch (err: any) {
      console.error(err);
      alert('Failed to change page: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveUnderlay = async () => {
    if (!session) return;
    
    const updated = {
      ...session,
      pdfData: {
        imageUri: null,
        transformMatrix: null,
        width: undefined,
        height: undefined,
        totalPages: undefined,
        pdfFileName: undefined
      }
    };
    
    await saveSession(updated);
    setSession(updated);
    setPdfFile(null);
    setPdfFileName(null);
    setPdfPageNum(1);
    setIsCalibrating(false);
    setCalibrationStep(0);
  };

  const handleDxfClick = (x: number, y: number) => {
    if (calibrationStep === 1) {
      setCalibDxfPt1({ x, y });
      setCalibrationStep(2);
    } else if (calibrationStep === 3) {
      setCalibDxfPt2({ x, y });
      setCalibrationStep(4);
    }
  };

  const handlePdfClick = async (x: number, y: number) => {
    if (!session) return;

    if (calibrationStep === 2) {
      setCalibPdfPt1({ x, y });
      setCalibrationStep(3);
    } else if (calibrationStep === 4) {
      setCalibPdfPt2({ x, y });
      if (calibDxfPt1 && calibPdfPt1 && calibDxfPt2) {
        try {
          const transform = calculateAffineTransform(
            calibDxfPt1,
            calibPdfPt1,
            calibDxfPt2,
            { x, y }
          );
          
          const updated: ImporterSession = {
            ...session,
            pdfData: {
              ...session.pdfData,
              transformMatrix: transform
            }
          };
          await saveSession(updated);
          setSession(updated);
          
          // Complete calibration
          setIsCalibrating(false);
          setCalibrationStep(0);
          setCalibDxfPt1(null);
          setCalibDxfPt2(null);
          setCalibPdfPt1(null);
          setCalibPdfPt2(null);
        } catch (err: any) {
          alert(err.message || String(err));
          setCalibrationStep(3);
        }
      }
    }
  };

  const handleClearSession = async () => {
    if (session) {
      await clearSession(session.id);
    }
    setSession(null);
    setPdfFileName(null);
    setPdfFile(null);
    setPdfPageNum(1);
    setIsCalibrating(false);
    setCalibrationStep(0);
    setError(null);
  };

  const handleToleranceChange = async (key: keyof typeof tolerances, val: number) => {
    const next = { ...tolerances, [key]: val };
    setTolerances(next);
    if (session) {
      const updated = { ...session, tolerances: next };
      await saveSession(updated);
      setSession(updated);
    }
  };

  // Drag and drop dropzone handlers
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = () => {
    setDragging(false);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.dxf')) {
      await handleDXFUpload(file);
    } else {
      setError({
        title: 'Invalid File Type',
        desc: 'Please upload an AutoCAD/Vectorworks .dxf vector drawing file.'
      });
    }
  };
  const handleSignoffToggle = async (key: string) => {
    if (!session) return;
    const nextSignoffs = {
      ...signoffs,
      [key]: !signoffs[key]
    };
    setSignoffs(nextSignoffs);
    const updated = {
      ...session,
      signOffs: nextSignoffs
    };
    await saveSession(updated);
    setSession(updated);
  };

  const layers = Array.from(new Set([
    ...(session?.dxfData?.lineEntities.map(l => l.layer) || []),
    ...(session?.dxfData?.polylines.map(p => p.layer) || []),
    ...(session?.dxfData?.hatches.map(h => h.layer) || []),
    ...(session?.dxfData?.inserts.map(i => i.layer) || []),
    ...(session?.dxfData?.textEntities.map(t => t.layer) || [])
  ])).filter(Boolean).sort();

  const blocks = Array.from(new Set(
    session?.dxfData?.inserts.map(i => i.blockName) || []
  )).filter(Boolean).sort();

  const hasRoofMapped = session ? Object.values(session.mappings).some(m => m.canonicalCategory === 'ROOF') : false;
  const hasGridMapped = session ? Object.values(session.mappings).some(m => m.canonicalCategory === 'GRID') : false;
  const isRoofSignoffOk = hasRoofMapped || !!signoffs['roof'];
  const isGridSignoffOk = hasGridMapped || !!signoffs['grid'];
  const canHandoff = isRoofSignoffOk && isGridSignoffOk;

  const handleHandoff = async () => {
    if (!session || !session.elements) return;
    const handoffWalls: ClassifiedWall[] = session.elements.walls.map(w => ({
      id: w.id,
      layer: w.layer,
      bearing: w.bearing,
      vertices: w.vertices,
      bbox: bboxOf(w.vertices),
      segments: findWallSegments(w.vertices)
    }));
    localStorage.setItem('importer_handoff_walls', JSON.stringify(handoffWalls));
    localStorage.setItem('importer_handoff_filename', session.fileName);
    localStorage.setItem('importer_handoff_dxf_data', JSON.stringify({
      lineEntities: session.dxfData?.lineEntities || [],
      polylines: session.dxfData?.polylines || [],
      hatches: session.dxfData?.hatches || [],
      inserts: session.dxfData?.inserts || [],
      textEntities: session.dxfData?.textEntities || [],
      insunits: session.dxfData?.insunits || 1,
      unitScale: session.dxfData?.unitScale || 1.0,
      unitName: session.dxfData?.unitName || 'inches',
      measurement: session.dxfData?.measurement || 0
    }));
    await clearSession(session.id);
    setSession(null);
    router.push('/');
  };
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.18em', color: 'var(--accent-light)', fontWeight: 800 }}>
                NEWT'S TOOLKIT | STRUCTURAL SUITE
              </div>
              <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', marginTop: '0.15rem' }}>
                Archs Importer Workspace
              </h1>
            </div>

            {/* Top Navigation Tabs */}
            <nav style={{ display: 'flex', gap: '0.25rem', marginLeft: '1.5rem', backgroundColor: 'var(--paper-dark)', border: '1px solid var(--ink-disabled)', padding: '0.2rem', borderRadius: '4px' }}>
              <Link href="/" style={{
                textDecoration: 'none',
                padding: '0.35rem 0.85rem',
                borderRadius: '3px',
                fontSize: '0.7rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                backgroundColor: 'transparent',
                color: 'var(--ink-muted)',
                transition: 'all 0.15s'
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = 'var(--foreground)';
                e.currentTarget.style.backgroundColor = 'var(--paper-light)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.color = 'var(--ink-muted)';
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
              >
                Beam Framer
              </Link>
              <Link href="/importer" style={{
                textDecoration: 'none',
                padding: '0.35rem 0.85rem',
                borderRadius: '3px',
                fontSize: '0.7rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                backgroundColor: 'var(--accent)',
                color: 'var(--foreground)',
                transition: 'all 0.1s ease-in-out'
              }}>
                Archs Importer
              </Link>
            </nav>
          </div>

          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            {session && (
              <button
                onClick={handleClearSession}
                style={{
                  backgroundColor: 'transparent',
                  color: 'var(--ink-muted)',
                  border: '1px solid var(--ink-disabled)',
                  padding: '0.45rem 1rem',
                  fontSize: '0.7rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                  fontWeight: 600,
                  borderRadius: '2px',
                  transition: 'all 0.15s'
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.color = 'var(--foreground)';
                  e.currentTarget.style.borderColor = 'red';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color = 'var(--ink-muted)';
                  e.currentTarget.style.borderColor = 'var(--ink-disabled)';
                }}
              >
                Reset Session
              </button>
            )}
          </div>
        </div>
      </header>

      {/* PIPELINE PROGRESS BAR */}
      {session && (
        <div style={{
          backgroundColor: 'var(--paper-light)',
          padding: '0.75rem 2rem',
          borderBottom: '1px solid var(--ink-disabled)',
          display: 'flex',
          justifyContent: 'center',
          gap: '4rem',
          fontSize: '0.75rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: session.currentStep === 1 ? 'var(--accent-light)' : 'var(--ink-muted)' }}>
            <span style={{ backgroundColor: session.currentStep === 1 ? 'var(--accent)' : 'var(--ink-disabled)', color: '#fff', width: '18px', height: '18px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}>1</span>
            Scale-Aware Intake Gate
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: session.currentStep === 2 ? 'var(--accent-light)' : 'var(--ink-muted)' }}>
            <span style={{ backgroundColor: session.currentStep === 2 ? 'var(--accent)' : 'var(--ink-disabled)', color: '#fff', width: '18px', height: '18px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}>2</span>
            AI Recognition & Exceptions
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: session.currentStep === 3 ? 'var(--accent-light)' : 'var(--ink-muted)' }}>
            <span style={{ backgroundColor: session.currentStep === 3 ? 'var(--accent)' : 'var(--ink-disabled)', color: '#fff', width: '18px', height: '18px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem' }}>3</span>
            Completeness Sign-off
          </div>
        </div>
      )}

      {/* WORKSPACE CONTENT */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        
        {/* NO FILE LOADED: DROPAREA STATE */}
        {!session ? (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4rem 2rem',
            overflowY: 'auto'
          }}>
            {/* INTAKE ERROR STATE */}
            {error ? (
              <div style={{
                maxWidth: '650px',
                width: '100%',
                backgroundColor: 'rgba(255,0,0,0.06)',
                border: '1px solid #ff4a4a',
                padding: '2rem',
                borderRadius: '6px',
                marginBottom: '2rem',
                boxShadow: '0 8px 24px rgba(0,0,0,0.2)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#ff4a4a', fontWeight: 800, fontSize: '1.1rem', fontFamily: "'Syne', sans-serif" }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  {error.title}
                </div>
                <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--foreground)', lineHeight: 1.5 }}>
                  {error.desc}
                </p>
                {error.details && (
                  <pre style={{
                    marginTop: '1rem',
                    padding: '1rem',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--ink-disabled)',
                    borderRadius: '4px',
                    color: 'var(--ink-muted)',
                    fontSize: '0.72rem',
                    lineHeight: 1.6,
                    fontFamily: 'var(--font-mono), monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all'
                  }}>
                    {error.details}
                  </pre>
                )}
                <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                  <button
                    onClick={() => setError(null)}
                    style={{
                      backgroundColor: 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      padding: '0.5rem 1.25rem',
                      fontWeight: 700,
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      borderRadius: '3px'
                    }}
                  >
                    Upload Another DXF
                  </button>
                  <button
                    onClick={() => {
                      // Bypass scale limit for testing purposes
                      handleToleranceChange('maxBBoxFt', 5000);
                      setError(null);
                    }}
                    style={{
                      backgroundColor: 'transparent',
                      color: 'var(--ink-muted)',
                      border: '1px solid var(--ink-disabled)',
                      padding: '0.5rem 1.25rem',
                      fontWeight: 600,
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      borderRadius: '3px'
                    }}
                  >
                    Bypass limit
                  </button>
                </div>
              </div>
            ) : (
              <div
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                style={{
                  maxWidth: '650px',
                  width: '100%',
                  border: dragging ? '2px dashed var(--accent)' : '1px dashed var(--ink-disabled)',
                  backgroundColor: dragging ? 'var(--paper-light)' : 'var(--paper-dark)',
                  padding: '4rem 2rem',
                  textAlign: 'center',
                  borderRadius: '6px',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
                  transition: 'all 0.15s ease-in-out',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <div style={{
                  backgroundColor: 'rgba(75, 160, 70, 0.1)',
                  color: 'var(--accent)',
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '1.5rem'
                }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                  </svg>
                </div>

                <h2 style={{ fontFamily: "'Syne', sans-serif", fontSize: '1.25rem', fontWeight: 800, marginBottom: '0.5rem', letterSpacing: '-0.02em' }}>
                  {loading ? 'Analyzing Vector Structure...' : 'Drop Clean CAD Floor Plan (DXF)'}
                </h2>
                <p style={{ color: 'var(--ink-muted)', fontSize: '0.8rem', maxWidth: '420px', marginBottom: '1.5rem', lineHeight: 1.4 }}>
                  {loading ? 'Ingesting entity tables, scanning INSUNITS scale headers, and evaluating bounds limit constraints.' : 'Upload your ASCII .dxf vector plan. We auto-discover active scales and reject uncleaned overlays to keep geometry accurate.'}
                </p>

                {!loading && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'center' }}>
                    <label style={{
                      backgroundColor: 'var(--foreground)',
                      color: 'var(--background)',
                      padding: '0.55rem 1.5rem',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      cursor: 'pointer',
                      borderRadius: '3px',
                      transition: 'background-color 0.15s'
                    }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--accent)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'var(--foreground)'}
                    >
                      Browse DXF File
                      <input
                        type="file"
                        accept=".dxf"
                        style={{ display: 'none' }}
                        onChange={e => e.target.files?.[0] && handleDXFUpload(e.target.files[0])}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* RECOVERY HELPER */}
            {!loading && !error && (
              <div style={{ marginTop: '2rem', maxWidth: '650px', width: '100%', fontSize: '0.75rem', color: 'var(--ink-disabled)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
                <div>
                  <h4 style={{ fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Drawing Cleanliness Gate</h4>
                  <p style={{ lineHeight: 1.4 }}>The importer rejects files spanning over 400 ft physically. Please ensure only the active building footprint is saved in modelspace. Do not include other floor levels side-by-side.</p>
                </div>
                <div>
                  <h4 style={{ fontWeight: 700, color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Auto-Scale Discovery</h4>
                  <p style={{ lineHeight: 1.4 }}>We parse AutoCAD $INSUNITS and $MEASUREMENT variables, converting all dimensions to physical inches internally to bypass unit mismatches.</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          
          /* ACTIVE IMPORT WORKSPACE */
          <>
            {/* LEFT WORKSPACE SIDEBAR */}
            <aside style={{
              width: '320px',
              borderRight: '1px solid var(--ink-disabled)',
              backgroundColor: 'var(--paper-dark)',
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
              overflowY: 'auto'
            }}>
              
              {/* FILE METADATA CARD */}
              <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--ink-disabled)', flexShrink: 0 }}>
                <div style={{ fontSize: '0.65rem', textTransform: 'uppercase', color: 'var(--accent-light)', fontWeight: 700, letterSpacing: '0.08em', marginBottom: '0.35rem' }}>
                  Active Import Asset
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={session.fileName}>
                  {session.fileName}
                </div>
                <div className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-muted)', marginTop: '0.2rem' }}>
                  Scale Code: {session.dxfData?.insunits} ({session.dxfData?.unitName})<br />
                  Internal Scaling: {session.dxfData?.unitScale.toFixed(5)}x to Inches
                </div>
              </div>

              {/* STEP 1 PANEL */}
              {session.currentStep === 1 && (
                <>
                  {/* DYNAMIC SCALE-AWARE TOLERANCES CARD (COLLAPSIBLE) */}
                  <div style={{ borderBottom: '1px solid var(--ink-disabled)' }}>
                    <button
                      onClick={() => setIsTolerancesOpen(!isTolerancesOpen)}
                      style={{
                        width: '100%',
                        backgroundColor: 'transparent',
                        border: 'none',
                        padding: '1rem 1.25rem',
                        color: '#fff',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.75rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                      }}
                    >
                      Tolerances & Settings
                      <span>{isTolerancesOpen ? '▲' : '▼'}</span>
                    </button>

                    {isTolerancesOpen && (
                      <div style={{ padding: '0 1.25rem 1.25rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        
                        {/* Snap Tolerance T_snap */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Snap Tolerance (T_snap)</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.snap.toFixed(1)} in ({ (tolerances.snap / (session.dxfData?.unitScale || 1)).toFixed(1) } native)</span>
                          </div>
                          <input
                            type="range"
                            min="0.5"
                            max="6"
                            step="0.1"
                            value={tolerances.snap}
                            onChange={e => handleToleranceChange('snap', parseFloat(e.target.value))}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>

                        {/* Prune Threshold T_prune */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Prune Stub (T_prune)</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.prune.toFixed(1)} in ({ (tolerances.prune / (session.dxfData?.unitScale || 1)).toFixed(1) } native)</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="12"
                            step="0.5"
                            value={tolerances.prune}
                            onChange={e => handleToleranceChange('prune', parseFloat(e.target.value))}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>

                        {/* Min Wall Width W_min */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Min Wall Width (W_min)</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.wMin.toFixed(1)} in</span>
                          </div>
                          <input
                            type="range"
                            min="2"
                            max="8"
                            step="0.5"
                            value={tolerances.wMin}
                            onChange={e => handleToleranceChange('wMin', parseFloat(e.target.value))}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>

                        {/* Max Wall Width W_max */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Max Wall Width (W_max)</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.wMax.toFixed(1)} in</span>
                          </div>
                          <input
                            type="range"
                            min="8"
                            max="24"
                            step="0.5"
                            value={tolerances.wMax}
                            onChange={e => handleToleranceChange('wMax', parseFloat(e.target.value))}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>

                        {/* Bounding Box FT Check */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Max Footprint Limit</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.maxBBoxFt} ft</span>
                          </div>
                          <input
                            type="number"
                            value={tolerances.maxBBoxFt}
                            onChange={e => handleToleranceChange('maxBBoxFt', parseInt(e.target.value) || 400)}
                            style={{
                              backgroundColor: 'var(--paper-light)',
                              border: '1px solid var(--ink-disabled)',
                              padding: '0.3rem 0.5rem',
                              color: '#fff',
                              fontSize: '0.7rem',
                              fontFamily: 'var(--font-mono), monospace',
                              borderRadius: '2px'
                            }}
                          />
                        </div>

                        {/* Max Wall Vertices */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Max Wall Vertices</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.maxWallVertices} verts</span>
                          </div>
                          <input
                            type="range"
                            min="10"
                            max="100"
                            step="5"
                            value={tolerances.maxWallVertices}
                            onChange={e => handleToleranceChange('maxWallVertices', parseInt(e.target.value) || 40)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>

                        {/* Max Wall Area Sq Ft */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600 }}>
                            <span style={{ color: 'var(--ink-muted)' }}>Max Wall Area</span>
                            <span className="mono" style={{ color: 'var(--accent-light)' }}>{tolerances.maxWallAreaSqFt} sq ft</span>
                          </div>
                          <input
                            type="range"
                            min="10"
                            max="250"
                            step="5"
                            value={tolerances.maxWallAreaSqFt}
                            onChange={e => handleToleranceChange('maxWallAreaSqFt', parseInt(e.target.value) || 50)}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* PDF UNDERLAY FIELD Persistence */}
                  <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--ink-disabled)' }}>
                    <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.75rem' }}>
                      PDF Design Underlay
                    </div>
                    {session.pdfData?.imageUri ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {/* Linked filename */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--accent-light)', fontWeight: 600 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {pdfFileName || 'Raster Snapshot'}
                          </span>
                        </div>

                        {/* Page Selector Navigation */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', fontWeight: 600, color: 'var(--ink-muted)' }}>
                            <span>PDF Document Sheet</span>
                            <span className="mono">Page {pdfPageNum} of {session.pdfData.totalPages || 1}</span>
                          </div>
                          {pdfFile ? (
                            <div style={{ display: 'flex', gap: '0.25rem' }}>
                              <button
                                onClick={() => handlePageChange(pdfPageNum - 1)}
                                disabled={pdfPageNum <= 1}
                                style={{
                                  flex: 1,
                                  backgroundColor: 'var(--paper-light)',
                                  border: '1px solid var(--ink-disabled)',
                                  color: pdfPageNum <= 1 ? 'var(--ink-disabled)' : '#fff',
                                  padding: '0.25rem',
                                  fontSize: '0.65rem',
                                  fontWeight: 700,
                                  borderRadius: '2px',
                                  cursor: pdfPageNum <= 1 ? 'not-allowed' : 'pointer'
                                }}
                              >
                                ◀ Prev Page
                              </button>
                              <button
                                onClick={() => handlePageChange(pdfPageNum + 1)}
                                disabled={pdfPageNum >= (session.pdfData.totalPages || 1)}
                                style={{
                                  flex: 1,
                                  backgroundColor: 'var(--paper-light)',
                                  border: '1px solid var(--ink-disabled)',
                                  color: pdfPageNum >= (session.pdfData.totalPages || 1) ? 'var(--ink-disabled)' : '#fff',
                                  padding: '0.25rem',
                                  fontSize: '0.65rem',
                                  fontWeight: 700,
                                  borderRadius: '2px',
                                  cursor: pdfPageNum >= (session.pdfData.totalPages || 1) ? 'not-allowed' : 'pointer'
                                }}
                              >
                                Next Page ▶
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                              <label style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                backgroundColor: 'transparent',
                                border: '1px dashed var(--ink-disabled)',
                                color: 'var(--ink-muted)',
                                padding: '0.35rem',
                                fontSize: '0.65rem',
                                borderRadius: '2px',
                                cursor: 'pointer',
                                textAlign: 'center',
                                width: '100%'
                              }}
                              onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                              onMouseLeave={e => e.currentTarget.style.color = 'var(--ink-muted)'}
                              >
                                Re-link PDF to navigate pages
                                <input
                                  type="file"
                                  accept=".pdf"
                                  style={{ display: 'none' }}
                                  onChange={handlePdfUpload}
                                />
                              </label>
                            </div>
                          )}
                        </div>

                        {/* Opacity Slider */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600, color: 'var(--ink-muted)' }}>
                            <span>Opacity Contrast</span>
                            <span className="mono">{Math.round(pdfOpacity * 100)}%</span>
                          </div>
                          <input
                            type="range"
                            min="0.0"
                            max="1.0"
                            step="0.05"
                            value={pdfOpacity}
                            onChange={e => setPdfOpacity(parseFloat(e.target.value))}
                            style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                          />
                        </div>

                        {/* Calibration Status & Actions */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.25rem' }}>
                          {session.pdfData.transformMatrix ? (
                            <div style={{
                              backgroundColor: 'rgba(75, 160, 70, 0.08)',
                              border: '1px solid rgba(75, 160, 70, 0.4)',
                              borderRadius: '3px',
                              padding: '0.45rem 0.6rem'
                            }}>
                              <div style={{ fontSize: '0.65rem', color: 'var(--accent-light)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                ✓ Affine Calibrated
                              </div>
                              <div className="mono" style={{ fontSize: '0.6rem', color: 'var(--ink-muted)', marginTop: '0.15rem', lineHeight: 1.3 }}>
                                Scale: {session.pdfData.transformMatrix.s.toFixed(4)}x<br />
                                Rotation: {((session.pdfData.transformMatrix.theta * 180) / Math.PI).toFixed(1)}°<br />
                                Translation: ({session.pdfData.transformMatrix.tx.toFixed(1)}, {session.pdfData.transformMatrix.ty.toFixed(1)})
                              </div>
                            </div>
                          ) : (
                            <div style={{
                              backgroundColor: 'rgba(255, 152, 0, 0.08)',
                              border: '1px solid rgba(255, 152, 0, 0.4)',
                              borderRadius: '3px',
                              padding: '0.45rem 0.6rem'
                            }}>
                              <div style={{ fontSize: '0.65rem', color: 'orange', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                ⚠️ Uncalibrated Underlay
                              </div>
                              <p style={{ fontSize: '0.62rem', color: 'var(--ink-muted)', marginTop: '0.15rem', lineHeight: 1.3 }}>
                                Align sheet visually to CAD vector space via 2-point similarity transform.
                              </p>
                            </div>
                          )}

                          <div style={{ display: 'flex', gap: '0.35rem' }}>
                            <button
                              onClick={() => {
                                setIsCalibrating(true);
                                setCalibrationStep(1);
                                setCalibDxfPt1(null);
                                setCalibDxfPt2(null);
                                setCalibPdfPt1(null);
                                setCalibPdfPt2(null);
                              }}
                              style={{
                                flex: 2,
                                backgroundColor: 'var(--foreground)',
                                color: 'var(--background)',
                                border: 'none',
                                padding: '0.4rem',
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                borderRadius: '2px',
                                cursor: 'pointer',
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                transition: 'background-color 0.15s'
                              }}
                              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--accent)'}
                              onMouseLeave={e => e.currentTarget.style.backgroundColor = 'var(--foreground)'}
                            >
                              {session.pdfData.transformMatrix ? 'Recalibrate Plan' : 'Start Calibration'}
                            </button>
                            <button
                              onClick={handleRemoveUnderlay}
                              style={{
                                flex: 1,
                                backgroundColor: 'transparent',
                                color: 'var(--ink-muted)',
                                border: '1px solid var(--ink-disabled)',
                                padding: '0.4rem',
                                fontSize: '0.68rem',
                                fontWeight: 600,
                                borderRadius: '2px',
                                cursor: 'pointer',
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                transition: 'all 0.15s'
                              }}
                              onMouseEnter={e => {
                                e.currentTarget.style.color = '#ff4a4a';
                                e.currentTarget.style.borderColor = '#ff4a4a';
                              }}
                              onMouseLeave={e => {
                                e.currentTarget.style.color = 'var(--ink-muted)';
                                e.currentTarget.style.borderColor = 'var(--ink-disabled)';
                              }}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <p style={{ fontSize: '0.7rem', color: 'var(--ink-disabled)', lineHeight: 1.3 }}>
                          Upload multi-page design PDFs client-side and calibrate alignment dynamically using similarity matrices.
                        </p>
                        <label style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: 'transparent',
                          color: 'var(--foreground)',
                          border: '1px dashed var(--ink-disabled)',
                          padding: '0.5rem',
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          cursor: 'pointer',
                          borderRadius: '2px',
                          transition: 'all 0.15s',
                          textAlign: 'center'
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.borderColor = 'var(--accent)';
                          e.currentTarget.style.color = 'var(--accent)';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.borderColor = 'var(--ink-disabled)';
                          e.currentTarget.style.color = 'var(--foreground)';
                        }}
                        >
                          Browse PDF File
                          <input
                            type="file"
                            accept=".pdf"
                            style={{ display: 'none' }}
                            onChange={handlePdfUpload}
                          />
                        </label>
                      </div>
                    )}
                  </div>

                  {/* PROCEED BUTTON */}
                  <div style={{ marginTop: 'auto', padding: '1.25rem', backgroundColor: 'var(--paper-light)', borderTop: '1px solid var(--ink-disabled)', flexShrink: 0 }}>
                    <button
                      onClick={async () => {
                        const updated = { ...session, currentStep: 2 as const };
                        await saveSession(updated);
                        setSession(updated);
                        runCompilation(updated);
                      }}
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        padding: '0.75rem 1rem',
                        fontWeight: 700,
                        fontSize: '0.75rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        cursor: 'pointer',
                        borderRadius: '3px',
                        transition: 'background-color 0.15s'
                      }}
                      onMouseEnter={e => e.currentTarget.style.backgroundColor = 'var(--accent-light)'}
                      onMouseLeave={e => e.currentTarget.style.backgroundColor = 'var(--accent)'}
                    >
                      Compile & Proceed
                    </button>
                  </div>
                </>
              )}

              {/* STEP 2 PANEL */}
              {session.currentStep === 2 && (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                  
                  {/* AI CLASSIFIER TRIGGER CARD */}
                  <div style={{ padding: '1rem', borderBottom: '1px solid var(--ink-disabled)', flexShrink: 0 }}>
                    <button
                      onClick={handleAiClassification}
                      disabled={isAiLoading}
                      style={{
                        width: '100%',
                        backgroundColor: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        padding: '0.65rem 1rem',
                        fontWeight: 700,
                        fontSize: '0.75rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        cursor: isAiLoading ? 'not-allowed' : 'pointer',
                        borderRadius: '3px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        boxShadow: '0 4px 12px rgba(75, 160, 70, 0.2)',
                        transition: 'all 0.15s'
                      }}
                      onMouseEnter={e => !isAiLoading && (e.currentTarget.style.backgroundColor = 'var(--accent-light)')}
                      onMouseLeave={e => !isAiLoading && (e.currentTarget.style.backgroundColor = 'var(--accent)')}
                    >
                      {isAiLoading ? (
                        <>
                          <svg style={{ animation: 'spin 1s linear infinite', marginRight: '0.25rem' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.2)" />
                            <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" />
                          </svg>
                          Classifying layers...
                        </>
                      ) : (
                        <>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
                          </svg>
                          Trigger AI Classification
                        </>
                      )}
                    </button>
                  </div>

                  {/* LAYER & BLOCK MAPPINGS CONTAINER */}
                  <div style={{ padding: '1rem', borderBottom: '1px solid var(--ink-disabled)', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                      CAD Layer & Block Mappings
                    </div>
                    <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingRight: '0.2rem' }}>
                      {layers.map(layerName => {
                        const key = `layer:${layerName}`;
                        const mapping = session.mappings[key];
                        const currentCategory = mapping?.canonicalCategory || 'REVIEW';
                        
                        let badgeColor = 'var(--ink-disabled)';
                        let badgeText = 'unassigned';
                        if (mapping) {
                          if (mapping.provenance === 'human-confirmed') {
                            badgeColor = 'rgba(75, 160, 70, 0.2)';
                            badgeText = 'human';
                          } else if (mapping.provenance === 'ai-suggested') {
                            badgeColor = 'rgba(33, 150, 243, 0.2)';
                            badgeText = 'AI';
                          } else {
                            badgeColor = 'rgba(156, 39, 176, 0.2)';
                            badgeText = 'auto';
                          }
                        }
                        
                        return (
                          <div key={key} style={{
                            backgroundColor: 'var(--paper-light)',
                            border: '1px solid var(--ink-disabled)',
                            borderRadius: '4px',
                            padding: '0.45rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.25rem'
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span className="mono" style={{ fontSize: '0.65rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }} title={layerName}>
                                {layerName}
                              </span>
                              <span style={{
                                fontSize: '0.5rem',
                                textTransform: 'uppercase',
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                padding: '0.05rem 0.3rem',
                                borderRadius: '2px',
                                backgroundColor: badgeColor,
                                color: mapping?.provenance === 'human-confirmed' ? 'var(--accent-light)' : mapping?.provenance === 'ai-suggested' ? '#2196f3' : 'var(--ink-muted)'
                              }}>
                                {badgeText}
                              </span>
                            </div>
                            <select
                              value={currentCategory}
                              onChange={e => handleMappingChange('layer', layerName, e.target.value)}
                              style={{
                                backgroundColor: 'var(--paper-dark)',
                                border: '1px solid var(--ink-disabled)',
                                color: '#fff',
                                fontSize: '0.65rem',
                                padding: '0.15rem',
                                borderRadius: '2px',
                                cursor: 'pointer',
                                width: '100%'
                              }}
                            >
                              <option value="WALL">Category: WALL</option>
                              <option value="POCHE">Category: POCHE</option>
                              <option value="FIX">Category: FIX (Toilets/Sinks)</option>
                              <option value="DOOR">Category: DOOR</option>
                              <option value="WIN">Category: WIN</option>
                              <option value="RMNAME">Category: RMNAME</option>
                              <option value="STAIR">Category: STAIR</option>
                              <option value="ROOF">Category: ROOF</option>
                              <option value="GRID">Category: GRID</option>
                              <option value="JUNK">Category: JUNK</option>
                              <option value="REVIEW">Category: REVIEW (Default)</option>
                            </select>
                          </div>
                        );
                      })}

                      {blocks.map(blockName => {
                        const key = `block:${blockName}`;
                        const mapping = session.mappings[key];
                        const currentCategory = mapping?.canonicalCategory || 'REVIEW';
                        
                        let badgeColor = 'var(--ink-disabled)';
                        let badgeText = 'unassigned';
                        if (mapping) {
                          if (mapping.provenance === 'human-confirmed') {
                            badgeColor = 'rgba(75, 160, 70, 0.2)';
                            badgeText = 'human';
                          } else if (mapping.provenance === 'ai-suggested') {
                            badgeColor = 'rgba(33, 150, 243, 0.2)';
                            badgeText = 'AI';
                          } else {
                            badgeColor = 'rgba(156, 39, 176, 0.2)';
                            badgeText = 'auto';
                          }
                        }
                        
                        return (
                          <div key={key} style={{
                            backgroundColor: 'var(--paper-light)',
                            border: '1px solid var(--ink-disabled)',
                            borderRadius: '4px',
                            padding: '0.45rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.25rem'
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span className="mono" style={{ fontSize: '0.65rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }} title={blockName}>
                                Block: {blockName}
                              </span>
                              <span style={{
                                fontSize: '0.5rem',
                                textTransform: 'uppercase',
                                fontWeight: 700,
                                letterSpacing: '0.04em',
                                padding: '0.05rem 0.3rem',
                                borderRadius: '2px',
                                backgroundColor: badgeColor,
                                color: mapping?.provenance === 'human-confirmed' ? 'var(--accent-light)' : mapping?.provenance === 'ai-suggested' ? '#2196f3' : 'var(--ink-muted)'
                              }}>
                                {badgeText}
                              </span>
                            </div>
                            <select
                              value={currentCategory}
                              onChange={e => handleMappingChange('block', blockName, e.target.value)}
                              style={{
                                backgroundColor: 'var(--paper-dark)',
                                border: '1px solid var(--ink-disabled)',
                                color: '#fff',
                                fontSize: '0.65rem',
                                padding: '0.15rem',
                                borderRadius: '2px',
                                cursor: 'pointer',
                                width: '100%'
                              }}
                            >
                              <option value="WALL">Category: WALL</option>
                              <option value="POCHE">Category: POCHE</option>
                              <option value="FIX">Category: FIX</option>
                              <option value="DOOR">Category: DOOR</option>
                              <option value="WIN">Category: WIN</option>
                              <option value="RMNAME">Category: RMNAME</option>
                              <option value="STAIR">Category: STAIR</option>
                              <option value="ROOF">Category: ROOF</option>
                              <option value="GRID">Category: GRID</option>
                              <option value="JUNK">Category: JUNK</option>
                              <option value="REVIEW">Category: REVIEW (Default)</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* EXCEPTION QUEUE CARD (SCROLLABLE) */}
                  <div style={{ padding: '1rem', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.5rem', flexShrink: 0 }}>
                      Exception Queue ({session.exceptions.filter(e => !e.resolved).length} unresolved)
                    </div>
                    <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, paddingRight: '0.2rem' }}>
                      {session.exceptions.filter(e => !e.resolved).map(exc => (
                        <div
                          key={exc.id}
                          onClick={() => exc.location && setFocusedCoordinates(exc.location)}
                          style={{
                            backgroundColor: 'rgba(244, 67, 54, 0.05)',
                            border: '1px solid rgba(244, 67, 54, 0.25)',
                            borderRadius: '4px',
                            padding: '0.5rem',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.2rem',
                            transition: 'background-color 0.1s'
                          }}
                          onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(244, 67, 54, 0.08)'}
                          onMouseLeave={e => e.currentTarget.style.backgroundColor = 'rgba(244, 67, 54, 0.05)'}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#f44336' }}>{exc.title}</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleResolveException(exc.id);
                              }}
                              style={{
                                backgroundColor: 'rgba(244, 67, 54, 0.15)',
                                border: 'none',
                                color: '#fff',
                                fontSize: '0.52rem',
                                fontWeight: 700,
                                padding: '0.1rem 0.35rem',
                                borderRadius: '2px',
                                cursor: 'pointer'
                              }}
                            >
                              Resolve
                            </button>
                          </div>
                          <p style={{ fontSize: '0.62rem', color: 'var(--ink-muted)', lineHeight: 1.3 }}>
                            {exc.description}
                          </p>
                        </div>
                      ))}
                      {session.exceptions.filter(e => !e.resolved).length === 0 && (
                        <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--accent-light)', fontSize: '0.75rem', fontWeight: 600 }}>
                          ✓ All exceptions resolved!
                        </div>
                      )}
                    </div>
                  </div>

                  {/* BACK/PROCEED BUTTONS CONTAINER */}
                  <div style={{ padding: '1rem', display: 'flex', gap: '0.5rem', backgroundColor: 'var(--paper-light)', borderTop: '1px solid var(--ink-disabled)', flexShrink: 0 }}>
                    <button
                      onClick={async () => {
                        const updated = { ...session, currentStep: 1 as const };
                        await saveSession(updated);
                        setSession(updated);
                      }}
                      style={{
                        flex: 1,
                        backgroundColor: 'transparent',
                        border: '1px solid var(--ink-disabled)',
                        color: 'var(--ink-muted)',
                        padding: '0.55rem',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        borderRadius: '3px',
                        cursor: 'pointer'
                      }}
                    >
                      Back
                    </button>
                    <button
                      onClick={async () => {
                        const updated = { ...session, currentStep: 3 as const };
                        await saveSession(updated);
                        setSession(updated);
                      }}
                      style={{
                        flex: 1,
                        backgroundColor: 'var(--accent)',
                        color: '#fff',
                        border: 'none',
                        padding: '0.55rem',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        borderRadius: '3px',
                        cursor: 'pointer'
                      }}
                    >
                      Proceed
                    </button>
                  </div>

                </div>
              )}

              {/* STEP 3 PANEL */}
              {session.currentStep === 3 && (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                  
                  {/* STATS SUMMARY */}
                  <div style={{ padding: '1rem', borderBottom: '1px solid var(--ink-disabled)', flexShrink: 0 }}>
                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.6rem' }}>
                      Compilation Results
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                      <div style={{ backgroundColor: 'var(--paper-light)', padding: '0.4rem', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--ink-disabled)' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--accent-light)' }}>
                          {session.elements?.walls.length || 0}
                        </div>
                        <div style={{ fontSize: '0.52rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 600 }}>Assembled Walls</div>
                      </div>
                      <div style={{ backgroundColor: 'var(--paper-light)', padding: '0.4rem', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--ink-disabled)' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 800, color: '#ff2a2a' }}>
                          {session.elements?.openings.length || 0}
                        </div>
                        <div style={{ fontSize: '0.52rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 600 }}>Openings</div>
                      </div>
                      <div style={{ backgroundColor: 'var(--paper-light)', padding: '0.4rem', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--ink-disabled)' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 800, color: '#ffc107' }}>
                          {session.elements?.stairs.length || 0}
                        </div>
                        <div style={{ fontSize: '0.52rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 600 }}>Staircases</div>
                      </div>
                      <div style={{ backgroundColor: 'var(--paper-light)', padding: '0.4rem', borderRadius: '4px', textAlign: 'center', border: '1px solid var(--ink-disabled)' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 800, color: '#2196f3' }}>
                          {session.elements?.rooms.length || 0}
                        </div>
                        <div style={{ fontSize: '0.52rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 600 }}>Rooms Parsed</div>
                      </div>
                    </div>
                  </div>

                  {/* SIGN-OFFS & COMPLETE AUDIT */}
                  <div style={{ padding: '1rem', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', color: 'var(--ink-muted)', fontWeight: 700, letterSpacing: '0.05em', marginBottom: '0.5rem', flexShrink: 0 }}>
                      Completeness Sign-off
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', overflowY: 'auto', flex: 1, paddingRight: '0.2rem' }}>
                      
                      {/* Roof audit */}
                      {!Object.values(session.mappings).some(m => m.canonicalCategory === 'ROOF') ? (
                        <label style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.45rem',
                          fontSize: '0.68rem',
                          color: '#fff',
                          cursor: 'pointer',
                          backgroundColor: 'rgba(255, 152, 0, 0.05)',
                          padding: '0.45rem',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 152, 0, 0.25)'
                        }}>
                          <input
                            type="checkbox"
                            checked={!!signoffs['roof']}
                            onChange={() => handleSignoffToggle('roof')}
                            style={{ marginTop: '0.1rem', accentColor: 'var(--accent)' }}
                          />
                          <div>
                            <div style={{ fontWeight: 700, color: 'orange' }}>Verify Roof Layout</div>
                            <p style={{ fontSize: '0.6rem', color: 'var(--ink-muted)', marginTop: '0.1rem', lineHeight: 1.25 }}>
                              No ROOF layer is mapped. Confirm that roof framing is not required or is mapped manually.
                            </p>
                          </div>
                        </label>
                      ) : (
                        <div style={{ fontSize: '0.65rem', color: 'var(--accent-light)', fontWeight: 700, backgroundColor: 'rgba(75,160,70,0.06)', border: '1px solid rgba(75,160,70,0.2)', padding: '0.45rem', borderRadius: '4px' }}>
                          ✓ ROOF layer mapped and verified.
                        </div>
                      )}

                      {/* Grid audit */}
                      {!Object.values(session.mappings).some(m => m.canonicalCategory === 'GRID') ? (
                        <label style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.45rem',
                          fontSize: '0.68rem',
                          color: '#fff',
                          cursor: 'pointer',
                          backgroundColor: 'rgba(255, 152, 0, 0.05)',
                          padding: '0.45rem',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 152, 0, 0.25)'
                        }}>
                          <input
                            type="checkbox"
                            checked={!!signoffs['grid']}
                            onChange={() => handleSignoffToggle('grid')}
                            style={{ marginTop: '0.1rem', accentColor: 'var(--accent)' }}
                          />
                          <div>
                            <div style={{ fontWeight: 700, color: 'orange' }}>Verify Grid References</div>
                            <p style={{ fontSize: '0.6rem', color: 'var(--ink-muted)', marginTop: '0.1rem', lineHeight: 1.25 }}>
                              No GRID references are mapped. Confirm that grids are absent or mapped correctly.
                            </p>
                          </div>
                        </label>
                      ) : (
                        <div style={{ fontSize: '0.65rem', color: 'var(--accent-light)', fontWeight: 700, backgroundColor: 'rgba(75,160,70,0.06)', border: '1px solid rgba(75,160,70,0.2)', padding: '0.45rem', borderRadius: '4px' }}>
                          ✓ GRID layer mapped and verified.
                        </div>
                      )}

                      {/* Wet Zone/Toilet Audit failures list */}
                      {session.exceptions.filter(e => e.type === 'missing-toilet' && !e.resolved).length > 0 && (
                        <div style={{
                          backgroundColor: 'rgba(244, 67, 54, 0.08)',
                          border: '1px solid rgba(244, 67, 54, 0.4)',
                          borderRadius: '4px',
                          padding: '0.55rem',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.35rem'
                        }}>
                          <div style={{ fontSize: '0.65rem', color: '#f44336', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            ⚠️ Toilet Audit Failure Warning
                          </div>
                          <p style={{ fontSize: '0.58rem', color: 'var(--ink-muted)', lineHeight: 1.25 }}>
                            Plumbing zones were detected without toilets in close proximity. Click exception points on canvas to inspect visually.
                          </p>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                            {session.exceptions.filter(e => e.type === 'missing-toilet' && !e.resolved).map(exc => (
                              <div
                                key={exc.id}
                                onClick={() => exc.location && setFocusedCoordinates(exc.location)}
                                style={{ fontSize: '0.58rem', color: '#fff', borderLeft: '2px solid #f44336', paddingLeft: '0.35rem', cursor: 'pointer' }}
                              >
                                At ({exc.location?.x.toFixed(0)}, {exc.location?.y.toFixed(0)}): {exc.title}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                    </div>
                  </div>

                  {/* BOTTOM ACTION BUTTONS HANDOFF */}
                  <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', backgroundColor: 'var(--paper-light)', borderTop: '1px solid var(--ink-disabled)', flexShrink: 0 }}>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        onClick={async () => {
                          const updated = { ...session, currentStep: 2 as const };
                          await saveSession(updated);
                          setSession(updated);
                        }}
                        style={{
                          flex: 1,
                          backgroundColor: 'transparent',
                          border: '1px solid var(--ink-disabled)',
                          color: 'var(--ink-muted)',
                          padding: '0.55rem',
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          borderRadius: '3px',
                          cursor: 'pointer'
                        }}
                      >
                        Back
                      </button>
                      <button
                        onClick={handleHandoff}
                        disabled={!canHandoff}
                        style={{
                          flex: 2,
                          backgroundColor: canHandoff ? 'var(--accent)' : 'var(--ink-disabled)',
                          color: canHandoff ? '#fff' : 'var(--ink-muted)',
                          border: 'none',
                          padding: '0.55rem',
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          borderRadius: '3px',
                          cursor: canHandoff ? 'pointer' : 'not-allowed',
                          boxShadow: canHandoff ? '0 4px 12px rgba(75, 160, 70, 0.2)' : undefined,
                          transition: 'all 0.1s ease-in-out'
                        }}
                        onMouseEnter={e => canHandoff && (e.currentTarget.style.backgroundColor = 'var(--accent-light)')}
                        onMouseLeave={e => canHandoff && (e.currentTarget.style.backgroundColor = 'var(--accent)')}
                      >
                        Handoff to Beam Framer
                      </button>
                    </div>
                    {!canHandoff && (
                      <p style={{ fontSize: '0.58rem', color: 'orange', textAlign: 'center', margin: 0 }}>
                        Please confirm ROOF and GRID sign-offs above to enable handoff.
                      </p>
                    )}
                  </div>

                </div>
              )}

            </aside>

            {isCalibrating ? (
              <main style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--paper-dark)', overflow: 'hidden' }}>
                {/* Instructional HUD Header */}
                <div style={{
                  backgroundColor: 'var(--paper-light)',
                  borderBottom: '1px solid var(--ink-disabled)',
                  padding: '0.75rem 1.5rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexShrink: 0,
                  zIndex: 10
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div style={{
                      fontFamily: "'Syne', sans-serif",
                      fontSize: '0.75rem',
                      fontWeight: 800,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: 'var(--accent-light)'
                    }}>
                      Visual Underlay Calibration Active
                    </div>
                    <div style={{
                      backgroundColor: 'rgba(255, 152, 0, 0.1)',
                      border: '1px solid orange',
                      padding: '0.3rem 0.75rem',
                      borderRadius: '3px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      color: 'orange'
                    }}>
                      {calibrationStep === 1 && "Step 1: Click first reference point on DXF (Right side)"}
                      {calibrationStep === 2 && "Step 2: Click the same reference point on PDF (Left side)"}
                      {calibrationStep === 3 && "Step 3: Click second reference point on DXF (Right side)"}
                      {calibrationStep === 4 && "Step 4: Click the same reference point on PDF (Left side)"}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setIsCalibrating(false);
                      setCalibrationStep(0);
                      setCalibDxfPt1(null);
                      setCalibDxfPt2(null);
                      setCalibPdfPt1(null);
                      setCalibPdfPt2(null);
                    }}
                    style={{
                      backgroundColor: 'rgba(255, 74, 74, 0.1)',
                      color: '#ff4a4a',
                      border: '1px solid rgba(255, 74, 74, 0.3)',
                      padding: '0.45rem 1rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      cursor: 'pointer',
                      borderRadius: '2px',
                      transition: 'all 0.15s'
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.backgroundColor = 'rgba(255, 74, 74, 0.2)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.backgroundColor = 'rgba(255, 74, 74, 0.1)';
                    }}
                  >
                    Cancel Calibration
                  </button>
                </div>

                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  {/* Left Column (50%): PDF Calibration panel */}
                  <div style={{
                    width: '50%',
                    height: '100%',
                    borderRight: '1px solid var(--ink-disabled)',
                    display: 'flex',
                    flexDirection: 'column',
                    backgroundColor: 'var(--background)',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      padding: '0.5rem 1.25rem',
                      borderBottom: '1px solid var(--ink-disabled)',
                      fontSize: '0.65rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--ink-muted)',
                      fontWeight: 600,
                      backgroundColor: 'var(--paper-dark)'
                    }}>
                      PDF Design Sheet (Left)
                    </div>
                    <div style={{
                      flex: 1,
                      position: 'relative',
                      overflow: 'auto',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '2rem',
                      backgroundColor: '#111'
                    }}>
                      {session.pdfData?.imageUri ? (
                        <div style={{
                          position: 'relative',
                          cursor: (calibrationStep === 2 || calibrationStep === 4) ? 'crosshair' : 'not-allowed',
                          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                          maxWidth: '100%',
                          maxHeight: '100%'
                        }}
                        onClick={(e) => {
                          if (calibrationStep !== 2 && calibrationStep !== 4) return;
                          const img = e.currentTarget.querySelector('img');
                          if (!img) return;
                          const rect = img.getBoundingClientRect();
                          // Map relative percentages of container
                          const xPercent = (e.clientX - rect.left) / rect.width;
                          const yPercent = (e.clientY - rect.top) / rect.height;
                          
                          // PDF natural pixels
                          const naturalX = xPercent * img.naturalWidth;
                          const naturalY = yPercent * img.naturalHeight;
                          
                          handlePdfClick(naturalX, naturalY);
                        }}
                        >
                          <img
                            src={session.pdfData.imageUri}
                            alt="PDF Design Underlay"
                            style={{
                              display: 'block',
                              maxWidth: '100%',
                              maxHeight: '80vh',
                              objectFit: 'contain',
                              userSelect: 'none',
                              pointerEvents: 'none' // Click handled by parent div bounding box
                            }}
                          />
                          
                          {/* Pin 1 (Green) */}
                          {calibPdfPt1 && session.pdfData.width && session.pdfData.height && (
                            <div style={{
                              position: 'absolute',
                              left: `${(calibPdfPt1.x / session.pdfData.width) * 100}%`,
                              top: `${(calibPdfPt1.y / session.pdfData.height) * 100}%`,
                              transform: 'translate(-50%, -50%)',
                              width: '12px',
                              height: '12px',
                              backgroundColor: '#4ba046',
                              border: '2px solid #fff',
                              borderRadius: '50%',
                              boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                              pointerEvents: 'none'
                            }} />
                          )}
                          
                          {/* Pin 2 (Orange) */}
                          {calibPdfPt2 && session.pdfData.width && session.pdfData.height && (
                            <div style={{
                              position: 'absolute',
                              left: `${(calibPdfPt2.x / session.pdfData.width) * 100}%`,
                              top: `${(calibPdfPt2.y / session.pdfData.height) * 100}%`,
                              transform: 'translate(-50%, -50%)',
                              width: '12px',
                              height: '12px',
                              backgroundColor: '#ff9800',
                              border: '2px solid #fff',
                              borderRadius: '50%',
                              boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                              pointerEvents: 'none'
                            }} />
                          )}
                        </div>
                      ) : (
                        <div style={{ color: 'var(--ink-disabled)', fontSize: '0.8rem' }}>
                          No PDF Raster snapshot found.
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Column (50%): DXF Workspace */}
                  <div style={{
                    width: '50%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      padding: '0.5rem 1.25rem',
                      borderBottom: '1px solid var(--ink-disabled)',
                      fontSize: '0.65rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--ink-muted)',
                      fontWeight: 600,
                      backgroundColor: 'var(--paper-dark)'
                    }}>
                      CAD Vector Workspace (Right)
                    </div>
                    <div style={{ flex: 1, position: 'relative' }}>
                      <ImporterCanvas
                        polylines={session.dxfData?.polylines || []}
                        lineEntities={session.dxfData?.lineEntities || []}
                        inserts={session.dxfData?.inserts || []}
                        textEntities={session.dxfData?.textEntities || []}
                        tolerances={tolerances}
                        unitName={session.dxfData?.unitName || 'inches'}
                        unitScale={session.dxfData?.unitScale || 1.0}
                        pdfData={session.pdfData}
                        pdfOpacity={pdfOpacity}
                        calibrationStep={calibrationStep}
                        calibDxfPt1={calibDxfPt1}
                        calibDxfPt2={calibDxfPt2}
                        onDxfClick={handleDxfClick}
                        walls={session.elements?.walls || []}
                        openings={session.elements?.openings || []}
                        fixtures={session.elements?.fixtures || []}
                        rooms={session.elements?.rooms || []}
                        stairs={session.elements?.stairs || []}
                        exceptions={session.exceptions || []}
                        focusedCoordinates={focusedCoordinates}
                      />
                    </div>
                  </div>
                </div>
              </main>
            ) : (
              /* STANDARD FULL-WIDTH DXF WORKSPACE */
              <main style={{ flex: 1, height: '100%', position: 'relative' }}>
                <ImporterCanvas
                  polylines={session.dxfData?.polylines || []}
                  lineEntities={session.dxfData?.lineEntities || []}
                  inserts={session.dxfData?.inserts || []}
                  textEntities={session.dxfData?.textEntities || []}
                  tolerances={tolerances}
                  unitName={session.dxfData?.unitName || 'inches'}
                  unitScale={session.dxfData?.unitScale || 1.0}
                  pdfData={session.pdfData}
                  pdfOpacity={pdfOpacity}
                  walls={session.elements?.walls || []}
                  openings={session.elements?.openings || []}
                  fixtures={session.elements?.fixtures || []}
                  rooms={session.elements?.rooms || []}
                  stairs={session.elements?.stairs || []}
                  exceptions={session.exceptions || []}
                  focusedCoordinates={focusedCoordinates}
                />
              </main>
            )}
          </>
        )}

      </div>
    </div>
  );
}
