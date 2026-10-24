import { importBbList, type ImportResult } from '../data/importer';
import { moveToNoMansLand } from '../model/noMansLand';
import { playerName } from '../model/players';
import type { Store } from '../model/store';
import type { PlayerId } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Knöpfe "Armee laden" und die Vorschau vor dem Aufstellen. */
export class ImportDialog {
  private owner: PlayerId = 'p1';
  private pending: ImportResult | null = null;
  private readonly dialog = $('import-dialog') as HTMLDialogElement;
  private readonly fileInput = $('import-file') as HTMLInputElement;

  constructor(private store: Store, private onDeployed: (owner: PlayerId) => void) {
    document.querySelectorAll<HTMLButtonElement>('[data-import]').forEach((btn) => {
      btn.onclick = () => {
        this.owner = btn.dataset.import as PlayerId;
        this.fileInput.value = '';
        this.fileInput.click();
      };
    });
    this.fileInput.onchange = () => {
      const file = this.fileInput.files?.[0];
      if (file) this.load(file);
    };
    $('import-confirm').onclick = () => this.confirm();
    $('import-cancel').onclick = () => this.dialog.close();
  }

  private async load(file: File): Promise<void> {
    this.pending = null;
    $('import-confirm').hidden = true;
    $('import-title').textContent = `Army for ${playerName(this.owner)}`;
    $('import-body').innerHTML = '<p class="meta">Loading …</p>';
    this.dialog.showModal();
    try {
      const json = JSON.parse(await file.text());
      const result = await importBbList(json, this.owner, this.store.state.table);
      this.pending = result;
      this.renderPreview(result);
      $('import-confirm').hidden = false;
    } catch (e) {
      const msg = e instanceof SyntaxError ? 'The file is not valid JSON.' : (e as Error).message;
      $('import-body').innerHTML = `<p class="warn">${escapeHtml(msg)}</p>`;
    }
  }

  private renderPreview(r: ImportResult): void {
    const rows = r.units.map((u) => {
      const i = u.info;
      const missing = i.profile.length === 0;
      return `<tr class="${missing ? 'missing' : ''}">
        <td>${missing ? '⚠' : '✓'}</td>
        <td>${u.models}× ${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.troopType)}</td>
        <td>${i.baseWidth}×${i.baseDepth}</td>
        <td>${i.rules.length}</td>
        <td>${i.items.length}</td>
      </tr>`;
    }).join('');
    const warnings = r.warnings.length
      ? `<ul class="warn">${r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
      : '<p class="ok">All units, special rules and items matched.</p>';
    $('import-body').innerHTML = `
      <p class="meta">${escapeHtml(r.listName)} · ${escapeHtml(r.factionName)} · ${r.units.length} units</p>
      <table class="preview">
        <thead><tr><th></th><th>Unit</th><th>Troop Type</th><th>Base mm</th><th>Rules</th><th>Items</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${warnings}`;
  }

  private confirm(): void {
    if (!this.pending) return;
    this.store.replacePlayerUnits(this.owner, this.pending.units);
    // Neue Armee ins Niemandsland, außerhalb beider Zonen; die andere Armee bleibt stehen
    moveToNoMansLand(this.store, [this.owner]);
    // Armee für die Anzeige links merken (Fraktion und Listenname)
    const armies = { ...this.store.state.meta.armies, [this.owner]: { faction: this.pending.factionName, list: this.pending.listName } };
    this.store.setMeta({ armies });
    this.dialog.close();
    this.onDeployed(this.owner);
  }
}
