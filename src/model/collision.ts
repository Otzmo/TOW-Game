import { contactPose } from './flow';
import { isJoined, unitFootprint } from './store';
import type { Point, UnitState } from './types';

/** Zoll: Berühren ist erlaubt, Überlappen nicht */
const TOUCH = 0.02;

export type Pose = Pick<UnitState, 'x' | 'y' | 'rotation'>;

/** Ecken der Einheit auf dem Tisch (gedrehtes Rechteck um ihre Mitte) */
function corners(u: UnitState, units: Record<string, UnitState>): Point[] {
  const { w, h } = unitFootprint(u, units);
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const lx = (a * w) / 2;
    const ly = (b * h) / 2;
    return { x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c };
  });
}

/** Überlappen sich zwei gedrehte Rechtecke? (Trennachsen: die Kantenrichtungen beider Rechtecke) */
function overlap(a: Point[], b: Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const p = poly[i];
      const q = poly[i + 1];
      const axis = { x: -(q.y - p.y), y: q.x - p.x };
      const len = Math.hypot(axis.x, axis.y) || 1;
      const proj = (pts: Point[]) => pts.map((v) => (v.x * axis.x + v.y * axis.y) / len);
      const pa = proj(a);
      const pb = proj(b);
      if (Math.max(...pa) - Math.min(...pb) <= TOUCH || Math.max(...pb) - Math.min(...pa) <= TOUCH) return false;
    }
  }
  return true;
}

/** Einheiten, mit denen u überlappt (angeschlossene Charaktere, Vernichtete und Geflohene zählen nicht) */
export function overlappingUnits(u: UnitState, units: Record<string, UnitState>): UnitState[] {
  const mine = corners(u, units);
  return Object.values(units).filter((t) => t.id !== u.id && t.joinedTo !== u.id && !isJoined(t, units)
    && t.status !== 'destroyed' && t.status !== 'fledOff' && overlap(mine, corners(t, units)));
}

/**
 * Einheiten stehen nie übereinander. Landet u auf einer gegnerischen Einheit, wird sie bündig an deren
 * nächste Kante angelegt (dort, wo losgelassen wurde, sonst zur Startposition hin); geht das nicht oder ist
 * es eine eigene Einheit, bleibt sie an der Startposition. Ohne Überlappung: null.
 */
export function keepApart(u: UnitState, units: Record<string, UnitState>, start: Pose): { pose: Pose; note: string } | null {
  const hit = overlappingUnits(u, units);
  if (!hit.length) return null;
  const enemy = hit.find((t) => t.owner !== u.owner);
  if (enemy) {
    // Erst die Kante dort, wo losgelassen wurde, dann die zur Startposition
    for (const from of [u, { ...u, x: start.x, y: start.y }]) {
      const contact = contactPose(from, enemy, units);
      const pose = { x: contact.x, y: contact.y, rotation: contact.rotation };
      if (!overlappingUnits({ ...u, ...pose }, units).length) {
        return { pose, note: `in contact with ${enemy.info.name} (${contact.side})` };
      }
    }
  }
  return { pose: start, note: 'units may not overlap – moved back' };
}
