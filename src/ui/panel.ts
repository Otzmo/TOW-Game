import type { Store } from '../model/store';
import {
  canSkirmish, isJoined, isNonUnitChange, isSkirmish, joinedCharacters, SKIRMISH_GAP, spreadPositions, unitLayout,
} from '../model/store';
import type { History } from '../model/history';
import { hasStandard, unitVictoryPoints, wounds } from '../model/score';
import type { RuleRef, UnitState, UnitStatus } from '../model/types';
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
  showRanges(on: boolean): void;
}

/** Seitenpanel mit allen Angaben zur ausgewählten Einheit. */
export class UnitPanel {
  private unitId: string | null = null;
  private lastAction = new Map<string, string>();

  constructor(private store: Store, private history: History, actions: PanelActions) {
    $('p-close').onclick = () => actions.close();
    $('p-rank').onclick = () => this.arrangeInRanks();
    ($('p-ranges') as HTMLInputElement).onchange = (e) => actions.showRanges((e.target as HTMLInputElement).checked);
    $('p-status').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (btn) this.change({ status: (btn.dataset.status || null) as UnitStatus | null });
    };
    $('p-wounds-row').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      const u = this.unit();
      if (!btn || !u) return;
      const lost = u.woundsLost ?? 0;
      const total = wounds(u).total;
      this.change({ woundsLost: btn.dataset.wound === 'lose' ? Math.min(total, lost + 1) : Math.max(0, lost - 1) });
    };
    ($('p-captured') as HTMLInputElement).onchange = (e) => {
      this.change({ standardCaptured: (e.target as HTMLInputElement).checked });
    };
    ($('p-points') as HTMLInputElement).onchange = (e) => {
      const u = this.unit();
      const points = Math.max(0, Math.round(Number((e.target as HTMLInputElement).value) || 0));
      if (u) this.change({ info: { ...u.info, points } });
    };
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
    store.subscribe((_, change) => {
      if (isNonUnitChange(change)) return;
      const { unitId, patch } = change;
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

  private unit(): UnitState | undefined {
    return this.unitId ? this.store.state.units[this.unitId] : undefined;
  }

  /** Änderung an der ausgewählten Einheit, rückgängig machbar. */
  change(patch: Partial<UnitState>): void {
    const u = this.unit();
    if (!u) return;
    this.history.record();
    this.store.updateUnit(u.id, patch);
  }

  /** Breite (w-/w+) oder Modellzahl (m-/m+) der ausgewählten Einheit ändern */
  onFormation(act: string): void {
    const units = this.store.state.units;
    const u = this.unit();
    if (!u) return;
    // Plänkler haben keine Glieder; die Breite gilt dort für "In Reihen ordnen"
    const cols = isSkirmish(u) ? Math.min(u.width, u.models) : unitLayout(u, units).cols;
    const max = isSkirmish(u) ? u.models : unitLayout(u, units).slots.length;
    if (act === 'w-') this.change({ width: Math.max(1, cols - 1) });
    if (act === 'w+') this.change({ width: Math.min(max, cols + 1) });
    if (act === 'm-') this.change({ models: Math.max(1, u.models - 1) });
    if (act === 'm+') this.change({ models: u.models + 1 });
  }

  /** Plänkler in Reihen mit 0,5″ Abstand aufstellen (Breite wie eingestellt). */
  arrangeInRanks(): void {
    const u = this.unit();
    if (!u || !isSkirmish(u)) return;
    this.change({ positions: spreadPositions(u, this.store.state.units) });
    this.setLastAction(u.id, 'in Reihen mit 0,5″ Abstand geordnet');
  }

  /** Zwischen geschlossener Formation und Plänklern wechseln, falls erlaubt */
  toggleFormation(): void {
    const u = this.unit();
    if (u && (canSkirmish(u) || isSkirmish(u))) this.setFormation(isSkirmish(u) ? 'close' : 'skirmish');
  }

  /** Reichweiten-Anzeige umschalten (wie das Häkchen) */
  toggleRanges(): void {
    const box = $('p-ranges') as HTMLInputElement;
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  }

  setFormation(form: 'close' | 'skirmish'): void {
    const units = this.store.state.units;
    const u = this.unit();
    if (!u || (u.formation ?? 'close') === form) return;
    this.history.record();
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
    $('p-items-head').parentElement!.hidden = info.items.length === 0;
    $('p-items').innerHTML = info.items.map(ruleHtml).join('');
    $('p-rules').innerHTML = info.rules.map(ruleHtml).join('') || '<p>–</p>';
    $('p-source').innerHTML = info.url
      ? `Quelle: <a href="${escapeHtml(info.url)}" target="_blank" rel="noopener">tow.whfb.app ↗</a>`
      : '';
    // Ein angeschlossener Charakter hat keine eigene Formation
    $('p-formation').hidden = joined;
    $('p-form-row').hidden = !canSkirmish(u) && !skirmish;
    $('p-rank').hidden = !skirmish;
    $('p-width-row').querySelector('.label')!.textContent = skirmish ? 'Breite beim Ordnen' : 'Breite (Modelle in Front)';

    // Siegpunkte
    document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((btn) => {
      btn.classList.toggle('on', (btn.dataset.status || null) === (u.status ?? null));
    });
    const single = (info.startModels ?? u.models) === 1;
    $('p-wounds-row').hidden = !single;
    const wd = wounds(u);
    $('p-wounds').textContent = `${wd.left}/${wd.total}`;
    $('p-captured-row').hidden = !hasStandard(u);
    ($('p-captured') as HTMLInputElement).checked = !!u.standardCaptured;
    const pointsInput = $('p-points') as HTMLInputElement;
    if (document.activeElement !== pointsInput) pointsInput.value = String(info.points ?? 0);
    const vp = unitVictoryPoints(u);
    const total = vp.reduce((s, l) => s + l.vp, 0);
    const tags = [info.isGeneral ? 'General' : '', info.isBsb ? 'Armeestandarte' : ''].filter(Boolean).join(' · ');
    $('p-vp-value').textContent = `Bringt dem Gegner jetzt ${total} SP` + (tags ? ` · ${tags}` : '');
    document.querySelectorAll<HTMLButtonElement>('[data-form]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.form === (u.formation ?? 'close'));
    });
    $('p-width').textContent = String(skirmish ? Math.min(u.width, u.models) : cols);
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
