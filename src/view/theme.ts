import type { PlayerId } from '../model/types';

/** Pixel pro Zoll in Weltkoordinaten. */
export const PPI = 20;

export const PLAYER_COLORS: Record<PlayerId, { fill: number; edge: number; dark: number; css: string }> = {
  p1: { fill: 0x7a1414, edge: 0xe0b44c, dark: 0x2a0606, css: '#7a1414' },
  p2: { fill: 0x1c3f7a, edge: 0xcfd8e6, dark: 0x08142a, css: '#1c3f7a' },
};

export const TABLE_COLOR = 0x41592f;

/** Zufallsfolge mit festem Startwert: gleiche Struktur (Gras, Bäume …) bei jedem Laden und für beide Spieler */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Startwert aus einem Text, z. B. der Kennung eines Geländestücks */
export const hashSeed = (text: string) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 2166136261);
export const GUIDE_COLOR = 0xe0b44c;
/** Plänkler außerhalb von 1″ bzw. ungültige Position */
export const STRAY_COLOR = 0xf0603e;
export const OK_COLOR = 0x8fca7a;
