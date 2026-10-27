import { shootingReroll, statOf, toHitCombat, toHitShooting, toWound } from './flow';
import type { WeaponProfile } from './gear';
import type { UnitState } from './types';

export type AttackMode = 'shooting' | 'combat';

/** Änderung eines Wurfs: −1 macht ihn schwerer (4+ wird 5+), +1 leichter */
export interface RollMod {
  label: string;
  value: number;
  /** Hinweis zum Anhaken, z. B. die gemessene Entfernung bei langer Reichweite */
  hint?: string;
}

/** Waffe, mit der angegriffen wird (aufgelöste Werte für diese Einheit) */
export interface AttackWeapon {
  name: string;
  /** Zoll; null = Nahkampfwaffe */
  range: number | null;
  strength: number;
  /** z. B. −1; 0 ohne AP */
  ap: number;
  rules: string[];
  /** Text der Profilwerte, wie in der Quelle ("S+2", "-1(-2)") */
  raw: string;
}

/** Erster Zahlenwert eines Felds wie "5(10)", "-1(-2)", "-" (Werte in Klammern gelten nur in Sonderfällen) */
const first = (s: string) => s.trim().replace(/\(.*$/, '').replace('−', '-');

/** Stärke einer Waffe: "S" = eigene Stärke, "S+2" = eigene +2, "4" = feste Stärke */
export function weaponStrength(text: string, own: number): number {
  const t = first(text);
  const m = /^S\s*([+-]\s*\d+)?$/i.exec(t);
  if (m) return own + (m[1] ? Number(m[1].replace(/\s/g, '')) : 0);
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : own;
}

/** Durchschlag: "-1" → −1, "-" oder "N/A" → 0 */
export function weaponAp(text: string): number {
  const n = Number.parseInt(first(text), 10);
  return Number.isFinite(n) ? Math.min(0, n) : 0;
}

/** Größte Reichweite in Zoll: "24\"" → 24, "12-60\"" → 60, "Combat" → null */
export function weaponRange(text: string): number | null {
  const nums = [...text.matchAll(/(\d+)\s*["″]?/g)].map((m) => Number(m[1]));
  return /combat|n\/a/i.test(text) || !nums.length || /D\d/i.test(text) ? null : Math.max(...nums);
}

export function attackWeapon(p: WeaponProfile, u: UnitState): AttackWeapon {
  return {
    name: p.name, range: weaponRange(p.range), strength: weaponStrength(p.strength, statOf(u, 'S')), ap: weaponAp(p.ap),
    rules: p.rules, raw: `S ${p.strength} · AP ${p.ap}`,
  };
}

/** Ohne passende Waffe: eigene Stärke, kein AP */
export const bareHands = (u: UnitState): AttackWeapon =>
  ({ name: 'Hand weapon', range: null, strength: statOf(u, 'S'), ap: 0, rules: [], raw: 'S S · AP -' });

/**
 * Grundwert des Trefferwurfs mit Erklärung: Beschuss nach BS, Nahkampf nach WS gegen WS.
 * reroll: ab BS 6 werden Fehlschüsse auf diesen Wert wiederholt (Modifikatoren gelten nur für den ersten Wurf).
 */
export function baseToHit(mode: AttackMode, a: UnitState, t: UnitState): { need: number; why: string; reroll: number | null } {
  if (mode === 'shooting') {
    const bs = statOf(a, 'BS');
    const reroll = shootingReroll(bs);
    return { need: toHitShooting(bs), why: `BS ${bs}${reroll ? `, misses re-rolled on ${reroll}+` : ''}`, reroll };
  }
  const ws = statOf(a, 'WS');
  const enemy = statOf(t, 'WS');
  return { need: toHitCombat(ws, enemy), why: `WS ${ws} vs WS ${enemy}`, reroll: null };
}

/** Grundwert des Verwundungswurfs: Stärke gegen Widerstand */
export function baseToWound(strength: number, toughness: number): { need: number; why: string; reroll: null } {
  return { need: toWound(strength, toughness), why: `S ${strength} vs T ${toughness}`, reroll: null };
}

export const sumMods = (mods: RollMod[]) => mods.reduce((s, m) => s + m.value, 0);

/**
 * Nötiger Wurf nach allen Modifikatoren. Eine natürliche 1 misslingt immer, darum nie besser als 2+.
 * Trefferwurf über 6+: erst eine 6, dann für jede 6 noch einmal 4+ (7+), 5+ (8+) oder 6+ (9+); 10+ trifft nie.
 * Andere Würfe über 6+ gelingen nie.
 */
export function finalNeed(base: number, mods: RollMod[], kind: 'hit' | 'wound' | 'save'):
  { need: number | null; then: number | null } {
  const n = base - sumMods(mods);
  if (n <= 6) return { need: Math.max(2, n), then: null };
  if (kind === 'hit' && n <= 9) return { need: 6, then: n - 3 };
  return { need: null, then: null };
}

export const needText = (r: { need: number | null; then: number | null }) =>
  r.need === null ? 'impossible' : r.then ? `6, then ${r.then}+` : `${r.need}+`;

/**
 * Erfolge aus geworfenen Würfeln: bei „6, dann x+“ zählen die Würfe der zweiten Runde,
 * bei BS 6+ kommen die gelungenen Wiederholungen der Fehlschüsse dazu.
 */
export function successes(dice: number[], need: number | null, then: number[] = [], thenNeed: number | null = null,
  rerolled: number[] = [], rerollNeed: number | null = null): number {
  if (need === null) return 0;
  const first = thenNeed ? then.filter((d) => d >= thenNeed).length : dice.filter((d) => d >= need).length;
  return first + (rerollNeed ? rerolled.filter((d) => d >= rerollNeed).length : 0);
}

/** Wie viele Würfel wiederholt werden: Fehlschüsse des ersten Wurfs (bei „6, dann x+“ die der zweiten Runde) */
export function misses(dice: number[], need: number | null, then: number[] = [], thenNeed: number | null = null): number {
  if (need === null) return dice.length;
  if (thenNeed) return dice.length - then.filter((d) => d >= thenNeed).length;
  return dice.filter((d) => d < need).length;
}

/**
 * Modifikatoren beim Beschuss (Quick Reference): alle zum Anhaken, keiner wird von selbst verrechnet.
 * Bei langer Reichweite steht die gemessene Entfernung als Hinweis dabei.
 */
export function shootingOptions(range: number | null, distance: number): RollMod[] {
  const far = range !== null && distance > range / 2;
  return [
    { label: 'Moving & Shooting', value: -1 },
    { label: 'Long range', value: -1,
      hint: range === null ? undefined : `${distance.toFixed(1)}″ – half range ${range / 2}″${far ? ', looks like long range' : ''}` },
    { label: 'Stand & Shoot', value: -1 },
    { label: 'Partial cover', value: -1 },
    { label: 'Full cover', value: -2 },
    { label: 'Target is skirmishers', value: -1, hint: 'unit of models with Unit Strength 1' },
  ];
}

/** Rüstungswurf: AP der Waffe zum Anhaken */
export function saveMods(ap: number, weapon: string): RollMod[] {
  return ap ? [{ label: `AP ${ap} (${weapon})`, value: ap }] : [];
}

/** „Armour Bane (1)“: bei einer natürlichen 6 beim Verwunden verbessert sich der AP um diesen Wert */
export function armourBane(rules: string[]): number {
  for (const r of rules) {
    const m = /armour bane\s*\((\d+)\)/i.exec(r);
    if (m) return Number(m[1]);
  }
  return 0;
}
