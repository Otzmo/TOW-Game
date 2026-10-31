import { woundsPerModel } from './score';
import { isSkirmish, unitFootprint } from './store';
import type { UnitState } from './types';

/**
 * Formation ändert ihre Tiefe (Modelle verloren, Front breiter …): die Front bleibt an derselben Stelle,
 * nur das hintere Ende rückt nach. Gibt den Patch mit verschobener Mitte zurück.
 */
export function keepFront(u: UnitState, units: Record<string, UnitState>, patch: Partial<UnitState>): Partial<UnitState> {
  if (isSkirmish(u)) return patch;
  const before = unitFootprint(u, units).h;
  const after = unitFootprint({ ...u, ...patch }, units).h;
  const shift = (after - before) / 2;
  if (Math.abs(shift) < 1e-6) return patch;
  // In Einheitsrichtung nach hinten (+y lokal)
  return { ...patch, x: u.x - Math.sin(u.rotation) * shift, y: u.y + Math.cos(u.rotation) * shift };
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
