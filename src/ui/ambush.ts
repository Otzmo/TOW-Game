import { playerName } from '../model/players';
import { isJoined, joinedCharacters, type Store } from '../model/store';
import type { PlayerId } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Fenster „Ambushers“ unten links: alle Einheiten im Hinterhalt beider Spieler. Mit „Place“ wird eine Einheit
 * aufgestellt – der nächste Klick auf den Tisch bestimmt die Stelle.
 */
export class AmbushPanel {
  constructor(
    private store: Store,
    private seat: () => PlayerId | 'spectator' | null,
    actions: { place(id: string): void; select(id: string): void },
  ) {
    $('ambush-list').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ambush]');
      if (!btn) return;
      if (btn.dataset.act === 'place') actions.place(btn.dataset.ambush!);
      else actions.select(btn.dataset.ambush!);
    };
    store.subscribe((_, c) => { if (c.unitId || c.loaded || c.replacedOwner) this.render(); });
    this.render();
  }

  private mayAct(p: PlayerId): boolean {
    const s = this.seat();
    return s !== 'spectator' && (!s || s === p);
  }

  private render(): void {
    const units = this.store.state.units;
    const waiting = Object.values(units).filter((u) => u.ambush && !isJoined(u, units));
    $('ambush-count').textContent = waiting.length ? `(${waiting.length})` : '';
    $('ambush-list').innerHTML = (['p1', 'p2'] as const).map((p) => {
      const mine = waiting.filter((u) => u.owner === p);
      return `<section><h4><span class="dot ${p}"></span>${playerName(p)}</h4>${mine.length
        ? `<ul class="destroyed">${mine.map((u) => {
          const chars = joinedCharacters(u, units).map((c) => c.info.name);
          return `<li><button class="rule-link" data-ambush="${u.id}">${esc(u.info.name)}</button>
            <span class="meta">${u.models} model${u.models === 1 ? '' : 's'}${chars.length ? ` · with ${esc(chars.join(', '))}` : ''}</span>
            <button data-ambush="${u.id}" data-act="place" class="primary" ${this.mayAct(p) ? '' : 'disabled'}>⌖ Place</button></li>`;
        }).join('')}</ul>`
        : '<p class="meta">No units in ambush.</p>'}</section>`;
    }).join('') + '<p class="meta">Place: click the button, then click on the table where the unit arrives. Afterwards it can be moved as usual.</p>';
  }
}
