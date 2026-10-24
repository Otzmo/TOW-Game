import { newObject, OBJECT_TYPES } from './objects';
import type { BoardObject, PlayerId, Point, SetupState } from './types';

/**
 * Schlachtfeld nach „Core Battle“ aus OTZMO-TOW (github.com/Otzmo/Battle-March):
 * sechs Aufstellungen, Missionen in zwei Gruppen und der Zufallsgenerator für Gelände.
 * Tisch 72″ × 48″, Ursprung oben links (y nach unten).
 */

export const TABLE_W = 72;
export const TABLE_H = 48;
const ZONE_DEPTH = 12;
const PASS_GAP = 24;
/** Kreis in der Mitte, frei von Gelände (bei Close Encounter auch frei von Aufstellung) */
export const CENTRE_CIRCLE = 18;
/** Mindestabstand zwischen Geländestücken (wird bei Platzmangel schrittweise verringert) */
const MIN_GAP = 6;
/** Mindestabstand Gelände – Rand eines Missionsziels */
const OBJECTIVE_GAP = 6;
export const OBJECTIVE_DIAMETER = 40 / 25.4;

export const DEPLOYMENTS: Record<string, string> = {
  pitched: 'Pitched Battle',
  close: 'Close Encounter',
  flanks: 'Opposed Flanks',
  chance: 'A Chance Encounter',
  pass: 'Mountain Pass',
  encirclement: 'Encirclement',
};

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/** Die beiden Zonen jeder Aufstellung vor dem Spiegeln (A unten bzw. links, B gegenüber). */
const PRESETS: Record<string, () => [Point[], Point[]]> = {
  pitched: () => [rect(0, TABLE_H - ZONE_DEPTH, TABLE_W, TABLE_H), rect(0, 0, TABLE_W, ZONE_DEPTH)],
  close: () => [rect(0, 0, TABLE_W / 2, TABLE_H / 2), rect(TABLE_W / 2, TABLE_H / 2, TABLE_W, TABLE_H)],
  flanks: () => [
    [{ x: 0, y: 0 }, { x: TABLE_W, y: 0 }, { x: 0, y: TABLE_H / 2 }],
    [{ x: TABLE_W, y: TABLE_H }, { x: 0, y: TABLE_H }, { x: TABLE_W, y: TABLE_H / 2 }],
  ],
  chance: () => [rect(0, 0, TABLE_W * 0.75, ZONE_DEPTH), rect(TABLE_W * 0.25, TABLE_H - ZONE_DEPTH, TABLE_W, TABLE_H)],
  pass: () => {
    const zb = (TABLE_W - PASS_GAP) / 2;
    return [rect(0, 0, zb, TABLE_H), rect(TABLE_W - zb, 0, TABLE_W, TABLE_H)];
  },
  encirclement: () => [
    [{ x: 0, y: TABLE_H }, { x: 0, y: 0 }, { x: TABLE_W / 2, y: 0 }],
    [{ x: TABLE_W, y: 0 }, { x: TABLE_W, y: TABLE_H }, { x: TABLE_W / 2, y: TABLE_H }],
  ],
};

/** Zonen beider Spieler auf dem Tisch (gespiegelt und zugeteilt wie im Aufbau festgelegt). */
export function deploymentZones(setup: SetupState | undefined): Record<PlayerId, Point[]> | null {
  if (!setup?.deployment || !PRESETS[setup.deployment]) return null;
  const flip = (pts: Point[]) => pts.map((p) => ({
    x: setup.flipX ? TABLE_W - p.x : p.x,
    y: setup.flipY ? TABLE_H - p.y : p.y,
  }));
  const [a, b] = PRESETS[setup.deployment]().map(flip);
  // Spieler 1 hat Zone A, außer der Verteidiger hat getauscht
  return setup.swapZones ? { p1: b, p2: a } : { p1: a, p2: b };
}

/** Bei Close Encounter darf im Mittelkreis niemand aufstellen. */
export const circleBlocksDeployment = (setup: SetupState | undefined) => setup?.deployment === 'close';

// --- Missionen -----------------------------------------------------------------

export interface Mission {
  key: string;
  name: string;
  /** Wann gewertet wird */
  group: 'turn' | 'game';
  rule: string;
  /** Missionsziele als Anteile von Breite und Tiefe; eine Variante wird ausgewürfelt */
  objectives?: [number, number][][];
  /** Ruine (7″ × 7″) in der Tischmitte */
  ruin?: boolean;
}

