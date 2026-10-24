/**
 * Fenster der Hilfsmittel (Würfel, Protokoll, Siegpunkte …). Sie öffnen sich unten an der langen
 * Tischkante, an der Stelle der Einheitenleiste; es ist immer höchstens eins offen.
 */

type Listener = (open: string | null) => void;
const listeners = new Set<Listener>();
let current: string | null = null;
let closeButtonsAdded = false;

/** Jedes Fenster bekommt oben rechts ein × zum Schließen. */
function addCloseButtons(): void {
  closeButtonsAdded = true;
  document.querySelectorAll<HTMLElement>('.sheet').forEach((el) => {
    const btn = document.createElement('button');
    btn.className = 'close sheet-close';
    btn.setAttribute('aria-label', 'Close');
    btn.textContent = '×';
    btn.onclick = () => openSheet(null);
    el.prepend(btn);
  });
}

export function openSheet(name: string | null): void {
  if (!closeButtonsAdded) addCloseButtons();
  current = name;
  document.querySelectorAll<HTMLElement>('.sheet').forEach((el) => {
    el.hidden = el.id !== `sheet-${name}`;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-sheet]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.sheet === name);
  });
  // Die Einheiten- bzw. Objektleiste tritt zurück, solange ein Fenster offen ist
  document.body.classList.toggle('sheet-open', name !== null);
  for (const fn of listeners) fn(name);
}

export function toggleSheet(name: string): void {
  openSheet(current === name ? null : name);
}

export const openedSheet = () => current;

export function onSheetChange(fn: Listener): void {
  listeners.add(fn);
}
