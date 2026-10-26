import type { History } from '../model/history';
import { currentPhase, nextSub, subLabel } from '../model/phases';
import { armyPoints, victoryPoints } from '../model/score';
import { isSkirmish, unitLayout, type Store } from '../model/store';
import type { GameMeta, LogKind, PlayerId } from '../model/types';

import { missionByKey } from '../model/battlefield';
import { playerName } from '../model/players';

type Step = Pick<GameMeta, 'phase' | 'sub' | 'active' | 'round'>;

const $ = (id: string) => document.getElementById(id)!;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const other = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');

/** Leiste oben: Runde, Spieler am Zug, Zug beenden, Rückgängig und Siegpunkte. */
export class GameBar {
  /** Online: der eigene Spieler; offline null (beide spielen am selben Bildschirm) */
  private me: PlayerId | 'spectator' | null = null;

  constructor(private store: Store, history: History, private log: (kind: LogKind, text: string) => void) {
    $('g-end').onclick = () => this.endRound();
    $('g-confirm-yes').onclick = () => { if (this.pending) this.go(this.pending); };
    $('g-confirm-no').onclick = () => { $('g-confirm').hidden = true; };
    $('g-undo').onclick = () => history.undo();
    $('g-redo').onclick = () => history.redo();
    $('score-panel').onchange = (e) => {
      const box = e.target as HTMLInputElement;
      if (box.dataset.break) {
        const breakBonus = { ...this.store.state.meta.breakBonus, [box.dataset.break]: box.checked };
        this.store.setMeta({ breakBonus });
      } else if (box.dataset.mission) {
        const missionVp = { ...this.store.state.meta.missionVp, [box.dataset.mission]: Math.max(0, Math.round(Number(box.value) || 0)) };
        this.store.setMeta({ missionVp });
      }
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

  /** Aufbau: was vor dem nächsten Schritt noch fehlt (von SetupPanel gesetzt) */
  setupBlocker: () => string | null = () => null;

  /** Neu anzeigen, z. B. nachdem setupBlocker gesetzt wurde */
  refresh(): void {
    this.render();
  }

  /** Aufbau: weiter zum nächsten Schritt (nach dem letzten beginnt die Schlacht). */
  requestNext(): void {
    if (currentPhase(this.store.state.meta) === 'setup') this.request(nextSub(this.store.state.meta));
  }

  /** Schlacht: keine Phasen mehr, nur Runden. Beide Spieler dürfen die Runde beenden. */
  endRound(): void {
    const { meta } = this.store.state;
    if (currentPhase(meta) === 'setup' || this.me === 'spectator') return;
    const round = meta.round;
    this.store.setMeta({ round: round + 1, active: meta.setup?.firstPlayer ?? 'p1' });
    this.log('turn', `Round ${round} ends · Round ${round + 1} begins`);
  }

  /** Vor dem Ende der Aufstellung wird geprüft, ob Plänkler mehr als 1″ vom Rest ihrer Einheit entfernt stehen. */
  private request(next: Step): void {
    const { units, meta } = this.store.state;
    const phase = currentPhase(meta);
    if (this.setupBlocker()) return;
    const leaving = next.phase !== phase;
    const broken = leaving && phase === 'setup'
      ? Object.values(units)
        .filter((u) => isSkirmish(u) && unitLayout(u, units).stray.size > 0)
        .map((u) => u.info.name)
      : [];
    if (!broken.length) {
      this.go(next);
      return;
    }
    this.pending = next;
    $('g-confirm-text').textContent =
      `${broken.join(', ')}: models are more than 1″ from the rest of their unit (skirmishers). Continue anyway?`;
    $('g-confirm').hidden = false;
  }

  private pending: Step | null = null;

  private go(next: Step): void {
    $('g-confirm').hidden = true;
    const { meta } = this.store.state;
    // Werte vor dem Wechsel merken – setMeta ändert dasselbe Objekt
    const before = currentPhase(meta);
    this.store.setMeta(next);
    const now = this.store.state.meta;
    this.log('turn', before === 'setup' && currentPhase(now) !== 'setup'
      ? `Setup finished – the battle begins · Round ${now.round}`
      : `Setup: ${subLabel(now)}`);
  }

  private render(): void {
    const { state } = this.store;
    const { round } = state.meta;
    const phase = currentPhase(state.meta);
    // Nur die aktuelle Runde; Phasen und Unterphasen werden nicht angezeigt
    $('g-round').innerHTML = phase === 'setup' ? '<b>Setup</b> · before round 1' : `Round <b>${round}</b>`;
    const end = $('g-end') as HTMLButtonElement;
    end.textContent = 'End round';
    end.disabled = this.me === 'spectator';

    // Nach der Aufstellung: Armee laden, Gelände und Battlefield ausblenden (siehe CSS)
    document.body.classList.toggle('battle', phase !== 'setup');
    // Knöpfe „Load army“: nur der Farbpunkt unterscheidet sie, der Spielername steht im Tooltip
    document.querySelectorAll<HTMLButtonElement>('[data-import]').forEach((btn) => {
      btn.title = `Load army for ${playerName(btn.dataset.import as PlayerId)}`;
    });
    if (this.me) $('room-me').textContent = this.me === 'spectator' ? 'You are spectating' : `You: ${playerName(this.me)}`;
    this.renderScore();
  }

  /** Siegpunkte rechts: Killpoints je Einheit und Missionspunkte (von Hand) */
  private renderScore(): void {
    const { state } = this.store;
    const panel = $('score-panel');
    // Nicht neu zeichnen, während dort eine Zahl eingegeben wird
    if (panel.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    const { breakBonus, missionVp, setup } = state.meta;
    const score = { p1: victoryPoints(state, 'p1'), p2: victoryPoints(state, 'p2') };
    $('score-btn').innerHTML = `Victory Points <b>${score.p1.total}</b> : <b>${score.p2.total}</b>`;
    const missions = [missionByKey(setup?.missionTurn), missionByKey(setup?.missionGame)].filter(Boolean).map((m) => m!.name);
    panel.innerHTML = `<h3>Victory Points</h3>` + (['p1', 'p2'] as const).map((p) => {
      const kills = score[p].lines.filter((l) => l.label !== 'Mission points');
      const killTotal = kills.reduce((s, l) => s + l.vp, 0);
      const lines = kills.map((l) =>
        `<li><span>${escapeHtml(l.label)}</span><b>${l.vp}</b></li>`).join('') || '<li class="empty">none yet</li>';
      return `<section>
        <h3><span class="dot ${p}"></span>${playerName(p)} <span class="vp">${score[p].total} VP</span></h3>
        <p class="meta">Army ${armyPoints(state, p)} pts · Kill points ${killTotal} · Mission points ${missionVp?.[p] ?? 0}</p>
        <ul>${lines}</ul>
        <label><input type="checkbox" data-break="${p}" ${breakBonus[p] ? 'checked' : ''}>
          ${playerName(other(p))}'s army is broken (+500)</label>
        <label>Mission points${missions.length ? ` (${escapeHtml(missions.join(' + '))})` : ''}
          <input type="number" min="0" step="25" data-mission="${p}" value="${missionVp?.[p] ?? 0}"></label>
      </section>`;
    }).join('') + '<p class="meta note">Score as if the game ended now.</p>';
  }
}
