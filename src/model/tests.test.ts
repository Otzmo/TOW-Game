import { describe, expect, it } from 'vitest';
import { breakResult, keptDice, testPassed } from './tests';

describe('break test', () => {
  it('natural roll above Leadership: flee', () => {
    expect(breakResult([5, 4], 8, 0, [])).toBe('flee');
  });

  it('passes naturally but fails with the combat result: fall back in good order, or flee against twice the Unit Strength', () => {
    expect(breakResult([3, 3], 8, 3, [])).toBe('fallBack');
    expect(breakResult([3, 3], 8, 3, ['Winner has twice the Unit Strength'])).toBe('flee');
  });

  it('passes with the modifier or rolls double 1: give ground', () => {
    expect(breakResult([2, 3], 8, 2, [])).toBe('giveGround');
    expect(breakResult([1, 1], 3, 9, [])).toBe('giveGround');
  });

  it('Stubborn ignores the combat result, Unbreakable never breaks', () => {
    expect(breakResult([3, 3], 8, 3, ['Stubborn'])).toBe('giveGround');
    expect(breakResult([6, 6], 8, 5, ['Unbreakable'])).toBe('giveGround');
  });

  it('Cold-blooded keeps the two lowest of three dice', () => {
    expect(keptDice([6, 2, 3])).toEqual([2, 3]);
    expect(breakResult([6, 2, 3], 7, 0, [])).toBe('giveGround');
  });
});

describe('leadership tests', () => {
  it('pass on roll plus modifier up to Leadership, or double 1', () => {
    expect(testPassed('ld', [4, 4], 8, 0, [])).toBe(true);
    expect(testPassed('ld', [4, 4], 8, 1, [])).toBe(false);
    expect(testPassed('panic', [1, 1], 2, 5, [])).toBe(true);
  });

  it('Immune to Psychology passes Panic, Fear and Terror but not other tests', () => {
    expect(testPassed('terror', [6, 6], 7, 0, ['Immune to Psychology'])).toBe(true);
    expect(testPassed('ld', [6, 6], 7, 0, ['Immune to Psychology'])).toBe(false);
  });
});
