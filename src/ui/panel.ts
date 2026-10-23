import type { Store } from '../model/store';
import {
  canSkirmish, isJoined, isSkirmish, joinedCharacters, SKIRMISH_GAP, spreadPositions, unitLayout,
} from '../model/store';
import type { RuleRef } from '../model/types';
import { PLAYER_COLORS } from '../view/theme';

const $ = (id: string) => document.getElementById(id)!;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ruleHtml(r: RuleRef): string {
  const note = r.note ? `<span class="note">${escapeHtml(r.note)}</span>` : '';
  const link = r.url ? `\n<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Volltext ↗</a>` : '';
  return `<details><summary>${escapeHtml(r.name)}${note}</summary><p>${escapeHtml(r.text || 'Kein Text gefunden.')}${link}</p></details>`;
}

export interface PanelActions {
  close(): void;
  select(unitId: string): void;
  detach(charId: string): void;
}

/** Seitenpanel mit allen Angaben zur ausgewählten Einheit. */
export class UnitPanel {
  private unitId: string | null = null;
  private lastAction = new Map<string, string>();

  constructor(private store: Store, actions: PanelActions) {
    $('p-close').onclick = () => actions.close();
    document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
      btn.onclick = () => this.onFormation(btn.dataset.act!);
    });
    document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((btn) => {
      btn.onclick = () => this.setFormation(btn.dataset.form as 'close' | 'skirmish');
    });
    $('p-join').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn) return;
      if (btn.dataset.select) actions.select(btn.dataset.select);
      if (btn.dataset.detach) actions.detach(btn.dataset.detach);
    };
    store.subscribe((_, { unitId, patch }) => {
      if (!unitId || unitId === this.unitId || (patch && 'joinedTo' in patch)) this.render();
    });
  }

  show(unitId: string | null): void {
    this.unitId = unitId;
    this.render();
  }

  setLastAction(unitId: string, text: string): void {
    this.lastAction.set(unitId, text);
    if (unitId === this.unitId) this.render();
  }

  private onFormation(act: string): void {
    const units = this.store.state.units;
    const u = this.unitId ? units[this.unitId] : undefined;
    if (!u) return;
    const { cols, slots } = unitLayout(u, units);
    if (act === 'w-') this.store.updateUnit(u.id, { width: Math.max(1, cols - 1) });
    if (act === 'w+') this.store.updateUnit(u.id, { width: Math.min(slots.length, cols + 1) });
    if (act === 'm-') this.store.updateUnit(u.id, { models: Math.max(1, u.models - 1) });
    if (act === 'm+') this.store.updateUnit(u.id, { models: u.models + 1 });
  }

  private setFormation(form: 'close' | 'skirmish'): void {
    const units = this.store.state.units;
    const u = this.unitId ? units[this.unitId] : undefined;
    if (!u || (u.formation ?? 'close') === form) return;
    if (form === 'skirmish') {
      // Geschlossene Aufstellung locker auseinanderziehen
      this.store.updateUnit(u.id, { formation: 'skirmish', positions: spreadPositions(u, units) });
    } else {
      this.store.updateUnit(u.id, { formation: 'close', positions: null });
    }
    this.setLastAction(u.id, form === 'skirmish' ? 'in Plänklerformation gewechselt' : 'in geschlossene Formation gewechselt');
  }

  private render(): void {
    const units = this.store.state.units;
    const u = this.unitId ? units[this.unitId] : undefined;
    $('panel').hidden = !u;
    if (!u) return;
    const { info } = u;
    const { cols, ranks, w, h, stray } = unitLayout(u, units);
    const joined = isJoined(u, units);
    const skirmish = isSkirmish(u);

    $('p-swatch').style.background = PLAYER_COLORS[u.owner].css;
    $('p-name').textContent = info.name;
    const base = `Base ${info.baseWidth}×${info.baseDepth} mm`;
    const warn = stray.size ? ` · <span class="warn-line">${stray.size} außerhalb von ${SKIRMISH_GAP}″</span>` : '';
    $('p-meta').innerHTML = joined
      ? `${u.models} Modell · ${base}`
      : skirmish
        ? `${u.models} Modelle · ${base} · Plänkler · Fläche ${w.toFixed(1)}″ × ${h.toFixed(1)}″${warn}`
        : `${u.models} Modelle · ${base} · Formation ${cols} × ${ranks} · Fläche ${w.toFixed(1)}″ × ${h.toFixed(1)}″`;
    $('p-join').innerHTML = this.joinHtml(u.id);
    $('p-profile').innerHTML = info.profile
      .map((r) => `<tr><td>${escapeHtml(r.name)}</td>${r.values.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`)
      .join('');
    $('p-equip').textContent = info.equipment || '–';
    $('p-options').textContent = info.options.join(' · ') || '–';
    $('p-items-head').hidden = info.items.length === 0;
    $('p-items').innerHTML = info.items.map(ruleHtml).join('');
    $('p-rules').innerHTML = info.rules.map(ruleHtml).join('') || '<p>–</p>';
    $('p-source').innerHTML = info.url
      ? `Quelle: <a href="${escapeHtml(info.url)}" target="_blank" rel="noopener">tow.whfb.app ↗</a>`
      : '';
    // Ein angeschlossener Charakter hat keine eigene Formation
    $('p-formation').hidden = joined;
    $('p-form-row').hidden = !canSkirmish(u) && !skirmish;
    $('p-width-row').hidden = skirmish;
    document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.form === (u.formation ?? 'close'));
    });
    $('p-width').textContent = String(cols);
    $('p-models').textContent = String(u.models);
    const last = this.lastAction.get(u.id);
    $('p-move').textContent = last ? `Letzte Aktion: ${last}` : '';
  }

  /** Anschluss-Status: Charakter in Einheit, Charaktere einer Einheit oder Hinweis zum Anschließen. */
  private joinHtml(id: string): string {
    const units = this.store.state.units;
    const u = units[id];
    if (isJoined(u, units)) {
      const host = units[u.joinedTo!];
      return `<div class="join-row"><span>In Einheit: <button class="link" data-select="${escapeHtml(host.id)}">` +
        `${escapeHtml(host.info.name)}</button></span>` +
        `<button data-detach="${escapeHtml(u.id)}">Einheit verlassen</button></div>`;
    }
    const chars = joinedCharacters(u, units);
    if (chars.length) {
      const list = chars.map((c) => `<button class="link" data-select="${escapeHtml(c.id)}">${escapeHtml(c.info.name)}</button>`);
      return `<div class="join-row"><span>Charaktere: ${list.join(', ')}</span></div>`;
    }
    if (u.info.isCharacter) {
      return '<p class="hint">Zum Anschließen auf eine eigene Einheit ziehen.</p>';
    }
    return '';
  }
}
