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
  constructor(private publish: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void) {
    for (const [id, def, none] of [['d-hit', '4', '– (trifft automatisch)'], ['d-wound', '4', '– (überspringen)'],
      ['d-save', '', '– (keiner)'], ['d-ward', '', '– (keiner)']] as const) {
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
    const parts: string[] = [`${count} W6`];
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
    step('d-hit', 'Treffer', 'Treffer', false);
    step('d-wound', 'Verwunden', 'Verwundungen', false);
    step('d-save', 'Rüstung', 'nicht gerüstet', true);
    step('d-ward', 'Rettung', 'ungerettet', true);
    if (!stages.length) {
      const dice = roll(count);
      stages.push({ label: 'Wurf', dice, success: 7 });
      parts.push(`Summe ${dice.reduce((s, d) => s + d, 0)}`);
    }

    const text = (note ? `${note}: ` : '') + parts.join(' → ');
    this.show(text, stages);
    this.publish({ kind: 'roll', text, dice: stages.map((s) => s.dice) });
  }

  private rollQuick(kind: string): void {
    const [n, sides] = kind.split('d').map(Number);
    const dice = roll(n).map((d) => (sides === 3 ? Math.ceil(d / 2) : d));
    const sum = dice.reduce((s, d) => s + d, 0);
    const text = `${n > 1 ? n : ''}W${sides}: ${dice.join(' + ')}${n > 1 ? ` = ${sum}` : ''}`;
    this.show(text, [{ label: `${n}W${sides}`, dice, success: 7 }]);
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
