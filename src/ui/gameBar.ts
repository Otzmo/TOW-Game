import type { History } from '../model/history';
import { armyPoints, victoryPoints } from '../model/score';
import { isSkirmish, unitLayout, type Store } from '../model/store';
import type { LogKind, PlayerId } from '../model/types';
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
    $('g-end').onclick = () => this.requestEndTurn();
    $('g-confirm-yes').onclick = () => this.endTurn();
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

  /** Vor dem Zugende prüfen, ob Plänkler des aktiven Spielers mehr als 1″ auseinanderstehen. */
  requestEndTurn(): void {
    const { units, meta } = this.store.state;
    const broken = Object.values(units)
      .filter((u) => u.owner === meta.active && isSkirmish(u) && unitLayout(u, units).stray.size > 0)
      .map((u) => u.info.name);
    if (!broken.length) {
      this.endTurn();
      return;
    }
    $('g-confirm-text').textContent =
      `${broken.join(', ')}: Modelle stehen mehr als 1″ vom Rest der Einheit entfernt. Trotzdem beenden?`;
    $('g-confirm').hidden = false;
  }

  private endTurn(): void {
    $('g-confirm').hidden = true;
    const { round, active } = this.store.state.meta;
    // Nach Spieler 2 beginnt die nächste Runde
    const next = { active: other(active), round: active === 'p2' ? round + 1 : round };
    this.store.setMeta(next);
    this.log('turn', `${playerName(active)} beendet den Zug · Runde ${next.round}, ${playerName(next.active)} am Zug`);
  }

  private render(): void {
    const { state } = this.store;
    const { round, active, breakBonus } = state.meta;
    $('g-round').innerHTML = `Runde <b>${round}</b> · <span class="dot ${active}"></span>${playerName(active)} am Zug`;
    // Online darf nur der Spieler am Zug seinen Zug beenden
    ($('g-end') as HTMLButtonElement).disabled = this.me !== null && this.me !== active;

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
