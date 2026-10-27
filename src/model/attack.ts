import { shootingReroll, statOf, toHitCombat, toHitShooting, toWound } from './flow';
import type { WeaponProfile } from './gear';
import { isSkirmish, unitLayout } from './store';
import type { UnitState } from './types';

/**
 * Wie viele Modelle schießen: das erste Glied (auf einem Hügel die ersten zwei); Plänkler alle.
 * Volley Fire: dazu aus jedem weiteren Glied die Hälfte, aufgerundet – nicht nach einer Bewegung in diesem Zug
 * und nicht bei Stand & Shoot. Angeschlossene Charaktere zählen nicht (sie schießen selbst).
 */
export function shooters(u: UnitState, units: Record<string, UnitState>, hill: boolean, volley: boolean): number {
  const troops = unitLayout(u, units).slots.filter((s) => !s.charId);
  if (isSkirmish(u)) return troops.length;
  const rows = new Map<number, number>();
  for (const s of troops) {
    const y = Math.round(s.y * 100);
    rows.set(y, (rows.get(y) ?? 0) + 1);
  }
  const ranks = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  const shooting = hill ? 2 : 1;
  const front = ranks.slice(0, shooting).reduce((s, n) => s + n, 0);
  const rear = volley ? ranks.slice(shooting).reduce((s, n) => s + Math.ceil(n / 2), 0) : 0;
  return front + rear;
}

/** Sonderregeln einer Schusswaffe, die die Würfe verändern (Texte: tow.whfb.app, weapons.json) */
export interface ShootingRules {
  volley: boolean;
  /** Moving & Shooting −2 statt −1 */
  ponderous: boolean;
  /** kein −1 für Moving & Shooting */
  quickShot: boolean;
  /** kein −1 bei Stand & Shoot */
  dwarfCrafted: boolean;
  /** nicht, wenn das Modell sich in diesem Zug bewegt hat */
  moveOrShoot: boolean;
  /** nicht bei Stand & Shoot */
  cumbersome: boolean;
  /** „Multiple Shots (X)“: X Schüsse je Modell mit −1, z. B. "2" oder "D3" */
  multipleShots: string | null;
  /** natürliche 6 beim Treffen: +2 auf den Verwundungswurf */
  poisoned: boolean;
  /** „Multiple Wounds (X)“: jede unverhinderte Verwundung zählt X-fach */
  multipleWounds: string | null;
}

const bracket = (rules: string[], name: string) => {
  for (const r of rules) {
    const m = new RegExp(`^${name}\\s*\\(([^)]+)\\)`, 'i').exec(r.trim());
    if (m) return m[1].trim();
  }
  return null;
};

/** Regeln der Waffe, dazu Regeln der Einheit, die beim Schießen gelten (Poisoned Attacks, Dwarf Crafted) */
export function shootingRules(weaponRules: string[], unitRules: string[] = []): ShootingRules {
  const all = [...weaponRules, ...unitRules];
  const has = (re: RegExp) => all.some((r) => re.test(r.trim()));
  const own = (re: RegExp) => weaponRules.some((r) => re.test(r.trim()));
  return {
    volley: own(/^volley fire/i), ponderous: own(/^ponderous/i), quickShot: own(/^quick shot/i),
    dwarfCrafted: has(/^dwarf crafted/i), moveOrShoot: own(/^move or shoot/i), cumbersome: own(/^cumbersome/i),
    multipleShots: bracket(weaponRules, 'Multiple Shots'), poisoned: has(/^poisoned attacks/i),
    multipleWounds: bracket(weaponRules, 'Multiple Wounds'),
  };
}

/** Würfelausdruck wie "3", "D3", "D3+1", "2D6", "D6+1" werfen; ohne Würfel bleibt es die Zahl */
export function rollExpr(expr: string, d6: () => number): { total: number; dice: number[] } {
  const m = /^(\d*)D(3|6)\s*([+-]\s*\d+)?$/i.exec(expr.replace(/\s/g, ''));
  if (!m) return { total: Number.parseInt(expr, 10) || 1, dice: [] };
  const n = Number(m[1] || 1);
  const dice = Array.from({ length: n }, () => (m[2] === '3' ? Math.ceil(d6() / 2) : d6()));
  return { total: dice.reduce((s, d) => s + d, 0) + (m[3] ? Number(m[3].replace(/\s/g, '')) : 0), dice };
}

export const isDiceExpr = (expr: string) => /D\d/i.test(expr);

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

/** @param ownS Stärke des Modells, das die Waffe führt (sonst die der ersten Profilzeile) */
export function attackWeapon(p: WeaponProfile, u: UnitState, ownS = statOf(u, 'S')): AttackWeapon {
  return {
    name: p.name, range: weaponRange(p.range), strength: weaponStrength(p.strength, ownS), ap: weaponAp(p.ap),
    rules: p.rules, raw: `S ${p.strength} · AP ${p.ap}`,
  };
}

/** Ohne passende Waffe: eigene Stärke, kein AP */
export const bareHands = (u: UnitState, ownS = statOf(u, 'S'), name = 'Hand weapon'): AttackWeapon =>
  ({ name, range: null, strength: ownS, ap: 0, rules: [], raw: 'S S · AP -' });

