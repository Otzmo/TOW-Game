/** Alle Längen im Spielzustand sind in Zoll, Winkel in Radiant. */

export type PlayerId = 'p1' | 'p2';

export interface ProfileRow {
  name: string;
  /** M, WS, BS, S, T, W, I, A, Ld – als Text, damit z. B. "4(6)" oder "-" möglich ist */
  values: string[];
}

export interface RuleRef {
  name: string;
  text: string;
  /** Link zum Volltext, z. B. auf tow.whfb.app */
  url?: string;
  /** Zusatzinfo, z. B. Gegenstandstyp und Punkte */
  note?: string;
}

/** Feste Angaben zu einer Einheit, ändern sich im Spiel nicht. */
export interface UnitInfo {
  name: string;
  troopType: string;
  /** Base-Größe in mm: Breite × Tiefe */
  baseWidth: number;
  baseDepth: number;
  profile: ProfileRow[];
  equipment: string;
  options: string[];
  rules: RuleRef[];
  items: RuleRef[];
  /** Kürzel der Kommandomodelle im ersten Glied, z. B. ['M', 'S', 'C'] */
  command: string[];
  url?: string;
}

/** Veränderlicher Zustand einer Einheit auf dem Tisch. */
export interface UnitState {
  id: string;
  owner: PlayerId;
  info: UnitInfo;
  models: number;
  /** Modelle pro Glied */
  width: number;
  x: number;
  y: number;
  rotation: number;
}

export interface GameState {
  table: { width: number; height: number };
  units: Record<string, UnitState>;
}
