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
  /** Aufstellungszonen, siehe SCENARIOS */
  scenario?: string;
  /** Aktuelle Phase, siehe phases.ts; fehlt = Aufstellung */
  phase?: 'setup' | 'strategy' | 'movement' | 'shooting' | 'combat';
}

/** Gelände, Marker und Schablonen auf dem Tisch. */
export type ObjectKind = 'terrain' | 'marker' | 'template';

export interface BoardObject {
  id: string;
  kind: ObjectKind;
  /** Schlüssel im Katalog (objects.ts), z. B. "forest", "objective", "flame" */
  type: string;
  x: number;
  y: number;
  /** Größe in Zoll */
  w: number;
  h: number;
  rotation: number;
  /** Eigener Text, z. B. Name eines Zaubers */
  label?: string | null;
}

export type LogKind = 'chat' | 'roll' | 'action' | 'turn';

export interface LogEntry {
  id: string;
  ts: number;
  /** Wer: Spieler 1/2 oder Zuschauer */
  by: PlayerId | 'spectator';
  kind: LogKind;
  text: string;
  /** Würfelergebnisse, falls geworfen */
  dice?: number[][];
}

/** Reaktion einer angegriffenen Einheit */
export type ChargeReaction = 'hold' | 'standShoot' | 'flee' | 'fireFlee' | 'counter';

/** Angesagter Angriff: von der Ansage über die Reaktion bis zum Angriffswurf */
export interface Charge {
  id: string;
  charger: string;
  target: string;
  round: number;
  status: 'declared' | 'reacted' | 'rolled';
  reaction?: ChargeReaction | null;
  /** Angriffswurf: Würfel und Ergebnis */
  dice?: number[] | null;
  range?: number | null;
  distance?: number | null;
  success?: boolean | null;
}

export type PromptKind = 'chargeReaction' | 'chargeRoll' | 'saves' | 'dispel' | 'test';

/**
 * Aufforderung an einen Spieler (z. B. "Reaktion wählen", "Rüstungswurf ablegen").
 * Ist sie erledigt, sieht der auslösende Spieler das Ergebnis, bis er es bestätigt.
 */
export interface Prompt {
  id: string;
  kind: PromptKind;
  /** wer handeln muss */
  to: PlayerId;
  /** wer die Aufforderung ausgelöst hat */
  from: PlayerId;
  ts: number;
  status: 'open' | 'done';
  title: string;
  text: string;
  /** Art-spezifische Angaben (Einheiten, Werte) */
  data: Record<string, string | number | boolean | null>;
  /** Ergebnis in Worten, sobald erledigt */
  result?: string | null;
  /** auslösender Spieler hat das Ergebnis gesehen */
  acknowledged?: boolean;
}

export interface GameState {
  table: { width: number; height: number };
  units: Record<string, UnitState>;
  meta: GameMeta;
  objects: Record<string, BoardObject>;
  log: LogEntry[];
  charges: Record<string, Charge>;
  prompts: Record<string, Prompt>;
}
