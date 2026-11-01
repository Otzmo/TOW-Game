/**
 * Griffe an den Innenkanten der linken und rechten Spalte: ziehen macht die Spalte breiter oder schmaler,
 * Doppelklick stellt die Standardbreite wieder her. Die Breite merkt sich der Browser.
 */
const KEY = 'tow-column-widths';

type Side = 'left' | 'right';

interface Widths { left?: number; right?: number }

const LIMITS: Record<Side, (w: number) => number> = {
  left: (w) => Math.round(Math.max(120, Math.min(420, w))),
  right: (w) => Math.round(Math.max(260, Math.min(window.innerWidth * 0.6, w))),
};

function load(): Widths {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Widths;
  } catch {
    return {};
  }
}

function save(w: Widths): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    // ohne Speicher gilt die Breite nur bis zum Neuladen
  }
}

/** @param changed nach jeder Änderung (Tisch neu einpassen) */
export function setupColumnResizers(changed: () => void): void {
  const sidebar = document.getElementById('sidebar')!;
  const root = document.documentElement;
  const widths = load();
  const apply = (side: Side, w: number | undefined) => {
    if (side === 'left') sidebar.style.width = w ? `${w}px` : '';
    else if (w) root.style.setProperty('--right', `${w}px`);
    else root.style.removeProperty('--right');
  };
  apply('left', widths.left && LIMITS.left(widths.left));
  apply('right', widths.right && LIMITS.right(widths.right));

  for (const side of ['left', 'right'] as const) {
    const grip = document.createElement('div');
    grip.className = `col-resizer ${side}`;
    grip.title = 'Drag to resize the column · double-click for the default width';
    document.body.appendChild(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('active');
      const move = (ev: PointerEvent) => {
        const w = LIMITS[side](side === 'left' ? ev.clientX : window.innerWidth - ev.clientX);
        widths[side] = w;
        apply(side, w);
        changed();
      };
      const up = () => {
        grip.classList.remove('active');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        save(widths);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => {
      delete widths[side];
      apply(side, undefined);
      save(widths);
      changed();
    });
  }
}
