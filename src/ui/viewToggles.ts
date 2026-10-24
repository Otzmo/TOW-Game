const $ = (id: string) => document.getElementById(id)!;
const STORAGE_KEY = 'tow-hidden-columns';

type Side = 'left' | 'right';

/**
 * Spalten links und rechts ein- und ausblenden, damit der Tisch das ganze Fenster nutzen kann.
 * Der Zustand bleibt im Browser gespeichert. Kommt eine Aufforderung (Popup) an, wird die rechte
 * Spalte automatisch wieder eingeblendet, damit sie nicht übersehen wird.
 */
export class ViewToggles {
  constructor(private onChange: () => void) {
    $('toggle-left').onclick = () => this.toggle('left');
    $('toggle-right').onclick = () => this.toggle('right');
    $('toggle-all').onclick = () => this.toggleAll();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<Side, boolean>>;
      this.apply('left', !!saved.left);
      this.apply('right', !!saved.right);
    } catch {
      // Ohne gespeicherten Zustand bleibt alles sichtbar
    }
    new MutationObserver(() => {
      if (!$('prompt-card').hidden && this.hidden('right')) this.set('right', false);
    }).observe($('prompt-card'), { attributes: true, attributeFilter: ['hidden'] });
  }

  hidden(side: Side): boolean {
    return document.body.classList.contains(`hide-${side}`);
  }

  toggle(side: Side): void {
    this.set(side, !this.hidden(side));
  }

  /** Alles aus, wenn noch etwas sichtbar ist; sonst alles wieder an. */
  toggleAll(): void {
    const hide = !(this.hidden('left') && this.hidden('right'));
    this.apply('left', hide);
    this.set('right', hide);
  }

  private set(side: Side, hide: boolean): void {
    this.apply(side, hide);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: this.hidden('left'), right: this.hidden('right') }));
    } catch {
      // Speichern ist nur eine Bequemlichkeit
    }
    this.onChange();
  }

  private apply(side: Side, hide: boolean): void {
    document.body.classList.toggle(`hide-${side}`, hide);
    $(`toggle-${side}`).textContent = side === 'left' ? (hide ? '⟩' : '⟨') : (hide ? '⟨' : '⟩');
  }
}
