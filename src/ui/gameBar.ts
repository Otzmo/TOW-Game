import type { History } from '../model/history';
import {
  currentPhase, currentSub, nextPhase, nextSub, PHASES, phaseInfo, phaseLabel, repeatPhase, SUB_DECLARE, subLabel,
} from '../model/phases';
import { armyPoints, victoryPoints } from '../model/score';
import { isSkirmish, unitLayout, type Store } from '../model/store';
import type { GameMeta, LogKind, PlayerId } from '../model/types';

type Step = Pick<GameMeta, 'phase' | 'sub' | 'active' | 'round'>;
import { onSheetChange, toggleSheet } from './sheets';

const $ = (id: string) => document.getElementById(id)!;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const playerName = (p: PlayerId) => `Spieler ${p === 'p1' ? 1 : 2}`;
const other = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');

/** Leiste oben: Runde, Spieler am Zug, Zug beenden, Rückgängig und Siegpunkte. */
export class GameBar {
  /** Online: der eigene Spieler; offline null (beide spielen am selben Bildschirm) */
  private me: PlayerId | 'spectator' | null = null;

  constructor(private store: Store, history: History, private log: (kind: LogKind, text: string) => void) {
    $('g-end').onclick = () => this.requestNext();
    $('g-phase-end').onclick = () => this.requestEndPhase();
    $('g-repeat').onclick = () => this.repeat();
    $('g-confirm-yes').onclick = () => { if (this.pending) this.go(this.pending); };
    $('g-confirm-no').onclick = () => { $('g-confirm').hidden = true; };
    $('g-undo').onclick = () => history.undo();
    $('g-redo').onclick = () => history.redo();
    $('g-score-toggle').onclick = () => toggleSheet('score');
    onSheetChange((name) => {
      $('g-score-toggle').classList.toggle('on', name === 'score');
      if (name === 'score') this.render();
    });
    $('sheet-score').onchange = (e) => {
      const box = e.target as HTMLInputElement;
      if (!box.dataset.break) return;
      const breakBonus = { ...this.store.state.meta.breakBonus, [box.dataset.break]: box.checked };
      this.store.setMeta({ breakBonus });
    };
    store.subscribe(() => {
      ($('g-undo') as HTMLButtonElement).disabled = !history.canUndo();
      ($('g-redo') as HTMLButtonElement).disabled = !history.canRedo();
      this.render();
    });
    this.render();
  }

  setOnlinePlayer(me: PlayerId | 'spectator'): void {
    this.me = me;
    this.render();
  }

  /** Angriffe: Reaktions-Popups erst nach Ende der Ansage verschicken (von PromptCenter gesetzt) */
  chargeFlow: { unsent(): number; waiting(): number; send(): void } = { unsent: () => 0, waiting: () => 0, send: () => {} };

  /** Weiter zur nächsten Unterphase (nach der letzten: nächste Phase). */
  requestNext(): void {
    this.request(nextSub(this.store.state.meta));
  }

  /** Phase direkt beenden (überspringt die übrigen Unterphasen). */
  requestEndPhase(): void {
    this.request(nextPhase(this.store.state.meta));
  }

  /** Fernkampf/Nahkampf: zurück zur ersten Unterphase für die nächste Einheit bzw. den nächsten Kampf. */
  repeat(): void {
    const { meta } = this.store.state;
    const name = phaseInfo(currentPhase(meta)).repeat;
    if (!name) return;
    this.store.setMeta(repeatPhase(meta));
    this.log('turn', `${playerName(meta.active)}: ${name} – ${subLabel(this.store.state.meta)}`);
  }

  /**
   * Vor dem Wechsel: Angriffe brauchen erst alle Reaktionen; beim Verlassen der Bewegungsphase
   * (und der Aufstellung) wird geprüft, ob Plänkler mehr als 1″ vom Rest ihrer Einheit entfernt stehen.
   */
  private request(next: Step): void {
    const { units, meta } = this.store.state;
    const phase = currentPhase(meta);
    if (phase === 'movement' && currentSub(meta) === SUB_DECLARE) {
      if (this.chargeFlow.unsent() > 0) {
        this.chargeFlow.send();
        return;
      }
      if (this.chargeFlow.waiting() > 0) return;
    }
    const leaving = next.phase !== phase;
    const broken = leaving && (phase === 'movement' || phase === 'setup')
      ? Object.values(units)
        .filter((u) => (phase === 'setup' || u.owner === meta.active) && isSkirmish(u) && unitLayout(u, units).stray.size > 0)
        .map((u) => u.info.name)
      : [];
    if (!broken.length) {
      this.go(next);
      return;
    }
    this.pending = next;
    $('g-confirm-text').textContent =
      `${broken.join(', ')}: Modelle stehen mehr als 1″ vom Rest der Einheit entfernt. Trotzdem weiter?`;
    $('g-confirm').hidden = false;
  }

