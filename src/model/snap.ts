import { isJoined, isSkirmish, unitFootprint } from './store';
import type { UnitState } from './types';

/** Bis zu diesem Abstand (oder dieser Überlappung) rasten Einheiten aneinander (Zoll) */
export const SNAP_DISTANCE = 1;
/** Bis zu diesem Winkelunterschied werden sie parallel ausgerichtet (Bogenmaß, 20°) */
const SNAP_ANGLE = (20 * Math.PI) / 180;

const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Einheit an eine benachbarte Einheit anlegen: Steht eine Kante höchstens SNAP_DISTANCE von einer Kante einer anderen
 * Einheit entfernt (oder überlappt sie so wenig) und sind beide fast parallel, wird die Einheit parallel ausgerichtet
 * und bündig an diese Kante geschoben; entlang der Kante bleibt sie, wo sie losgelassen wurde.
 * Ergebnis: neue Lage und die Einheit, an der sie anliegt – oder null.
 */
export function snapTogether(u: UnitState, units: Record<string, UnitState>):
  { pose: Pick<UnitState, 'x' | 'y' | 'rotation'>; to: UnitState } | null {
  if (isSkirmish(u) || isJoined(u, units)) return null;
  const me = unitFootprint(u, units);
  let best: { pose: Pick<UnitState, 'x' | 'y' | 'rotation'>; to: UnitState; gap: number } | null = null;
  for (const t of Object.values(units)) {
    if (t.id === u.id || t.joinedTo === u.id || isJoined(t, units) || isSkirmish(t) || t.ambush
      || t.status === 'destroyed' || t.status === 'fledOff') continue;
    // Nächste Ausrichtung in 90°-Schritten zur anderen Einheit
    const quarter = Math.round(norm(u.rotation - t.rotation) / (Math.PI / 2));
    const rotation = t.rotation + quarter * (Math.PI / 2);
    if (Math.abs(norm(u.rotation - rotation)) > SNAP_ANGLE) continue;
    // Im Koordinatensystem der anderen Einheit: beide als achsenparallele Rechtecke
    const c = Math.cos(-t.rotation);
    const s = Math.sin(-t.rotation);
    const lx = (u.x - t.x) * c - (u.y - t.y) * s;
    const ly = (u.x - t.x) * s + (u.y - t.y) * c;
    const them = unitFootprint(t, units);
    const sideways = Math.abs(quarter) % 2 === 1;
    const hw = (sideways ? me.h : me.w) / 2;
    const hh = (sideways ? me.w : me.h) / 2;
    const overlapX = Math.min(lx + hw, them.w / 2) - Math.max(lx - hw, -them.w / 2);
    const overlapY = Math.min(ly + hh, them.h / 2) - Math.max(ly - hh, -them.h / 2);
    // Abstand der Kanten: positiv = Lücke, negativ = Überlappung
    const gapX = Math.abs(lx) - hw - them.w / 2;
    const gapY = Math.abs(ly) - hh - them.h / 2;
    const options: { nx: number; ny: number; gap: number }[] = [];
    if (overlapY > 0.01 && Math.abs(gapX) <= SNAP_DISTANCE) options.push({ nx: Math.sign(lx || 1) * (hw + them.w / 2), ny: ly, gap: gapX });
    if (overlapX > 0.01 && Math.abs(gapY) <= SNAP_DISTANCE) options.push({ nx: lx, ny: Math.sign(ly || 1) * (hh + them.h / 2), gap: gapY });
    for (const o of options) {
      if (best && Math.abs(o.gap) >= Math.abs(best.gap)) continue;
      // zurück auf den Tisch
      const x = t.x + o.nx * Math.cos(t.rotation) - o.ny * Math.sin(t.rotation);
      const y = t.y + o.nx * Math.sin(t.rotation) + o.ny * Math.cos(t.rotation);
      best = { pose: { x, y, rotation }, to: t, gap: o.gap };
    }
  }
  return best ? { pose: best.pose, to: best.to } : null;
}
