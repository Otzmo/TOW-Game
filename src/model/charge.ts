import type { ChargeReaction, UnitState } from './types';

/**
 * Sonderregel rund um den Angriff: wer sie hat (Angreifer oder Ziel) und was sie bewirkt. Regeln des Angreifers
 * verändern den Angriffswurf, Regeln des Ziels den Fluchtwurf; andere sind nur Hinweise.
 */
export interface ChargeRule {
  name: string;
  side: 'charger' | 'target';
  hint: string;
  /** So heißt die Regel bei der Einheit (Standard: beginnt mit name) */
  match?: RegExp;
  /** +W6 bzw. +W3 auf den Wurf */
  d6?: boolean;
  d3?: boolean;
  /** fester Bonus (negativ: Abzug) */
  plus?: number;
  /** erhöht die größtmögliche Angriffsweite um so viele Zoll */
  max?: number;
  /** einen W6 mehr würfeln, der niedrigste fällt weg */
  extra?: boolean;
  /** den ganzen Wurf wiederholen */
  rerollAll?: boolean;
  /** natürliche 1en wiederholen (alle bzw. eine), bevor ein Würfel wegfällt */
  ones?: 'all' | 'one';
  /** Ergebnis mindestens 1 */
  min1?: boolean;
  /** den höchsten statt des niedrigsten Würfels streichen (schwieriges Gelände) */
  dropHighest?: boolean;
  /** freiwillig und nachteilig: nicht vorab anhaken */
  optional?: boolean;
  /** gilt nur für diese Truppentypen */
  troop?: RegExp;
  /** kommt nicht von der Einheit: Zauber bzw. Regel einer befreundeten Einheit, oder Gelände auf dem Tisch */
  from?: 'army-spell' | 'army-rule' | 'terrain';
}

const D3_MAX3 = { d3: true, max: 3 } as const;

/** Alle Regeln, die beim Angriff eine Rolle spielen; im Fenster erscheinen nur die, die die Einheit hat */
export const CHARGE_RULES: ChargeRule[] = [
  // Angriffswurf
  { name: 'Swiftstride', side: 'charger', hint: 'charge roll +D6, maximum charge range +3″', d6: true, max: 3 },
  { name: 'Battle Hunger', side: 'charger', hint: 'charge roll +D3, maximum charge range +2″', d3: true, max: 2 },
  { name: 'The Beast Banner', side: 'charger', hint: 'charge roll +D3, maximum charge range +3″', ...D3_MAX3 },
  { name: 'Waaagh! Banner', side: 'charger', hint: 'charge roll +D3, maximum charge range +3″', ...D3_MAX3 },
  { name: 'First to the Fray', side: 'charger', hint: 'charge roll +D3, maximum charge range +3″', ...D3_MAX3 },
  { name: 'Virtue of the Impetuous Knight', side: 'charger', hint: 'charge roll +D3, maximum charge range +3″', ...D3_MAX3 },
  { name: "'Ere We Go!", side: 'charger', hint: 'spell: charge roll +D3, maximum charge range +3″', ...D3_MAX3, match: /ere we go/i, from: 'army-spell' },
  { name: 'Battle Howl', side: 'charger', hint: 'Prayer of Ulric: charge roll +D3', d3: true, match: /prayers of ulric/i, from: 'army-rule' },
  { name: "Crusader's Zeal", side: 'charger', hint: 'charge roll +1, maximum charge range +1″', plus: 1, max: 1, match: /crusader.s zeal/i },
  { name: 'Daemons of Slaanesh', side: 'charger', hint: 'charge roll +1, maximum charge range +1″', plus: 1, max: 1, match: /daemons?(\s*\(s\))?\s+of\s+slaanesh/i },
  { name: 'Jaguar Standard', side: 'charger', hint: 'roll an extra D6 and discard the lowest', extra: true },
  { name: 'Warband', side: 'charger', hint: 'may re-roll the charge roll (majority of the models)', rerollAll: true },
  { name: 'Rampaging Banner', side: 'charger', hint: 'may re-roll the charge roll', rerollAll: true },
  { name: 'Icon of Endless War', side: 'charger', hint: 'may re-roll the charge roll', rerollAll: true },
  { name: 'Ravenous Hunger', side: 'charger', hint: 'may re-roll the charge roll (majority of the models)', rerollAll: true },
  { name: 'Implacable', side: 'charger', hint: 'once per game: may re-roll the charge roll', rerollAll: true },
  { name: 'Discipline of the Dragon', side: 'charger', hint: 'Fury of the Falling Blade: regular infantry may re-roll the charge roll', rerollAll: true },
  { name: 'Finest Warhorses', side: 'charger', hint: 're-roll natural 1s before discarding', ones: 'all' },
  { name: 'Da Banner of Da Nomadz', side: 'charger', hint: 're-roll natural 1s before discarding', ones: 'all' },
  { name: 'Steeds of Darkness', side: 'charger', hint: 'cavalry and chariots: re-roll natural 1s before discarding', ones: 'all', troop: /cavalry|chariot/i },
  { name: 'Order of the Knights Panther', side: 'charger', hint: 're-roll a single natural 1 before discarding', ones: 'one', match: /knights panther/i },
  { name: 'Difficult Terrain', side: 'charger', hint: 'charging through difficult terrain: discard the highest die instead of the lowest', dropHighest: true, from: 'terrain' },
  // Nur Hinweise
  { name: 'Fly', side: 'charger', hint: 'may charge over other units and terrain' },
  { name: 'Furious Charge', side: 'charger', hint: '+1 Attack in a turn in which it charged' },
  { name: 'Impact Hits', side: 'charger', hint: 'impact hits are resolved before anything else' },
  { name: 'Impetuous', side: 'charger', hint: 'must declare a charge if possible' },
  { name: 'Frenzy', side: 'charger', hint: 'must declare a charge if possible' },
  { name: 'Random Movement', side: 'charger', hint: 'moves by random movement instead of a charge roll' },
  { name: 'Ogre Kingdoms Charge', side: 'charger', hint: 'a charge move of 6″ or more after a roll with a natural 6 gives Impact Hits (1)', match: /ogre (kingdoms )?charge/i },
  { name: 'Temperamental', side: 'charger', hint: 'a natural 1 on the charge roll builds up dangerous pressure' },
  // Reaktion und Fluchtwurf
  { name: 'Fire & Flee', side: 'target', hint: 'may Fire & Flee: flee roll 2D6, discard the lowest', match: /fire (&|and) flee/i },
  { name: 'Counter Charge', side: 'target', hint: 'may Counter Charge as a charge reaction' },
  { name: 'Quick Shot', side: 'target', hint: 'may Stand & Shoot however close the charger is' },
  { name: 'Dwarf Crafted', side: 'target', hint: 'no −1 To Hit for Stand & Shoot' },
  { name: 'Swiftstride', side: 'target', hint: 'flee roll +D6', d6: true },
  { name: 'Daemons of Slaanesh', side: 'target', hint: 'flee roll +1', plus: 1, match: /daemons?(\s*\(s\))?\s+of\s+slaanesh/i },
  { name: 'Scurry Away', side: 'target', hint: 'flee roll +1', plus: 1 },
  { name: 'Resolute', side: 'target', hint: 'flee roll −1 (minimum 1)', plus: -1, min1: true },
  { name: 'An Unholy Union', side: 'target', hint: 'may apply −1 to the flee roll (within 6″ of the other army list)', plus: -1, optional: true },
  { name: 'Discipline of the Dragon', side: 'target', hint: 'Fury of the Falling Blade: may re-roll the flee roll', rerollAll: true },
  { name: 'Finest Warhorses', side: 'target', hint: 're-roll natural 1s on the flee roll', ones: 'all' },
  { name: 'Da Banner of Da Nomadz', side: 'target', hint: 're-roll natural 1s on the flee roll', ones: 'all' },
  { name: 'Steeds of Darkness', side: 'target', hint: 'cavalry and chariots: re-roll natural 1s on the flee roll', ones: 'all', troop: /cavalry|chariot/i },
];

