import { describe, expect, it } from 'vitest';
import { byId, testUnit } from './testUnits';
import { beyond, cannonPath, misfireResult } from './warMachines';

describe('war machines', () => {
  it('moves the strike point directly away from the cannon', () => {
    expect(beyond({ x: 0, y: 0 }, { x: 0, y: 10 }, 4)).toEqual({ x: 0, y: 14 });
  });

  it('finds the units under the strike point and the bounce', () => {
    const u = testUnit('u', { models: 5, x: 0, y: 20 });
    expect(cannonPath({ x: 0, y: 15 }, { x: 0, y: 25 }, byId(u)).map((h) => h.unit.id)).toEqual(['u']);
    expect(cannonPath({ x: 30, y: 15 }, { x: 30, y: 25 }, byId(u))).toHaveLength(0);
  });

  it('reads the misfire table', () => {
    expect(misfireResult('black-powder', 1)).toMatch(/^Destroyed/);
    expect(misfireResult('black-powder', 3)).toMatch(/^Malfunction/);
    expect(misfireResult('stone-thrower', 6)).toMatch(/^Twang/);
  });
});
