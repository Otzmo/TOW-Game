import type { GameState, PlayerId, UnitState } from './types';

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

/** Fläche des Regimentsblocks in Zoll. */
export function unitFootprint(u: UnitState): { cols: number; ranks: number; w: number; h: number } {
  const cols = Math.max(1, Math.min(u.width, u.models));
  const ranks = Math.ceil(u.models / cols);
  return { cols, ranks, w: (cols * u.info.baseWidth) / 25.4, h: (ranks * u.info.baseDepth) / 25.4 };
}
