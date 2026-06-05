import { get, set, del } from 'idb-keyval';
import { ParsedDXF } from '../dxf/parser';

export interface AffineTransform {
  s: number;
  theta: number;
  tx: number;
  ty: number;
}

export interface ClosedWallPolygon {
  id: number;
  layer: string;
  vertices: { x: number; y: number }[];
  bearing: boolean;
  material: 'wood' | 'masonry' | 'none';
  height: 'full' | 'half';
  thickness: number;
  area: number;
  perimeter: number;
  exceptions?: string[];
}

export interface ExplicitOpening {
  id: number;
  type: 'door' | 'window';
  layer: string;
  x: number;
  y: number;
  width: number;
  associatedWallId?: number;
}

export interface Fixture {
  id: number;
  type: 'toilet' | 'sink' | 'tub' | 'other';
  layer: string;
  x: number;
  y: number;
  blockName: string;
}

export interface RoomInstance {
  id: number;
  name: string;
  x: number;
  y: number;
  area?: number;
  ceilingHeight?: string;
  dimensions?: string;
}

export interface StairInstance {
  id: number;
  x: number;
  y: number;
  treads: number;
  width: number;
  length: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  confidence: 'high' | 'medium' | 'low';
  layer?: string;
}

export interface ExceptionItem {
  id: string;
  type: 'gap' | 'unresolved-mapping' | 'missing-stair' | 'missing-toilet' | 'generic';
  title: string;
  description: string;
  location?: { x: number; y: number };
  refId?: string | number; // e.g. wallId, blockName, layerName
  resolved: boolean;
  resolution?: any;
}

export interface MappingEntry {
  sourceType: 'layer' | 'block' | 'hatch-pattern';
  sourceName: string;
  canonicalCategory: 'WALL' | 'POCHE' | 'FIX' | 'DOOR' | 'WIN' | 'RMNAME' | 'STAIR' | 'JUNK' | 'ROOF' | 'GRID' | 'REVIEW';
  attributes?: {
    bearing?: boolean;
    material?: 'wood' | 'masonry' | 'none';
    height?: 'full' | 'half';
  };
  provenance: 'deterministic' | 'ai-suggested' | 'human-confirmed';
  scope: 'global';
  firmId?: string;
  timestamp: number;
}

export type MappingDictionary = Record<string, MappingEntry>;

export interface ManualWallOverride {
  centroidX: number;
  centroidY: number;
  bearing?: boolean;
  deleted?: boolean;
}

export interface ManualFixtureOverride {
  x: number;
  y: number;
  type?: 'toilet' | 'sink' | 'tub' | 'other';
  deleted?: boolean;
}

export interface ManualOverrides {
  walls?: ManualWallOverride[];
  fixtures?: ManualFixtureOverride[];
}

export interface ImporterSession {
  id: string;
  fileName: string;
  lastUpdated: number;
  currentStep: 1 | 2 | 3;
  dxfData: ParsedDXF | null;
  pdfData: {
    imageUri: string | null;
    transformMatrix: AffineTransform | null;
    width?: number;
    height?: number;
    totalPages?: number;
    pdfFileName?: string;
  };
  mappings: MappingDictionary;
  elements: {
    walls: ClosedWallPolygon[];
    openings: ExplicitOpening[];
    fixtures: Fixture[];
    rooms: RoomInstance[];
    stairs: StairInstance[];
  };
  exceptions: ExceptionItem[];
  signOffs: Record<string, boolean>;
  tolerances: {
    snap: number;      // T_snap (native units)
    prune: number;     // T_prune (native units)
    wMin: number;      // W_min (native units)
    wMax: number;      // W_max (native units)
    maxBBoxFt: number; // Maximum building footprint width check (in feet, e.g. 400)
    maxWallVertices: number; // Maximum allowed vertices for a wall loop
    maxWallAreaSqFt: number; // Maximum allowed area for a wall loop in sq ft
  };
  manualOverrides?: ManualOverrides;
}


const SESSION_KEY_PREFIX = 'archs-importer-session-';

export async function saveSession(session: ImporterSession): Promise<void> {
  const updated = { ...session, lastUpdated: Date.now() };
  await set(`${SESSION_KEY_PREFIX}${session.id}`, updated);
  await set('archs-importer-active-session-id', session.id);
}

export async function getSession(id: string): Promise<ImporterSession | null> {
  try {
    const session = await get<ImporterSession>(`${SESSION_KEY_PREFIX}${id}`);
    return session || null;
  } catch (e) {
    console.error('Failed to get session from IndexedDB:', e);
    return null;
  }
}

export async function getActiveSession(): Promise<ImporterSession | null> {
  try {
    const activeId = await get<string>('archs-importer-active-session-id');
    if (!activeId) return null;
    return getSession(activeId);
  } catch (e) {
    console.error('Failed to get active session ID from IndexedDB:', e);
    return null;
  }
}

export async function clearSession(id: string): Promise<void> {
  try {
    await del(`${SESSION_KEY_PREFIX}${id}`);
    const activeId = await get<string>('archs-importer-active-session-id');
    if (activeId === id) {
      await del('archs-importer-active-session-id');
    }
  } catch (e) {
    console.error('Failed to clear session from IndexedDB:', e);
  }
}
