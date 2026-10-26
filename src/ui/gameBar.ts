import type { History } from '../model/history';
import { currentPhase, nextSub, subLabel } from '../model/phases';
import { victoryPoints } from '../model/score';
import { isSkirmish, unitLayout, type Store } from '../model/store';
import type { GameMeta, LogKind, PlayerId } from '../model/types';

import { playerName } from '../model/players';

type Step = Pick<GameMeta, 'phase' | 'sub' | 'active' | 'round'>;

const $ = (id: string) => document.getElementById(id)!;

/** Ein Spiel dauert 6 Runden mit je zwei Spielerzügen */
const ROUNDS = 6;
/** Laufende Nummer des Spielerzugs (1–12) */
const turnNumber = (meta: GameMeta) => (meta.round - 1) * 2 + (meta.active === (meta.setup?.firstPlayer ?? 'p1') ? 1 : 2);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);


/** Leiste oben: Runde, Spieler am Zug, Zug beenden, Rückgängig und Siegpunkte. */
export class GameBar {
  /** Online: der eigene Spieler; offline null (beide spielen am selben Bildschirm) */
  private me: PlayerId | 'spectator' | null = null;

  constructor(private store: Store, history: History, private log: (kind: LogKind, text: string) => void) {
    $('g-end').onclick = () => this.endTurn();
    $('g-confirm-yes').onclick = () => { if (this.pending) this.go(this.pending); };
    $('g-confirm-no').onclick = () => { $('g-confirm').hidden = true; };
    $('g-undo').onclick = () => history.undo();
    $('g-redo').onclick = () => history.redo();
    $('score-panel').onchange = (e) => {
      const box = e.target as HTMLInputElement;
      if (box.dataset.mission) {
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

  /**
   * Schlacht: keine Phasen, aber Spielerzüge. Jede Runde hat zwei Züge (wer den ersten Zug hat, dann der andere);
   * nach dem zweiten Zug beginnt die nächste Runde, nach Runde 6 endet das Spiel. Beide Spieler dürfen weiterschalten.
   */
  endTurn(): void {
    const { meta } = this.store.state;
    if (currentPhase(meta) === 'setup' || this.me === 'spectator' || meta.gameOver) return;
    const first = meta.setup?.firstPlayer ?? 'p1';
    const second: PlayerId = first === 'p1' ? 'p2' : 'p1';
    const round = meta.round;
    // Angriffe gelten nur für den Zug, in dem sie angesagt wurden
    for (const id of Object.keys(this.store.state.charges)) this.store.setCharge(id, null);
    if (meta.active === first) {
      this.store.setMeta({ active: second });
      this.log('turn', `${playerName(first)} ends their turn · ${playerName(second)}'s turn (round ${round}, turn ${turnNumber(this.store.state.meta)} of ${ROUNDS * 2})`);
    } else if (round >= ROUNDS) {
      this.store.setMeta({ gameOver: true });
      this.log('turn', `${playerName(second)} ends their turn · Round ${ROUNDS} is over – the game has ended`);
    } else {
      this.store.setMeta({ round: round + 1, active: first });
      this.log('turn', `Round ${round} ends · Round ${round + 1}, ${playerName(first)}'s turn (turn ${turnNumber(this.store.state.meta)} of ${ROUNDS * 2})`);
    }
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
    const { round, active, gameOver } = state.meta;
    const phase = currentPhase(state.meta);
    // Runde, Zug und wer gerade dran ist; Phasen und Unterphasen werden nicht angezeigt
    $('g-round').innerHTML = phase === 'setup' ? '<b>Setup</b> · before round 1'
      : gameOver ? `<b>Game over</b> · ${ROUNDS} rounds played`
      : `Round <b>${round}</b>/${ROUNDS} · Turn <b>${turnNumber(state.meta)}</b>/${ROUNDS * 2}
         <span class="turn-of"><span class="dot ${active}"></span>${playerName(active)}'s turn</span>`;
    const end = $('g-end') as HTMLButtonElement;
    end.textContent = 'End turn';
    end.disabled = this.me === 'spectator' || !!gameOver;

    // Nach der Aufstellung: Armee laden, Gelände und Battlefield ausblenden (siehe CSS)
    document.body.classList.toggle('battle', phase !== 'setup');
    // Knöpfe „Load army“: nur der Farbpunkt unterscheidet sie, der Spielername steht im Tooltip
    document.querySelectorAll<HTMLButtonElement>('[data-import]').forEach((btn) => {
      btn.title = `Load army for ${playerName(btn.dataset.import as PlayerId)}`;
    });
    if (this.me) $('room-me').textContent = this.me === 'spectator' ? 'You are spectating' : `You: ${playerName(this.me)}`;
    this.renderScore();
  }

  /** Scoring: je Spieler Kill points (automatisch) + Mission points (eintragen oder per Knopf werten) = Summe */
  private renderScore(): void {
    const { state } = this.store;
    const panel = $('score-panel');
    // Nicht neu zeichnen, während dort eine Zahl eingegeben wird
    if (panel.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    const { missionVp } = state.meta;
    const kills = (p: PlayerId) => victoryPoints(state, p).lines.filter((l) => l.label !== 'Mission points');
    const killTotal = (p: PlayerId) => kills(p).reduce((s, l) => s + l.vp, 0);
    const total = (p: PlayerId) => killTotal(p) + (missionVp?.[p] ?? 0);
    $('score-btn').innerHTML = `Scoring <b>${total('p1')}</b> : <b>${total('p2')}</b>`;
    const head = (['p1', 'p2'] as const).map((p) => `<th><span class="dot ${p}"></span>${playerName(p)}</th>`).join('');
    // Kill points: Aufschlüsselung im Tooltip
    const killCell = (p: PlayerId) => `<td title="${escapeHtml(kills(p).map((l) => `${l.label}: ${l.vp}`).join('\n') || 'none yet')}">${killTotal(p)}</td>`;
    const missionCell = (p: PlayerId) => `<td><input type="number" min="0" step="5" data-mission="${p}" value="${missionVp?.[p] ?? 0}"></td>`;
    panel.innerHTML = `<h3>Scoring</h3>
      <table class="scoring"><thead><tr><th></th>${head}</tr></thead><tbody>
        <tr><td>Kill points</td>${killCell('p1')}${killCell('p2')}</tr>
        <tr><td>Mission points</td>${missionCell('p1')}${missionCell('p2')}</tr>
        <tr class="sum"><td>Total</td><td>${total('p1')}</td><td>${total('p2')}</td></tr>
      </tbody></table>`;
  }
}
