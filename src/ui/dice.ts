import type { Store } from '../model/store';
import { playerName } from '../model/players';
import type { LogEntry } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const select = (id: string) => $(id) as HTMLSelectElement;

const rnd = (sides: number) => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * sides);
const d6 = () => rnd(6);
const roll = (n: number) => Array.from({ length: n }, d6);

/** Würfelarten: normale W6, W3, Artilleriewürfel und Abweichungswürfel */
export type DieKind = 'd6' | 'd3' | 'artillery' | 'scatter';
const KIND_NAMES: Record<DieKind, string> = { d6: 'D6', d3: 'D3', artillery: 'Artillery dice', scatter: 'Scatter dice' };

/** Artilleriewürfel: 2, 4, 6, 8, 10 oder Misfire (0) */
export const artilleryDie = (): number => [2, 4, 6, 8, 10, 0][d6() - 1];
/**
 * Abweichungswürfel: auf 2 von 6 Seiten "Hit", sonst ein Pfeil in eine zufällige Richtung (Grad, 0 = nach oben).
 * Auch die Hit-Seiten tragen einen kleinen Pfeil – er gilt, wenn ein Treffer nicht möglich ist.
 */
export const scatterDie = (): { hit: boolean; angle: number } => ({ hit: d6() <= 2, angle: rnd(360) - 1 });

/** Text für einen Artillerie- bzw. Abweichungswürfel */
export const artilleryText = (v: number) => (v === 0 ? 'Misfire!' : String(v));
/** Hit-Seite mit kleinem Pfeil (anklickbar, wenn i gesetzt), sonst großer Pfeil */
export const scatterHtml = (s: { hit: boolean; angle: number }, i?: number, useArrow = false) => s.hit && !useArrow
  ? `<button class="die die-hit" ${i !== undefined ? `data-small-arrow="${i}"` : ''} title="Click to use the small arrow (when a hit is not possible)">HIT <span class="small-arrow" style="transform: rotate(${s.angle}deg)">↑</span></button>`
  : `<span class="die die-arrow" title="${s.angle}°"><span style="transform: rotate(${s.angle}deg)">↑</span></span>`;

/**
 * Würfel, allgemein und an keine Aktion gebunden: Anzahl und Art (D6, D3, Artillerie, Abweichung) wählen
 * und würfeln. Bei D6/D3 danach (auch nachträglich) einen Zielwert wie 4+ wählen, die Würfel darunter
 * entfernen und die übrigen neu würfeln. "Clear all dice" leert den Tisch.
 */
export class DicePanel {
  /** Aktueller Würfelpool (D6/D3) */
  private dice: number[] = [];
  private kind: DieKind = 'd6';
  /** Ergebnis von Artilleriewürfeln */
  private special = '';
  /** Ergebnis der Abweichungswürfel; useArrow = beim Hit gilt der kleine Pfeil */
  private scatter: { hit: boolean; angle: number; useArrow: boolean }[] = [];

  constructor(private publish: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void) {
    select('d-target-value').innerHTML = '<option value="">– (no target)</option>' +
      [2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}+</option>`).join('');
    select('d-kind').innerHTML = (Object.keys(KIND_NAMES) as DieKind[])
      .map((k) => `<option value="${k}">${KIND_NAMES[k]}</option>`).join('');
    $('d-roll').onclick = () => this.rollNow();
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
      this.dice = this.kind === 'd3' ? this.dice.map(() => rnd(3)) : roll(this.dice.length);
      this.publish({ kind: 'roll', text: `${this.dice.length} ${KIND_NAMES[this.kind]} re-rolled`, dice: [this.dice] });
      this.render();
    };
    // Hit-Seite angeklickt: stattdessen dem kleinen Pfeil folgen
    $('d-result').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-small-arrow]');
      const x = btn ? this.scatter[Number(btn.dataset.smallArrow)] : undefined;
      if (!x) return;
      x.useArrow = true;
      this.publish({ kind: 'roll', text: `Scatter dice: Hit – the small arrow is used instead (${x.angle}°)` });
      this.render();
    };
    $('d-clear').onclick = () => {
      this.dice = [];
      this.special = '';
      this.scatter = [];
      this.render();
    };
    this.render();
  }

  private rollNow(): void {
    const count = Math.max(1, Math.min(100, Math.round(Number(($('d-count') as HTMLInputElement).value) || 1)));
    this.kind = select('d-kind').value as DieKind;
    this.dice = [];
    this.special = '';
    this.scatter = [];
    if (this.kind === 'd6' || this.kind === 'd3') {
      this.dice = this.kind === 'd3' ? Array.from({ length: count }, () => rnd(3)) : roll(count);
      this.publish({ kind: 'roll', text: `${count} ${KIND_NAMES[this.kind]}`, dice: [this.dice] });
    } else if (this.kind === 'artillery') {
      const r = Array.from({ length: count }, artilleryDie);
      this.special = r.map((v) => `<span class="die die-art${v === 0 ? ' misfire' : ''}">${artilleryText(v)}</span>`).join('');
      this.publish({ kind: 'roll', text: `Artillery dice: ${r.map(artilleryText).join(', ')}` });
    } else {
      const r = Array.from({ length: count }, scatterDie);
      this.scatter = r.map((x) => ({ ...x, useArrow: false }));
      this.publish({ kind: 'roll', text: `Scatter dice: ${r.map((s) => (s.hit ? 'Hit' : `${s.angle}°`)).join(', ')}` });
    }
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
      ? `<p class="dice-sum">${this.dice.length} ${KIND_NAMES[this.kind]}${ok === null ? ` · total ${sum}` : ` · <b>${ok}</b> on ${t}+`}</p>
         <div class="dice-row">${diceHtml([...this.dice].sort((a, b) => b - a), t ?? 7)}</div>`
      : this.scatter.length ? `<div class="dice-row">${this.scatter.map((x, i) => scatterHtml(x, i, x.useArrow)).join('')}</div>`
        + (this.scatter.some((x) => x.hit && !x.useArrow) ? '<p class="meta">HIT: click the die to use its small arrow if a hit is not possible.</p>' : '')
      : this.special ? `<div class="dice-row">${this.special}</div>`
      : '<p class="meta">Choose the dice and roll.</p>';
    ($('d-keep') as HTMLButtonElement).disabled = t === null || !this.dice.length;
    ($('d-keep') as HTMLButtonElement).textContent = t === null ? 'Remove dice below target' : `Remove dice below ${t}+`;
    ($('d-reroll') as HTMLButtonElement).disabled = !this.dice.length;
    ($('d-reroll') as HTMLButtonElement).textContent = this.dice.length ? `Re-roll ${this.dice.length} dice` : 'Re-roll dice';
    ($('d-clear') as HTMLButtonElement).disabled = !this.dice.length && !this.special && !this.scatter.length;
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
