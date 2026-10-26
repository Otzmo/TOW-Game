import { deploymentZones, missionByKey, TABLE_H, TABLE_W } from './battlefield';
import { pointInPolygon } from './objects';
import { woundsPerModel } from './score';
import { isJoined, joinedCharacters, unitFootprint } from './store';
import type { GameState, PlayerId, Point, UnitState } from './types';

/**
 * Missionswertung nach OTZMO-TOW (Core Battle): wer gerade welches Missionsziel hält, und wie viele
 * Siegpunkte das bei einer Wertung bringt. Gewertet wird von Hand per Knopf (Ende eines Spielerzugs
 * bzw. Spielende); die Punkte landen in den Missionspunkten.
 */

const PLAYERS: PlayerId[] = ['p1', 'p2'];

/** Unit Strength (Näherung): Lebenspunkte aller Modelle samt angeschlossener Charaktere */
export function unitStrength(u: UnitState, units: Record<string, UnitState>): number {
  return [u, ...joinedCharacters(u, units)].reduce((s, m) => s + Math.max(0, m.models) * woundsPerModel(m), 0);
}

/** Wertende Einheit: US 10+, kein Fly, nicht fliehend, vernichtet oder geflohen */
export function isScoring(u: UnitState, units: Record<string, UnitState>): boolean {
  if (isJoined(u, units) || u.status) return false;
  if (u.info.rules.some((r) => /^fly\b/i.test(r.name))) return false;
  return unitStrength(u, units) >= 10;
}

/** Ecken der Einheit auf dem Tisch */
function corners(u: UnitState, units: Record<string, UnitState>): Point[] {
  const { w, h } = unitFootprint(u, units);
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({
    x: u.x + (a * w) / 2 * c - (b * h) / 2 * s,
    y: u.y + (a * w) / 2 * s + (b * h) / 2 * c,
  }));
}

/** Abstand eines Punktes zur Fläche der Einheit (0 = darauf) */
function distanceTo(u: UnitState, units: Record<string, UnitState>, p: Point): number {
  const { w, h } = unitFootprint(u, units);
  const c = Math.cos(-u.rotation);
  const s = Math.sin(-u.rotation);
  const lx = (p.x - u.x) * c - (p.y - u.y) * s;
  const ly = (p.x - u.x) * s + (p.y - u.y) * c;
  return Math.hypot(Math.max(0, Math.abs(lx) - w / 2), Math.max(0, Math.abs(ly) - h / 2));
}

const completelyIn = (u: UnitState, units: Record<string, UnitState>, poly: Point[]) =>
  corners(u, units).every((p) => pointInPolygon(p, poly));

/** Wer hält ein Gebiet: mehr US wertender Einheiten; Gleichstand = niemand */
function controller(us: Record<PlayerId, number>): PlayerId | null {
  if (us.p1 === us.p2) return null;
  return us.p1 > us.p2 ? 'p1' : 'p2';
}

export interface MissionStatus {
  key: string;
  name: string;
  group: 'turn' | 'game';
  /** Siegpunkte je Spieler, wenn jetzt gewertet würde */
  vp: Record<PlayerId, number>;
  /** Erklärung je Ziel, z. B. "Location 2: Attacker" */
  lines: string[];
  /** Nicht automatisch prüfbar (z. B. Baggage Train) */
  manual?: boolean;
}

