import { polyDistance, slotPolygons } from './contact';
import { unitWeapons, type WeaponProfile } from './gear';
import { OBJECT_TYPES, objectPolygon, pointInPolygon } from './objects';
import { isJoined, isSkirmish, unitFootprint } from './store';
import type { BoardObject, Point, UnitState } from './types';

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

/** Ein von der Kanonenkugel getroffenes Modell */
export interface CannonHitModel {
  key: string;
  /** Name und id, wenn es ein angeschlossener Charakter ist */
  character?: string;
  characterId?: string;
  poly: Point[];
}

export interface CannonResult {
  hits: { unit: UnitState; models: CannonHitModel[] }[];
  /** Wo der Abprall wirklich endet (Gelände oder ein Monster kann ihn vorher stoppen) */
  end: Point;
  /** Was die Kugel gestoppt hat */
  stop: string | null;
}

/** Parameter (0…1), an denen die Strecke a–b das Polygon betritt und verlässt; null ohne Berührung */
function crossing(a: Point, b: Point, poly: Point[]): { enter: number; exit: number } | null {
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const den = (b.x - a.x) * (q.y - p.y) - (b.y - a.y) * (q.x - p.x);
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - a.x) * (q.y - p.y) - (p.y - a.y) * (q.x - p.x)) / den;
    const u = ((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
  }
  const startIn = pointInPolygon(a, poly);
  const endIn = pointInPolygon(b, poly);
  if (!ts.length && !startIn) return null;
  return { enter: startIn ? 0 : Math.min(...ts), exit: endIn ? 1 : Math.max(...ts) };
}

/**
 * Kanonenschuss nach "Cannon Fire": Jedes Modell unter dem Aufschlagpunkt ist getroffen, dazu jedes Modell auf der
 * Abprallstrecke – bei einer Einheit in Formation aber höchstens eines je Glied (Kanone im Front- oder Rückenbereich)
 * bzw. je Reihe (Kanone im Flankenbereich). Ein Monstrous Creature oder Behemoth stoppt die Kugel, ebenso Gelände
 * nach seinen Regeln (OTZMO: Gebäude an der nahen Kante, Wald, Hügel … an der fernen Kante).
 */
export function cannonShot(cannon: Point, strike: Point, end: Point, units: Record<string, UnitState>,
  objects: Record<string, BoardObject>, skip?: string): CannonResult {
  let stop: string | null = null;
  let cut = 1;
  const moving = Math.hypot(end.x - strike.x, end.y - strike.y) > 1e-9;
  // Gelände auf der Abprallstrecke
  if (moving) {
    for (const o of Object.values(objects)) {
      const rules = OBJECT_TYPES[o.type]?.rules ?? [];
      const near = rules.some((r) => /cannon fire stops at the near edge/i.test(r));
      const far = rules.some((r) => /cannon fire stops at the far edge/i.test(r));
      if (o.kind !== 'terrain' || (!near && !far)) continue;
      const c = crossing(strike, end, objectPolygon(o));
      if (!c) continue;
      const at = near ? c.enter : c.exit;
      if (at < 1 - 1e-9 && at < cut) {
        cut = at;
        stop = `${o.label || OBJECT_TYPES[o.type].name} (${near ? 'near' : 'far'} edge)`;
      }
    }
  }
  const len = Math.hypot(end.x - strike.x, end.y - strike.y);
  const dir = moving ? { x: (end.x - strike.x) / len, y: (end.y - strike.y) / len } : { x: 0, y: 0 };
  let stopAt = cut * len;
  const pathEnd = { x: strike.x + dir.x * stopAt, y: strike.y + dir.y * stopAt };

  // Alle Bases unter Aufschlagpunkt oder Strecke, sortiert nach Abstand vom Aufschlagpunkt
  type Cand = { unit: UnitState; key: string; slotX: number; slotY: number; character?: UnitState; poly: Point[]; t: number };
  const cands: Cand[] = [];
  for (const u of Object.values(units)) {
    if (u.id === skip || isJoined(u, units) || u.ambush || u.status === 'destroyed' || u.status === 'fledOff') continue;
    for (const { slot, poly } of slotPolygons(u, units)) {
      const onStrike = pointInPolygon(strike, poly);
      const c = moving && stopAt > 1e-9 ? crossing(strike, pathEnd, poly) : null;
      if (!onStrike && !c) continue;
      cands.push({ unit: u, key: slot.key, slotX: slot.x, slotY: slot.y, character: slot.charId ? units[slot.charId] : undefined,
        poly, t: onStrike ? -1 : (c!.enter * stopAt) });
    }
  }
  cands.sort((a, b) => a.t - b.t);
  // Monster und Behemoths stoppen die Kugel
  const big = cands.find((c) => /monstrous creature|behemoth/i.test((c.character ?? c.unit).info.troopType));
  if (big && big.t < stopAt) {
    stopAt = Math.max(0, big.t);
    stop = `${(big.character ?? big.unit).info.name} (${(big.character ?? big.unit).info.troopType})`;
  }
  const reached = cands.filter((c) => c.t <= stopAt + 1e-9);

  // Je Einheit: in Formation ein Modell je Glied bzw. Reihe
  const hits: CannonResult['hits'] = [];
  for (const u of new Set(reached.map((c) => c.unit))) {
    const mine = reached.filter((c) => c.unit === u);
    let chosen = mine;
    if (!isSkirmish(u)) {
      const { w, h } = unitFootprint(u, units);
      const cos = Math.cos(-u.rotation);
      const sin = Math.sin(-u.rotation);
      const lx = (cannon.x - u.x) * cos - (cannon.y - u.y) * sin;
      const ly = (cannon.x - u.x) * sin + (cannon.y - u.y) * cos;
      // Front-/Rückenbereich: zwischen den Diagonalen durch die Ecken
      const frontRear = Math.abs(ly) - h / 2 >= Math.abs(lx) - w / 2;
      const groups = new Map<number, Cand>();
      for (const c of mine) {
        const g = Math.round((frontRear ? c.slotY : c.slotX) * 100);
        if (!groups.has(g)) groups.set(g, c);
      }
      chosen = [...groups.values()];
    }
    hits.push({ unit: u, models: chosen.map((c) => ({ key: c.key, character: c.character?.info.name, characterId: c.character?.id, poly: c.poly })) });
  }
  return { hits, end: { x: strike.x + dir.x * stopAt, y: strike.y + dir.y * stopAt }, stop };
}
