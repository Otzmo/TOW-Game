import type { Store } from './store';
import type { BoardObject, UnitState } from './types';

/** Felder einer Einheit, die sich im Spiel ändern (ohne die festen Angaben in info – außer Punkten). */
const MUTABLE = ['models', 'width', 'x', 'y', 'rotation', 'joinedTo', 'formation', 'positions', 'status',
  'standardCaptured', 'woundsLost', 'info'] as const;

interface Snapshot {
  units: Record<string, Partial<UnitState>>;
  objects: Record<string, BoardObject>;
}

const MAX_STEPS = 100;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Rückgängig für eigene Aktionen: Vor jeder Aktion werden Einheiten und Objekte festgehalten.
 * Rückgängig schreibt den Stand als normale lokale Änderung zurück – online sieht der Gegner das mit.
 */
export class History {
  private steps: Snapshot[] = [];

  constructor(private store: Store) {}

  /** Vor einer Aktion aufrufen. */
  record(): void {
    const units: Snapshot['units'] = {};
    for (const u of Object.values(this.store.state.units)) {
      const s: Record<string, unknown> = {};
      // null statt undefined, damit beim Zurücksetzen auch später gesetzte Felder gelöscht werden
      for (const key of MUTABLE) s[key] = key === 'info' ? u.info : structuredClone(u[key] ?? null);
      units[u.id] = s as Partial<UnitState>;
    }
    this.steps.push({ units, objects: structuredClone(this.store.state.objects) });
    if (this.steps.length > MAX_STEPS) this.steps.shift();
  }

  /** Letzten Schritt verwerfen, wenn sich seitdem nichts geändert hat (z. B. nur geklickt). */
  dropIfUnchanged(): void {
    const last = this.steps.at(-1);
    if (!last) return;
    const { units, objects } = this.store.state;
    const unitsChanged = Object.entries(last.units).some(([id, patch]) =>
      units[id] && MUTABLE.some((key) => !same(units[id][key], patch[key])));
    if (!unitsChanged && same(objects, last.objects)) this.steps.pop();
  }

  canUndo(): boolean {
    return this.steps.length > 0;
  }

  undo(): boolean {
    const snap = this.steps.pop();
    if (!snap) return false;
    const { units, objects } = this.store.state;
    for (const [id, patch] of Object.entries(snap.units)) {
      const u = units[id];
      if (!u) continue;
      // Nur geänderte Felder zurückschreiben
      const changed: Partial<UnitState> = {};
      for (const key of MUTABLE) if (!same(u[key], patch[key])) Object.assign(changed, { [key]: patch[key] });
      if (Object.keys(changed).length) this.store.updateUnit(id, changed);
    }
    for (const id of Object.keys(objects)) if (!snap.objects[id]) this.store.removeObject(id);
    for (const [id, o] of Object.entries(snap.objects)) if (!same(objects[id], o)) this.store.setObject(o);
    return true;
  }

  /** Nach einem Armeeimport oder Laden passen alte Schritte nicht mehr. */
  clear(): void {
    this.steps = [];
  }
}
