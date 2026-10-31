import { polyDistance } from './contact';
import { contactPoses } from './flow';
import { isJoined, isSkirmish, unitFootprint } from './store';
import type { Point, UnitState } from './types';

/** Bis zu diesem Abstand (oder bei Überlappung) rasten Einheiten an den Gegner (Zoll) */
export const SNAP_DISTANCE = 1;

const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Umriss einer Einheit auf dem Tisch (Rechteck um die Mitte) */
function outline(u: UnitState, w: number, h: number): Point[] {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => ({ x: u.x + x * c - y * s, y: u.y + x * s + y * c }));
}

/**
 * Einheit an eine gegnerische Einheit anlegen: Kommt sie ihr bis auf SNAP_DISTANCE nahe (oder überlappt sie), wird sie
 * – egal wie schräg sie steht – parallel zur gegnerischen Einheit ausgerichtet und bündig an die Kante geschoben, vor
 * der sie steht; entlang der Kante bleibt sie, wo sie losgelassen wurde. Eigene Einheiten rasten nicht ein.
 * Liegt sie mit ihrer Front an, wird wie beim Angriff maximiert: so viele Modelle wie möglich in Basekontakt
 * (auch Ecke an Ecke zählt), bei gleicher Zahl mit möglichst wenig seitlicher Verschiebung.
 * Ergebnis: neue Lage und die Einheit, an der sie anliegt – oder null.
 */
export function snapTogether(u: UnitState, units: Record<string, UnitState>):
  { pose: Pick<UnitState, 'x' | 'y' | 'rotation'>; to: UnitState } | null {
  if (isSkirmish(u) || isJoined(u, units)) return null;
  const me = unitFootprint(u, units);
  const mine = outline(u, me.w, me.h);
  let best: { pose: Pick<UnitState, 'x' | 'y' | 'rotation'>; to: UnitState; dist: number } | null = null;
  for (const t of Object.values(units)) {
    if (t.id === u.id || t.owner === u.owner || t.joinedTo === u.id || isJoined(t, units) || isSkirmish(t) || t.ambush
      || t.status === 'destroyed' || t.status === 'fledOff') continue;
    const them = unitFootprint(t, units);
    // Wirklicher Abstand der Umrisse (bei schräger Stellung zählt die nächste Ecke)
    const dist = polyDistance(mine, outline(t, them.w, them.h));
    if (dist > SNAP_DISTANCE || (best && dist >= best.dist)) continue;
    // Nächste Ausrichtung in 90°-Schritten zur gegnerischen Einheit
    const quarter = Math.round(norm(u.rotation - t.rotation) / (Math.PI / 2));
    const rotation = t.rotation + quarter * (Math.PI / 2);
    const sideways = Math.abs(quarter) % 2 === 1;
    const hw = (sideways ? me.h : me.w) / 2;
    const hh = (sideways ? me.w : me.h) / 2;
    // Mitte im Koordinatensystem des Gegners
    const c = Math.cos(-t.rotation);
    const s = Math.sin(-t.rotation);
    const lx = (u.x - t.x) * c - (u.y - t.y) * s;
    const ly = (u.x - t.x) * s + (u.y - t.y) * c;
    // Angelegt wird an der Seite mit dem größten Abstand der (ausgerichteten) Umrisse – dort trennen sie sich
    const byX = Math.abs(lx) - hw - them.w / 2 > Math.abs(ly) - hh - them.h / 2;
    const nx = byX ? Math.sign(lx || 1) * (hw + them.w / 2) : Math.max(-them.w / 2 - hw, Math.min(them.w / 2 + hw, lx));
    const ny = byX ? Math.max(-them.h / 2 - hh, Math.min(them.h / 2 + hh, ly)) : Math.sign(ly || 1) * (hh + them.h / 2);
    const x = t.x + nx * Math.cos(t.rotation) - ny * Math.sin(t.rotation);
    const y = t.y + nx * Math.sin(t.rotation) + ny * Math.cos(t.rotation);
    let pose = { x, y, rotation };
    // Front an der Kante? Dann die maximierte Stellung an dieser Kante (gleiche Wertung wie beim Angriff)
    const side = byX ? (lx < 0 ? 'left flank' : 'right flank') : (ly < 0 ? 'front' : 'rear');
    const maxed = contactPoses({ ...u, ...pose }, t, units).filter((q) => q.side === side)[0];
    if (maxed && Math.abs(norm(maxed.rotation - rotation)) < 0.01) pose = { x: maxed.x, y: maxed.y, rotation: maxed.rotation };
    best = { pose, to: t, dist };
  }
  return best ? { pose: best.pose, to: best.to } : null;
}
