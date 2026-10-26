import { describe, expect, it } from 'vitest';
import { basesOnTable, templateHits } from './templates';
import { byId, MM, testTemplate, testUnit } from './testUnits';

const B = 25 * MM;

describe('templateHits', () => {
  it('counts models wholly and partly under a small blast', () => {
    // 5 × 2 Modelle, Schablone (3″) mitten drauf
    const unit = testUnit('u', { models: 10, width: 5 });
    const hits = templateHits(testTemplate('smallBlast', 0, 0, 3), basesOnTable(byId(unit)));
    expect(hits.full + hits.partial).toBe(10);
    expect(hits.full).toBeGreaterThan(0);
    expect(hits.partial).toBeGreaterThan(0);
  });

  it('a template that only grazes a base counts it as partial', () => {
    const unit = testUnit('u', { models: 1 });
    // Kreis (Radius 1,5″) reicht 0,05″ in die rechte Kante der Base
    const hits = templateHits(testTemplate('smallBlast', B / 2 + 1.45, 0, 3), basesOnTable(byId(unit)));
    expect(hits).toMatchObject({ full: 0, partial: 1 });
  });

  it('misses a unit that is clear of the template', () => {
    const unit = testUnit('u', { models: 5 });
    expect(templateHits(testTemplate('largeBlast', 20, 20, 5), basesOnTable(byId(unit)))).toMatchObject({ full: 0, partial: 0 });
  });

  it('ignores destroyed units and units in ambush; joined characters count once', () => {
    const dead = { ...testUnit('d', { models: 5 }), status: 'destroyed' as const };
    const hidden = { ...testUnit('a', { models: 5 }), ambush: true };
    expect(basesOnTable(byId(dead, hidden))).toHaveLength(0);
    const host = testUnit('h', { models: 5 });
    const hero = { ...testUnit('c'), joinedTo: 'h' };
    expect(basesOnTable(byId(host, hero))).toHaveLength(6);
  });

  it('follows the direction of the flame template', () => {
    // Spitze vorn (−y), runder Kopf hinten: ein Modell im Kopf liegt ganz darunter,
    // nach einer Drehung um 180° liegt dort die schmale Spitze und trifft es nur noch teilweise
    const unit = testUnit('u', { models: 1, y: 3 });
    const flame = { ...testTemplate('flame', 0, 0, 3), h: 8 };
    const bases = basesOnTable(byId(unit));
    expect(templateHits(flame, bases)).toMatchObject({ full: 1, partial: 0 });
    expect(templateHits({ ...flame, rotation: Math.PI }, bases)).toMatchObject({ full: 0, partial: 1 });
  });
});
