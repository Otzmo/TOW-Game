import { playerName } from '../model/players';
import type { Store } from '../model/store';
import type { UnitState } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STATUS: Record<string, string> = { destroyed: 'Destroyed', fledOff: 'Fled the battlefield' };

/** Fenster „Destroyed“ unten links: alle vernichteten und geflohenen Einheiten beider Spieler mit Punkten. */
export class DestroyedPanel {
  constructor(private store: Store, private select: (id: string) => void) {
    $('destroyed-list').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unit]');
      if (btn) this.select(btn.dataset.unit!);
    };
    store.subscribe((_, c) => { if (c.unitId || c.loaded || c.replacedOwner) this.render(); });
    this.render();
  }

  private render(): void {
    const gone = Object.values(this.store.state.units).filter((u) => u.status === 'destroyed' || u.status === 'fledOff');
    $('destroyed-count').textContent = gone.length ? `(${gone.length})` : '';
    const row = (u: UnitState) => `<li><button class="rule-link" data-unit="${u.id}">${esc(u.info.name)}</button>
      <span class="meta">${STATUS[u.status!]}${u.info.points ? ` · ${u.info.points} pts` : ''}</span></li>`;
    $('destroyed-list').innerHTML = (['p1', 'p2'] as const).map((p) => {
      const mine = gone.filter((u) => u.owner === p);
      const pts = mine.reduce((s, u) => s + (u.info.points ?? 0), 0);
      return `<section><h4><span class="dot ${p}"></span>${playerName(p)} <span class="meta">${mine.length} units · ${pts} pts</span></h4>
        ${mine.length ? `<ul class="destroyed">${mine.map(row).join('')}</ul>` : '<p class="meta">None.</p>'}</section>`;
    }).join('');
  }
}
