import type { Store } from '../model/store';
import { playerName } from '../model/players';
import type { LogEntry } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const select = (id: string) => $(id) as HTMLSelectElement;

const d6 = () => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * 6);
const roll = (n: number) => Array.from({ length: n }, d6);

/**
 * Würfel, allgemein und an keine Aktion gebunden: Anzahl D6 würfeln, danach (auch nachträglich)
 * einen Zielwert wie 4+ wählen, die Würfel darunter entfernen und die übrigen neu würfeln.
 */
export class DicePanel {
  /** Aktueller Würfelpool */
  private dice: number[] = [];

  constructor(private publish: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void) {
    select('d-target-value').innerHTML = '<option value="">– (no target)</option>' +
      [2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}+</option>`).join('');
    $('d-roll').onclick = () => {
      const count = Math.max(1, Math.min(100, Math.round(Number(($('d-count') as HTMLInputElement).value) || 1)));
      this.dice = roll(count);
      this.publish({ kind: 'roll', text: `${count} D6`, dice: [this.dice] });
      this.render();
    };
    select('d-target-value').onchange = () => this.render();
    $('d-keep').onclick = () => {
      const t = this.target();
      if (t === null || !this.dice.length) return;
      const before = this.dice.length;
      this.dice = this.dice.filter((d) => d >= t);
      ($('d-count') as HTMLInputElement).value = String(Math.max(1, this.dice.length));
      this.publish({ kind: 'roll', text: `${this.dice.length} of ${before} dice on ${t}+ kept`, dice: [this.dice] });
      this.render();
    };
    $('d-reroll').onclick = () => {
      if (!this.dice.length) return;
      this.dice = roll(this.dice.length);
      this.publish({ kind: 'roll', text: `${this.dice.length} D6 re-rolled`, dice: [this.dice] });
      this.render();
    };
    this.render();
  }

  private target(): number | null {
    const v = select('d-target-value').value;
    return v === '' ? null : Number(v);
  }

  private render(): void {
    const t = this.target();
    const ok = t === null ? null : this.dice.filter((d) => d >= t).length;
    const sum = this.dice.reduce((s, d) => s + d, 0);
    $('d-result').innerHTML = this.dice.length
      ? `<p class="dice-sum">${this.dice.length} D6${ok === null ? ` · total ${sum}` : ` · <b>${ok}</b> on ${t}+`}</p>
         <div class="dice-row">${diceHtml([...this.dice].sort((a, b) => b - a), t ?? 7)}</div>`
      : '<p class="meta">Enter the number of dice and roll.</p>';
    ($('d-keep') as HTMLButtonElement).disabled = t === null || !this.dice.length;
    ($('d-keep') as HTMLButtonElement).textContent = t === null ? 'Remove dice below target' : `Remove dice below ${t}+`;
    ($('d-reroll') as HTMLButtonElement).disabled = !this.dice.length;
    ($('d-reroll') as HTMLButtonElement).textContent = this.dice.length ? `Re-roll ${this.dice.length} dice` : 'Re-roll dice';
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
