import type { Point } from './types';

/** Aufstellungszonen je Szenario; Polygone in Zoll auf einem 72″ × 48″ Tisch. */
export interface Scenario {
  name: string;
  zones: { p1: Point[]; p2: Point[] } | null;
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

export const SCENARIOS: Record<string, Scenario> = {
  none: { name: 'Keine Zonen', zones: null },
  // Lange Tischkanten, mehr als 12″ von der Mittellinie entfernt
  lines: { name: 'Lange Kanten (12″ zur Mitte)', zones: { p1: rect(0, 36, 72, 48), p2: rect(0, 0, 72, 12) } },
  // Kurze Tischkanten, je 24″ tief
  flanks: { name: 'Kurze Kanten (24″ tief)', zones: { p1: rect(0, 0, 24, 48), p2: rect(48, 0, 72, 48) } },
  // Diagonal geteilte Ecken
  diagonal: {
    name: 'Diagonal (Ecken)',
    zones: {
      p1: [{ x: 0, y: 48 }, { x: 0, y: 16 }, { x: 40, y: 48 }],
      p2: [{ x: 72, y: 0 }, { x: 72, y: 32 }, { x: 32, y: 0 }],
    },
  },
};
