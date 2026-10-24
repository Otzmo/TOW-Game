/** Seitenfenster neben der Werkzeugleiste; es ist immer höchstens eins offen. */

type Listener = (open: string | null) => void;
const listeners = new Set<Listener>();
let current: string | null = null;

export function openSheet(name: string | null): void {
  current = name;
  document.querySelectorAll<HTMLElement>('.sheet').forEach((el) => {
    el.hidden = el.id !== `sheet-${name}`;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-sheet]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.sheet === name);
  });
  for (const fn of listeners) fn(name);
}

export function toggleSheet(name: string): void {
  openSheet(current === name ? null : name);
}

export const openedSheet = () => current;

export function onSheetChange(fn: Listener): void {
  listeners.add(fn);
}
