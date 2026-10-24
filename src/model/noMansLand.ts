import { deploymentZones } from './battlefield';
import { objectPolygon, pointInPolygon } from './objects';
import { isJoined, unitFootprint, type Store } from './store';
import type { BoardObject, PlayerId, Point, SetupState, UnitState } from './types';

/** Rastergröße in Zoll */
const CELL = 0.5;
/** Abstand zwischen Einheiten, zu Zonen und Gelände */
const GAP = 0.5;
/** Schmale Einheiten brauchen so viel Breite für ihre umbrochene Beschriftung (unitView) */
const LABEL_W = 3;
/** Die Beschriftung steht hinter der Einheit */
const LABEL_D = 1.5;

export type Pose = Pick<UnitState, 'x' | 'y' | 'rotation'>;

/**
 * Plätze im Niemandsland: alles außerhalb beider Aufstellungszonen, außerhalb von Gelände und Missionszielen.
 * Spieler 1 bekommt die untere Tischhälfte, Spieler 2 die obere, jeweils von der Mittellinie aus
 * nach außen und von links nach rechts. Ohne Schlachtfeld ist der ganze Tisch frei (dann die Mitte).
 */
export function noMansLandPoses(
  units: Record<string, UnitState>,
  table: { width: number; height: number },
  setup: SetupState | undefined,
  objects: Record<string, BoardObject>,
  owners: PlayerId[] = ['p1', 'p2'],
): Record<string, Pose> {
  const cols = Math.round(table.width / CELL);
  const rows = Math.round(table.height / CELL);
  const blocked = new Uint8Array(cols * rows);
  const zones = deploymentZones(setup);
  const polys = [
    ...(zones ? [zones.p1, zones.p2] : []),
    // Gelände und Missionsziele bleiben frei
    ...Object.values(objects).filter((o) => o.kind === 'terrain' || o.type === 'objective').map(objectPolygon),
  ];
  // Gesperrte Zellen: Mittelpunkt oder eine Ecke des Polygons liegt darin
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = { x: (i + 0.5) * CELL, y: (j + 0.5) * CELL };
      if (polys.some((p) => pointInPolygon(c, p))) blocked[j * cols + i] = 1;
    }
  }
  for (const p of polys) for (const v of p) mark(v.x, v.y, v.x, v.y);
  // Einheiten, die nicht neu gelegt werden (z. B. die Armee des Gegners), bleiben stehen und sperren ihren Platz
  for (const u of Object.values(units)) {
    if (owners.includes(u.owner) || isJoined(u, units)) continue;
    const fp = unitFootprint(u, units);
    const c = Math.cos(u.rotation);
    const s = Math.sin(u.rotation);
    const xs = [-1, 1].flatMap((a) => [-1, 1].map((b) => u.x + (a * fp.w / 2) * c - (b * fp.h / 2) * s));
    const ys = [-1, 1].flatMap((a) => [-1, 1].map((b) => u.y + (a * fp.w / 2) * s + (b * fp.h / 2) * c));
    mark(Math.min(...xs), Math.min(...ys) - LABEL_D, Math.max(...xs), Math.max(...ys) + LABEL_D);
  }

  function mark(x0: number, y0: number, x1: number, y1: number): void {
    for (let j = Math.max(0, Math.floor(y0 / CELL)); j <= Math.min(rows - 1, Math.floor(y1 / CELL)); j++) {
      for (let i = Math.max(0, Math.floor(x0 / CELL)); i <= Math.min(cols - 1, Math.floor(x1 / CELL)); i++) blocked[j * cols + i] = 1;
    }
  }
  /** Ist das Rechteck (Zoll, mit Abstand) frei und auf dem Tisch? */
  function free(x0: number, y0: number, w: number, d: number): boolean {
    if (x0 < GAP || y0 < GAP || x0 + w > table.width - GAP || y0 + d > table.height - GAP) return false;
    const i0 = Math.floor((x0 - GAP) / CELL);
    const i1 = Math.ceil((x0 + w + GAP) / CELL) - 1;
    const j0 = Math.floor((y0 - GAP) / CELL);
    const j1 = Math.ceil((y0 + d + GAP) / CELL) - 1;
    for (let j = Math.max(0, j0); j <= Math.min(rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(cols - 1, i1); i++) if (blocked[j * cols + i]) return false;
    }
    return true;
  }

  const mid = table.height / 2;
  const result: Record<string, Pose> = {};
  for (const owner of owners) {
    const list = Object.values(units).filter((u) => u.owner === owner && !isJoined(u, units));
    for (const u of list) {
      const fp = unitFootprint({ ...u, rotation: 0 }, units);
      const w = Math.max(fp.w, LABEL_W);
      const d = fp.h + LABEL_D;
      // Zeilen: erst die eigene Hälfte von der Mitte nach außen, dann die andere Hälfte
      const own: number[] = [];
      const rest: number[] = [];
      for (let k = 0; k * CELL <= table.height; k++) {
        if (owner === 'p1') {
          own.push(mid + GAP / 2 + k * CELL);
          rest.push(mid - GAP / 2 - d - k * CELL);
        } else {
          own.push(mid - GAP / 2 - d - k * CELL);
          rest.push(mid + GAP / 2 + k * CELL);
        }
      }
      let spot: Point | null = null;
      for (const y0 of [...own, ...rest]) {
        for (let x0 = GAP; x0 + w <= table.width - GAP && !spot; x0 += CELL) {
          if (free(x0, y0, w, d)) spot = { x: x0, y: y0 };
        }
        if (spot) break;
      }
      // Kein Platz mehr frei: notfalls an die Mittellinie, auch wenn es eng wird
      if (!spot) spot = { x: table.width / 2 - w / 2, y: owner === 'p1' ? mid : mid - d };
      mark(spot.x, spot.y, spot.x + w - 0.01, spot.y + d - 0.01);
      // Spieler 1 blickt nach oben (Beschriftung unten), Spieler 2 nach unten (Beschriftung oben)
      result[u.id] = owner === 'p1'
        ? { x: spot.x + w / 2, y: spot.y + fp.h / 2, rotation: 0 }
        : { x: spot.x + w / 2, y: spot.y + d - fp.h / 2, rotation: Math.PI };
    }
  }
  return result;
}

/** Einheiten der genannten Spieler ins Niemandsland legen (Schlachtfeld und Gelände aus dem Spielstand). */
export function moveToNoMansLand(store: Store, owners: PlayerId[] = ['p1', 'p2']): void {
  const { units, table, meta, objects } = store.state;
  const poses = noMansLandPoses(units, table, meta.setup, objects, owners);
  for (const [id, pose] of Object.entries(poses)) store.updateUnit(id, pose);
}
