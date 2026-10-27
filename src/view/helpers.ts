/** Hilfen beim Bewegen und beim Angriff – je eine Checkbox, angehakt = das Spiel hilft (pro Spieler gespeichert) */
export type Helper = 'maximise' | 'snap' | 'apart';

export const HELPERS: { key: Helper; label: string; hint: string }[] = [
  { key: 'maximise', label: 'Maximise contact on the charge move', hint: 'as many models as possible into base contact' },
  { key: 'snap', label: 'Snap to an enemy edge', hint: 'when a unit is released within 1″ of it' },
  { key: 'apart', label: 'Keep units from overlapping', hint: 'push a dropped unit off other units' },
];

const STORAGE = 'tow-helpers-off';

function load(): Set<Helper> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE) ?? '[]') as Helper[]);
  } catch {
    return new Set();
  }
}

const off = load();

export const helperOn = (key: Helper) => !off.has(key);

export function setHelper(key: Helper, on: boolean): void {
  if (on) off.delete(key);
  else off.add(key);
  try {
    localStorage.setItem(STORAGE, JSON.stringify([...off]));
  } catch {
    // ohne Speicher gilt die Wahl nur bis zum Neuladen
  }
}
