import type { History } from '../model/history';
import { OBJECT_TYPES, typesOfKind } from '../model/objects';
import { SCENARIOS } from '../model/scenarios';
import type { Store } from '../model/store';
import type { GameState, ObjectKind } from '../model/types';
import type { BoardTools, Tool } from '../view/boardTools';
import { openSheet, toggleSheet } from './sheets';

const $ = (id: string) => document.getElementById(id)!;

const HINTS: Record<string, string> = {
  measure: 'Maßband: auf dem Tisch ziehen · Esc beendet',
  sight: 'Sichtlinie: vom Betrachter zum Ziel ziehen · Esc beendet',
};

const SAVE_FORMAT = 'tow-tabletop-save';

/** Werkzeugleiste links: Werkzeuge, Objekte setzen, Aufstellungszonen, Speichern und Laden. */
export class Toolbox {
  private pendingLoad: Pick<GameState, 'units' | 'meta' | 'objects' | 'log' | 'charges' | 'prompts'> | null = null;

  constructor(private store: Store, private history: History, tools: BoardTools,
    private log: (text: string) => void) {
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
      btn.onclick = () => tools.setTool(btn.dataset.tool as Tool);
    });
    document.querySelectorAll<HTMLButtonElement>('#toolbox [data-sheet]').forEach((btn) => {
      btn.onclick = () => toggleSheet(btn.dataset.sheet!);
    });
    tools.onToolChange = (tool) => this.showTool(tool);

    // Auswahllisten für Gelände, Marker und Schablonen
    document.querySelectorAll<HTMLElement>('.pick').forEach((box) => {
      box.innerHTML = typesOfKind(box.dataset.kind as ObjectKind)
        .map(([key, t]) => `<button data-place="${key}"><span class="swatch-sm" style="background:#${t.fill.toString(16).padStart(6, '0')}"></span>${t.name}</button>`)
        .join('');
      box.onclick = (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-place]');
        if (!btn) return;
        tools.setTool({ place: btn.dataset.place! });
        openSheet(null);
      };
    });

    this.renderZones();
    $('zone-list').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-zone]');
      if (!btn) return;
      store.setMeta({ scenario: btn.dataset.zone });
      this.log(`Aufstellung: ${SCENARIOS[btn.dataset.zone!].name}`);
    };
    store.subscribe((_, c) => { if (c.meta || c.loaded) this.renderZones(); });

    $('save-game').onclick = () => this.save();
    $('load-game').onclick = () => this.openLoad();
    $('load-file').onchange = () => {
      const file = ($('load-file') as HTMLInputElement).files?.[0];
      if (file) this.prepareLoad(file);
    };
    $('load-cancel').onclick = () => ($('load-dialog') as HTMLDialogElement).close();
    $('load-confirm').onclick = () => this.load();

    this.showTool(tools.tool);
  }

  private showTool(tool: Tool): void {
    const name = typeof tool === 'object' ? 'place' : tool;
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.tool === name);
    });
    const hint = typeof tool === 'object'
      ? `${OBJECT_TYPES[tool.place].name}: auf den Tisch klicken · Esc bricht ab`
      : HINTS[tool] ?? '';
    $('tool-hint').textContent = hint;
    $('tool-hint').hidden = !hint;
    document.body.classList.toggle('placing', name !== 'select');
  }

  /** Dateiauswahl für einen gespeicherten Spielstand öffnen */
  openLoad(): void {
    ($('load-file') as HTMLInputElement).value = '';
    $('load-file').click();
  }

  private renderZones(): void {
    const current = this.store.state.meta.scenario ?? 'none';
    $('zone-list').innerHTML = Object.entries(SCENARIOS)
      .map(([key, s]) => `<button data-zone="${key}" class="${key === current ? 'on' : ''}">${s.name}</button>`)
      .join('');
  }

  // --- Speichern und Laden ----------------------------------------------------

  save(): void {
    const { units, meta, objects, log, charges, prompts } = this.store.state;
    const data = { format: SAVE_FORMAT, version: 1, savedAt: new Date().toISOString(), units, meta, objects, log, charges, prompts };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tow-spiel-runde-${meta.round}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async prepareLoad(file: File): Promise<void> {
    const dialog = $('load-dialog') as HTMLDialogElement;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== SAVE_FORMAT || typeof data.units !== 'object') throw new Error();
      this.pendingLoad = {
        units: data.units, objects: data.objects ?? {}, log: data.log ?? [], charges: data.charges ?? {}, prompts: data.prompts ?? {},
        meta: { round: 1, active: 'p1', breakBonus: {}, ...data.meta },
      };
      const n = Object.keys(data.units).length;
      $('load-text').textContent = `Spielstand vom ${new Date(data.savedAt).toLocaleString('de-DE')}: ` +
        `Runde ${this.pendingLoad.meta.round}, ${n} Einheiten. Der aktuelle Tisch wird ersetzt – online auch beim Gegner.`;
      ($('load-confirm') as HTMLButtonElement).hidden = false;
    } catch {
      this.pendingLoad = null;
      $('load-text').textContent = 'Diese Datei ist kein Spielstand von TOW Tabletop.';
      ($('load-confirm') as HTMLButtonElement).hidden = true;
    }
    dialog.showModal();
  }

  private load(): void {
    ($('load-dialog') as HTMLDialogElement).close();
    if (!this.pendingLoad) return;
    this.history.clear();
    this.store.loadState(this.pendingLoad);
    this.log(`Spielstand geladen (Runde ${this.pendingLoad.meta.round})`);
    this.pendingLoad = null;
  }
}
