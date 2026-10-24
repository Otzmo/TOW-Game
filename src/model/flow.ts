import { unitFootprint } from './store';
import type { Charge, ChargeReaction, GameState, Point, UnitState } from './types';

/** Regelabläufe: Angriffe, Würfe und Werte, die mehrere Aufforderungen gemeinsam brauchen. */

// --- Würfel -------------------------------------------------------------------

export const d6 = () => 1 + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * 6);
export const roll = (n: number) => Array.from({ length: n }, d6);
const d3 = () => Math.ceil(d6() / 2);

export interface RollResult {
  dice: number[];
  total: number;
  /** Erklärung, z. B. "höchster von 3, 5 + W6 (4)" */
  text: string;
}

/**
 * Angriffswurf: 2W6, der niedrigere fällt weg (TOW). Swiftstride darf +W6, Battle Hunger +W3 addieren.
 */
export function chargeRoll(swiftstride: boolean, battleHunger: boolean): RollResult {
  const dice = roll(2);
  let total = Math.max(...dice);
  const parts = [`highest of ${dice.join(' and ')} = ${total}`];
  if (swiftstride) {
    const x = d6();
    dice.push(x);
    total += x;
    parts.push(`Swiftstride +${x}`);
  }
  if (battleHunger) {
    const x = d3();
    dice.push(x);
    total += x;
    parts.push(`Battle Hunger +${x}`);
  }
  return { dice, total, text: parts.join(', ') };
}

/** Fluchtwurf: 2W6; bei Fire & Flee fällt der niedrigere weg. Swiftstride darf +W6 addieren. */
export function fleeRoll(fireAndFlee: boolean, swiftstride: boolean): RollResult {
  const dice = roll(2);
  let total = fireAndFlee ? Math.max(...dice) : dice[0] + dice[1];
  const parts = [fireAndFlee ? `highest of ${dice.join(' and ')} = ${total}` : `${dice.join(' + ')} = ${total}`];
  if (swiftstride) {
    const x = d6();
    dice.push(x);
    total += x;
    parts.push(`Swiftstride +${x}`);
  }
  return { dice, total, text: parts.join(', ') };
}

// --- Werte aus dem Profil -----------------------------------------------------

const hasRule = (u: UnitState, re: RegExp) => [...u.info.rules, ...u.info.items].some((r) => re.test(r.name));
export const hasSwiftstride = (u: UnitState) => hasRule(u, /swiftstride/i);
export const hasBattleHunger = (u: UnitState) => hasRule(u, /battle hunger/i);

/** Bewegung: erster Zahlenwert in der M-Spalte (bei Reitern der des Reittiers). */
export function movementOf(u: UnitState): number {
  for (const row of u.info.profile) {
    const m = Number.parseInt(row.values[0], 10);
    if (Number.isFinite(m)) return m;
  }
  return 0;
}

