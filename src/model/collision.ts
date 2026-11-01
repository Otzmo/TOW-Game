import { polyDistance } from './contact';
import { contactPose } from './flow';
import { isJoined, isSkirmish, unitFootprint, unitLayout } from './store';
import type { Point, UnitState } from './types';

/** Zoll: Berühren ist erlaubt, Überlappen nicht */
const TOUCH = 0.02;

export type Pose = Pick<UnitState, 'x' | 'y' | 'rotation'>;

/**
 * Fläche der Einheit als gedrehte Rechtecke auf dem Tisch: in geschlossener Formation eines je Glied
 * (so ist der freie Platz neben einem unvollständigen letzten Glied wirklich frei), bei Plänklern das
 * umschließende Rechteck.
 */
function areas(u: UnitState, units: Record<string, UnitState>): Point[][] {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  const rect = (x0: number, y0: number, x1: number, y1: number) =>
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([lx, ly]) => ({ x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c }));
  if (isSkirmish(u)) {
    const { w, h } = unitFootprint(u, units);
    return [rect(-w / 2, -h / 2, w / 2, h / 2)];
  }
  // Bases nach Gliedern (gleiches y) zusammenfassen
  const rows = new Map<number, { x0: number; x1: number; y0: number; y1: number }>();
  for (const sl of unitLayout(u, units).slots) {
    const key = Math.round(sl.y * 100);
    const r = rows.get(key);
    if (r) {
      r.x0 = Math.min(r.x0, sl.x); r.x1 = Math.max(r.x1, sl.x + sl.w); r.y1 = Math.max(r.y1, sl.y + sl.d);
    } else rows.set(key, { x0: sl.x, x1: sl.x + sl.w, y0: sl.y, y1: sl.y + sl.d });
  }
  return [...rows.values()].map((r) => rect(r.x0, r.y0, r.x1, r.y1));
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
  const mine = areas(u, units);
  return Object.values(units).filter((t) => t.id !== u.id && t.joinedTo !== u.id && !isJoined(t, units)
    && t.status !== 'destroyed' && t.status !== 'fledOff' && !t.ambush
    && areas(t, units).some((b) => mine.some((a) => overlap(a, b))));
}

/** Mindestabstand zu gegnerischen Einheiten, wenn man nicht mit ihnen im Nahkampf steht (Zoll) */
export const ENEMY_GAP = 1;

/**
 * Darf die Einheit so stehen? Nie auf einer anderen Einheit; und nie näher als ENEMY_GAP an einer gegnerischen
 * Einheit, außer sie steht im Nahkampf (in Basekontakt mit einem Gegner). Ergebnis: Grund oder null.
 * gap = false: nur Überlappen prüfen (im Aufbau stehen die Armeen im Niemandsland dicht an der Mittellinie).
 */
export function placementProblem(u: UnitState, units: Record<string, UnitState>, gap = true): string | null {
  if (isJoined(u, units) || u.ambush || u.status === 'destroyed' || u.status === 'fledOff') return null;
  const hit = overlappingUnits(u, units);
  if (hit.length) return `units may not overlap (${hit[0].info.name})`;
  if (!gap) return null;
  const mine = areas(u, units);
  const enemies = Object.values(units).filter((t) => t.owner !== u.owner && !isJoined(t, units) && !t.ambush
    && t.status !== 'destroyed' && t.status !== 'fledOff');
  const gaps = enemies.map((t) => ({ t, d: Math.min(...areas(t, units).flatMap((b) => mine.map((a) => polyDistance(a, b)))) }));
  if (gaps.some((g) => g.d <= TOUCH * 2)) return null;
  const near = gaps.filter((g) => g.d < ENEMY_GAP - 1e-6).sort((a, b) => a.d - b.d)[0];
  return near ? `must stay ${ENEMY_GAP}″ away from ${near.t.info.name} unless in base contact (${near.d.toFixed(2)}″)` : null;
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
