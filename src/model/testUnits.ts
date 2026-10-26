import type { BoardObject, PlayerId, UnitState } from './types';

/** Nur für Tests: eine Einheit mit den nötigsten Angaben (Bases in mm, Lage in Zoll) */
export function testUnit(id: string, opts: {
  owner?: PlayerId; models?: number; width?: number; base?: [number, number];
  x?: number; y?: number; rotation?: number; command?: string[]; rules?: string[];
} = {}): UnitState {
  const [baseWidth, baseDepth] = opts.base ?? [25, 25];
  return {
    id,
    owner: opts.owner ?? 'p1',
    info: {
      name: id, troopType: 'Regular Infantry', baseWidth, baseDepth,
      profile: [], equipment: '', options: [], items: [], command: opts.command ?? [],
      rules: (opts.rules ?? []).map((name) => ({ name, text: '' })),
    },
    models: opts.models ?? 1,
    width: opts.width ?? opts.models ?? 1,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    rotation: opts.rotation ?? 0,
  };
}

export const byId = (...units: UnitState[]): Record<string, UnitState> => Object.fromEntries(units.map((u) => [u.id, u]));

/** Nur für Tests: eine Schablone (Zoll) */
export function testTemplate(type: string, x: number, y: number, size: number, rotation = 0): BoardObject {
  return { id: `t-${type}`, kind: 'template', type, x, y, w: size, h: size, rotation };
}

/** 1 mm in Zoll */
export const MM = 1 / 25.4;
