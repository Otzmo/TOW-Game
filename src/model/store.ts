import type { GameState, PlayerId, Point, UnitState } from './types';

/** Woher eine Änderung kommt: vom eigenen Bildschirm oder vom Mitspieler über das Netz. */
export type Origin = 'local' | 'remote';

export interface Change {
  /** Betroffene Einheit; fehlt bei Änderungen an mehreren Einheiten */
  unitId?: string;
  origin: Origin;
  /** Bei lokalen Änderungen: nur diese Felder wurden geändert */
  patch?: Partial<UnitState>;
  /** Bei lokalem Armeeimport: der Spieler, dessen Einheiten ersetzt wurden */
  replacedOwner?: PlayerId;
}

type Listener = (state: GameState, change: Change) => void;

/**
 * Hält den Spielzustand und benachrichtigt Ansicht und Netzwerk bei Änderungen.
 */
export class Store {
  private listeners = new Set<Listener>();

  constructor(public state: GameState) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  updateUnit(id: string, patch: Partial<UnitState>, origin: Origin = 'local'): void {
    const unit = this.state.units[id];
    if (!unit) return;
    Object.assign(unit, patch);
    this.emit({ unitId: id, origin, patch });
  }

  /** Einheit vollständig setzen (neu oder ersetzt), z. B. wenn sie vom Mitspieler kommt. */
  setUnit(unit: UnitState, origin: Origin = 'local'): void {
    this.state.units[unit.id] = unit;
    this.emit({ unitId: unit.id, origin });
  }

  removeUnit(id: string, origin: Origin = 'local'): void {
    if (!this.state.units[id]) return;
    delete this.state.units[id];
    this.emit({ origin });
  }

  /** Ersetzt alle Einheiten eines Spielers, z. B. beim erneuten Armeeimport. */
  replacePlayerUnits(owner: PlayerId, units: UnitState[], origin: Origin = 'local'): void {
    for (const [id, u] of Object.entries(this.state.units)) {
      if (u.owner === owner) delete this.state.units[id];
    }
    for (const u of units) this.state.units[u.id] = u;
    this.emit({ origin, replacedOwner: owner });
  }

  private emit(change: Change): void {
    for (const fn of this.listeners) fn(this.state, change);
  }
}

/** Eine Base in der Einheit, in Zoll, linke obere Ecke relativ zur Einheitsmitte (Front = −y). */
export interface Slot {
  /** "m0", "m1", … für Truppen, bei Charakteren deren id */
  key: string;
  x: number;
  y: number;
  w: number;
  d: number;
  /** Kommandokürzel (M, S, C) */
  label?: string;
  /** Angeschlossener Charakter auf dieser Position */
  charId?: string;
}

export interface UnitLayout {
  cols: number;
  ranks: number;
  /** Größe in Zoll (bei Plänklern: umschließendes Rechteck) */
  w: number;
  h: number;
  slots: Slot[];
  /** Plänkler: Modelle, die mehr als 1″ vom Rest der Einheit entfernt sind */
  stray: Set<string>;
}

const MM = 25.4;
/** Größter erlaubter Abstand zwischen Plänklern in Zoll */
export const SKIRMISH_GAP = 1;
/** Abstand der Modelle beim Wechsel in die Plänklerformation */
const SKIRMISH_SPREAD = 0.5;

/** Charaktere, die sich dieser Einheit angeschlossen haben. */
export function joinedCharacters(u: UnitState, units: Record<string, UnitState>): UnitState[] {
  return Object.values(units).filter((c) => c.joinedTo === u.id);
}

/** Ist der Charakter gerade Teil einer (noch vorhandenen) Einheit? */
export function isJoined(u: UnitState, units: Record<string, UnitState>): boolean {
  return !!u.joinedTo && !!units[u.joinedTo];
}

export const canSkirmish = (u: UnitState) => u.info.rules.some((r) => /skirmish/i.test(r.name));
export const isSkirmish = (u: UnitState) => u.formation === 'skirmish';

