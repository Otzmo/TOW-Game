import { describe, expect, it } from 'vitest';
import {
  armourBane, attackLines, baseToHit, baseToWound, finalNeed, lineToHit, misses, needText, rollExpr, saveMods, shooters, shootingOptions, shootingRules,
  successes, weaponAp, weaponRange, weaponStrength,
} from './attack';
import { shootingReroll, toHitCombat, toWound } from './flow';
import { byId } from './testUnits';
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
    expect(baseToHit('shooting', archer, knight)).toEqual({ need: 4, why: 'BS 3', reroll: null });
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

  it('shooting modifiers are only offered: long range shows the distance but is not ticked', () => {
    const far = shootingOptions(24, 13);
    expect(far.map((m) => m.label)).toEqual(
      ['Moving & Shooting', 'Long range', 'Stand & Shoot', 'Partial cover', 'Full cover', 'Target is skirmishers']);
    expect(far.find((m) => m.label === 'Long range')?.hint).toContain('looks like long range');
    expect(shootingOptions(24, 12).find((m) => m.label === 'Long range')?.hint).not.toContain('looks like');
    expect(far.find((m) => m.label === 'Target is skirmishers')?.value).toBe(-1);
  });

  it('counts successes, with the second roll after sixes and BS 6+ re-rolls', () => {
    expect(successes([1, 4, 5, 6], 4)).toBe(3);
    expect(successes([6, 6, 3], 6, [4, 2], 4)).toBe(1);
    expect(successes([6, 6], null)).toBe(0);
    // BS 6: 2+, Fehlschüsse (die 1en) auf 6+ wiederholt
    expect(misses([1, 1, 3, 5], 2)).toBe(2);
    expect(successes([1, 1, 3, 5], 2, [], null, [6, 2], 6)).toBe(3);
  });
});

describe('attack lines (one per profile)', () => {
  // Empire Knights: Ritter, Preceptor (Champion), Barded Warhorse (Reittier, Ld "-")
  const knights = {
    ...testUnit('k', { models: 5, command: ['S', 'M', 'C'] }),
    info: {
      ...testUnit('k').info, command: ['S', 'M', 'C'], startModels: 5,
      profile: [
        { name: 'Empire Knight', values: ['-', '4', '3', '3', '3', '1', '3', '1', '8'] },
        { name: 'Preceptor', values: ['-', '4', '3', '3', '3', '1', '3', '2', '8'] },
        { name: 'Barded Warhorse', values: ['7', '3', '-', '3', '-', '-', '3', '1', '-'] },
      ],
    },
  };

  it('splits knights into riders, champion and horses in combat', () => {
    const lines = attackLines(knights, byId(knights), 'combat');
    expect(lines.map((l) => [l.label, l.models, l.count, l.mount])).toEqual([
      ['Empire Knight', 4, 4, false], ['Preceptor', 1, 2, false], ['Barded Warhorse', 5, 5, true],
    ]);
    expect(lines[2]).toMatchObject({ ws: 3, s: 3 });
  });

  it('horses do not shoot; the champion shoots in the front rank', () => {
    const lines = attackLines(knights, byId(knights), 'shooting');
    expect(lines.map((l) => [l.label, l.count])).toEqual([['Empire Knight', 4], ['Preceptor', 1]]);
  });

  it('without the champion option the second row is not used', () => {
    const plain = { ...knights, info: { ...knights.info, command: ['S'] } };
    expect(attackLines(plain, byId(plain), 'combat').map((l) => l.label)).toEqual(['Empire Knight', 'Barded Warhorse']);
  });

  it('joined characters fight with their own profile', () => {
    const general = { ...withProfile('g', ['4', '6', '5', '4', '4', '3', '6', '4', '9']), joinedTo: 'k', info: { ...withProfile('g', ['4', '6', '5', '4', '4', '3', '6', '4', '9']).info, name: 'General' } };
    const lines = attackLines(knights, byId(knights, general), 'combat');
    expect(lines.at(-1)).toMatchObject({ label: 'General', models: 1, count: 4, ws: 6, s: 4 });
  });

  it('to hit uses the line, e.g. WS 3 horses against WS 3', () => {
    const lines = attackLines(knights, byId(knights), 'combat');
    const target = withProfile('t', ['4', '3', '3', '3', '3', '1', '3', '1', '7']);
    expect(lineToHit('combat', lines[2], target).need).toBe(4);
    expect(lineToHit('combat', lines[0], target).need).toBe(3);
  });
});

