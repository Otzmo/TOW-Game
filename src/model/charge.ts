import type { ChargeReaction, UnitState } from './types';

/** Sonderregel rund um den Angriff: wer sie hat (Angreifer oder Ziel) und was sie bewirkt */
export interface ChargeRule {
  name: string;
  side: 'charger' | 'target';
  hint: string;
}

/** Alle Regeln, die beim Angriff eine Rolle spielen – im Fenster je eine Checkbox, angehakt, wenn die Einheit die Regel hat */
export const CHARGE_RULES: ChargeRule[] = [
  { name: 'Swiftstride', side: 'charger', hint: 'charge roll +D6' },
  { name: 'Battle Hunger', side: 'charger', hint: 'charge roll +D3' },
  { name: 'Fly', side: 'charger', hint: 'may charge over other units and terrain' },
  { name: 'Furious Charge', side: 'charger', hint: '+1 Attack in a turn in which it charged' },
  { name: 'Impact Hits', side: 'charger', hint: 'impact hits are resolved before anything else' },
  { name: 'Impetuous', side: 'charger', hint: 'must declare a charge if possible' },
  { name: 'Frenzy', side: 'charger', hint: 'must declare a charge if possible' },
  { name: 'Random Movement', side: 'charger', hint: 'moves by random movement instead of a charge roll' },
  { name: 'Fire & Flee', side: 'target', hint: 'may Fire & Flee as a charge reaction' },
  { name: 'Counter Charge', side: 'target', hint: 'may Counter Charge as a charge reaction' },
  { name: 'Quick Shot', side: 'target', hint: 'may Stand & Shoot however close the charger is' },
  { name: 'Dwarf Crafted', side: 'target', hint: 'no −1 To Hit for Stand & Shoot' },
  { name: 'Swiftstride', side: 'target', hint: 'flee roll +D6' },
];

/** Hat die Einheit (oder ein Gegenstand) eine Regel dieses Namens? (dann ist die Checkbox vorab angehakt) */
export const unitHasRule = (u: UnitState, name: string) =>
  [...u.info.rules, ...u.info.items].some((r) => r.name.toLowerCase().replace(/\s*\(.*\)/, '').replace('and', '&') === name.toLowerCase()
    || r.name.toLowerCase().startsWith(name.toLowerCase()));

/** Reaktionen, die ein Ziel wählen kann, mit Hinweis, wann sie erlaubt sind */
export function reactionChoices(on: string[], distance: number, chargerMove: number, fleeing: boolean):
  { key: ChargeReaction; label: string; hint: string; allowed: boolean }[] {
  const tooClose = distance < chargerMove && !on.includes('Quick Shot (target)');
  return [
    { key: 'hold', label: 'Hold', hint: 'take the charge', allowed: !fleeing },
    { key: 'standShoot', label: 'Stand & Shoot',
      hint: tooClose ? `not allowed: the charger is closer (${distance.toFixed(1)}″) than its Movement (${chargerMove}″)` : 'shoot at the charger, then hold',
      allowed: !fleeing && !tooClose },
    { key: 'flee', label: 'Flee', hint: fleeing ? 'fleeing units must flee' : 'turn directly away from the charger and flee 2D6″', allowed: true },
    { key: 'fireFlee', label: 'Fire & Flee', hint: 'shoot, then flee (needs the Fire & Flee rule)',
      allowed: !fleeing && on.includes('Fire & Flee (target)') },
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