export function unitLayout(u: UnitState, units: Record<string, UnitState> = {}): UnitLayout {
  return isSkirmish(u) ? skirmishLayout(u, units) : closeLayout(u, units);
}

/**
 * Geschlossene Formation: Angeschlossene Charaktere stehen mittig im ersten Glied,
 * die Kommandomodelle daneben, die übrigen Modelle füllen die Glieder dahinter.
 */
function closeLayout(u: UnitState, units: Record<string, UnitState>): UnitLayout {
  const bw = u.info.baseWidth / MM;
  const bd = u.info.baseDepth / MM;
  const chars = joinedCharacters(u, units).map((c) => ({
    id: c.id,
    cols: Math.max(1, Math.round(c.info.baseWidth / u.info.baseWidth)),
    d: c.info.baseDepth / MM,
  }));
  const charCols = chars.reduce((n, c) => n + c.cols, 0);
  const total = u.models + charCols;
  const cols = Math.max(1, charCols, Math.min(u.width, total));
  const ranks = Math.ceil(total / cols);
  const w = cols * bw;
  const h = Math.max(ranks * bd, ...chars.map((c) => c.d));
  const left = -w / 2;
  const top = -h / 2;
  const slots: Slot[] = [];
  let m = 0;

  // Charaktere mittig ins erste Glied
  let col = Math.floor((cols - charCols) / 2);
  const taken = new Set<number>();
  for (const c of chars) {
    slots.push({ key: c.id, x: left + col * bw, y: top, w: c.cols * bw, d: c.d, charId: c.id });
    for (let i = 0; i < c.cols; i++) taken.add(col + i);
    col += c.cols;
  }

  // Erstes Glied auffüllen, Kommando auf die Plätze nächst der Mitte
  const front = Array.from({ length: cols }, (_, i) => i).filter((i) => !taken.has(i)).slice(0, u.models);
  const center = (cols - 1) / 2;
  const commandCols = [...front].sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)
    .slice(0, u.info.command.length).sort((a, b) => a - b);
  for (const i of front) {
    const k = commandCols.indexOf(i);
    slots.push({ key: `m${m++}`, x: left + i * bw, y: top, w: bw, d: bd, label: k >= 0 ? u.info.command[k] : undefined });
  }

  // Restliche Glieder, unvollständiges letztes Glied mittig
  let rest = u.models - front.length;
  for (let row = 1; rest > 0; row++) {
    const inRow = Math.min(cols, rest);
    const offset = ((cols - inRow) * bw) / 2;
    for (let i = 0; i < inRow; i++) slots.push({ key: `m${m++}`, x: left + offset + i * bw, y: top + row * bd, w: bw, d: bd });
    rest -= inRow;
  }

  return { cols, ranks, w, h, slots, stray: new Set() };
}

/** Plänkler: jedes Modell an seiner gespeicherten Position. */
function skirmishLayout(u: UnitState, units: Record<string, UnitState>): UnitLayout {
  const bw = u.info.baseWidth / MM;
  const bd = u.info.baseDepth / MM;
  const pos = u.positions ?? {};
  // Kommandokürzel bleiben bei den Modellen, die sie in geschlossener Formation hatten
  const labels = new Map(closeLayout({ ...u, formation: 'close' }, {}).slots.map((s) => [s.key, s.label]));
  const bases: { key: string; w: number; d: number; charId?: string }[] = [
    ...Array.from({ length: u.models }, (_, i) => ({ key: `m${i}`, w: bw, d: bd })),
    ...joinedCharacters(u, units).map((c) => ({ key: c.id, w: c.info.baseWidth / MM, d: c.info.baseDepth / MM, charId: c.id })),
  ];

  const slots: Slot[] = [];
  for (const b of bases) {
    // Neue Modelle ohne Position hinter die Einheit stellen
    const p = pos[b.key] ?? { x: 0, y: Math.max(0, ...slots.map((s) => s.y + s.d)) + SKIRMISH_SPREAD + b.d / 2 };
    slots.push({ key: b.key, x: p.x - b.w / 2, y: p.y - b.d / 2, w: b.w, d: b.d, charId: b.charId, label: labels.get(b.key) });
  }
  const x0 = Math.min(...slots.map((s) => s.x));
  const y0 = Math.min(...slots.map((s) => s.y));
  const x1 = Math.max(...slots.map((s) => s.x + s.w));
  const y1 = Math.max(...slots.map((s) => s.y + s.d));
  return { cols: 0, ranks: 0, w: x1 - x0, h: y1 - y0, slots, stray: strayModels(slots) };
}

