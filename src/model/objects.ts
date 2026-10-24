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
  /** Sichtlinie: blockiert ganz oder gibt nur Deckung */
  sight?: 'blocks' | 'cover';
  /** Kurzzeichen auf Markern */
  icon?: string;
  /** Größe ist durch die Regeln festgelegt (Schablonen) */
  fixedSize?: boolean;
}

export const OBJECT_TYPES: Record<string, ObjectType> = {
  // Gelände
  forest: { kind: 'terrain', name: 'Wald', shape: 'ellipse', w: 10, h: 7, fill: 0x24401f, stroke: 0x18301a, alpha: 0.9, sight: 'cover' },
  hill: { kind: 'terrain', name: 'Hügel', shape: 'ellipse', w: 14, h: 8, fill: 0x6b6440, stroke: 0x8a8255, alpha: 0.55 },
  building: { kind: 'terrain', name: 'Gebäude', shape: 'rect', w: 6, h: 4, fill: 0x5a4a3a, stroke: 0x2e241b, alpha: 0.95, sight: 'blocks' },
  wall: { kind: 'terrain', name: 'Mauer / Hecke', shape: 'rect', w: 8, h: 0.6, fill: 0x8a8a80, stroke: 0x4a4a44, alpha: 0.95, sight: 'cover' },
  river: { kind: 'terrain', name: 'Fluss', shape: 'rect', w: 16, h: 3, fill: 0x2f5f86, stroke: 0x1f3f5a, alpha: 0.75 },
  marsh: { kind: 'terrain', name: 'Sumpf', shape: 'ellipse', w: 9, h: 6, fill: 0x4a5a3a, stroke: 0x34402a, alpha: 0.7 },
  // Marker
  objective: { kind: 'marker', name: 'Missionsziel', shape: 'circle', w: 1.6, h: 1.6, fill: 0xe0b44c, stroke: 0x3a2a00, alpha: 1, icon: '★' },
  disrupted: { kind: 'marker', name: 'Disrupted', shape: 'circle', w: 1.2, h: 1.2, fill: 0xf0603e, stroke: 0x3a0a00, alpha: 1, icon: 'D' },
  spell: { kind: 'marker', name: 'Zauber', shape: 'circle', w: 1.2, h: 1.2, fill: 0x8a5cd6, stroke: 0x241040, alpha: 1, icon: '✦' },
  wound: { kind: 'marker', name: 'Verwundung', shape: 'circle', w: 1, h: 1, fill: 0xb3261e, stroke: 0x2a0000, alpha: 1, icon: '+' },
  note: { kind: 'marker', name: 'Notiz', shape: 'circle', w: 1.2, h: 1.2, fill: 0xd8dccf, stroke: 0x333333, alpha: 1, icon: '!' },
  // Schablonen
  smallBlast: { kind: 'template', name: 'Kleine Schablone (3″)', shape: 'circle', w: 3, h: 3, fill: 0xf0603e, stroke: 0xf0603e, alpha: 0.25, fixedSize: true },
  largeBlast: { kind: 'template', name: 'Große Schablone (5″)', shape: 'circle', w: 5, h: 5, fill: 0xf0603e, stroke: 0xf0603e, alpha: 0.25, fixedSize: true },
  flame: { kind: 'template', name: 'Flammenschablone', shape: 'flame', w: 3, h: 8, fill: 0xf08a3e, stroke: 0xf08a3e, alpha: 0.3, fixedSize: true },
};

export const typesOfKind = (kind: ObjectKind) => Object.entries(OBJECT_TYPES).filter(([, t]) => t.kind === kind);

export function newObject(type: string, at: Point): BoardObject {
  const t = OBJECT_TYPES[type];
  return {
    id: `${t.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: t.kind, type, x: at.x, y: at.y, w: t.w, h: t.h, rotation: 0, label: null,
  };
}

/** Startgelände für ein neues Spiel. */
export function defaultTerrain(): Record<string, BoardObject> {
  const forest = { ...newObject('forest', { x: 20, y: 14 }), id: 'terrain-forest-1' };
  const hill = { ...newObject('hill', { x: 48, y: 30 }), id: 'terrain-hill-1' };
  return { [forest.id]: forest, [hill.id]: hill };
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
