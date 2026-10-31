import { describe, expect, it } from 'vitest';
import { unitFootprint } from './store';
import { byId, testUnit } from './testUnits';
import { loseWounds } from './wounds';

/** Einheit mit 3 Lebenspunkten je Modell */
const ogres = (models: number) => ({ ...testUnit('o', { models, width: 3 }), info: { ...testUnit('o').info, woundsPerModel: 3 } });

describe('losing wounds', () => {
  it('fills one model first, then the next', () => {
    const u = ogres(6);
    expect(loseWounds(u, byId(u), 2).patch).toMatchObject({ models: 6, woundsLost: 2 });
    expect(loseWounds(u, byId(u), 4)).toMatchObject({ removed: 1, patch: { models: 5, woundsLost: 1 } });
    expect(loseWounds({ ...u, woundsLost: 2 }, byId(u), 1)).toMatchObject({ removed: 1, patch: { models: 5, woundsLost: 0 } });
  });

  it('the last model stays with all wounds lost', () => {
    const u = ogres(1);
    expect(loseWounds(u, byId(u), 5).patch).toMatchObject({ models: 1, woundsLost: 3 });
  });

  it('keeps the front rank in place when a rank disappears', () => {
    const u = testUnit('u', { models: 10, width: 5, y: 10 });
    const before = unitFootprint(u).h;
    const { patch } = loseWounds(u, byId(u), 5);
    const after = { ...u, ...patch };
    // Front = Mitte − halbe Tiefe (Blick nach −y)
    expect(after.y - unitFootprint(after).h / 2).toBeCloseTo(u.y - before / 2, 6);
  });
});
