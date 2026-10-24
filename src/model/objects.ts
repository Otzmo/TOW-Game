import type { BoardObject, ObjectKind, Point } from './types';

/** Eintrag im Katalog: wie ein Objekt aussieht und wie groß es neu ist (Zoll). */
export interface ObjectType {
  kind: ObjectKind;
  name: string;
  shape: 'ellipse' | 'rect' | 'circle' | 'flame';
  w: number;
  h: number;
  fill: number;
  stroke: number;
  alpha: number;
  /** Sichtlinie: blockiert (Zonengelände nach OTZMO-TOW) oder gibt nur Deckung */
  sight?: 'blocks' | 'cover';
  /** Geländeregeln (OTZMO-TOW Core Battle, Terrain Rules) */
  rules?: string[];
  /** Kurzzeichen auf Markern */
  icon?: string;
  /** Größe ist durch die Regeln festgelegt (Schablonen, Missionsziele) */
  fixedSize?: boolean;
}

const COVER = 'Cover (−1 to hit)';
const FAR = 'Cannon fire stops at the far edge';

export const OBJECT_TYPES: Record<string, ObjectType> = {
  // Gelände: Maße und Eigenschaften wie in OTZMO-TOW (Core Battle)
  woods: { kind: 'terrain', name: 'Woods', shape: 'rect', w: 6, h: 10, fill: 0x3d6b2c, stroke: 0x1f3a16, alpha: 0.9, sight: 'blocks',
    rules: ['Difficult Terrain', COVER, FAR, 'Natural Terrain'] },
  building: { kind: 'terrain', name: 'Building', shape: 'rect', w: 6, h: 8, fill: 0x8a4a1e, stroke: 0x3a1e0a, alpha: 0.95, sight: 'blocks',
    rules: ['Impassable', 'Cannon fire stops at the near edge'] },
  hill: { kind: 'terrain', name: 'Hill', shape: 'rect', w: 8, h: 6, fill: 0x8f7140, stroke: 0x5a4524, alpha: 0.8, sight: 'blocks',
    rules: ['Two ranks may shoot', FAR] },
  ruins: { kind: 'terrain', name: 'Ruins', shape: 'rect', w: 7, h: 7, fill: 0x6b645a, stroke: 0x2f2b26, alpha: 0.9, sight: 'blocks',
    rules: [COVER, 'Difficult Terrain', 'Dangerous Terrain', FAR] },
  field: { kind: 'terrain', name: 'Field', shape: 'rect', w: 6, h: 8, fill: 0xb59b4e, stroke: 0x6e5c28, alpha: 0.85, sight: 'blocks',
    rules: [COVER, FAR] },
  lake: { kind: 'terrain', name: 'Lake', shape: 'rect', w: 6, h: 10, fill: 0x3d6f9a, stroke: 0x1f3f5a, alpha: 0.85, sight: 'blocks',
    rules: ['Difficult Terrain', 'Dangerous Terrain', FAR, 'Natural Terrain'] },
  wall: { kind: 'terrain', name: 'Wall / Hedge', shape: 'rect', w: 8, h: 0.6, fill: 0x8a8a80, stroke: 0x4a4a44, alpha: 0.95, sight: 'cover',
    rules: ['Low linear obstacle'] },
  // Marker
  objective: { kind: 'marker', name: 'Objective', shape: 'circle', w: 40 / 25.4, h: 40 / 25.4, fill: 0xe0b44c, stroke: 0x3a2a00, alpha: 1, icon: '★', fixedSize: true },
  disrupted: { kind: 'marker', name: 'Disrupted', shape: 'circle', w: 1.2, h: 1.2, fill: 0xf0603e, stroke: 0x3a0a00, alpha: 1, icon: 'D' },
  spell: { kind: 'marker', name: 'Spell', shape: 'circle', w: 1.2, h: 1.2, fill: 0x8a5cd6, stroke: 0x241040, alpha: 1, icon: '✦' },
  wound: { kind: 'marker', name: 'Wound', shape: 'circle', w: 1, h: 1, fill: 0xb3261e, stroke: 0x2a0000, alpha: 1, icon: '+' },
  note: { kind: 'marker', name: 'Note', shape: 'circle', w: 1.2, h: 1.2, fill: 0xd8dccf, stroke: 0x333333, alpha: 1, icon: '!' },
  // Schablonen
  smallBlast: { kind: 'template', name: 'Small blast template (3″)', shape: 'circle', w: 3, h: 3, fill: 0xf0603e, stroke: 0xf0603e, alpha: 0.25, fixedSize: true },
  largeBlast: { kind: 'template', name: 'Large blast template (5″)', shape: 'circle', w: 5, h: 5, fill: 0xf0603e, stroke: 0xf0603e, alpha: 0.25, fixedSize: true },
  flame: { kind: 'template', name: 'Flame template', shape: 'flame', w: 3, h: 8, fill: 0xf08a3e, stroke: 0xf08a3e, alpha: 0.3, fixedSize: true },
};

export const typesOfKind = (kind: ObjectKind) => Object.entries(OBJECT_TYPES).filter(([, t]) => t.kind === kind);

export function newObject(type: string, at: Point): BoardObject {
  const t = OBJECT_TYPES[type];
  return {
    id: `${t.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: t.kind, type, x: at.x, y: at.y, w: t.w, h: t.h, rotation: 0, label: null,
  };
}

/** Ein neues Spiel beginnt ohne Gelände; es wird in der Aufbauphase gesetzt oder ausgewürfelt. */
export function defaultTerrain(): Record<string, BoardObject> {
  return {};
}

/** Umriss eines Objekts auf dem Tisch als Polygon (Zoll). Ellipsen und Kreise werden angenähert. */
export function objectPolygon(o: BoardObject): Point[] {
  const t = OBJECT_TYPES[o.type];
  const local: Point[] = [];
  if (t?.shape === 'rect') {
    local.push({ x: -o.w / 2, y: -o.h / 2 }, { x: o.w / 2, y: -o.h / 2 }, { x: o.w / 2, y: o.h / 2 }, { x: -o.w / 2, y: o.h / 2 });
  } else if (t?.shape === 'flame') {
    local.push(...flameOutline(o.w, o.h));
  } else {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      local.push({ x: (Math.cos(a) * o.w) / 2, y: (Math.sin(a) * o.h) / 2 });
    }
  }
  const c = Math.cos(o.rotation);
  const s = Math.sin(o.rotation);
  return local.map((p) => ({ x: o.x + p.x * c - p.y * s, y: o.y + p.x * s + p.y * c }));
}

/** Tropfenform der Flammenschablone: Spitze vorn (−y), runder Kopf hinten. */
export function flameOutline(w: number, h: number): Point[] {
  const r = w / 2;
  const pts: Point[] = [{ x: 0, y: -h / 2 }];
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI - (i / 12) * Math.PI;
    pts.push({ x: Math.cos(a) * r, y: h / 2 - r + Math.sin(a) * r });
  }
  return pts;
}

/** Schneidet die Strecke a–b das Polygon (oder liegt sie darin)? */
export function segmentHitsPolygon(a: Point, b: Point, poly: Point[]): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return false;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