/** Wer in einem Angriff zuschlägt bzw. schießt: eine Zeile je Profil (Truppe, Champion, Reittier, Charakter) */
export interface AttackLine {
  key: string;
  /** Einheit, zu der das Profil gehört (bei angeschlossenen Charakteren der Charakter) */
  unitId: string;
  label: string;
  /** Profilzeile in dieser Einheit */
  row: number;
  /** Modelle mit diesem Profil */
  models: number;
  ws: number;
  bs: number;
  s: number;
  a: number;
  /** Reittier: kämpft mit eigenen Werten, schießt nicht */
  mount: boolean;
  /** Vorschlag für die Zahl der Attacken bzw. Schüsse (änderbar) */
  count: number;
}

const rowStat = (u: UnitState, row: number, i: number) => {
  const v = Number.parseInt(u.info.profile[row]?.values[i] ?? '', 10);
  return Number.isFinite(v) ? v : 0;
};

/** Reittier-Zeile: ohne eigenen Moralwert (Ld "-"), es gilt der des Reiters */
const isMountRow = (u: UnitState, row: number) => row > 0 && !/\d/.test(u.info.profile[row]?.values[8] ?? '');

/**
 * Profile einer Einheit, die angreifen: das Hauptprofil (ohne Champion), der Champion (wenn gewählt), Reittiere
 * und angeschlossene Charaktere mit ihren Reittieren.
 * Vorschlag Nahkampf: Modelle × Attacken; Beschuss: die Schützen aus shooters (Champion schießt im ersten Glied mit).
 */
export function attackLines(u: UnitState, units: Record<string, UnitState>, mode: AttackMode,
  shots = (unit: UnitState) => shooters(unit, units, false, false)): AttackLine[] {
  const lines: AttackLine[] = [];
  const add = (unit: UnitState, row: number, models: number, label = unit.info.profile[row]?.name ?? unit.info.name) => {
    const line: AttackLine = {
      key: `${unit.id}:${row}`, unitId: unit.id, label, row, models,
      ws: rowStat(unit, row, 1), bs: rowStat(unit, row, 2), s: rowStat(unit, row, 3), a: Math.max(1, rowStat(unit, row, 7)),
      mount: isMountRow(unit, row), count: 0,
    };
    if (mode === 'shooting' && line.mount) return;
    line.count = mode === 'combat' ? models * line.a : models;
    lines.push(line);
  };
  const profile = u.info.profile;
  const single = (u.info.startModels ?? u.models) === 1;
  const champion = !single && u.info.command.includes('C') && profile.length > 1 && !isMountRow(u, 1) ? 1 : 0;
  // Beschuss: Schützen im ersten Glied; der Champion ist einer davon
  const troops = mode === 'shooting' ? Math.max(0, shots(u) - champion) : Math.max(0, u.models - champion);
  add(u, 0, troops, profile[0]?.name ?? u.info.name);
  if (champion) add(u, 1, 1);
  profile.forEach((_, row) => { if (isMountRow(u, row)) add(u, row, u.models); });
  for (const c of Object.values(units).filter((x) => x.joinedTo === u.id)) {
    add(c, 0, 1, c.info.name);
    c.info.profile.forEach((_, row) => { if (isMountRow(c, row)) add(c, row, 1, `${c.info.profile[row].name} (${c.info.name})`); });
  }
  return lines;
}

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

/** Trefferwurf einer Angriffszeile: Beschuss nach ihrem BS, Nahkampf ihr WS gegen das WS des Ziels */
export function lineToHit(mode: AttackMode, line: AttackLine, t: UnitState): { need: number; why: string; reroll: number | null } {
  if (mode === 'shooting') {
    const reroll = shootingReroll(line.bs);
    return { need: toHitShooting(line.bs), why: `BS ${line.bs}${reroll ? `, misses re-rolled on ${reroll}+` : ''}`, reroll };
  }
  const enemy = statOf(t, 'WS');
  return { need: toHitCombat(line.ws, enemy), why: `WS ${line.ws} vs WS ${enemy}`, reroll: null };
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
export function shootingOptions(range: number | null, distance: number, rules?: ShootingRules): RollMod[] {
  const far = range !== null && distance > range / 2;
  // Waffenregeln ändern den Wert: Ponderous −2, Quick Shot 0; Dwarf Crafted kein −1 bei Stand & Shoot
  const moving = rules?.quickShot ? 0 : rules?.ponderous ? -2 : -1;
  const movingHint = rules?.moveOrShoot ? 'Move or Shoot: cannot shoot after moving'
    : rules?.quickShot ? 'Quick Shot: no penalty' : rules?.ponderous ? 'Ponderous: −2 instead of −1' : undefined;
  const standHint = rules?.cumbersome ? 'Cumbersome: cannot Stand & Shoot' : rules?.dwarfCrafted ? 'Dwarf Crafted: no penalty' : undefined;
  return [
    { label: 'Moving & Shooting', value: moving, hint: movingHint },
    { label: 'Long range', value: -1,
      hint: range === null ? undefined : `${distance.toFixed(1)}″ – half range ${range / 2}″${far ? ', looks like long range' : ''}` },
    { label: 'Stand & Shoot', value: rules?.dwarfCrafted ? 0 : -1, hint: standHint },
    { label: 'Partial cover', value: -1 },
    { label: 'Full cover', value: -2 },
    { label: 'Target is skirmishers', value: -1, hint: 'unit of models with Unit Strength 1' },
  ];
}

/** Rüstungswurf: AP der Waffe (gilt immer) */
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
