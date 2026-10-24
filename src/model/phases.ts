import type { GameMeta, PlayerId, UnitState } from './types';

/**
 * Zugabfolge von The Old World: vor der ersten Runde die Aufstellung, danach je Spielerzug
 * Strategie-, Bewegungs-, Fernkampf- und Nahkampfphase.
 */
export type Phase = 'setup' | 'strategy' | 'movement' | 'shooting' | 'combat';

export const PHASES: { key: Phase; name: string; hint: string }[] = [
  { key: 'setup', name: 'Aufstellung', hint: 'Beide Spieler stellen auf; Vanguard-Bewegungen' },
  { key: 'strategy', name: 'Strategie', hint: 'Zugbeginn, Kommando, Beschwörungen, Sammeln' },
  { key: 'movement', name: 'Bewegung', hint: 'Angriffe ansagen, Angriffe, Pflichtbewegungen, übrige Bewegung' },
  { key: 'shooting', name: 'Fernkampf', hint: 'Schießen und Geschosszauber' },
  { key: 'combat', name: 'Nahkampf', hint: 'Kämpfe, Aufriebstests, Verfolgen, Überrennen' },
];

/** Vollständiger Name, z. B. "Bewegungsphase" */
export const phaseLabel = (p: Phase): string =>
  ({ setup: 'Aufstellung', strategy: 'Strategiephase', movement: 'Bewegungsphase', shooting: 'Fernkampfphase', combat: 'Nahkampfphase' })[p];
export const currentPhase = (meta: GameMeta): Phase => meta.phase ?? 'setup';

/** Nächste Phase; nach dem Nahkampf ist der andere Spieler dran, nach Spieler 2 beginnt eine neue Runde. */
export function nextPhase(meta: GameMeta): Pick<GameMeta, 'phase' | 'active' | 'round'> {
  const phase = currentPhase(meta);
  if (phase === 'setup') return { phase: 'strategy', active: 'p1', round: Math.max(1, meta.round) };
  if (phase === 'combat') {
    const active: PlayerId = meta.active === 'p1' ? 'p2' : 'p1';
    return { phase: 'strategy', active, round: meta.active === 'p2' ? meta.round + 1 : meta.round };
  }
  const order: Phase[] = ['strategy', 'movement', 'shooting', 'combat'];
  return { phase: order[order.indexOf(phase) + 1], active: meta.active, round: meta.round };
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
 */
export function checkMove(meta: GameMeta, unit: UnitState, seat: PlayerId | 'spectator' | null, exception: boolean): MoveCheck {
  if (seat === 'spectator') return { ok: false, reason: 'Zuschauer können nichts bewegen.', overridable: false };
  if (seat && unit.owner !== seat) {
    return { ok: false, reason: 'Online bewegt jeder Spieler nur seine eigenen Einheiten.', overridable: false };
  }
  const phase = currentPhase(meta);
  if (phase === 'setup' || exception) return { ok: true };
  const own = unit.owner === meta.active;
  if (phase === 'movement' && own) return { ok: true };
  if (phase === 'combat') return { ok: true, note: 'Nahkampfbewegung' };
  if (phase === 'movement' && !own) {
    const rule = [...unit.info.rules].find((r) => REACTION_RULES.test(r.name));
    if (rule) return { ok: true, note: `Reaktion (${rule.name})` };
    return { ok: false, overridable: true,
      reason: 'Der Gegner ist in seiner Bewegungsphase. Eigene Einheiten bewegen sich jetzt nur als Reaktion (z. B. Flucht).' };
  }
  return { ok: false, overridable: true,
    reason: `Bewegen ist in der ${phaseLabel(phase)} nicht erlaubt – nur in der Bewegungsphase.` };
}