/** Hat die Einheit (oder ein Gegenstand) eine Regel dieses Namens? */
export const unitHasRule = (u: UnitState, name: string) =>
  [...u.info.rules, ...u.info.items].some((r) => r.name.toLowerCase().replace(/\s*\(.*\)/, '').replace('and', '&') === name.toLowerCase()
    || r.name.toLowerCase().startsWith(name.toLowerCase()));

/** Hat die Einheit (mit ihren angeschlossenen Charakteren) diese Angriffsregel? */
export function hasChargeRule(u: UnitState, r: ChargeRule, units: Record<string, UnitState>): boolean {
  if (r.from) return false;
  const who = [u, ...Object.values(units).filter((c) => c.joinedTo === u.id)];
  if (r.troop && !r.troop.test(u.info.troopType)) return false;
  return who.some((w) => (r.match ? [...w.info.rules, ...w.info.items].some((x) => r.match!.test(x.name)) : unitHasRule(w, r.name)));
}

/** Gewürfelt: die W6 des Wurfs (null = noch nicht), dazu +W6/+W3; used* = Regel-Wiederholung schon benutzt */
export interface RollDice {
  base: (number | null)[];
  d6?: number | null;
  d3?: number | null;
  usedAll?: boolean;
  usedOnes?: boolean;
}

/** Wie gewürfelt und gerechnet wird, nach den angehakten Regeln */
export interface RollSetup {
  dice: number;
  keep: 'highest' | 'lowest' | 'sum';
  d6: boolean;
  d3: boolean;
  plus: number;
  /** größtmögliches Ergebnis des Wurfs (Angriff: 6 + Erhöhungen); null = ohne Grenze */
  cap: number | null;
  min1: boolean;
  rerollAll: ChargeRule[];
  ones: ChargeRule[];
}

