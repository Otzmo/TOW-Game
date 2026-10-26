import { objectPolygon, pointInPolygon, segmentHitsPolygon } from './objects';
import { isJoined, unitLayout } from './store';
import type { BoardObject, Point, UnitState } from './types';

/** Eine getroffene Base: ihre Ecken auf dem Tisch und ob sie ganz unter der Schablone liegt */
export interface TemplateHit {
  corners: Point[];
  whole: boolean;
}

/** Alle Bases auf dem Tisch als Vierecke (Zoll). Vernichtete, geflohene und Einheiten im Hinterhalt fehlen. */
export function basesOnTable(units: Record<string, UnitState>): Point[][] {
  const bases: Point[][] = [];
  for (const u of Object.values(units)) {
    if (isJoined(u, units) || u.ambush || u.status === 'destroyed' || u.status === 'fledOff') continue;
    const c = Math.cos(u.rotation);
    const s = Math.sin(u.rotation);
    for (const sl of unitLayout(u, units).slots) {
      bases.push([[sl.x, sl.y], [sl.x + sl.w, sl.y], [sl.x + sl.w, sl.y + sl.d], [sl.x, sl.y + sl.d]]
        .map(([lx, ly]) => ({ x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c })));
    }
  }
  return bases;
}

/**
 * Modelle unter einer Schablone: ganz darunter (full) oder nur teilweise berührt (partial).
 * @param bases aus basesOnTable, damit mehrere Schablonen sie sich teilen können
 */
export function templateHits(o: BoardObject, bases: Point[][]): { full: number; partial: number; hits: TemplateHit[] } {
  const poly = objectPolygon(o);
  const hits: TemplateHit[] = [];
  for (const b of bases) {
    const inside = b.filter((p) => pointInPolygon(p, poly)).length;
    const touched = inside > 0 || pointInPolygon(poly[0], b) || b.some((p, i) => segmentHitsPolygon(p, b[(i + 1) % 4], poly));
    if (touched) hits.push({ corners: b, whole: inside === 4 });
  }
  const full = hits.filter((h) => h.whole).length;
  return { full, partial: hits.length - full, hits };
}
