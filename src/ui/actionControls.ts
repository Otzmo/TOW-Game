import type { Store } from '../model/store';
import type { PlayerId } from '../model/types';
import type { Board } from '../view/board';
import type { PromptCenter } from './prompts';
import { TEST_TYPES } from './prompts';

const $ = (id: string) => document.getElementById(id)!;
const sel = (id: string) => $(id) as HTMLSelectElement;

/**
 * Test verlangen (Aufriebs-, Panik-, Moralwerttest …). Angriffe, Beschuss und Nahkampf
 * werden von Hand über die Würfel geklärt.
 */
export class ActionControls {
  constructor(
    private store: Store,
    private board: Board,
    private prompts: PromptCenter,
    private seat: () => PlayerId | 'spectator' | null,
  ) {
    sel('p-test-type').innerHTML = Object.entries(TEST_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel('p-test-mod').innerHTML = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3]
      .map((n) => `<option value="${n}" ${n === 0 ? 'selected' : ''}>Ld ${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}</option>`).join('');
    $('p-test').onclick = () => {
      const id = this.board.selectedId;
      if (id) this.prompts.requestTest(this.me(), id, sel('p-test-type').value, Number(sel('p-test-mod').value));
    };
  }

  /** Wer gerade handelt: online der eigene Platz, offline der Spieler am Zug. */
  private me(): PlayerId {
    const s = this.seat();
    return s && s !== 'spectator' ? s : this.store.state.meta.active;
  }
}
