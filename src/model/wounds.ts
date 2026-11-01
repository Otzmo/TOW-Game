import { woundsPerModel } from './score';
import { isSkirmish, unitFootprint } from './store';
import type { UnitState } from './types';

/**
 * Formation ändert ihre Tiefe (Modelle verloren, Front breiter …): die Front bleibt an derselben Stelle,
 * nur das hintere Ende rückt nach. Wird ein einzelnes Glied durch Verluste schmaler (oder durch neue Modelle
 * breiter), bleibt ein Ende stehen – Verluste gehen am gewählten Ende weg (casualtiesFrom).
 * Gibt den Patch mit verschobener Mitte zurück.
 */
export function keepFront(u: UnitState, units: Record<string, UnitState>, patch: Partial<UnitState>): Partial<UnitState> {
  if (isSkirmish(u)) return patch;
  const before = unitFootprint(u, units);
  const after = unitFootprint({ ...u, ...patch }, units);
  // In Einheitsrichtung nach hinten (+y lokal)
  const back = (after.h - before.h) / 2;
  // Seitlich nur, wenn sich die Modellzahl ändert (Breite verstellen formiert bewusst um die Mitte)
  const side = patch.models !== undefined && patch.width === undefined
    ? ((after.w - before.w) / 2) * (u.casualtiesFrom === 'left' ? -1 : 1)
    : 0;
  if (Math.abs(back) < 1e-6 && Math.abs(side) < 1e-6) return patch;
  const cos = Math.cos(u.rotation);
  const sin = Math.sin(u.rotation);
  // lokal +x = (cos, sin), lokal +y = (−sin, cos)
  return { ...patch, x: u.x + cos * side - sin * back, y: u.y + sin * side + cos * back };
}

/** Steht die Einheit nur noch in einem Glied (geschlossen/offen, mehr als ein Modell)? */
export function singleRank(u: UnitState, units: Record<string, UnitState>): boolean {
  return !isSkirmish(u) && u.models > 1 && unitFootprint(u, units).ranks <= 1;
}

/**
 * Lebenspunkte verlieren (negativ: zurückbekommen): erst ein Modell ganz, dann das nächste; volle Modelle werden
 * entfernt, das letzte Modell bleibt mit allen Lebenspunkten verloren stehen (gilt dann als vernichtet).
 * Ergebnis: Patch (mit fester Front) und wie viele Modelle entfernt wurden.
 */
export function loseWounds(u: UnitState, units: Record<string, UnitState>, n: number): { patch: Partial<UnitState>; removed: number } {
  const per = woundsPerModel(u);
  let models = u.models;
  let lost = (u.woundsLost ?? 0) + n;
  while (lost >= per && models > 1) {
    models--;
    lost -= per;
  }
  lost = Math.max(0, Math.min(per, lost));
  return { patch: keepFront(u, units, { models, woundsLost: lost }), removed: u.models - models };
}