export const SCORING_RULES =
  'Scoring Units: All units with US 10 or higher that do not have the Fly (X) special rule count as scoring units. ' +
  'Tiebreakers to determine control are Banner > Proximity > US.\n' +
  'Scoring Check: Checks for the control of objectives and scoring take place at the end of each player turn. ' +
  'For any "End of game" objectives, this takes place at the end of the game.';

export const MISSIONS: Mission[] = [
  { key: 'locations', name: 'Strategic Locations', group: 'turn',
    rule: 'There are 3 strategic locations, each marked by a 40 mm round base. A strategic location is controlled by a scoring unit within 6" of it. 30 Victory Points per scoring.',
    objectives: [[[0.25, 0.5], [0.5, 0.5], [0.75, 0.5]], [[0.5, 0.25], [0.5, 0.5], [0.5, 0.75]]] },
  { key: 'domination', name: 'Domination', group: 'turn',
    rule: '30 Victory Points per scoring. To score a Quarter, a unit must be completely within that Quarter. Each unit can only score one Quarter and counts only models from scoring units.' },
  { key: 'banners', name: 'Hold the Banners High', group: 'turn',
    rule: 'The player with more scoring units with a banner completely outside of its deployment zone receives 90 VP per scoring. (You don\'t multiply 90 times the banners, just check who has more.)' },
  { key: 'ruin', name: 'The Ruin', group: 'game', ruin: true,
    rule: 'A ruin, 7" × 7", is placed in the centre of the battlefield. The ruin is controlled by a scoring unit that is completely within it. 300 VP per scoring (300 total).' },
  { key: 'baggage', name: 'Baggage Train', group: 'game',
    rule: 'Each player has a Baggage Train (the Defender places theirs first, together with additional terrain). Each destroyed Baggage Train is worth 300 VP.' },
  { key: 'holdline', name: 'Hold the Line', group: 'game',
    rule: 'Have two scoring units within your opponent\'s deployment zone for 300 VP.' },
];

export const missionByKey = (key: string | null | undefined) => MISSIONS.find((m) => m.key === key);

/** Regeln für Gelände aus OTZMO-TOW (Core Battle) */
export const TERRAIN_RULES = 'All terrain features have clearly defined edges (area terrain) and block line of sight behind them.';

// --- Zufallsgenerator -----------------------------------------------------------

/** Geländestücke für den Generator (Maße wie in OTZMO-TOW Core Battle) */
export const GENERATED_TERRAIN = ['woods', 'building', 'hill', 'ruins', 'field', 'lake'];

export interface GeneratorChoice {
  deployments: string[];
  turnMissions: string[];
  gameMissions: string[];
}

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

interface Box { x: number; y: number; w: number; d: number }

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
const gapOk = (a: Box, b: Box, gap: number) => {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.d), a.y - (b.y + b.d));
  return Math.hypot(dx, dy) >= gap;
};
const clearOfCircle = (r: Box) => {
  const cx = TABLE_W / 2;
  const cy = TABLE_H / 2;
  const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
  const ny = Math.max(r.y, Math.min(cy, r.y + r.d));
  return Math.hypot(nx - cx, ny - cy) >= CENTRE_CIRCLE / 2;
};
const clearOfObjectives = (r: Box, objectives: Point[]) => objectives.every((o) => {
  const nx = Math.max(r.x, Math.min(o.x, r.x + r.w));
  const ny = Math.max(r.y, Math.min(o.y, r.y + r.d));
  return Math.hypot(nx - o.x, ny - o.y) >= OBJECTIVE_GAP + OBJECTIVE_DIAMETER / 2;
});

/**
 * Würfelt Aufstellung und je Gruppe eine Mission aus und verteilt das Gelände wie OTZMO-TOW:
 * größte Stücke zuerst, quer oder längs, mindestens 6″ Abstand (wenn nötig weniger, nie überlappend),
 * Mittelkreis und Missionsziele bleiben frei. Bei „The Ruin“ steht die Ruine in der Mitte.
 */