/** Moralwert: höchster Ld-Wert im Profil. */
export function leadershipOf(u: UnitState): number {
  const values = u.info.profile.map((r) => Number.parseInt(r.values[8], 10)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 7;
}

/** Zauberstufe aus den Optionen, z. B. "Level 4 wizard"; 0 = kein Zauberer. */
export function wizardLevel(u: UnitState): number {
  for (const o of u.info.options) {
    const m = /level\s*(\d)\s*wizard/i.exec(o);
    if (m) return Number(m[1]);
  }
  return /wizard/i.test(u.info.options.join(' ')) ? 1 : 0;
}

// --- Angriffe -----------------------------------------------------------------

function toLocal(u: UnitState, p: Point): Point {
  const c = Math.cos(-u.rotation);
  const s = Math.sin(-u.rotation);
  return { x: (p.x - u.x) * c - (p.y - u.y) * s, y: (p.x - u.x) * s + (p.y - u.y) * c };
}

function toTable(u: UnitState, lx: number, ly: number): Point {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return { x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c };
}

/** Mitte der Front einer Einheit auf dem Tisch. */
export function frontCenter(u: UnitState, units: Record<string, UnitState>): Point {
  const { h } = unitFootprint(u, units);
  return toTable(u, 0, -h / 2);
}

/** Kürzester Abstand von der Frontmitte des Angreifers zur Fläche des Ziels (Zoll). */
export function chargeDistance(charger: UnitState, target: UnitState, units: Record<string, UnitState>): number {
  const p = toLocal(target, frontCenter(charger, units));
  const { w, h } = unitFootprint(target, units);
  const dx = Math.max(0, Math.abs(p.x) - w / 2);
  const dy = Math.max(0, Math.abs(p.y) - h / 2);
  return Math.hypot(dx, dy);
}

export const REACTION_NAMES: Record<ChargeReaction, string> = {
  hold: 'Hold',
  standShoot: 'Stand & Shoot',
  flee: 'Flee',
  fireFlee: 'Fire & Flee',
  counter: 'Counter Charge',
};

/** Erlaubte Reaktionen auf einen Angriff, mit kurzer Erklärung. */
export function reactionOptions(state: GameState, charge: Charge): { key: ChargeReaction; note: string }[] {
  const { units } = state;
  const charger = units[charge.charger];
  const target = units[charge.target];
  if (!charger || !target) return [];
  if (target.status === 'fleeing') return [{ key: 'flee', note: 'Fleeing units must Flee.' }];
  const dist = chargeDistance(charger, target, units);
  const tooClose = dist < movementOf(charger);
  const options: { key: ChargeReaction; note: string }[] = [
    { key: 'hold', note: 'Stand firm and receive the charge.' },
  ];
  if (!tooClose) options.push({ key: 'standShoot', note: 'Only with missile weapons and line of sight; then Hold.' });
  options.push({ key: 'flee', note: 'Flee directly away from the charger (2D6).' });
  if (!tooClose && hasRule(target, /fire (&|and) flee/i)) {
    options.push({ key: 'fireFlee', note: 'Shoot, then Flee (2D6, discard the lowest).' });
  }
  if (!tooClose && hasRule(target, /counter charge/i)) {
    options.push({ key: 'counter', note: 'Only against cavalry, chariots or monsters charging the front arc.' });
  }
  return options;
}

/** Punkt, an dem der Angreifer bündig an der ihm zugewandten Kante des Ziels steht. */
export function contactPose(charger: UnitState, target: UnitState, units: Record<string, UnitState>):
  { x: number; y: number; rotation: number; side: string } {
  const me = unitFootprint(charger, units);
  const { w, h } = unitFootprint(target, units);
  const p = toLocal(target, { x: charger.x, y: charger.y });
  // Kante, auf deren Seite der Angreifer steht (Front, Rücken, Flanken)
  const nx = Math.abs(p.x) / (w / 2);
  const ny = Math.abs(p.y) / (h / 2);
  let lp: Point;
  let n: Point;
  let side: string;
  if (ny >= nx) {
    const sign = p.y < 0 ? -1 : 1;
    lp = { x: Math.max(-w / 2, Math.min(w / 2, p.x)), y: (sign * h) / 2 };
    n = { x: 0, y: sign };
    side = sign < 0 ? 'front' : 'rear';
  } else {
    const sign = p.x < 0 ? -1 : 1;
    lp = { x: (sign * w) / 2, y: Math.max(-h / 2, Math.min(h / 2, p.y)) };
    n = { x: sign, y: 0 };
    side = sign < 0 ? 'left flank' : 'right flank';
  }
  const contact = toTable(target, lp.x, lp.y);
  const c = Math.cos(target.rotation);
  const s = Math.sin(target.rotation);
  const wn = { x: n.x * c - n.y * s, y: n.x * s + n.y * c };
  return { x: contact.x + wn.x * (me.h / 2), y: contact.y + wn.y * (me.h / 2), rotation: Math.atan2(-wn.x, wn.y), side };
}

/** Angreifer um eine Strecke direkt auf das Ziel zu bewegen (fehlgeschlagener Angriff). */
export function advanceToward(charger: UnitState, target: UnitState, units: Record<string, UnitState>, dist: number):
  { x: number; y: number; rotation: number } {
  const from = frontCenter(charger, units);
  const tx = target.x - from.x;
  const ty = target.y - from.y;
  const len = Math.hypot(tx, ty) || 1;
  const step = Math.min(dist, Math.max(0, chargeDistance(charger, target, units) - 0.1));
  const rotation = Math.atan2(tx, -ty);
  return { x: charger.x + (tx / len) * step, y: charger.y + (ty / len) * step, rotation };
}

/** Fluchtrichtung: von der Mitte des Angreifers weg; neue Position nach der Flucht. */
export function fleeFrom(target: UnitState, charger: UnitState, dist: number): { x: number; y: number; rotation: number } {
  const dx = target.x - charger.x;
  const dy = target.y - charger.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: target.x + (dx / len) * dist, y: target.y + (dy / len) * dist, rotation: Math.atan2(dx, -dy) };
}
