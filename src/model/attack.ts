import { statOf, toHitCombat, toHitShooting, toWound } from './flow';
import type { WeaponProfile } from './gear';
import type { UnitState } from './types';

export type AttackMode = 'shooting' | 'combat';

/** Änderung eines Wurfs: −1 macht ihn schwerer (4+ wird 5+), +1 leichter */
export interface RollMod {
  label: string;
  value: number;
  /** vom Programm vorgeschlagen (Reichweite, AP der Waffe) statt von Hand eingetragen */
  auto?: boolean;
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

/** Grundwert des Trefferwurfs mit Erklärung: Beschuss nach BS, Nahkampf nach WS gegen WS */
export function baseToHit(mode: AttackMode, a: UnitState, t: UnitState): { need: number; why: string } {
  if (mode === 'shooting') {
    const bs = statOf(a, 'BS');
    return { need: toHitShooting(bs), why: `BS ${bs}` };
  }
  const ws = statOf(a, 'WS');
  const enemy = statOf(t, 'WS');
  return { need: toHitCombat(ws, enemy), why: `WS ${ws} vs WS ${enemy}` };
}

/** Grundwert des Verwundungswurfs: Stärke gegen Widerstand */
export function baseToWound(strength: number, toughness: number): { need: number; why: string } {
  return { need: toWound(strength, toughness), why: `S ${strength} vs T ${toughness}` };
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

/** Erfolge aus geworfenen Würfeln (bei „6, dann x+“ mit den Würfen der zweiten Runde) */
export function successes(dice: number[], need: number | null, then: number[] = [], thenNeed: number | null = null): number {
  if (need === null) return 0;
  const first = dice.filter((d) => d >= need).length;
  return thenNeed ? then.filter((d) => d >= thenNeed).length : first;
}

/** Beschuss: über die halbe Reichweite hinaus −1 (lange Reichweite) */
export function rangeMods(range: number | null, distance: number): RollMod[] {
  if (range === null) return [];
  return distance > range / 2 ? [{ label: `Long range (${distance.toFixed(1)}″ > ${range / 2}″)`, value: -1, auto: true }] : [];
}

/** Übliche Modifikatoren zum Anhaken (Beschuss nach dem Regelbuch, Nahkampf: eigene Einträge) */
export const SHOOTING_OPTIONS: RollMod[] = [
  { label: 'Moved and shot', value: -1 },
  { label: 'Stand & Shoot', value: -1 },
  { label: 'Partial cover', value: -1 },
  { label: 'Full cover', value: -2 },
];

/** Rüstungswurf: Grundwert und AP der Waffe als Modifikator */
export function saveMods(ap: number, weapon: string): RollMod[] {
  return ap ? [{ label: `AP ${ap} (${weapon})`, value: ap, auto: true }] : [];
}

/** „Armour Bane (1)“: bei einer natürlichen 6 beim Verwunden verbessert sich der AP um diesen Wert */
export function armourBane(rules: string[]): number {
  for (const r of rules) {
    const m = /armour bane\s*\((\d+)\)/i.exec(r);
    if (m) return Number(m[1]);
  }
  return 0;
}
