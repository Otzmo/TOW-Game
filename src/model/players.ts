import type { GameMeta, PlayerId } from './types';

let currentMeta: () => GameMeta | undefined = () => undefined;

/** Woher die Namen ihre Rollen nehmen (main.ts bindet den Spielstand an). */
export function bindPlayerNames(meta: () => GameMeta | undefined): void {
  currentMeta = meta;
}

/** Anzeigename eines Spielers: nach dem Roll-off „Attacker“ bzw. „Defender“, davor „Player 1/2“. */
export function playerName(p: PlayerId | 'spectator'): string {
  if (p === 'spectator') return 'Spectator';
  const defender = currentMeta()?.setup?.defender;
  if (defender) return p === defender ? 'Defender' : 'Attacker';
  return `Player ${p === 'p1' ? 1 : 2}`;
}