  private pending: Step | null = null;

  private go(next: Step): void {
    $('g-confirm').hidden = true;
    const { meta } = this.store.state;
    // Werte vor dem Wechsel merken – setMeta ändert dasselbe Objekt
    const before = currentPhase(meta);
    const prev = meta.active;
    this.store.setMeta(next);
    const now = this.store.state.meta;
    const turnChange = before === 'combat' && next.phase === 'strategy' || before === 'setup';
    this.log('turn', turnChange
      ? `${before === 'setup' ? 'Aufstellung beendet' : `${playerName(prev)} beendet den Zug`} · Runde ${now.round}, ${playerName(now.active)}: ${phaseLabel(currentPhase(now))} – ${subLabel(now)}`
      : `${playerName(prev)}: ${phaseLabel(currentPhase(now))} – ${subLabel(now)}`);
  }

  private render(): void {
    const { state } = this.store;
    const { round, active, breakBonus } = state.meta;
    const phase = currentPhase(state.meta);
    const sub = currentSub(state.meta);
    const info = phaseInfo(phase);
    $('g-round').innerHTML = phase === 'setup'
      ? '<b>Aufstellung</b> · vor Runde 1'
      : `Runde <b>${round}</b> · <span class="dot ${active}"></span>${playerName(active)} am Zug`;
    // Phasen und Unterphasen der aktuellen Phase
    $('g-phases').innerHTML = PHASES.filter((p) => (phase === 'setup') === (p.key === 'setup'))
      .map((p) => `<li class="${p.key === phase ? 'on' : ''}">${p.name}</li>`).join('');
    $('g-subs').innerHTML = info.subs.map((name, i) =>
      `<li class="${i === sub ? 'on' : i < sub ? 'done' : ''}"><span>${i + 1}</span>${name}</li>`).join('');

    // Knöpfe: Online darf nur der Spieler am Zug weiterschalten (Aufstellung: beide)
    const notMine = this.me === 'spectator' || (phase !== 'setup' && this.me !== null && this.me !== active);
    const next = $('g-end') as HTMLButtonElement;
    const declaring = phase === 'movement' && sub === SUB_DECLARE;
    const unsent = declaring ? this.chargeFlow.unsent() : 0;
    const waiting = declaring ? this.chargeFlow.waiting() : 0;
    const lastSub = sub + 1 >= info.subs.length;
    next.textContent = phase === 'setup' ? 'Aufstellung beenden'
      : unsent ? `Ansagen abschließen (${unsent} Angriff${unsent === 1 ? '' : 'e'})`
      : waiting ? `Warte auf Reaktionen (${waiting})`
      : lastSub ? (phase === 'combat' ? 'Zug abgeben »' : 'Phase beenden »') : 'Weiter ›';
    next.disabled = notMine || waiting > 0;
    const endBtn = $('g-phase-end') as HTMLButtonElement;
    endBtn.hidden = phase === 'setup' || lastSub;
    endBtn.textContent = phase === 'combat' ? 'Zug abgeben »' : 'Phase beenden »';
    endBtn.disabled = notMine || waiting > 0 || unsent > 0;
    const rep = $('g-repeat') as HTMLButtonElement;
    rep.hidden = !info.repeat || sub === 0;
    rep.textContent = `↺ ${info.repeat ?? ''}`;
    rep.disabled = notMine;

    const score = { p1: victoryPoints(state, 'p1'), p2: victoryPoints(state, 'p2') };
    $('g-score-toggle').innerHTML = `Siegpunkte <b>${score.p1.total}</b> : <b>${score.p2.total}</b>`;
    if ($('sheet-score').hidden) return;
    $('sheet-score').innerHTML = '<h3>Siegpunkte</h3>' + (['p1', 'p2'] as const).map((p) => {
      const lines = score[p].lines.map((l) =>
        `<li><span>${escapeHtml(l.label)}</span><b>${l.vp}</b></li>`).join('') || '<li class="empty">noch keine</li>';
      return `<section>
        <h3><span class="dot ${p}"></span>${playerName(p)} <span class="vp">${score[p].total} SP</span></h3>
        <p class="meta">Armee ${armyPoints(state, p)} Pkt.</p>
        <ul>${lines}</ul>
        <label><input type="checkbox" data-break="${p}" ${breakBonus[p] ? 'checked' : ''}>
          Armee von ${playerName(other(p))} gebrochen (+500)</label>
      </section>`;
    }).join('') + '<p class="meta note">Stand, als würde das Spiel jetzt enden.</p>';
  }
}
