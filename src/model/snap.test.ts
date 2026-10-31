import { describe, expect, it } from 'vitest';
import { snapTogether, touchingEnemies } from './snap';
import { unitFootprint } from './store';
import { byId, testUnit } from './testUnits';
import type { Point } from './types';

const B = 25 / 25.4;

describe('snap units together', () => {
  it('a unit released 0.8″ beside the flank turns its front to the flank and lies flush against it', () => {
    const a = testUnit('a', { models: 5 });
    const w = unitFootprint(a).w;
    const b = testUnit('b', { owner: 'p2', models: 5, x: w + 0.8, y: 0.4, rotation: 0.1 });
    const r = snapTogether(b, byId(a, b))!;
    expect(r.to.id).toBe('a');
    // Front zeigt nach links, also auf die rechte Flanke von a
    expect(Math.sin(r.pose.rotation)).toBeCloseTo(-1, 6);
    expect(r.pose.x).toBeCloseTo(w / 2 + unitFootprint(b).h / 2, 6);
  });

  it('never sticks with its flank to an enemy front: a unit turned sideways below the front is turned to face it', () => {
    // Gegner schaut nach unten (+y); eigene Einheit steht davor, aber um 90° gedreht und seitlich versetzt
    const a = testUnit('a', { models: 5, rotation: Math.PI });
    const { w } = unitFootprint(a);
    const b = testUnit('b', { owner: 'p2', models: 25, width: 5, x: w / 2 + 1.5, y: 4, rotation: -Math.PI / 2 });
    const r = snapTogether({ ...b, y: B / 2 + unitFootprint(b).w / 2 + 0.3 }, byId(a, b))!;
    // Front nach oben zum Gegner, bündig an dessen Front
    expect(Math.cos(r.pose.rotation)).toBeCloseTo(1, 6);
    expect(r.pose.y).toBeCloseTo(B / 2 + unitFootprint(b).h / 2, 6);
  });

  it('a slight overlap is pushed out to touch', () => {
    const a = testUnit('a', { models: 5 });
    const b = testUnit('b', { owner: 'p2', models: 5, y: B - 0.4 });
    expect(snapTogether(b, byId(a, b))!.pose.y).toBeCloseTo(B, 6);
  });

  it('nothing happens when the units are far apart or both belong to the same player', () => {
    const a = testUnit('a', { models: 5 });
    const far = testUnit('b', { owner: 'p2', models: 5, y: B + 2 });
    expect(snapTogether(far, byId(a, far))).toBeNull();
    const friend = testUnit('f', { models: 5, y: B + 0.2 });
    expect(snapTogether(friend, byId(a, friend))).toBeNull();
  });

  it('snaps at any angle: a unit at 40° is turned parallel and laid against the enemy', () => {
    const a = testUnit('a', { models: 5 });
    const steep = testUnit('c', { owner: 'p2', models: 5, y: B + 0.3, rotation: (40 * Math.PI) / 180 });
    const r = snapTogether(steep, byId(a, steep))!;
    expect(Math.cos(r.pose.rotation)).toBeCloseTo(1, 6);
    expect(r.pose.y).toBeCloseTo(B, 6);
  });

  it('front to front it maximises: as many models in contact as possible, corners count', () => {
    // Gegner 3 Modelle breit, Angreifer 5 breit, beim Loslassen weit seitlich versetzt
    const a = testUnit('a', { models: 3, rotation: Math.PI });
    const b = testUnit('b', { owner: 'p2', models: 5, x: 2.6 * B, y: B + 0.4 });
    const r = snapTogether(b, byId(a, b))!;
    expect(r.pose.y).toBeCloseTo(B, 6);
    // Alle drei gegnerischen Modelle berührt: mittig darunter (Ecken der äußeren Bases zählen)
    expect(Math.abs(r.pose.x)).toBeLessThanOrEqual(B + 1e-6);
  });

  it('a unit already in contact can be corrected along the edge without jumping back to the maximised spot', () => {
    const a = testUnit('a', { models: 3, rotation: Math.PI });
    const b = testUnit('b', { owner: 'p2', models: 5, x: 2.6 * B, y: B + 0.4 });
    const first = snapTogether(b, byId(a, b))!;
    const placed = { ...b, ...first.pose };
    const keep = touchingEnemies(placed, byId(a, placed));
    expect(keep.has('a')).toBe(true);
    // Von Hand 1,5 Bases zur Seite geschoben (leicht abgehoben): bleibt dort, nur bündig angelegt
    const corrected = { ...placed, x: placed.x + 1.5 * B, y: B + 0.2 };
    const r = snapTogether(corrected, byId(a, corrected), keep)!;
    expect(r.pose.x).toBeCloseTo(placed.x + 1.5 * B, 6);
    expect(r.pose.y).toBeCloseTo(B, 6);
  });

  /** Einheit 5 × 5 schräg vor der rechten vorderen Ecke eines Gegners, der nach unten (+y) schaut */
  const diagonal = (forward: Point, left: Point) => {
    const a = testUnit('a', { models: 10, width: 5, rotation: Math.PI });
    const r = Math.atan2(forward.x, -forward.y);
    const right = { x: Math.cos(r), y: Math.sin(r) };
    const half = unitFootprint(testUnit('x', { models: 25, width: 5 })).w / 2;
    const b = testUnit('b', { owner: 'p2', models: 25, width: 5, rotation: r,
      x: left.x + right.x * half - forward.x * half, y: left.y + right.y * half - forward.y * half });
    return snapTogether(b, byId(a, b))!;
  };

  it('straight ahead: more than half of the lane in the enemy front snaps into the front, even from the corner', () => {
    const r = diagonal({ x: -0.5, y: -Math.sqrt(3) / 2 }, { x: 1.0, y: 2.0 });
    expect(Math.cos(r.pose.rotation)).toBeCloseTo(1, 6);
    expect(r.pose.y).toBeCloseTo(B + unitFootprint(testUnit('x', { models: 25, width: 5 })).h / 2, 6);
  });

  it('straight ahead: a lane that mostly hits the flank snaps to the flank', () => {
    const f = { x: -Math.cos(0.436), y: -Math.sin(0.436) };
    const r = diagonal(f, { x: 2.7, y: 1.6 });
    // Front nach links, auf die Flanke des Gegners
    expect(Math.sin(r.pose.rotation)).toBeCloseTo(-1, 6);
  });

  it('facing each other (180°) snaps front to front', () => {
    const a = testUnit('a', { models: 5, rotation: Math.PI });
    const b = testUnit('b', { owner: 'p2', models: 5, y: B + 0.3 });
    const r = snapTogether(b, byId(a, b))!;
    expect(r.pose.y).toBeCloseTo(B, 6);
    expect(Math.cos(r.pose.rotation)).toBeCloseTo(1, 6);
  });
});
