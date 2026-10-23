import type { GameState, PlayerId, UnitState } from './types';

type Listener = (state: GameState, changedUnitId?: string) => void;

/**
 * Hält den Spielzustand und benachrichtigt die Ansicht bei Änderungen.
 * Später hängt sich hier der Firebase-Abgleich an.
 */
export class Store {
  private listeners = new Set<Listener>();

  constructor(public state: GameState) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  updateUnit(id: string, patch: Partial<UnitState>): void {
    const unit = this.state.units[id];
    if (!unit) return;
    Object.assign(unit, patch);
    this.emit(id);
  }

  addUnit(unit: UnitState): void {
    this.state.units[unit.id] = unit;
    this.emit(unit.id);
  }

  /** Ersetzt alle Einheiten eines Spielers, z. B. beim erneuten Armeeimport. */
  replacePlayerUnits(owner: PlayerId, units: UnitState[]): void {
    for (const [id, u] of Object.entries(this.state.units)) {
      if (u.owner === owner) delete this.state.units[id];
    }
    for (const u of units) this.state.units[u.id] = u;
    this.emit();
  }

  private emit(changedUnitId?: string): void {
    for (const fn of this.listeners) fn(this.state, changedUnitId);
  }
}

/** Fläche des Regimentsblocks in Zoll. */
export function unitFootprint(u: UnitState): { cols: number; ranks: number; w: number; h: number } {
  const cols = Math.max(1, Math.min(u.width, u.models));
  const ranks = Math.ceil(u.models / cols);
  return { cols, ranks, w: (cols * u.info.baseWidth) / 25.4, h: (ranks * u.info.baseDepth) / 25.4 };
}