/** Kleinster Abstand zwischen zwei Bases (Kante zu Kante). */
function gap(a: Slot, b: Slot): number {
  const gx = Math.max(0, Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) - (a.w + b.w) / 2);
  const gy = Math.max(0, Math.abs(a.y + a.d / 2 - (b.y + b.d / 2)) - (a.d + b.d) / 2);
  return Math.hypot(gx, gy);
}

/** Abstand eines Modells zum nächsten anderen Modell der Einheit. */
export function nearestGap(slots: Slot[], key: string): number {
  const me = slots.find((s) => s.key === key);
  if (!me) return 0;
  return Math.min(Infinity, ...slots.filter((s) => s !== me).map((s) => gap(me, s)));
}

/** Alle Modelle außerhalb der größten zusammenhängenden Gruppe (Ketten mit ≤ 1″ Abstand). */
function strayModels(slots: Slot[]): Set<string> {
  const groups: Slot[][] = [];
  const seen = new Set<Slot>();
  for (const start of slots) {
    if (seen.has(start)) continue;
    const group = [start];
    seen.add(start);
    for (let i = 0; i < group.length; i++) {
      for (const s of slots) {
        if (!seen.has(s) && gap(group[i], s) <= SKIRMISH_GAP + 1e-6) {
          seen.add(s);
          group.push(s);
        }
      }
    }
    groups.push(group);
  }
  groups.sort((a, b) => b.length - a.length);
  return new Set(groups.slice(1).flat().map((s) => s.key));
}

/** Positionen beim Wechsel in die Plänklerformation: geschlossene Aufstellung locker auseinanderziehen. */
export function spreadPositions(u: UnitState, units: Record<string, UnitState>): Record<string, Point> {
  const bw = u.info.baseWidth / MM;
  const bd = u.info.baseDepth / MM;
  const fx = (bw + SKIRMISH_SPREAD) / bw;
  const fy = (bd + SKIRMISH_SPREAD) / bd;
  const positions: Record<string, Point> = {};
  for (const s of closeLayout(u, units).slots) {
    positions[s.key] = { x: (s.x + s.w / 2) * fx, y: (s.y + s.d / 2) * fy };
  }
  return positions;
}

/**
 * Plänkler-Positionen so verschieben, dass die Einheitsmitte wieder in der Mitte der Modelle liegt.
 * Gibt die neue Einheitsposition (Tisch) und die verschobenen Positionen zurück.
 */
export function recenter(u: UnitState, units: Record<string, UnitState>, positions: Record<string, Point>):
  { x: number; y: number; positions: Record<string, Point> } {
  const { slots } = skirmishLayout({ ...u, positions }, units);
  const cx = (Math.min(...slots.map((s) => s.x)) + Math.max(...slots.map((s) => s.x + s.w))) / 2;
  const cy = (Math.min(...slots.map((s) => s.y)) + Math.max(...slots.map((s) => s.y + s.d))) / 2;
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  const moved: Record<string, Point> = {};
  for (const sl of slots) moved[sl.key] = { x: sl.x + sl.w / 2 - cx, y: sl.y + sl.d / 2 - cy };
  return { x: u.x + cx * c - cy * s, y: u.y + cx * s + cy * c, positions: moved };
}

/** Fläche der Einheit in Zoll. */
export function unitFootprint(u: UnitState, units: Record<string, UnitState> = {}) {
  const { cols, ranks, w, h } = unitLayout(u, units);
  return { cols, ranks, w, h };
}
