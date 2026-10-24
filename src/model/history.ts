import type { Store } from './store';
import type { UnitState } from './types';

/** Felder einer Einheit, die sich im Spiel ändern (ohne die festen Angaben in info). */
const MUTABLE = ['models', 'width', 'x', 'y', 'rotation', 'joinedTo', 'formation', 'positions', 'status',
  'standardCaptured', 'woundsLost'] as const;
type Snapshot = Record<string, Partial<UnitState>>;

const MAX_STEPS = 100;

/**
 * Rückgängig für eigene Aktionen: Vor jeder Aktion wird der Zustand aller Einheiten festgehalten.
 * Rückgängig schreibt ihn als normale lokale Änderung zurück – online sieht der Gegner das also mit.
 */
export class History {
  private steps: Snapshot[] = [];

  constructor(private store: Store) {}

  /** Vor einer Aktion aufrufen. */
  record(): void {
    const snap: Snapshot = {};
    for (const u of Object.values(this.store.state.units)) {
      const s: Record<string, unknown> = {};
      // null statt undefined, damit beim Zurücksetzen auch später gesetzte Felder gelöscht werden
      for (const key of MUTABLE) s[key] = structuredClone(u[key] ?? null);
      snap[u.id] = s as Partial<UnitState>;
    }
    this.steps.push(snap);
    if (this.steps.length > MAX_STEPS) this.steps.shift();
  }

  /** Letzten Schritt verwerfen, wenn sich seitdem nichts geändert hat (z. B. nur geklickt). */
  dropIfUnchanged(): void {
    const last = this.steps.at(-1);
    if (!last) return;
    const units = this.store.state.units;
    const changed = Object.entries(last).some(([id, patch]) =>
      units[id] && MUTABLE.some((key) => JSON.stringify(units[id][key] ?? null) !== JSON.stringify(patch[key])));
    if (!changed) this.steps.pop();
  }

  canUndo(): boolean {
    return this.steps.length > 0;
  }

  undo(): boolean {
    const snap = this.steps.pop();
    if (!snap) return false;
    const units = this.store.state.units;
    for (const [id, patch] of Object.entries(snap)) {
      const u = units[id];
      if (!u) continue;
      // Nur geänderte Felder zurückschreiben
      const changed: Partial<UnitState> = {};
      for (const key of MUTABLE) {
        if (JSON.stringify(u[key] ?? null) !== JSON.stringify(patch[key])) Object.assign(changed, { [key]: patch[key] });
      }
      if (Object.keys(changed).length) this.store.updateUnit(id, changed);
    }
    return true;
  }

  /** Nach einem Armeeimport passen alte Schritte nicht mehr. */
  clear(): void {
    this.steps = [];
  }
}
