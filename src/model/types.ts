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
  /** Charakter, der sich Einheiten anschließen kann */
  isCharacter?: boolean;
  /** Punktkosten laut Armeeliste (für Siegpunkte) */
  points?: number;
  isGeneral?: boolean;
  isBsb?: boolean;
  /** Modellzahl zu Spielbeginn (für die 25-%-Regel) */
  startModels?: number;
  /** Lebenspunkte je Modell laut Profil */
  woundsPerModel?: number;
  url?: string;
}

/** Zustand für Siegpunkte: vernichtet, vom Tisch geflohen oder gerade fliehend */
export type UnitStatus = 'destroyed' | 'fledOff' | 'fleeing';

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
  /** Bei Charakteren: Einheit, der sie sich angeschlossen haben (null = keine) */
  joinedTo?: string | null;
  /** Fehlt = geschlossene Formation */
  formation?: 'close' | 'skirmish';
  /**
   * Plänkler: Mittelpunkt jedes Modells relativ zur Einheitsmitte, in Einheitsrichtung (Front = −y).
   * Schlüssel "m0", "m1", … für Truppen, bei angeschlossenen Charakteren deren id.
   */
  positions?: Record<string, Point> | null;
  /** Fehlt/null = normal im Spiel */
  status?: UnitStatus | null;
  /** Standarte vom Gegner erbeutet */
  standardCaptured?: boolean;
  /** Bei Einzelmodellen: verlorene Lebenspunkte */
  woundsLost?: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Spielweite Angaben, die beide Spieler teilen. */
export interface GameMeta {
  round: number;
  /** Spieler am Zug */
  active: PlayerId;
  /** Hat dieser Spieler die gegnerische Armee gebrochen? (+500 SP) */
  breakBonus: Partial<Record<PlayerId, boolean>>;
}

export interface GameState {
  table: { width: number; height: number };
  units: Record<string, UnitState>;
  meta: GameMeta;
}
