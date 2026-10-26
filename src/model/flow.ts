import { unitFootprint, unitLayout } from './store';
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
const STAT_INDEX = { M: 0, WS: 1, BS: 2, S: 3, T: 4, W: 5, I: 6, A: 7, Ld: 8 } as const;

/** Profilwert der ersten Profilzeile als Zahl (0, wenn er fehlt oder kein Wert ist) */
export function statOf(u: UnitState, key: keyof typeof STAT_INDEX): number {
  const v = Number.parseInt(u.info.profile[0]?.values[STAT_INDEX[key]] ?? '', 10);
  return Number.isFinite(v) ? v : 0;
}

/** Trefferwurf beim Schießen: BS 1 = 6+, BS 2 = 5+, BS 3 = 4+, BS 4 = 3+, BS 5+ = 2+ */
export const toHitShooting = (bs: number) => Math.min(6, Math.max(2, 7 - bs));

/** Trefferwurf im Nahkampf: höheres WS 3+, mehr als doppeltes WS des Gegners 5+, sonst 4+ */
export function toHitCombat(ws: number, enemyWs: number): number {
  if (ws > enemyWs) return 3;
  if (enemyWs > 2 * ws) return 5;
  return 4;
}

/** Verwundungswurf: Stärke gegen Widerstand */
export function toWound(s: number, t: number): number {
  const d = s - t;
  return d >= 2 ? 2 : d === 1 ? 3 : d === 0 ? 4 : d === -1 ? 5 : 6;
}

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

/**
 * Lage entlang einer Kante so runden, dass die Bases des Angreifers an den Base-Grenzen des Ziels anliegen.
 * @param along Mitte des Angreifers entlang der Kante (0 = Kantenmitte)
 * @param half halbe Kantenlänge
 * @param step Base-Breite des Ziels entlang dieser Kante
 * @param width Breite des Angreifers
 */
export function alignToBases(along: number, half: number, step: number, width: number): number {
  if (step <= 0) return Math.max(-half, Math.min(half, along));
  // Abstand der linken Kante des Angreifers vom Anfang der Zielkante, auf ganze Bases gerundet
  const e = Math.round((along - width / 2 + half) / step) * step;
  // Mindestens eine Base berührt die Kante
  const clamped = Math.max(Math.min(0, step - width), Math.min(2 * half - step, e));
  return clamped + width / 2 - half;
}

export type ContactPose = {
  x: number; y: number; rotation: number; side: string;
  /** Modelle beider Seiten in Basekontakt */
  contacts: number;
  /** davon Modelle im ersten Glied des Angreifers bzw. der angegriffenen Einheit */
  chargerContacts: number;
  targetContacts: number;
  /** Seitliche Verschiebung gegenüber „gerade hinein“ (Zoll) */
  shift: number;
};

/** Punkt, an dem der Angreifer bündig an der ihm zugewandten Kante des Ziels steht (Kontakt maximiert). */
export function contactPose(charger: UnitState, target: UnitState, units: Record<string, UnitState>): ContactPose {
  return contactPoses(charger, target, units)[0];
}

type Interval = [number, number];
const EPS = 0.01;
/** Zwei Bases berühren sich auch, wenn sie nur Kante an Kante liegen (Überdeckung 0) */
const touches = (a: Interval, b: Interval) => overlapLen(a, b) >= -EPS / 2;
const overlapLen = (a: Interval, b: Interval) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

/** Bases des Ziels an einer Kante, als Abschnitte entlang dieser Kante (Einheitskoordinaten des Ziels) */
function edgeBases(u: UnitState, units: Record<string, UnitState>, side: string): Interval[] {
  const { w, h, slots } = unitLayout(u, units);
  const at = (a: number, b: number) => Math.abs(a - b) < EPS;
  const list = side === 'front' ? slots.filter((s) => at(s.y, -h / 2)).map((s): Interval => [s.x, s.x + s.w])
    : side === 'rear' ? slots.filter((s) => at(s.y + s.d, h / 2)).map((s): Interval => [s.x, s.x + s.w])
    : side === 'left flank' ? slots.filter((s) => at(s.x, -w / 2)).map((s): Interval => [s.y, s.y + s.d])
    : slots.filter((s) => at(s.x + s.w, w / 2)).map((s): Interval => [s.y, s.y + s.d]);
  // Plänkler o. Ä.: die ganze Kante zählt als eine Base
  const half = side === 'front' || side === 'rear' ? w / 2 : h / 2;
  return list.length ? list : [[-half, half]];
}

