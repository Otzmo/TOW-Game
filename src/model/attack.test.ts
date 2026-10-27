import { describe, expect, it } from 'vitest';
import {
  armourBane, baseToHit, baseToWound, finalNeed, needText, rangeMods, saveMods, successes, weaponAp, weaponRange, weaponStrength,
} from './attack';
import { testUnit } from './testUnits';

/** Einheit mit Profil M WS BS S T W I A Ld */
const withProfile = (id: string, values: string[]) => ({ ...testUnit(id), info: { ...testUnit(id).info, profile: [{ name: id, values }] } });

describe('weapon values', () => {
  it('resolves strength relative to the model', () => {
    expect(weaponStrength('S', 3)).toBe(3);
    expect(weaponStrength('S+2', 3)).toBe(5);
    expect(weaponStrength('4', 3)).toBe(4);
    // Klammerwert gilt nur in Sonderfällen
    expect(weaponStrength('5(10)', 3)).toBe(5);
  });

  it('reads AP and range', () => {
    expect(weaponAp('-1')).toBe(-1);
    expect(weaponAp('-1(-2)')).toBe(-1);
    expect(weaponAp('-')).toBe(0);
    expect(weaponAp('N/A')).toBe(0);
    expect(weaponRange('24"')).toBe(24);
    expect(weaponRange('12-60"')).toBe(60);
    expect(weaponRange('Combat')).toBeNull();
  });

  it('finds Armour Bane', () => {
    expect(armourBane(['Armour Bane (2)', 'Cannon Fire'])).toBe(2);
    expect(armourBane(['Volley Fire'])).toBe(0);
  });
});

describe('base values', () => {
  const archer = withProfile('a', ['4', '3', '3', '3', '3', '1', '3', '1', '7']);
  const knight = withProfile('k', ['4', '4', '3', '4', '3', '1', '3', '1', '8']);

  it('shooting uses BS, combat compares WS', () => {
    expect(baseToHit('shooting', archer, knight)).toEqual({ need: 4, why: 'BS 3' });
    expect(baseToHit('combat', knight, archer).need).toBe(3);
    expect(baseToHit('combat', archer, knight).need).toBe(4);
  });

  it('to wound compares Strength with Toughness', () => {
    expect(baseToWound(4, 3).need).toBe(3);
    expect(baseToWound(3, 3).need).toBe(4);
    expect(baseToWound(5, 3).need).toBe(2);
    expect(baseToWound(2, 4).need).toBe(6);
  });
});

describe('modifiers', () => {
  it('a −1 makes the roll harder, a +1 easier, never better than 2+', () => {
    expect(finalNeed(4, [{ label: 'Long range', value: -1 }], 'hit')).toEqual({ need: 5, then: null });
    expect(finalNeed(3, [{ label: 'Rule', value: 2 }], 'hit')).toEqual({ need: 2, then: null });
  });

  it('to hit beyond 6+ needs a 6 and then 4+, 5+ or 6+; 10+ cannot hit', () => {
    expect(needText(finalNeed(6, [{ label: 'Cover', value: -1 }], 'hit'))).toBe('6, then 4+');
    expect(needText(finalNeed(6, [{ label: 'a', value: -3 }], 'hit'))).toBe('6, then 6+');
    expect(finalNeed(6, [{ label: 'a', value: -4 }], 'hit').need).toBeNull();
  });

  it('wounds and saves beyond 6+ are impossible', () => {
    expect(finalNeed(6, [{ label: 'a', value: -1 }], 'wound').need).toBeNull();
    expect(finalNeed(5, [{ label: 'AP -2', value: -2 }], 'save').need).toBeNull();
    expect(finalNeed(4, saveMods(-1, 'Handgun'), 'save').need).toBe(5);
  });

  it('long range applies beyond half the range', () => {
    expect(rangeMods(24, 13)).toHaveLength(1);
    expect(rangeMods(24, 12)).toHaveLength(0);
    expect(rangeMods(null, 30)).toHaveLength(0);
  });

  it('counts successes, with the second roll after sixes', () => {
    expect(successes([1, 4, 5, 6], 4)).toBe(3);
    expect(successes([6, 6, 3], 6, [4, 2], 4)).toBe(1);
    expect(successes([6, 6], null)).toBe(0);
  });
});
