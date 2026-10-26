import { describe, expect, it } from 'vitest';
import { overlappingUnits } from './collision';
import { rearFree, unitLayout } from './store';
import { byId, MM, testUnit } from './testUnits';

const B = 25 * MM;

describe('unitLayout', () => {
  it('builds ranks from the model count and the frontage', () => {
    const l = unitLayout(testUnit('u', { models: 12, width: 5 }));
    expect([l.cols, l.ranks]).toEqual([5, 3]);
    expect(l.w).toBeCloseTo(5 * B, 5);
    expect(l.h).toBeCloseTo(3 * B, 5);
    expect(l.slots).toHaveLength(12);
  });

  it('puts command models next to the centre of the front rank', () => {
    const l = unitLayout(testUnit('u', { models: 10, width: 5, command: ['M', 'S', 'C'] }));
    const cols = l.slots.filter((s) => s.label).map((s) => Math.round((s.x + l.w / 2) / B));
    expect(cols).toEqual([1, 2, 3]);
  });

  it('places a joined character in the middle of the front rank', () => {
    const host = testUnit('h', { models: 10, width: 5 });
    const hero = { ...testUnit('c'), joinedTo: 'h' };
    const l = unitLayout(host, byId(host, hero));
    const slot = l.slots.find((s) => s.charId === 'c')!;
    expect(slot.y).toBeCloseTo(-l.h / 2, 5);
    expect(slot.x + slot.w / 2).toBeCloseTo(0, 5);
  });

  it('reports free places in the last rank', () => {
    expect(rearFree(testUnit('u', { models: 12, width: 5 }))).toBe(3);
    expect(rearFree(testUnit('u', { models: 10, width: 5 }))).toBe(0);
  });
});

describe('overlappingUnits', () => {
  it('finds overlapping units but not ones that only touch', () => {
    const a = testUnit('a', { models: 5 });
    const touching = testUnit('b', { owner: 'p2', models: 5, y: B });
    const overlapping = testUnit('c', { owner: 'p2', models: 5, y: B / 2 });
    expect(overlappingUnits(a, byId(a, touching))).toHaveLength(0);
    expect(overlappingUnits(a, byId(a, overlapping)).map((u) => u.id)).toEqual(['c']);
  });
});
