import { describe, expect, it } from 'vitest';
import { CHARGE_RULES, chargeInitiative, reactionChoices, ruleKey, unitHasRule } from './charge';
import { testUnit } from './testUnits';

const allowed = (on: string[], distance: number, move: number, fleeing = false) =>
  reactionChoices(on, distance, move, fleeing).filter((c) => c.allowed).map((c) => c.key);

describe('charge reactions', () => {
  it('Hold, Stand & Shoot and Flee without special rules', () => {
    expect(allowed([], 8, 4)).toEqual(['hold', 'standShoot', 'flee']);
  });

  it('no Stand & Shoot when the charger is closer than its Movement, unless Quick Shot is ticked', () => {
    expect(allowed([], 3, 4)).toEqual(['hold', 'flee']);
    expect(allowed(['Quick Shot (target)'], 3, 4)).toContain('standShoot');
  });

  it('Fire & Flee and Counter Charge only when their rule is ticked', () => {
    expect(allowed(['Fire & Flee (target)', 'Counter Charge (target)'], 8, 4)).toEqual(['hold', 'standShoot', 'flee', 'fireFlee', 'counter']);
  });

  it('fleeing units must flee', () => {
    expect(allowed([], 8, 4, true)).toEqual(['flee']);
  });
});

describe('charge initiative bonus', () => {
  it('+1 per full inch, at most +3 in the front and +4 in flank or rear', () => {
    expect(chargeInitiative(2.9, 'front')).toBe(2);
    expect(chargeInitiative(7, 'front')).toBe(3);
    expect(chargeInitiative(7, 'left flank')).toBe(4);
    expect(chargeInitiative(0.5, 'rear')).toBe(0);
  });
});

describe('charge rules', () => {
  it('lists rules for both sides with distinct keys', () => {
    const keys = CHARGE_RULES.map(ruleKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('Swiftstride (charger)');
    expect(keys).toContain('Swiftstride (target)');
  });

  it('only hints whether a unit has a rule', () => {
    expect(unitHasRule(testUnit('k', { rules: ['Swiftstride', 'First Charge'] }), 'Swiftstride')).toBe(true);
    expect(unitHasRule(testUnit('k', { rules: ['Fire and Flee'] }), 'Fire & Flee')).toBe(true);
    expect(unitHasRule(testUnit('k'), 'Fly')).toBe(false);
  });
});