/** Stand der beiden gewürfelten Missionen, so als würde jetzt gewertet. */
export function missionStatus(state: GameState, name: (p: PlayerId) => string): MissionStatus[] {
  const { units, objects, meta } = state;
  const scoring = Object.values(units).filter((u) => isScoring(u, units));
  const zones = deploymentZones(meta.setup);
  const out: MissionStatus[] = [];
  for (const key of [meta.setup?.missionTurn, meta.setup?.missionGame]) {
    const m = missionByKey(key);
    if (!m) continue;
    const vp: Record<PlayerId, number> = { p1: 0, p2: 0 };
    const lines: string[] = [];
    const who = (p: PlayerId | null) => (p ? name(p) : 'nobody');
    if (m.key === 'locations') {
      const objs = Object.values(objects).filter((o) => o.type === 'objective');
      objs.forEach((o, i) => {
        const us = { p1: 0, p2: 0 };
        for (const u of scoring) if (distanceTo(u, units, o) <= 6) us[u.owner] += unitStrength(u, units);
        const c = controller(us);
        if (c) vp[c] += 30;
        lines.push(`Location ${o.label ?? i + 1}: ${who(c)} (US ${us.p1} : ${us.p2})`);
      });
    } else if (m.key === 'domination') {
      const quarters: [string, Point[]][] = [
        ['Top left', [{ x: 0, y: 0 }, { x: TABLE_W / 2, y: 0 }, { x: TABLE_W / 2, y: TABLE_H / 2 }, { x: 0, y: TABLE_H / 2 }]],
        ['Top right', [{ x: TABLE_W / 2, y: 0 }, { x: TABLE_W, y: 0 }, { x: TABLE_W, y: TABLE_H / 2 }, { x: TABLE_W / 2, y: TABLE_H / 2 }]],
        ['Bottom left', [{ x: 0, y: TABLE_H / 2 }, { x: TABLE_W / 2, y: TABLE_H / 2 }, { x: TABLE_W / 2, y: TABLE_H }, { x: 0, y: TABLE_H }]],
        ['Bottom right', [{ x: TABLE_W / 2, y: TABLE_H / 2 }, { x: TABLE_W, y: TABLE_H / 2 }, { x: TABLE_W, y: TABLE_H }, { x: TABLE_W / 2, y: TABLE_H }]],
      ];
      for (const [label, poly] of quarters) {
        const us = { p1: 0, p2: 0 };
        for (const u of scoring) if (completelyIn(u, units, poly)) us[u.owner] += unitStrength(u, units);
        const c = controller(us);
        if (c) vp[c] += 30;
        lines.push(`${label} quarter: ${who(c)} (US ${us.p1} : ${us.p2})`);
      }
    } else if (m.key === 'banners') {
      const count = { p1: 0, p2: 0 };
      for (const u of scoring) {
        const banner = u.info.command.includes('S') && !u.standardCaptured
          || joinedCharacters(u, units).some((c) => c.info.isBsb);
        if (banner && zones && !corners(u, units).some((p) => pointInPolygon(p, zones[u.owner]))) count[u.owner]++;
      }
      const c = controller(count);
      if (c) vp[c] += 90;
      lines.push(`Banners outside own zone: ${name('p1')} ${count.p1} · ${name('p2')} ${count.p2} → ${who(c)}`);
    } else if (m.key === 'ruin') {
      const ruin = Object.values(objects).find((o) => o.type === 'ruins'
        && Math.abs(o.x - TABLE_W / 2) < 0.5 && Math.abs(o.y - TABLE_H / 2) < 0.5);
      if (ruin) {
        const poly = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ({ x: ruin.x + (a * ruin.w) / 2, y: ruin.y + (b * ruin.h) / 2 }));
        const us = { p1: 0, p2: 0 };
        for (const u of scoring) if (completelyIn(u, units, poly)) us[u.owner] += unitStrength(u, units);
        const c = controller(us);
        if (c) vp[c] += 300;
        lines.push(`The Ruin: ${who(c)} (US ${us.p1} : ${us.p2})`);
      } else lines.push('No ruin in the centre of the table.');
    } else if (m.key === 'holdline') {
      for (const p of PLAYERS) {
        const enemyZone = zones?.[p === 'p1' ? 'p2' : 'p1'];
        const n = enemyZone ? scoring.filter((u) => u.owner === p && completelyIn(u, units, enemyZone)).length : 0;
        if (n >= 2) vp[p] += 300;
        lines.push(`${name(p)}: ${n} scoring unit${n === 1 ? '' : 's'} in the enemy zone`);
      }
    } else {
      lines.push('Score by hand: enter the points below.');
      out.push({ key: m.key, name: m.name, group: m.group, vp, lines, manual: true });
      continue;
    }
    out.push({ key: m.key, name: m.name, group: m.group, vp, lines });
  }
  return out;
}
