/** Moral: Aufriebstest und Leadership-Tests (Panik, Angst, Entsetzen, Sammeln) nach der Quick Reference */

export type TestKind = 'break' | 'ld' | 'panic' | 'fear' | 'terror' | 'rally';

export const TEST_NAMES: Record<TestKind, string> = {
  break: 'Break test', ld: 'Leadership test', panic: 'Panic test', fear: 'Fear test', terror: 'Terror test', rally: 'Rally test',
};

/** Regeln zum Anhaken (Erkanntes vorab angehakt): Name, Wirkung, für welche Tests */
export const TEST_RULES: { name: string; hint: string; tests: TestKind[] }[] = [
  { name: 'Inspiring Presence', hint: "use the General's Leadership (within range)", tests: ['break', 'ld', 'panic', 'fear', 'terror', 'rally'] },
  { name: 'Hold Your Ground', hint: 'Battle Standard Bearer in range: re-roll a failed test', tests: ['break', 'ld', 'panic', 'fear', 'terror', 'rally'] },
  { name: 'Cold-blooded', hint: 'roll 3D6 and discard the highest', tests: ['break', 'ld', 'panic', 'fear', 'terror', 'rally'] },
  { name: 'Immune to Psychology', hint: 'automatically passes Panic, Fear and Terror tests', tests: ['panic', 'fear', 'terror'] },
  { name: 'Stubborn', hint: 'Break tests against the unmodified Leadership', tests: ['break'] },
  { name: 'Unbreakable', hint: 'never breaks: automatically passes Break tests', tests: ['break'] },
  { name: 'Winner has twice the Unit Strength', hint: 'Fall Back in Good Order becomes Flee', tests: ['break'] },
];

/** Würfel des Tests: 2D6, bei Cold-blooded 3D6 ohne den höchsten; zählt sind die behaltenen zwei */
export function keptDice(dice: number[]): number[] {
  if (dice.length <= 2) return dice;
  const sorted = [...dice].sort((a, b) => a - b);
  return sorted.slice(0, 2);
}

export type BreakResult = 'flee' | 'fallBack' | 'giveGround';

export const BREAK_TEXT: Record<BreakResult, string> = {
  flee: 'Flees', fallBack: 'Falls Back in Good Order', giveGround: 'Gives Ground 2″',
};

/**
 * Aufriebstest: Natürlicher Wurf über Ld → Flucht; sonst, wenn Wurf + Unterschied im Kampfergebnis über Ld →
 * Fall Back in Good Order (bei doppelter Unit Strength des Siegers Flucht); sonst und bei Doppel-1 Give Ground.
 * Stubborn: der Unterschied zählt nicht; Unbreakable: bricht nie.
 */
export function breakResult(dice: number[], ld: number, diff: number, on: string[]): BreakResult {
  const kept = keptDice(dice);
  const natural = kept[0] + kept[1];
  if (on.includes('Unbreakable') || (kept[0] === 1 && kept[1] === 1)) return 'giveGround';
  if (natural > ld) return 'flee';
  const modified = natural + (on.includes('Stubborn') ? 0 : Math.max(0, diff));
  if (modified > ld) return on.includes('Winner has twice the Unit Strength') ? 'flee' : 'fallBack';
  return 'giveGround';
}

/** Leadership-Test: bestanden bei Wurf + Modifikatoren ≤ Ld oder Doppel-1; Immune to Psychology besteht Panik, Angst, Entsetzen */
export function testPassed(kind: TestKind, dice: number[], ld: number, modifier: number, on: string[]): boolean {
  if (on.includes('Immune to Psychology') && (kind === 'panic' || kind === 'fear' || kind === 'terror')) return true;
  const kept = keptDice(dice);
  if (kept[0] === 1 && kept[1] === 1) return true;
  return kept[0] + kept[1] + modifier <= ld;
}
