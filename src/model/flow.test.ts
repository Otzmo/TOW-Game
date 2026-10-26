import { describe, expect, it } from 'vitest';
import { alignToBases, chargePathCheck, chargeTravel, contactPoses, minChargeDistance } from './flow';
import { byId, MM, testUnit } from './testUnits';

// Ziel blickt nach unten (+y), der Angreifer steht darunter und blickt nach oben (−y)
const B = 25 * MM;

describe('contactPoses (charge maximising)', () => {
  it('a straight charge that already lines up stays put and has every front-rank model in contact', () => {
    const target = testUnit('t', { owner: 'p2', models: 5, rotation: Math.PI });
    const charger = testUnit('c', { models: 5, y: 6 + B });
    const best = contactPoses(charger, target, byId(target, charger))[0];
    expect(best.side).toBe('front');
    expect(best.chargerContacts).toBe(5);
    expect(best.targetContacts).toBe(5);
    expect(best.shift).toBeCloseTo(0, 5);
    expect(best.x).toBeCloseTo(0, 5);
  });

  it('a 50 mm cannon touches four 25 mm models, two of them only at the edge', () => {
    const target = testUnit('t', { owner: 'p2', models: 5, rotation: Math.PI });
    // leicht neben einer Base-Grenze: wird auf die Grenze gerückt
    const cannon = testUnit('c', { base: [50, 100], x: 0.3, y: 8 });
    const best = contactPoses(cannon, target, byId(target, cannon))[0];
    expect(best.chargerContacts).toBe(1);
    expect(best.targetContacts).toBe(4);
  });

  it('bases that only meet edge to edge count as contact, so no shift is needed', () => {
    const target = testUnit('t', { owner: 'p2', models: 1, rotation: Math.PI });
    // genau eine Base-Breite daneben: Kante an Kante
    const charger = testUnit('c', { models: 1, x: B, y: 6 });
    const best = contactPoses(charger, target, byId(target, charger))[0];
    expect(best.chargerContacts).toBe(1);
    expect(best.targetContacts).toBe(1);
    expect(best.shift).toBeCloseTo(0, 5);
  });

  it('after the front rank, as many target models as possible get into contact (edge to edge counts)', () => {
    // Ziel 10 Bases breit (−5 B … 5 B), Angreifer 5 Bases breit, nicht auf den Base-Grenzen
    const target = testUnit('t', { owner: 'p2', models: 10, width: 10, rotation: Math.PI });
    const charger = testUnit('c', { models: 5, x: 3.3 * B, y: 6 });
    const best = contactPoses(charger, target, byId(target, charger))[0];
    expect(best.chargerContacts).toBe(5);
    // auf die Base-Grenzen gerückt: 5 Bases voll, je eine links und rechts an der Kante
    expect(best.targetContacts).toBe(7);
    expect(best.x).toBeCloseTo(1.5 * B, 5);
    // ganz außerhalb: hineinschieben bis zur nächsten Lage mit allen Kontakten
    const far = testUnit('f', { models: 5, x: 8 * B, y: 6 });
    const moved = contactPoses(far, target, byId(target, far))[0];
    expect(moved.chargerContacts).toBe(5);
    expect(moved.targetContacts).toBe(7);
    expect(moved.x).toBeCloseTo(1.5 * B, 5);
  });

  it('prefers the edge the charger is standing in front of', () => {
    const target = testUnit('t', { owner: 'p2', models: 5, rotation: Math.PI });
    const flanker = testUnit('c', { models: 1, x: -8, rotation: Math.PI / 2 });
    expect(contactPoses(flanker, target, byId(target, flanker))[0].side).toMatch(/flank/);
  });
});

describe('charge distances', () => {
  const target = testUnit('t', { owner: 'p2', models: 5, rotation: Math.PI });
  const charger = testUnit('c', { models: 5, y: 6 + B });
  const units = byId(target, charger);

  it('minimum charge distance is the gap between the fronts', () => {
    expect(minChargeDistance(charger, target, units)).toBeCloseTo(6, 5);
  });

  it('travel to the contact pose of a straight charge equals the gap', () => {
    const best = contactPoses(charger, target, units)[0];
    expect(chargeTravel(charger, best, units)).toBeCloseTo(6, 5);
  });

  it('a target straight ahead needs no wheel, one behind cannot be reached', () => {
    expect(chargePathCheck(charger, { x: 0, y: B, rotation: 0 }, units)).toEqual({ ok: true, note: 'straight ahead' });
    expect(chargePathCheck(charger, { x: 0, y: 12, rotation: 0 }, units).ok).toBe(false);
  });
});

describe('alignToBases', () => {
  it('snaps the charger onto the base boundaries of the target', () => {
    // Kante 5 Bases lang (halbe Länge 2,5), Angreifer 2 Bases breit: erlaubte Mitten bei ±0,5, ±1,5
    expect(alignToBases(0.1, 2.5, 1, 2)).toBeCloseTo(0.5, 5);
    expect(alignToBases(-0.1, 2.5, 1, 2)).toBeCloseTo(-0.5, 5);
    expect(alignToBases(1.2, 2.5, 1, 2)).toBeCloseTo(1.5, 5);
  });

  it('keeps at least one base touching the edge', () => {
    expect(alignToBases(10, 2.5, 1, 2)).toBeCloseTo(2.5, 5);
    expect(alignToBases(-10, 2.5, 1, 2)).toBeCloseTo(-2.5, 5);
  });
});
