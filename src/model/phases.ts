import type { Charge, GameMeta, PlayerId, UnitState } from './types';

/**
 * Zugabfolge von The Old World: vor der ersten Runde die Aufstellung, danach je Spielerzug
 * Strategie-, Bewegungs-, Fernkampf- und Nahkampfphase mit je vier Unterphasen.
 */
export type Phase = 'setup' | 'strategy' | 'movement' | 'shooting' | 'combat';

export const PHASES: { key: Phase; name: string; subs: string[]; repeat?: string }[] = [
  { key: 'setup', name: 'Aufstellung', subs: ['Aufstellen (auch Vanguard)'] },
  { key: 'strategy', name: 'Strategie', subs: ['Zugbeginn', 'Kommando', 'Beschwörung', 'Fliehende sammeln'] },
  { key: 'movement', name: 'Bewegung', subs: ['Angriffe & Reaktionen ansagen', 'Angriffsbewegungen', 'Pflichtbewegungen', 'Übrige Bewegungen'] },
  // Fernkampf und Nahkampf werden je Einheit bzw. je Kampf durchlaufen
  { key: 'shooting', name: 'Fernkampf', subs: ['Einheit & Ziel wählen', 'Treffen', 'Verwunden & Rüstung', 'Verluste & Paniktest'], repeat: 'Nächste Einheit' },
  { key: 'combat', name: 'Nahkampf', subs: ['Kampf wählen & kämpfen', 'Kampfergebnis', 'Aufriebstest', 'Nachsetzen & Verfolgung'], repeat: 'Nächster Kampf' },
];

/** Unterphasen der Bewegungsphase */
export const SUB_DECLARE = 0;
export const SUB_CHARGE_MOVES = 1;
export const SUB_COMPULSORY = 2;

/** Vollständiger Name, z. B. "Bewegungsphase" */
export const phaseLabel = (p: Phase): string =>
  ({ setup: 'Aufstellung', strategy: 'Strategiephase', movement: 'Bewegungsphase', shooting: 'Fernkampfphase', combat: 'Nahkampfphase' })[p];
export const currentPhase = (meta: GameMeta): Phase => meta.phase ?? 'setup';
export const currentSub = (meta: GameMeta): number => meta.sub ?? 0;
export const phaseInfo = (p: Phase) => PHASES.find((x) => x.key === p)!;
export const subLabel = (meta: GameMeta) => phaseInfo(currentPhase(meta)).subs[currentSub(meta)] ?? '';

type Step = Pick<GameMeta, 'phase' | 'sub' | 'active' | 'round'>;

/** Nächste Phase (Unterphase 0); nach dem Nahkampf ist der andere Spieler dran, nach Spieler 2 neue Runde. */
export function nextPhase(meta: GameMeta): Step {
  const phase = currentPhase(meta);
  if (phase === 'setup') return { phase: 'strategy', sub: 0, active: 'p1', round: Math.max(1, meta.round) };
  if (phase === 'combat') {
    const active: PlayerId = meta.active === 'p1' ? 'p2' : 'p1';
    return { phase: 'strategy', sub: 0, active, round: meta.active === 'p2' ? meta.round + 1 : meta.round };
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
  if (seat === 'spectator') return { ok: false, reason: 'Zuschauer können nichts bewegen.', overridable: false };
  if (seat && unit.owner !== seat) {
    return { ok: false, reason: 'Online bewegt jeder Spieler nur seine eigenen Einheiten.', overridable: false };
  }
  const phase = currentPhase(meta);
  if (phase === 'setup' || exception) return { ok: true };
  const own = unit.owner === meta.active;
  if (phase === 'combat') return { ok: true, note: 'Nahkampfbewegung' };
  if (phase === 'movement' && own) {
    const sub = currentSub(meta);
    const charging = Object.values(charges).some((c) => c.charger === unit.id);
    const fleeing = unit.status === 'fleeing';
    if (sub === SUB_DECLARE) {
      return { ok: false, overridable: true, reason: 'Erst Angriffe ansagen – bewegt wird in den folgenden Unterphasen.' };
    }
    if (sub === SUB_CHARGE_MOVES) {
      return charging ? { ok: true, note: 'Angriffsbewegung' }
        : { ok: false, overridable: true, reason: 'In den Angriffsbewegungen ziehen nur angreifende Einheiten.' };
    }
    if (sub === SUB_COMPULSORY) {
      return fleeing ? { ok: true, note: 'Pflichtbewegung' }
        : { ok: false, overridable: true, reason: 'Pflichtbewegungen: nur fliehende und andere zur Bewegung gezwungene Einheiten.' };
    }
    if (charging || fleeing) {
      return { ok: false, overridable: true, reason: 'Angreifende und fliehende Einheiten bewegen sich in den übrigen Bewegungen nicht mehr.' };
    }
    return { ok: true };
  }
  if (phase === 'movement' && !own) {
    const rule = [...unit.info.rules].find((r) => REACTION_RULES.test(r.name));
    if (rule) return { ok: true, note: `Reaktion (${rule.name})` };
    return { ok: false, overridable: true,
      reason: 'Der Gegner ist in seiner Bewegungsphase. Eigene Einheiten bewegen sich jetzt nur als Reaktion (z. B. Flucht).' };
  }
  return { ok: false, overridable: true,
    reason: `Bewegen ist in der ${phaseLabel(phase)} nicht erlaubt – nur in der Bewegungsphase.` };
}
