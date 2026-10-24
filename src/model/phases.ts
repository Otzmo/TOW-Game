import type { Charge, GameMeta, PlayerId, UnitState } from './types';

/**
 * Zugabfolge von The Old World: vor der ersten Runde die Aufstellung, danach je Spielerzug
 * Strategie-, Bewegungs-, Fernkampf- und Nahkampfphase mit je vier Unterphasen.
 */
export type Phase = 'setup' | 'strategy' | 'movement' | 'shooting' | 'combat';

export const PHASES: { key: Phase; name: string; subs: string[]; repeat?: string }[] = [
  // Aufbau nach OTZMO-TOW (Core Battle, Game Sequence); Begriffe der Phasen wie auf tow.whfb.app
  { key: 'setup', name: 'Setup', subs: ['Load Armies', 'Generate Battlefield', 'Roll-off: Attacker & Defender', 'Deployment Zone & Terrain', 'Deploy Units', 'Scouts & Vanguard', 'Roll-off for First Turn'] },
  { key: 'strategy', name: 'Strategy', subs: ['Start of Turn', 'Command', 'Conjuration', 'Rally Fleeing Troops'] },
  { key: 'movement', name: 'Movement', subs: ['Declare Charges & Charge Reactions', 'Charge Moves', 'Compulsory Moves', 'Remaining Moves'] },
  // Fernkampf und Nahkampf werden je Einheit bzw. je Kampf durchlaufen
  { key: 'shooting', name: 'Shooting', subs: ['Choose Unit & Declare Target', 'Roll To Hit', 'Roll To Wound & Make Armour Saves', 'Remove Casualties & Make Panic Tests'], repeat: 'Next unit' },
  { key: 'combat', name: 'Combat', subs: ['Choose & Fight Combat', 'Calculate Combat Result', 'Break Test', 'Follow Up & Pursuit'], repeat: 'Next combat' },
];

/** Unterphasen der Bewegungsphase */
export const SUB_DECLARE = 0;
export const SUB_CHARGE_MOVES = 1;
export const SUB_COMPULSORY = 2;

/** Vollständiger Name, z. B. "Bewegungsphase" */
export const phaseLabel = (p: Phase): string =>
  ({ setup: 'Setup', strategy: 'Strategy phase', movement: 'Movement phase', shooting: 'Shooting phase', combat: 'Combat phase' })[p];
export const currentPhase = (meta: GameMeta): Phase => meta.phase ?? 'setup';
export const currentSub = (meta: GameMeta): number => meta.sub ?? 0;
export const phaseInfo = (p: Phase) => PHASES.find((x) => x.key === p)!;
export const subLabel = (meta: GameMeta) => phaseInfo(currentPhase(meta)).subs[currentSub(meta)] ?? '';

type Step = Pick<GameMeta, 'phase' | 'sub' | 'active' | 'round'>;

/** Nächste Phase (Unterphase 0); nach dem Nahkampf ist der andere Spieler dran, nach Spieler 2 neue Runde. */
export function nextPhase(meta: GameMeta): Step {
  const phase = currentPhase(meta);
  // Nach dem Aufbau beginnt, wer den ersten Zug hat (Roll-off)
  if (phase === 'setup') return { phase: 'strategy', sub: 0, active: meta.setup?.firstPlayer ?? 'p1', round: Math.max(1, meta.round) };
  if (phase === 'combat') {
    const active: PlayerId = meta.active === 'p1' ? 'p2' : 'p1';
    // Eine Runde endet, wenn der Spieler mit dem zweiten Zug fertig ist
    const second: PlayerId = meta.setup?.firstPlayer === 'p2' ? 'p1' : 'p2';
    return { phase: 'strategy', sub: 0, active, round: meta.active === second ? meta.round + 1 : meta.round };
  }
  const order: Phase[] = ['strategy', 'movement', 'shooting', 'combat'];
  return { phase: order[order.indexOf(phase) + 1], sub: 0, active: meta.active, round: meta.round };
}

/** Nächste Unterphase; nach der letzten folgt die nächste Phase. */
export function nextSub(meta: GameMeta): Step {
  const subs = phaseInfo(currentPhase(meta)).subs;
  const sub = currentSub(meta);
  if (sub + 1 < subs.length) return { phase: currentPhase(meta), sub: sub + 1, active: meta.active, round: meta.round };
  return nextPhase(meta);
}

/** Fernkampf/Nahkampf: zurück zur ersten Unterphase für die nächste Einheit bzw. den nächsten Kampf. */
export function repeatPhase(meta: GameMeta): Step {
  return { phase: currentPhase(meta), sub: 0, active: meta.active, round: meta.round };
}

/** Regeln, die eine Reaktion in der gegnerischen Bewegungsphase erlauben. */
const REACTION_RULES = /counter charge|fire (&|and) flee/i;

export type MoveCheck =
  | { ok: true; note?: string }
  | { ok: false; reason: string; overridable: boolean };

/**
 * Darf diese Einheit gerade bewegt, gedreht oder umformiert werden?
 * @param seat online der eigene Platz, offline null (beide spielen am selben Bildschirm)
 * @param exception für diese Einheit wurde eine Ausnahme (Sonderregel) erlaubt
 * @param charges Angriffe dieses Zuges (wer angreift, darf in den Angriffsbewegungen ziehen)
 */
export function checkMove(meta: GameMeta, unit: UnitState, seat: PlayerId | 'spectator' | null, exception: boolean,
  charges: Record<string, Charge> = {}): MoveCheck {
  if (seat === 'spectator') return { ok: false, reason: 'Spectators cannot move units.', overridable: false };
  if (seat && unit.owner !== seat) {
    return { ok: false, reason: 'Online, each player moves only their own units.', overridable: false };
  }
  const phase = currentPhase(meta);
  if (phase === 'setup' || exception) return { ok: true };
  const own = unit.owner === meta.active;
  if (phase === 'combat') return { ok: true, note: 'Combat move' };
  if (phase === 'movement' && own) {
    const sub = currentSub(meta);
    const charging = Object.values(charges).some((c) => c.charger === unit.id);
    const fleeing = unit.status === 'fleeing';
    if (sub === SUB_DECLARE) {
      return { ok: false, overridable: true, reason: 'Declare charges first – units move in the following sub-phases.' };
    }
    if (sub === SUB_CHARGE_MOVES) {
      return charging ? { ok: true, note: 'Charge move' }
        : { ok: false, overridable: true, reason: 'Only charging units move during Charge Moves.' };
    }
    if (sub === SUB_COMPULSORY) {
      return fleeing ? { ok: true, note: 'Compulsory move' }
        : { ok: false, overridable: true, reason: 'Compulsory Moves: only fleeing units and others forced to move.' };
    }
    if (charging || fleeing) {
      return { ok: false, overridable: true, reason: 'Charging and fleeing units do not move during Remaining Moves.' };
    }
    return { ok: true };
  }
  if (phase === 'movement' && !own) {
    const rule = [...unit.info.rules].find((r) => REACTION_RULES.test(r.name));
    if (rule) return { ok: true, note: `Reaction (${rule.name})` };
    return { ok: false, overridable: true,
      reason: "It is your opponent's Movement phase. Your units only move now as a charge reaction (e.g. Flee)." };
  }
  return { ok: false, overridable: true,
    reason: `Units cannot move in the ${phaseLabel(phase)} – only in the Movement phase.` };
}
