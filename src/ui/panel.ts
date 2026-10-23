import type { Store } from '../model/store';
import { unitFootprint } from '../model/store';
import { PLAYER_COLORS } from '../view/theme';

const $ = (id: string) => document.getElementById(id)!;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Seitenpanel mit allen Angaben zur ausgewählten Einheit. */
export class UnitPanel {
  private unitId: string | null = null;
  private lastAction = new Map<string, string>();

  constructor(private store: Store, onClose: () => void) {
    $('p-close').onclick = onClose;
    document.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
      btn.onclick = () => this.onFormation(btn.dataset.act!);
    });
    store.subscribe((_, changedId) => {
      if (!changedId || changedId === this.unitId) this.render();
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
    const u = this.unitId ? this.store.state.units[this.unitId] : undefined;
    if (!u) return;
    const width = Math.min(u.width, u.models);
    if (act === 'w-') this.store.updateUnit(u.id, { width: Math.max(1, width - 1) });
    if (act === 'w+') this.store.updateUnit(u.id, { width: Math.min(u.models, width + 1) });
    if (act === 'm-') this.store.updateUnit(u.id, { models: Math.max(1, u.models - 1) });
    if (act === 'm+') this.store.updateUnit(u.id, { models: u.models + 1 });
  }

  private render(): void {
    const u = this.unitId ? this.store.state.units[this.unitId] : undefined;
    $('panel').hidden = !u;
    if (!u) return;
    const { info } = u;
    const { cols, ranks, w, h } = unitFootprint(u);

    $('p-swatch').style.background = PLAYER_COLORS[u.owner].css;
    $('p-name').textContent = info.name;
    $('p-meta').textContent =
      `${u.models} Modelle · Base ${info.baseWidth}×${info.baseDepth} mm · Formation ${cols} × ${ranks} · ` +
      `Fläche ${w.toFixed(1)}″ × ${h.toFixed(1)}″`;
    $('p-profile').innerHTML = info.profile
      .map((r) => `<tr><td>${escapeHtml(r.name)}</td>${r.values.map((v) => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`)
      .join('');
    $('p-equip').textContent = info.equipment;
    $('p-rules').innerHTML = info.rules
      .map((r) => {
        const link = r.url ? ` <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Volltext ↗</a>` : '';
        return `<details><summary>${escapeHtml(r.name)}</summary><p>${escapeHtml(r.text)}${link}</p></details>`;
      })
      .join('');
    $('p-width').textContent = String(cols);
    $('p-models').textContent = String(u.models);
    const last = this.lastAction.get(u.id);
    $('p-move').textContent = last ? `Letzte Aktion: ${last}` : '';
  }
}
