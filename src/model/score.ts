import type { GameState, PlayerId, UnitState } from './types';

/**
 * Siegpunkte nach den „Common objectives“ des Matched Play Guide (tow.whfb.app):
 * - vernichtet oder vom Tisch geflohen: 100 % der Punkte
 * - flieht bei Spielende oder auf ≤ 25 % geschrumpft: 50 % (aufgerundet)
 * - gegnerischer General ausgeschaltet: +100, Armeestandartenträger: +50
 * - jede erbeutete Standarte: +50, gegnerische Armee gebrochen: +500
 * Die Werte gelten jeweils so, als würde das Spiel jetzt enden.
 */

export interface ScoreLine {
  unitId?: string;
  label: string;
  vp: number;
}

export const GENERAL_BONUS = 100;
export const BSB_BONUS = 50;
export const STANDARD_BONUS = 50;
export const BREAK_BONUS = 500;

/** Lebenspunkte eines Einzelmodells insgesamt und verbleibend. */
export function wounds(u: UnitState): { total: number; left: number } {
  const total = u.info.woundsPerModel ?? 1;
  return { total, left: Math.max(0, total - (u.woundsLost ?? 0)) };
}

/** Ist die Einheit vernichtet (Status oder alle Lebenspunkte verloren)? */
export function isDestroyed(u: UnitState): boolean {
  return u.status === 'destroyed' || (u.models === 1 && (u.info.startModels ?? 1) === 1 && wounds(u).left === 0);
}

/** Ist die Einheit auf 25 % ihrer Anfangsstärke oder weniger geschrumpft? */
export function isBelowQuarter(u: UnitState): boolean {
  const start = u.info.startModels ?? u.models;
  if (start > 1) return u.models <= start * 0.25;
  const w = wounds(u);
  return w.total > 1 && w.left <= w.total * 0.25;
}

/** Siegpunkte, die eine einzelne Einheit dem Gegner gerade einbringt. */
export function unitVictoryPoints(u: UnitState): ScoreLine[] {
  const points = u.info.points ?? 0;
  const name = u.info.name;
  const lines: ScoreLine[] = [];
  const gone = isDestroyed(u) || u.status === 'fledOff';
  if (isDestroyed(u)) lines.push({ unitId: u.id, label: `${name} destroyed`, vp: points });
  else if (u.status === 'fledOff') lines.push({ unitId: u.id, label: `${name} fled the battlefield`, vp: points });
  else if (u.status === 'fleeing') lines.push({ unitId: u.id, label: `${name} fleeing`, vp: Math.ceil(points / 2) });
  else if (isBelowQuarter(u)) lines.push({ unitId: u.id, label: `${name} at ≤ 25% strength`, vp: Math.ceil(points / 2) });

  const out = gone || u.status === 'fleeing';
  if (out && u.info.isGeneral) lines.push({ unitId: u.id, label: `General (${name}) slain or fled`, vp: GENERAL_BONUS });
  if (out && u.info.isBsb) lines.push({ unitId: u.id, label: `Battle Standard (${name}) slain or fled`, vp: BSB_BONUS });
  if (u.standardCaptured) lines.push({ unitId: u.id, label: `${name}'s standard captured`, vp: STANDARD_BONUS });
  return lines;
}

/** Alle Siegpunkte eines Spielers gegen die Einheiten des Gegners. */
export function victoryPoints(state: GameState, scorer: PlayerId): { total: number; lines: ScoreLine[] } {
  const lines = Object.values(state.units).filter((u) => u.owner !== scorer).flatMap(unitVictoryPoints);
  if (state.meta.breakBonus[scorer]) lines.push({ label: 'Enemy army broken', vp: BREAK_BONUS });
  return { total: lines.reduce((s, l) => s + l.vp, 0), lines };
}

/** Armeewert eines Spielers (Summe der Punktkosten). */
export function armyPoints(state: GameState, owner: PlayerId): number {
  return Object.values(state.units).filter((u) => u.owner === owner).reduce((s, u) => s + (u.info.points ?? 0), 0);
}

/** Hat die Einheit eine Standarte, die erbeutet werden kann? */
export const hasStandard = (u: UnitState) => u.info.command.includes('S') || !!u.info.isBsb;
