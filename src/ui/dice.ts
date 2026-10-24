import type { Store } from '../model/store';
import { playerName } from '../model/players';
import type { LogEntry } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const select = (id: string) => $(id) as HTMLSelectElement;

const d6 = () => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * 6);
const roll = (n: number) => Array.from({ length: n }, d6);

/** Mindestwurf aus einem Auswahlfeld; null = Schritt überspringen. */
const target = (id: string): number | null => {
  const v = select(id).value;
  return v === '' ? null : Number(v);
};

/** Würfelstufen eines Pools für die Anzeige: Würfe und ab welchem Wert sie gelingen. */
export interface DiceStage {
  label: string;
  dice: number[];
  /** Würfe ab diesem Wert sind Erfolge; beim Rettungswurf zählen Erfolge als abgewehrt */
  success: number;
}

/** Würfel: Pool aus Treffer → Verwundung → Rüstung → Rettung, und schnelle Einzelwürfe. */
export class DicePanel {
  /**
   * @param sendSaves Verwundungen an den Gegner zum Rüstungs-/Rettungswurf geben (wenn ein Ziel gewählt ist)
   */
  constructor(private publish: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void,
    private sendSaves: (targetId: string, wounds: number, save: string, ward: string, note: string) => void = () => {}) {
    for (const [id, def, none] of [['d-hit', '4', '– (hits automatically)'], ['d-wound', '4', '– (skip)'],
      ['d-save', '', '– (none)'], ['d-ward', '', '– (none)']] as const) {
      select(id).innerHTML = `<option value="">${none}</option>` +
        [2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${String(n) === def ? 'selected' : ''}>${n}+</option>`).join('');
    }
    $('d-roll').onclick = () => this.rollPool();
    document.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach((btn) => {
      btn.onclick = () => this.rollQuick(btn.dataset.quick!);
    });
  }

  private rollPool(): void {
    const count = Math.max(1, Math.min(100, Math.round(Number(($('d-count') as HTMLInputElement).value) || 1)));
    const note = ($('d-note') as HTMLInputElement).value.trim();
    const stages: DiceStage[] = [];
    const parts: string[] = [`${count} D6`];
    let pool = count;

    const step = (id: string, label: string, word: string, saving: boolean) => {
      const t = target(id);
      if (t === null || pool === 0) return;
      const dice = roll(pool);
      const ok = dice.filter((d) => d >= t).length;
      stages.push({ label: `${label} ${t}+`, dice, success: t });
      // Rüstung/Rettung: gelungene Würfe wehren ab, es bleiben die misslungenen
      pool = saving ? pool - ok : ok;
      parts.push(`${saving ? pool : ok} ${word} (${t}+)`);
    };
    step('d-hit', 'To Hit', 'hits', false);
    step('d-wound', 'To Wound', 'wounds', false);
    // Mit Ziel würfelt der Gegner Rüstung und Rettung selbst
    const targetId = select('d-target')?.value ?? '';
    const toOpponent = !!targetId && stages.length > 0 && pool > 0;
    if (toOpponent) {
      parts.push('opponent rolls saves');
    } else {
      step('d-save', 'Armour Save', 'unsaved', true);
      step('d-ward', 'Ward save', 'unsaved', true);
    }
    if (!stages.length) {
      const dice = roll(count);
      stages.push({ label: 'Roll', dice, success: 7 });
      parts.push(`total ${dice.reduce((s, d) => s + d, 0)}`);
    }

    const text = (note ? `${note}: ` : '') + parts.join(' → ');
    this.show(text, stages);
    this.publish({ kind: 'roll', text, dice: stages.map((s) => s.dice) });
    if (toOpponent) this.sendSaves(targetId, pool, select('d-save').value, select('d-ward').value, note);
  }

  private rollQuick(kind: string): void {
    const [n, sides] = kind.split('d').map(Number);
    const dice = roll(n).map((d) => (sides === 3 ? Math.ceil(d / 2) : d));
    const sum = dice.reduce((s, d) => s + d, 0);
    const text = `${n > 1 ? n : ''}D${sides}: ${dice.join(' + ')}${n > 1 ? ` = ${sum}` : ''}`;
    this.show(text, [{ label: `${n}D${sides}`, dice, success: 7 }]);
    this.publish({ kind: 'roll', text, dice: [dice] });
  }

  private show(text: string, stages: DiceStage[]): void {
    $('d-result').innerHTML = `<p class="dice-sum">${escapeHtml(text)}</p>` + stages.map((s) =>
      `<div class="dice-row"><span class="dice-label">${escapeHtml(s.label)}</span>${diceHtml(s.dice, s.success)}</div>`).join('');
  }
}

export function diceHtml(dice: number[], success = 7): string {
  return dice.map((d) => `<span class="die${d >= success ? ' ok' : ''}">${d}</span>`).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}


/** Würfelprotokoll in der rechten Spalte: alle Würfe beider Spieler, neueste oben. */
export class DiceLog {
  constructor(private store: Store) {
    store.subscribe((_, c) => {
      if ((c.log && c.log.kind === 'roll') || c.loaded) this.render();
    });
    this.render();
  }

  private render(): void {
    const rolls = this.store.state.log.filter((e) => e.kind === 'roll').slice(-100).reverse();
    $('dice-log').innerHTML = rolls.map((e) => {
      const time = new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const dice = e.dice?.length ? `<div class="log-dice">${e.dice.map((d) => diceHtml(d)).join('<span class="sep">→</span>')}</div>` : '';
      return `<li><span class="log-meta"><span class="dot ${e.by}"></span>${playerName(e.by)} · ${time}</span>` +
        `<span class="log-text">${escapeHtml(e.text)}</span>${dice}</li>`;
    }).join('') || '<li class="empty">No dice rolled yet.</li>';
  }
}