/** Bases im ersten Glied des Angreifers (Einheitskoordinaten, x quer zur Front) */
function frontBases(u: UnitState, units: Record<string, UnitState>): Interval[] {
  const { w, h, slots } = unitLayout(u, units);
  const list = slots.filter((s) => Math.abs(s.y + h / 2) < EPS).map((s): Interval => [s.x, s.x + s.w]);
  return list.length ? list : [[-w / 2, w / 2]];
}

/**
 * Anlegestellen an allen vier Kanten des Ziels (Front, Rücken, Flanken), bündig an der Kante.
 * Nach der Charge-Regel ("as many models as possible within its front rank into base contact"): der Angreifer geht
 * gerade hinein und wird nur so weit seitlich verschoben, bis möglichst viele Modelle seines ersten Glieds (danach:
 * der angegriffenen Einheit) Basekontakt haben – auch Bases, die nur Kante an Kante liegen, zählen. Die Kante, auf deren Seite der Angreifer steht, kommt zuerst.
 */
export function contactPoses(charger: UnitState, target: UnitState, units: Record<string, UnitState>): ContactPose[] {
  const me = unitFootprint(charger, units);
  const { w, h } = unitFootprint(target, units);
  const p = toLocal(target, { x: charger.x, y: charger.y });
  const c = Math.cos(target.rotation);
  const s = Math.sin(target.rotation);
  const mine = frontBases(charger, units);
  const sides: [string, Point][] = [
    ['front', { x: 0, y: -1 }], ['rear', { x: 0, y: 1 }], ['left flank', { x: -1, y: 0 }], ['right flank', { x: 1, y: 0 }],
  ];
  const all: ContactPose[] = [];
  for (const [side, n] of sides) {
    const theirs = edgeBases(target, units, side);
    const wn = { x: n.x * c - n.y * s, y: n.x * s + n.y * c };
    const rotation = Math.atan2(-wn.x, wn.y);
    // Richtung der Kante auf dem Tisch und wie die Front des Angreifers darauf liegt (gleich oder gespiegelt)
    const along = n.x === 0 ? { x: c, y: s } : { x: -s, y: c };
    const sign = Math.cos(rotation) * along.x + Math.sin(rotation) * along.y >= 0 ? 1 : -1;
    // Bases des Angreifers relativ zu seiner Mitte, so wie sie entlang der Kante liegen
    const rel = mine.map(([a, b]): Interval => (sign > 0 ? [a, b] : [-b, -a]));
    // Lagen entlang der Kante: wo der Angreifer gerade steht (gerade hinein) und die Stellen, an denen eine seiner
    // Bases eine gegnerische Base gerade eben berührt bzw. gerade nicht mehr – dazwischen ändert sich nichts
    const start = n.x === 0 ? p.x : p.y;
    const candidates = new Set<number>([start]);
    for (const [l, r] of rel) {
      for (const [s0, e0] of theirs) {
        candidates.add(s0 - r);
        candidates.add(e0 - l);
      }
    }
    for (const pos of candidates) {
      const placed = rel.map(([l, r]): Interval => [pos + l, pos + r]);
      // Berühren zählt schon, wenn zwei Bases nur Kante an Kante liegen
      const targetContacts = theirs.filter((t) => placed.some((m) => touches(m, t))).length;
      if (!targetContacts) continue;
      const chargerContacts = placed.filter((m) => theirs.some((t) => touches(m, t))).length;
      const contacts = chargerContacts + targetContacts;
      const lp = n.x === 0 ? { x: pos, y: (n.y * h) / 2 } : { x: (n.x * w) / 2, y: pos };
      const contact = toTable(target, lp.x, lp.y);
      all.push({ x: contact.x + wn.x * (me.h / 2), y: contact.y + wn.y * (me.h / 2), rotation, side, contacts, targetContacts,
        chargerContacts, shift: Math.abs(pos - start) });
    }
  }
  // Kante, auf deren Seite der Angreifer steht, zuerst. Je Kante nach der Charge-Regel: (1) möglichst viele Modelle
  // im ersten Glied des Angreifers in Basekontakt, dann möglichst viele der angegriffenen Einheit (auch nur Kante an
  // Kante zählt), (2) dann so wenig seitlich verschieben wie möglich – maximiert ist, sobald die letzte nötige
  // Base berührt wird (blockierte Lagen überspringt der Aufrufer)
  const nx = Math.abs(p.x) / (w / 2);
  const ny = Math.abs(p.y) / (h / 2);
  const facing = ny >= nx ? (p.y < 0 ? 'front' : 'rear') : (p.x < 0 ? 'left flank' : 'right flank');
  const dist = (q: ContactPose) => Math.hypot(q.x - charger.x, q.y - charger.y);
  const nearest = (side: string) => Math.min(...all.filter((q) => q.side === side).map(dist));
  const order = ['front', 'rear', 'left flank', 'right flank']
    .sort((a, b) => Number(b === facing) - Number(a === facing) || nearest(a) - nearest(b));
  return all.sort((a, b) => order.indexOf(a.side) - order.indexOf(b.side)
    || b.chargerContacts - a.chargerContacts || b.targetContacts - a.targetContacts || a.shift - b.shift || dist(a) - dist(b));
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

/**
 * Charge-Regel 3: Ein Angreifer geht so gerade wie möglich vorwärts und darf unterwegs nur einmal schwenken.
 * Das gelingt, wenn der Kontaktpunkt (neue Frontmitte) im vorderen Sichtbereich des Angreifers liegt (zwischen den
 * 45°-Linien von seinen vorderen Ecken). Ergebnis: ob das so ist, und wie weit geschwenkt werden muss.
 */
export function chargePathCheck(charger: UnitState, end: { x: number; y: number; rotation: number },
  units: Record<string, UnitState>): { ok: boolean; note: string } {
  const { w, h } = unitFootprint(charger, units);
  const to = toTable({ ...charger, ...end }, 0, -h / 2);
  const local = toLocal(charger, to);
  // Einheitskoordinaten: x nach rechts, vorwärts = −y (gemessen von der Frontmitte)
  const sideways = local.x;
  const forward = -(local.y + h / 2);
  if (forward < -EPS || Math.abs(sideways) - w / 2 > forward + EPS) {
    return { ok: false, note: '⚠ the target point is outside the front arc – one wheel and a straight move cannot reach it' };
  }
  if (Math.abs(sideways) <= 0.05) return { ok: true, note: 'straight ahead' };
  const deg = Math.round((Math.atan2(Math.abs(sideways), Math.max(forward, EPS)) * 180) / Math.PI);
  return { ok: true, note: `one wheel of about ${deg}° ${sideways > 0 ? 'right' : 'left'}, then straight ahead` };
}

/**
 * Kleinste Charge-Distanz: kürzester Abstand von der Front des Angreifers (ganze Frontbreite) zur Fläche des Ziels.
 * So weit muss die Einheit mindestens kommen, um überhaupt Kontakt zu haben.
 */
export function minChargeDistance(charger: UnitState, target: UnitState, units: Record<string, UnitState>): number {
  const me = unitFootprint(charger, units);
  const { w, h } = unitFootprint(target, units);
  let best = Infinity;
  for (let i = 0; i <= 20; i++) {
    const p = toLocal(target, toTable(charger, -me.w / 2 + (me.w * i) / 20, -me.h / 2));
    best = Math.min(best, Math.hypot(Math.max(0, Math.abs(p.x) - w / 2), Math.max(0, Math.abs(p.y) - h / 2)));
  }
  return best;
}

/**
 * Charge-Distanz bis zur maximierten Stellung: wie weit die vorderen Ecken des Angreifers dafür zurücklegen müssen
 * (die weitere der beiden Ecken zählt, wie beim Schwenken die äußere Ecke).
 */
export function chargeTravel(charger: UnitState, end: { x: number; y: number; rotation: number },
  units: Record<string, UnitState>): number {
  const me = unitFootprint(charger, units);
  const moved = { ...charger, ...end };
  return Math.max(...[-1, 1].map((sx) => {
    const a = toTable(charger, (sx * me.w) / 2, -me.h / 2);
    const b = toTable(moved, (sx * me.w) / 2, -me.h / 2);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }));
}
