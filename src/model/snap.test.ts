import { describe, expect, it } from 'vitest';
import { snapTogether } from './snap';
import { unitFootprint } from './store';
import { byId, testUnit } from './testUnits';

const B = 25 / 25.4;

describe('snap units together', () => {
  it('a unit released 0.8″ beside another snaps flush, parallel, and stays where it was along the edge', () => {
    const a = testUnit('a', { models: 5 });
    const w = unitFootprint(a).w;
    const b = testUnit('b', { models: 5, x: w + 0.8, y: 0.4, rotation: 0.1 });
    const r = snapTogether(b, byId(a, b))!;
    expect(r.to.id).toBe('a');
    expect(r.pose.rotation).toBeCloseTo(0, 6);
    expect(r.pose.x).toBeCloseTo(w, 6);
    expect(r.pose.y).toBeCloseTo(0.4, 6);
  });

  it('a slight overlap is pushed out to touch', () => {
    const a = testUnit('a', { models: 5 });
    const b = testUnit('b', { models: 5, y: B - 0.4 });
    expect(snapTogether(b, byId(a, b))!.pose.y).toBeCloseTo(B, 6);
  });

  it('nothing happens when the units are far apart or at a steep angle', () => {
    const a = testUnit('a', { models: 5 });
    expect(snapTogether(testUnit('b', { models: 5, y: B + 2 }), byId(a, testUnit('b', { models: 5, y: B + 2 })))).toBeNull();
    const steep = testUnit('c', { models: 5, y: B + 0.2, rotation: Math.PI / 4 });
    expect(snapTogether(steep, byId(a, steep))).toBeNull();
  });

  it('facing each other (180°) snaps front to front', () => {
    const a = testUnit('a', { models: 5, rotation: Math.PI });
    const b = testUnit('b', { models: 5, y: B + 0.3 });
    const r = snapTogether(b, byId(a, b))!;
    expect(r.pose.y).toBeCloseTo(B, 6);
    expect(Math.cos(r.pose.rotation)).toBeCloseTo(1, 6);
  });
});
