const $ = (id: string) => document.getElementById(id)!;
const STORAGE_KEY = 'tow-hidden-columns';

type Side = 'left';

/**
 * Linke Spalte ein- und ausblenden, damit der Tisch mehr Platz hat. Die rechte Spalte (Popups)
 * bleibt immer sichtbar. Der Zustand bleibt im Browser gespeichert.
 */
export class ViewToggles {
  constructor(private onChange: () => void) {
    $('toggle-left').onclick = () => this.toggle('left');
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<Side, boolean>>;
      this.apply('left', !!saved.left);
    } catch {
      // Ohne gespeicherten Zustand bleibt alles sichtbar
    }
  }

  hidden(side: Side): boolean {
    return document.body.classList.contains(`hide-${side}`);
  }

  toggle(side: Side): void {
    this.set(side, !this.hidden(side));
  }

  private set(side: Side, hide: boolean): void {
    this.apply(side, hide);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: this.hidden('left') }));
    } catch {
      // Speichern ist nur eine Bequemlichkeit
    }
    this.onChange();
  }

  private apply(side: Side, hide: boolean): void {
    document.body.classList.toggle(`hide-${side}`, hide);
    $(`toggle-${side}`).textContent = hide ? '⟩' : '⟨';
  }
}
