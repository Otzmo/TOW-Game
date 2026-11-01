import { describe, expect, it } from 'vitest';
import { byId, testUnit } from './testUnits';
import type { BoardObject } from './types';
import { beyond, cannonShot, misfireResult } from './warMachines';

/** 1 Zoll = 25,4 mm: 25-mm-Bases sind knapp 1″ breit */
const B = 25 / 25.4;

describe('war machines', () => {
  it('moves the strike point directly away from the cannon', () => {
    expect(beyond({ x: 0, y: 0 }, { x: 0, y: 10 }, 4)).toEqual({ x: 0, y: 14 });
  });

  it('hits at most one model per rank when the cannon is in the front arc', () => {
    // 5 × 4 Einheit bei y = 20, Blick nach −y (zur Kanone bei y = 0); Kugel fliegt mitten hindurch
    const u = testUnit('u', { models: 20, width: 5, x: 0, y: 20 });
    const r = cannonShot({ x: 0, y: 0 }, { x: 0, y: 17 }, { x: 0, y: 30 }, byId(u), {});
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].models).toHaveLength(4);
  });

  it('hits at most one model per file when the cannon is in the flank arc', () => {
    const u = testUnit('u', { models: 20, width: 5, x: 20, y: 0 });
    // Von links durch das zweite Glied
    const r = cannonShot({ x: 0, y: 0 }, { x: 15, y: -0.5 * B }, { x: 30, y: -0.5 * B }, byId(u), {});
    expect(r.hits[0].models).toHaveLength(5);
  });

  it('a behemoth stops the cannonball', () => {
    const monster = { ...testUnit('m', { x: 0, y: 20, base: [100, 100] }), info: { ...testUnit('m').info, name: 'Giant', troopType: 'Behemoth' } };
    const behind = testUnit('b', { models: 5, x: 0, y: 26 });
    const r = cannonShot({ x: 0, y: 0 }, { x: 0, y: 17 }, { x: 0, y: 30 }, byId(monster, behind), {});
    expect(r.hits.map((h) => h.unit.id)).toEqual(['m']);
    expect(r.stop).toMatch(/Giant/);
  });

  it('a building stops the cannonball at its near edge', () => {
    const house: BoardObject = { id: 'h', kind: 'terrain', type: 'building', x: 0, y: 22, w: 6, h: 2, rotation: 0 };
    const behind = testUnit('b', { models: 5, x: 0, y: 26 });
    const r = cannonShot({ x: 0, y: 0 }, { x: 0, y: 17 }, { x: 0, y: 30 }, byId(behind), { h: house });
    expect(r.hits).toHaveLength(0);
    expect(r.end.y).toBeCloseTo(21, 6);
    expect(r.stop).toMatch(/near edge/);
  });

  it('reads the misfire table', () => {
    expect(misfireResult('black-powder', 1)).toMatch(/^Destroyed/);
    expect(misfireResult('black-powder', 3)).toMatch(/^Malfunction/);
    expect(misfireResult('stone-thrower', 6)).toMatch(/^Twang/);
  });
});