describe('missile weapon rules', () => {
  it('only the front rank shoots; Volley Fire adds half of each further rank, rounded up', () => {
    const archers = testUnit('a', { models: 25, width: 5 });
    expect(shooters(archers, byId(archers), false, false)).toBe(5);
    expect(shooters(archers, byId(archers), false, true)).toBe(5 + 4 * 3);
    // auf einem Hügel schießen zwei Glieder, Volley Fire für die übrigen drei
    expect(shooters(archers, byId(archers), true, true)).toBe(10 + 3 * 3);
    // unvollständiges letztes Glied: 12 Modelle = 5 + 5 + 2 → 5 + 3 + 1
    const twelve = testUnit('b', { models: 12, width: 5 });
    expect(shooters(twelve, byId(twelve), false, true)).toBe(9);
  });

  it('skirmishers all shoot', () => {
    const s = { ...testUnit('s', { models: 6, width: 3 }), formation: 'skirmish' as const };
    expect(shooters(s, byId(s), false, false)).toBe(6);
  });

  it('reads the rules of the weapon and the unit', () => {
    const warbow = shootingRules(['Volley Fire']);
    expect(warbow).toMatchObject({ volley: true, ponderous: false, quickShot: false, multipleShots: null });
    expect(shootingRules(['Armour Bane (1)', 'Ponderous']).ponderous).toBe(true);
    expect(shootingRules(['Multiple Shots (D3)', 'Volley Fire']).multipleShots).toBe('D3');
    expect(shootingRules(['Multiple Wounds (D3+1)']).multipleWounds).toBe('D3+1');
    expect(shootingRules(['Multiple Shots (2)'], ['Poisoned Attacks']).poisoned).toBe(true);
    expect(shootingRules([], ['Dwarf Crafted']).dwarfCrafted).toBe(true);
  });

  it('Moving & Shooting is −2 with Ponderous, 0 with Quick Shot; Stand & Shoot 0 when Dwarf Crafted', () => {
    const moving = (rules: string[], unit: string[] = []) =>
      shootingOptions(24, 10, shootingRules(rules, unit)).find((m) => m.label === 'Moving & Shooting')!.value;
    expect(moving(['Volley Fire'])).toBe(-1);
    expect(moving(['Ponderous'])).toBe(-2);
    expect(moving(['Quick Shot'])).toBe(0);
    const stand = shootingOptions(24, 10, shootingRules([], ['Dwarf Crafted'])).find((m) => m.label === 'Stand & Shoot')!;
    expect(stand.value).toBe(0);
  });

  it('rolls dice expressions for Multiple Shots and Multiple Wounds', () => {
    const fixed = () => 4;
    expect(rollExpr('2', fixed).total).toBe(2);
    expect(rollExpr('D3', fixed)).toEqual({ total: 2, dice: [2] });
    expect(rollExpr('D3+1', fixed).total).toBe(3);
    expect(rollExpr('2D6', fixed).total).toBe(8);
    expect(rollExpr('D6+1', fixed).total).toBe(5);
  });
});

describe('charts from the quick reference', () => {
  it('to hit in combat: 2+ with more than double the enemy WS', () => {
    expect(toHitCombat(3, 1)).toBe(2);
    expect(toHitCombat(5, 2)).toBe(2);
    expect(toHitCombat(4, 2)).toBe(3);
    expect(toHitCombat(10, 5)).toBe(3);
    expect(toHitCombat(4, 4)).toBe(4);
    expect(toHitCombat(4, 8)).toBe(4);
    expect(toHitCombat(4, 9)).toBe(5);
  });

  it('BS 6 and more re-roll misses: 6+ at BS 6 down to 2+ at BS 10', () => {
    expect(shootingReroll(5)).toBeNull();
    expect(shootingReroll(6)).toBe(6);
    expect(shootingReroll(8)).toBe(4);
    expect(shootingReroll(10)).toBe(2);
  });

  it('to wound: impossible when Toughness is 6 or more above Strength', () => {
    expect(toWound(1, 6)).toBe(6);
    expect(toWound(1, 7)).toBe(7);
    expect(toWound(4, 10)).toBe(7);
    expect(finalNeed(toWound(1, 7), [], 'wound').need).toBeNull();
  });
});
