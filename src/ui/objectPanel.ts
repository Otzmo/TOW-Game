import type { History } from '../model/history';
import { OBJECT_TYPES } from '../model/objects';
import type { Store } from '../model/store';
import type { BoardObject } from '../model/types';

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;

/** Fenster rechts für ein ausgewähltes Gelände, einen Marker oder eine Schablone. */
export class ObjectPanel {
  private id: string | null = null;

  constructor(private store: Store, private history: History, actions: { close(): void; remove(): void }) {
    $('o-close').onclick = () => actions.close();
    $('o-delete').onclick = () => actions.remove();
    input('o-label').onchange = () => this.change({ label: input('o-label').value.trim() || null });
    input('o-w').onchange = () => this.change({ w: Math.max(0.5, Number(input('o-w').value) || 0.5) });
    input('o-h').onchange = () => this.change({ h: Math.max(0.5, Number(input('o-h').value) || 0.5) });
    input('o-rot').onchange = () => this.change({ rotation: ((Number(input('o-rot').value) || 0) * Math.PI) / 180 });
    store.subscribe((_, c) => {
      if (c.objectId === this.id || c.loaded) this.render();
    });
  }

  show(id: string | null): void {
    this.id = id;
    this.render();
  }

  private change(patch: Partial<BoardObject>): void {
    if (!this.id) return;
    this.history.record();
    this.store.updateObject(this.id, patch);
  }

  private render(): void {
    const o = this.id ? this.store.state.objects[this.id] : undefined;
    $('obj-panel').hidden = !o;
    if (!o) return;
    const t = OBJECT_TYPES[o.type];
    $('o-name').textContent = t?.name ?? o.type;
    // Felder nicht überschreiben, während jemand darin tippt
    const set = (id: string, v: string) => { if (document.activeElement !== $(id)) input(id).value = v; };
    set('o-label', o.label ?? '');
    set('o-w', o.w.toFixed(1));
    set('o-h', o.h.toFixed(1));
    set('o-rot', String(Math.round((((o.rotation * 180) / Math.PI) % 360 + 360) % 360)));
    $('o-size-row').hidden = !!t?.fixedSize || o.kind === 'marker';
    $('o-rot-row').hidden = o.kind === 'marker';
    const sight = t?.sight === 'blocks' ? 'Blockiert die Sichtlinie.' : t?.sight === 'cover' ? 'Sichtlinie hindurch gibt Deckung.' : '';
    $('o-meta').textContent = [t?.kind === 'template' ? `Feste Größe: ${t.w}″ × ${t.h}″.` : '', sight]
      .filter(Boolean).join(' ');
  }
}