export function generateBattlefield(choice: GeneratorChoice):
  { setup: Pick<SetupState, 'deployment' | 'flipX' | 'flipY' | 'missionTurn' | 'missionGame'>; objects: BoardObject[] } {
  const deployment = pick(choice.deployments.length ? choice.deployments : Object.keys(DEPLOYMENTS));
  // Ein Ziel genau in der Mitte verträgt sich nicht mit der Ruine dort – solche Paare neu ziehen, solange es anders geht
  const centreObjective = (m?: Mission) => !!m?.objectives?.every((v) => v.some(([fx, fy]) => fx === 0.5 && fy === 0.5));
  let missionTurn: string | null = null;
  let missionGame: string | null = null;
  for (let i = 0; i < 30; i++) {
    missionTurn = choice.turnMissions.length ? pick(choice.turnMissions) : null;
    missionGame = choice.gameMissions.length ? pick(choice.gameMissions) : null;
    if (!(missionByKey(missionGame)?.ruin && centreObjective(missionByKey(missionTurn)))) break;
  }
  const missions = [missionByKey(missionTurn), missionByKey(missionGame)].filter((m): m is Mission => !!m);

  const objectives: Point[] = [];
  for (const m of missions) {
    if (m.objectives) for (const [fx, fy] of pick(m.objectives)) objectives.push({ x: TABLE_W * fx, y: TABLE_H * fy });
  }
  const ruin = missions.some((m) => m.ruin);
  const ruinType = OBJECT_TYPES.ruins;
  const ruinBox: Box | null = ruin ? { x: TABLE_W / 2 - ruinType.w / 2, y: TABLE_H / 2 - ruinType.h / 2, w: ruinType.w, d: ruinType.h } : null;
  // Ein Ziel genau in der Mitte verträgt sich nicht mit der Ruine dort
  const objectivesFree = ruin ? objectives.filter((o) => !(Math.abs(o.x - TABLE_W / 2) < 0.1 && Math.abs(o.y - TABLE_H / 2) < 0.1)) : objectives;

  const order = GENERATED_TERRAIN
    .filter((t) => !(ruin && t === 'ruins'))
    .map((type) => ({ type, area: OBJECT_TYPES[type].w * OBJECT_TYPES[type].h }))
    .sort((a, b) => b.area - a.area);

  const attempt = () => {
    const placed: Box[] = ruinBox ? [ruinBox] : [];
    const result: { type: string; box: Box; rotated: boolean }[] = [];
    let allOk = true;
    for (const { type } of order) {
      const t = OBJECT_TYPES[type];
      const rotated = Math.random() < 0.5;
      const w = rotated ? t.h : t.w;
      const d = rotated ? t.w : t.h;
      let found: Box | null = null;
      for (let gap = MIN_GAP; gap >= 0 && !found; gap--) {
        const spots: Box[] = [];
        for (let x = 0; x <= TABLE_W - w; x++) {
          for (let y = 0; y <= TABLE_H - d; y++) {
            const box = { x, y, w, d };
            if (!clearOfCircle(box) || !clearOfObjectives(box, objectivesFree)) continue;
            if (placed.some((p) => overlap(box, p) || (gap > 0 && !gapOk(box, p, gap)))) continue;
            spots.push(box);
          }
        }
        if (spots.length) found = pick(spots);
        else if (gap === MIN_GAP) allOk = false;
      }
      if (!found) continue; // lieber weglassen als überlappen
      placed.push(found);
      result.push({ type, box: found, rotated });
    }
    return { result, allOk };
  };

  let best = attempt();
  for (let i = 0; i < 7 && !best.allOk; i++) {
    const next = attempt();
    if (next.allOk) {
      best = next;
      break;
    }
  }

  const objects: BoardObject[] = best.result.map(({ type, box, rotated }) => ({
    ...newObject(type, { x: box.x + box.w / 2, y: box.y + box.d / 2 }),
    rotation: rotated ? Math.PI / 2 : 0,
  }));
  if (ruinBox) objects.push({ ...newObject('ruins', { x: TABLE_W / 2, y: TABLE_H / 2 }), label: 'The Ruin' });
  objectivesFree.forEach((o, i) => objects.push({ ...newObject('objective', o), label: `${i + 1}` }));

  return {
    setup: { deployment, flipX: Math.random() < 0.5, flipY: Math.random() < 0.5, missionTurn, missionGame },
    objects,
  };
}
