import type { Store } from '../model/store';

const $ = (id: string) => document.getElementById(id) as HTMLTextAreaElement;

/** Allgemeine Notizen: ein Textfeld, das im Spielstand liegt und so für beide Spieler sichtbar ist. */
export class NotesPanel {
  private timer = 0;

  constructor(private store: Store) {
    // Beim Tippen kurz warten, dann speichern (nicht bei jedem Zeichen ins Netz schreiben)
    $('notes-text').oninput = () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.save(), 600);
    };
    $('notes-text').onchange = () => this.save();
    store.subscribe((_, c) => { if (c.meta || c.loaded) this.render(); });
    this.render();
  }

  private save(): void {
    clearTimeout(this.timer);
    const notes = $('notes-text').value;
    if (notes !== (this.store.state.meta.notes ?? '')) this.store.setMeta({ notes });
  }

  private render(): void {
    const box = $('notes-text');
    if (document.activeElement !== box) box.value = this.store.state.meta.notes ?? '';
  }
}
