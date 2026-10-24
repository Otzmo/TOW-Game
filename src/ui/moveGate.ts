import { checkMove, currentPhase, phaseLabel } from '../model/phases';
import type { Store } from '../model/store';
import type { PlayerId } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;

/**
 * Prüft vor jeder Bewegung, ob sie in der aktuellen Phase erlaubt ist, und zeigt sonst einen Hinweis.
 * Ausnahmen (Sonderregeln wie bewegende Zauber) gelten für eine Einheit bis zum Phasenende.
 */
export class MoveGate {
  /** Online der eigene Platz, offline null */
  seat: PlayerId | 'spectator' | null = null;
  private exceptions = new Set<string>();
  private pendingId: string | null = null;
  private hideTimer = 0;
  private phaseKey = '';

  constructor(private store: Store, private log: (text: string) => void) {
    $('notice-allow').onclick = () => this.allowPending();
    $('notice-close').onclick = () => this.hide();
    store.subscribe(({ meta }, c) => {
      if (!c.meta && !c.loaded) return;
      // Neue Phase: Ausnahmen verfallen
      const key = `${meta.round}-${meta.active}-${currentPhase(meta)}-${meta.sub ?? 0}`;
      if (key === this.phaseKey) return;
      this.phaseKey = key;
      this.exceptions.clear();
      this.hide();
    });
  }

  /** Darf die Einheit jetzt bewegt werden? Ein angeschlossener Charakter zählt als seine Einheit. */
  allow(unitId: string): boolean {
    const units = this.store.state.units;
    let u = units[unitId];
    if (!u) return false;
    if (u.joinedTo && units[u.joinedTo]) u = units[u.joinedTo];
    const check = checkMove(this.store.state.meta, u, this.seat, this.exceptions.has(u.id), this.store.state.charges);
    if (check.ok) return true;
    this.show(u.id, `${u.info.name}: ${check.reason}`, check.overridable);
    return false;
  }

  /** Ausnahme ohne Rückfrage, z. B. für Flucht oder Gegenangriff als Reaktion */
  grant(unitId: string): void {
    this.exceptions.add(unitId);
  }

  /** Zusatz für das Protokoll, z. B. "Reaktion (Counter Charge)" */
  note(unitId: string): string {
    const units = this.store.state.units;
    const u = units[unitId];
    if (!u) return '';
    const host = u.joinedTo && units[u.joinedTo] ? units[u.joinedTo] : u;
    if (this.exceptions.has(host.id)) return 'Ausnahme/Sonderregel';
    const check = checkMove(this.store.state.meta, host, this.seat, false, this.store.state.charges);
    return check.ok ? check.note ?? '' : '';
  }

  private allowPending(): void {
    if (!this.pendingId) return;
    const u = this.store.state.units[this.pendingId];
    this.exceptions.add(this.pendingId);
    const phase = phaseLabel(currentPhase(this.store.state.meta));
    if (u) this.log(`Ausnahme: ${u.info.name} darf in der ${phase} bewegt werden (Sonderregel)`);
    this.hide();
  }

  private show(unitId: string, text: string, overridable: boolean): void {
    this.pendingId = overridable ? unitId : null;
    $('notice-text').textContent = text;
    $('notice-allow').hidden = !overridable;
    $('phase-notice').hidden = false;
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 8000);
  }

  private hide(): void {
    $('phase-notice').hidden = true;
    this.pendingId = null;
  }
}