/** Angriffswurf: 2W6, der niedrigere fällt weg (schwieriges Gelände: der höhere); dazu die Regeln */
export function chargeSetup(rules: ChargeRule[]): RollSetup {
  return {
    dice: rules.some((r) => r.extra) ? 3 : 2,
    keep: rules.some((r) => r.dropHighest) ? 'lowest' : 'highest',
    d6: rules.some((r) => r.d6), d3: rules.some((r) => r.d3),
    plus: rules.reduce((s, r) => s + (r.plus ?? 0), 0),
    cap: 6 + rules.reduce((s, r) => s + (r.max ?? 0), 0),
    min1: false,
    rerollAll: rules.filter((r) => r.rerollAll), ones: rules.filter((r) => r.ones),
  };
}

/** Fluchtwurf: 2W6 zusammen; bei Fire & Flee fällt der niedrigere weg */
export function fleeSetup(rules: ChargeRule[], fireAndFlee: boolean): RollSetup {
  return {
    dice: 2, keep: fireAndFlee ? 'highest' : 'sum',
    d6: rules.some((r) => r.d6), d3: false,
    plus: rules.reduce((s, r) => s + (r.plus ?? 0), 0),
    cap: null, min1: true,
    rerollAll: rules.filter((r) => r.rerollAll), ones: rules.filter((r) => r.ones),
  };
}

/** Ergebnis, sobald alle Würfel liegen: behaltene und gestrichene Würfel, Summe und Erklärung */
export function rollTotal(d: RollDice, s: RollSetup): { total: number; dropped: number[]; text: string } | null {
  const base = d.base.slice(0, s.dice);
  if (base.length < s.dice || base.some((x) => x == null) || (s.d6 && d.d6 == null) || (s.d3 && d.d3 == null)) return null;
  const v = base as number[];
  let kept: number[];
  let dropped: number[] = [];
  if (s.keep === 'sum') kept = v.map((_, i) => i);
  else {
    const pick = v.reduce((best, x, i) => ((s.keep === 'highest' ? x > v[best] : x < v[best]) ? i : best), 0);
    kept = [pick];
    dropped = v.map((_, i) => i).filter((i) => i !== pick);
  }
  const parts: string[] = [s.keep === 'sum' ? v.join(' + ') : `${s.keep} of ${v.join(', ')} = ${v[kept[0]]}`];
  let total = kept.reduce((sum, i) => sum + v[i], 0);
  if (s.d6) { total += d.d6!; parts.push(`+D6 ${d.d6}`); }
  if (s.d3) { total += d.d3!; parts.push(`+D3 ${d.d3}`); }
  if (s.plus) { total += s.plus; parts.push(s.plus > 0 ? `+${s.plus}` : `−${-s.plus}`); }
  if (s.min1 && total < 1) { total = 1; parts.push('minimum 1'); }
  if (s.cap !== null && total > s.cap) { total = s.cap; parts.push(`limited to ${s.cap}`); }
  return { total, dropped, text: parts.join(', ') };
}

/** Reaktionen, die ein Ziel wählen kann, mit Hinweis, wann sie erlaubt sind (canShoot: hat eine Fernkampfwaffe) */
export function reactionChoices(on: string[], distance: number, chargerMove: number, fleeing: boolean, canShoot = true):
  { key: ChargeReaction; label: string; hint: string; allowed: boolean }[] {
  const tooClose = distance < chargerMove && !on.includes('Quick Shot (target)');
  return [
    { key: 'hold', label: 'Hold', hint: 'take the charge', allowed: !fleeing },
    { key: 'standShoot', label: 'Stand & Shoot',
      hint: !canShoot ? 'not possible: the unit has no missile weapon'
        : tooClose ? `not allowed: the charger is closer (${distance.toFixed(1)}″) than its Movement (${chargerMove}″)` : 'shoot at the charger, then hold',
      allowed: !fleeing && !tooClose && canShoot },
    { key: 'flee', label: 'Flee', hint: fleeing ? 'fleeing units must flee' : 'turn directly away from the charger and flee 2D6″', allowed: true },
    { key: 'fireFlee', label: 'Fire & Flee', hint: canShoot ? 'shoot, then flee (needs the Fire & Flee rule)' : 'not possible: the unit has no missile weapon',
      allowed: !fleeing && canShoot && on.includes('Fire & Flee (target)') },
    { key: 'counter', label: 'Counter Charge', hint: 'only against cavalry, chariots or monsters charging the front (needs Counter Charge)',
      allowed: !fleeing && on.includes('Counter Charge (target)') },
  ];
}

/** Initiative-Bonus des Angreifers: +1 je volle 1″ Bewegung, höchstens +3 von vorn, +4 in Flanke oder Rücken */
export function chargeInitiative(distance: number, side: string): number {
  return Math.min(side === 'front' ? 3 : 4, Math.max(0, Math.floor(distance)));
}

/** Schlüssel einer Regel im Fenster: Name und Seite (die gleiche Regel kann Angreifer und Ziel betreffen) */
export const ruleKey = (r: ChargeRule) => `${r.name} (${r.side})`;
