import { polyDistance, slotPolygons } from './contact';
import { unitWeapons, type WeaponProfile } from './gear';
import { pointInPolygon, segmentHitsPolygon } from './objects';
import { isJoined, unitFootprint } from './store';
import type { Point, UnitState } from './types';

/** Wie eine Kriegsmaschine schießt: Cannon Fire, Bombardment (Schablone) oder Needs More Nails (Grapeshot) */
export type WarMachineMode = 'cannon' | 'bombard' | 'grapeshot';

export interface WarMachineWeapon {
  mode: WarMachineMode;
  /** Profilname, z. B. "Great Cannon" */
  name: string;
  profile: WeaponProfile;
  min: number;
  max: number;
  /** Bombardment: Schablone 3″ oder 5″ */
  template: 3 | 5;
  misfire: 'black-powder' | 'stone-thrower';
}

/** Grapeshot-Profil für Kanonen (fehlt es in den Daten, gilt das Profil aus dem Regelwerk) */
const GRAPESHOT: WeaponProfile = { name: 'Grapeshot', range: '12"', strength: '4', ap: '-1', rules: ['Needs More Nails'], notes: '' };

/** "12-48\"" → 12 und 48, "60\"" → 0 und 60 */
function rangeOf(range: string): { min: number; max: number } {
  const both = /(\d+)\s*-\s*(\d+)/.exec(range);
  if (both) return { min: Number(both[1]), max: Number(both[2]) };
  const one = /(\d+)/.exec(range);
  return { min: 0, max: one ? Number(one[1]) : 0 };
}

/** Schießarten einer Einheit, die nach den Kriegsmaschinenregeln schießen (ohne BF) */
export function warMachineWeapons(u: UnitState): WarMachineWeapon[] {
  const out: WarMachineWeapon[] = [];
  for (const w of unitWeapons(u.info)) {
    for (const p of w.profiles) {
      const has = (re: RegExp) => p.rules.some((r) => re.test(r));
      const misfire = has(/stone thrower misfire/i) ? 'stone-thrower' : 'black-powder';
      const template = /5["″]\s*blast template/i.test(w.text) ? 5 : 3;
      const base = { name: p.name, profile: p, template, misfire, ...rangeOf(p.range) } as const;
      if (has(/^cannon fire$/i)) {
        out.push({ ...base, mode: 'cannon' });
        // Schwarzpulverkanonen können stattdessen Grapeshot feuern
        if (has(/black powder misfire/i)) out.push({ ...base, mode: 'grapeshot', name: 'Grapeshot', profile: GRAPESHOT, min: 0, max: 12 });
      } else if (has(/^bombardment$/i)) out.push({ ...base, mode: 'bombard' });
      else if (has(/^needs more nails$/i)) out.push({ ...base, mode: 'grapeshot' });
    }
  }
  return out;
}

/** Ergebnis auf der Misfire-Tabelle (W6) */
export function misfireResult(table: WarMachineWeapon['misfire'], d6: number): string {
  if (d6 === 1) return 'Destroyed – the war machine is destroyed and removed from play.';
  if (d6 <= 4) return 'Malfunction – the crew loses one Wound; the machine does not shoot this turn and cannot shoot before the end of the next round.';
  return `${table === 'stone-thrower' ? 'Twang!' : 'Pffft!'} – the machine does not shoot this turn.`;
}

/** Kürzester Abstand von der Kriegsmaschine zu den Bases einer Einheit (Zoll) */
export function distanceToUnit(from: UnitState, to: UnitState, units: Record<string, UnitState>): number {
  const { w, h } = unitFootprint(from, units);
  const c = Math.cos(from.rotation);
  const s = Math.sin(from.rotation);
  const mine = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => ({ x: from.x + x * c - y * s, y: from.y + x * s + y * c }));
  return Math.min(...slotPolygons(to, units).map((b) => polyDistance(mine, b.poly)));
}

/** Punkt dist Zoll weiter auf der Linie von from über to hinaus */
export function beyond(from: Point, to: Point, dist: number): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: to.x + ((to.x - from.x) / len) * dist, y: to.y + ((to.y - from.y) / len) * dist };
}

/**
 * Einheiten unter der Kanonenkugel: Bases unter dem Aufschlagpunkt oder auf der Abprallstrecke.
 * Ergebnis je Einheit die Zahl der berührten Bases (getroffen wird höchstens ein Modell je Glied bzw. Reihe).
 */
export function cannonPath(strike: Point, end: Point, units: Record<string, UnitState>, skip?: string):
  { unit: UnitState; bases: number }[] {
  const out: { unit: UnitState; bases: number }[] = [];
  for (const u of Object.values(units)) {
    if (u.id === skip || isJoined(u, units) || u.ambush || u.status === 'destroyed' || u.status === 'fledOff') continue;
    const bases = slotPolygons(u, units).filter(({ poly }) => pointInPolygon(strike, poly)
      || (end.x !== strike.x || end.y !== strike.y ? segmentHitsPolygon(strike, end, poly) : false)).length;
    if (bases) out.push({ unit: u, bases });
  }
  return out;
}
