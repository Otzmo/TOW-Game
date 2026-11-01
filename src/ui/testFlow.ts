import { unitHasRule } from '../model/charge';
import { leadershipOf, roll } from '../model/flow';
import type { Store } from '../model/store';
import { BREAK_TEXT, breakResult, keptDice, TEST_NAMES, TEST_RULES, testPassed, type TestKind } from '../model/tests';
import type { LogEntry, PlayerId, Prompt, PromptKind, UnitState } from '../model/types';
import { distanceToUnit } from '../model/warMachines';
import { diceHtml } from './dice';

/** Inspiring Presence und Hold Your Ground: bis zu diesem Abstand (Zoll) */
const SUPPORT_RANGE = 12;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export interface TestHost {
  store: Store;
  log(entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>): void;
  create(kind: PromptKind, to: PlayerId, from: PlayerId, title: string, text: string, data: Prompt['data']): void;
  finish(p: Prompt, result: string): void;
}

/** Stand im Fenster (im Spielstand, für beide sichtbar) */
interface TestState {
  kind: TestKind;
  /** angehakte Regeln – zu Beginn das, was das Spiel erkennt */
  on: string[];
  ld: number;
  /** Ld des Generals für Inspiring Presence */
  generalLd: number;
  /** Aufriebstest: um so viel verloren */
  diff: number;
  /** Leadership-Tests: Modifikator auf den Wurf (z. B. +1 schwerer) */
  mod: number;
  dice?: number[];
  reroll?: number[];
  flee?: number[];
}

/**
 * Aufriebstest und Leadership-Tests als Fenster für beide Spieler: Ld, Unterschied im Kampfergebnis bzw.
 * Modifikator, Regeln als Checkboxen (Erkanntes vorab angehakt), Wurf und Ergebnis. Bewegt wird von Hand.
 */
export class TestFlow {
  constructor(private host: TestHost) {}

  /** Neues Fenster für den Besitzer der Einheit */
  start(from: PlayerId, unitId: string, kind: 'break' | 'ld'): void {
    const u = this.host.store.state.units[unitId];
    if (!u) return;
    const general = Object.values(this.host.store.state.units).find((x) => x.owner === u.owner && x.info.isGeneral);
    const state: TestState = { kind, on: this.detected(u, kind), ld: leadershipOf(u), generalLd: general ? leadershipOf(general) : leadershipOf(u), diff: 0, mod: 0 };
    this.host.create('ldtest', u.owner, from, TEST_NAMES[kind], u.info.name, { unitId, state: JSON.stringify(state) });
  }

  /**
   * Was das Spiel erkennt: Regeln der Einheit (Cold-blooded, Immune to Psychology, Stubborn, Unbreakable),
   * General bzw. Armeestandarte (mit höherem bzw. beliebigem Ld) bis 12″ entfernt.
   */
  private detected(u: UnitState, kind: TestKind): string[] {
    const units = this.host.store.state.units;
    const onTable = (x: UnitState) => !x.ambush && x.status !== 'destroyed' && x.status !== 'fledOff';
    // Angeschlossene Charaktere stehen bei ihrer Einheit
    const placed = (x: UnitState) => (x.joinedTo && units[x.joinedTo]) || x;
    const near = (x: UnitState) => placed(x).id === placed(u).id || distanceToUnit(placed(x), placed(u), units) <= SUPPORT_RANGE;
    const friends = Object.values(units).filter((x) => x.owner === u.owner && x.id !== u.id && onTable(x));
    const general = friends.find((x) => x.info.isGeneral);
    const bsb = friends.find((x) => x.info.isBsb);
    const on = TEST_RULES.filter((r) => r.tests.includes(kind) && unitHasRule(u, r.name)).map((r) => r.name);
    if (general && near(general) && leadershipOf(general) > leadershipOf(u)) on.push('Inspiring Presence');
    if (bsb && near(bsb)) on.push('Hold Your Ground');
    return [...new Set(on)];
  }

  /**
   * Nur Regeln zeigen, die passen: Regeln der Einheit, General bzw. Armeestandarte (wenn sie auf dem Tisch stehen),
   * Lagen aus dem Kampf (doppelte Unit Strength) – und alles, was schon angehakt ist.
   */
  private offered(u: UnitState, name: string, s: TestState): boolean {
    if (s.on.includes(name) || unitHasRule(u, name)) return true;
    const friends = Object.values(this.host.store.state.units).filter((x) => x.owner === u.owner && x.id !== u.id
      && !x.ambush && x.status !== 'destroyed' && x.status !== 'fledOff');
    if (name === 'Inspiring Presence') return friends.some((x) => x.info.isGeneral);
    if (name === 'Hold Your Ground') return friends.some((x) => x.info.isBsb);
    return name === 'Winner has twice the Unit Strength';
  }

  private state(p: Prompt): TestState | null {
    try {
      return JSON.parse(String(p.data.state)) as TestState;
    } catch {
      return null;
    }
  }

  private commit(p: Prompt, s: TestState): void {
    const cur = this.host.store.state.prompts[p.id] ?? p;
    this.host.store.setPrompt(p.id, { ...cur, title: TEST_NAMES[s.kind], data: { ...cur.data, state: JSON.stringify(s) } });
  }

  render(p: Prompt, body: HTMLElement): void {
    const u = this.host.store.state.units[String(p.data.unitId)];
    const s = this.state(p);
    if (!u || !s) {
      if (p.status === 'open') this.host.finish(p, 'The unit is gone.');
      return;
    }
    const ld = s.on.includes('Inspiring Presence') ? Math.max(s.ld, s.generalLd) : s.ld;
    const isBreak = s.kind === 'break';
    const rules = TEST_RULES.filter((r) => r.tests.includes(s.kind) && this.offered(u, r.name, s));
    const cold = s.on.includes('Cold-blooded');
    body.innerHTML = `<div class="prompt-form">
        ${isBreak ? '' : `<label>Test <select data-kind>${(['ld', 'panic', 'fear', 'terror', 'rally'] as TestKind[]).map((k) => `<option value="${k}" ${k === s.kind ? 'selected' : ''}>${TEST_NAMES[k]}</option>`).join('')}</select></label>`}
        <label>Leadership of ${esc(u.info.name)} <input type="number" min="1" max="12" data-field="ld" value="${s.ld}"></label>
        ${s.on.includes('Inspiring Presence') ? `<label>Leadership of the General <input type="number" min="1" max="12" data-field="generalLd" value="${s.generalLd}"></label>` : ''}
        ${isBreak ? `<label>Lost the combat by <input type="number" min="0" max="30" data-field="diff" value="${s.diff}"></label>`
          : `<label>Modifier to the roll <input type="number" min="-6" max="6" data-field="mod" value="${s.mod}"></label>`}
      </div>
      <div class="atk-mods atk-rules-box"><div class="atk-base">Special rules <span class="meta">(only what applies to this unit; ticked: detected)</span></div>
        ${rules.map((r) => `<label class="atk-mod"><input type="checkbox" data-trule="${esc(r.name)}" ${s.on.includes(r.name) ? 'checked' : ''}>
          <span class="atk-label">${esc(r.name)} <span class="atk-hint">${esc(r.hint)}${unitHasRule(u, r.name) ? ` · ${esc(u.info.name)} has this rule` : ''}</span></span></label>`).join('')}
      </div>
      <p class="prompt-info">Test against <b>Ld ${ld}</b>${isBreak ? ` · combat result ${s.diff ? `−${s.diff}` : '0'}` : s.mod ? ` · roll ${signed(s.mod)}` : ''} · ${cold ? '3D6, discard the highest' : '2D6'} · a double 1 always ${isBreak ? 'gives ground' : 'passes'}</p>
      ${s.dice ? this.resultHtml(u, s, ld) : `<div class="prompt-actions"><button class="primary" data-roll>Roll ${TEST_NAMES[s.kind]}</button><button data-cancel>Cancel</button></div>`}`;

    body.querySelector<HTMLSelectElement>('[data-kind]')?.addEventListener('change', (e) => {
      s.kind = (e.target as HTMLSelectElement).value as TestKind;
      s.on = [...new Set([...s.on.filter((r) => TEST_RULES.find((x) => x.name === r)?.tests.includes(s.kind)), ...this.detected(u, s.kind)])];
      this.commit(p, s);
    });
    body.querySelectorAll<HTMLInputElement>('[data-field]').forEach((inp) => {
      inp.onchange = () => {
        const key = inp.dataset.field as 'ld' | 'generalLd' | 'diff' | 'mod';
        s[key] = Math.round(Number(inp.value) || 0);
        this.commit(p, s);
      };
    });
    body.querySelectorAll<HTMLInputElement>('[data-trule]').forEach((box) => {
      box.onchange = () => {
        const name = box.dataset.trule!;
        s.on = box.checked ? [...new Set([...s.on, name])] : s.on.filter((r) => r !== name);
        this.commit(p, s);
      };
    });
    body.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', () => this.host.store.setPrompt(p.id, null));
    body.querySelector<HTMLButtonElement>('[data-roll]')?.addEventListener('click', () => {
      s.dice = roll(cold ? 3 : 2);
      this.host.log({ kind: 'roll', dice: [s.dice], text: `${u.info.name}: ${TEST_NAMES[s.kind]} (Ld ${ld}) – ${this.outcome(s, ld)}` });
      this.commit(p, s);
    });
    body.querySelector<HTMLButtonElement>('[data-reroll]')?.addEventListener('click', () => {
      s.reroll = roll(cold ? 3 : 2);
      this.host.log({ kind: 'roll', dice: [s.reroll], text: `${u.info.name}: re-roll (Hold Your Ground) – ${this.outcome(s, ld)}` });
      this.commit(p, s);
    });
    body.querySelector<HTMLButtonElement>('[data-flee]')?.addEventListener('click', () => {
      s.flee = roll(2);
      this.host.log({ kind: 'roll', dice: [s.flee], text: `${u.info.name} flees ${s.flee[0] + s.flee[1]}″` });
      this.commit(p, s);
    });
    body.querySelector<HTMLButtonElement>('[data-done]')?.addEventListener('click', () =>
      this.host.finish(p, `${u.info.name}: ${TEST_NAMES[s.kind]} – ${this.outcome(s, ld)}${s.flee ? `, flees ${s.flee[0] + s.flee[1]}″` : ''}.`));
  }

  /** Ergebnis in Worten (mit Wiederholung, falls gewürfelt) */
  private outcome(s: TestState, ld: number): string {
    const dice = s.reroll ?? s.dice!;
    if (s.kind === 'break') return BREAK_TEXT[breakResult(dice, ld, s.diff, s.on)];
    return testPassed(s.kind, dice, ld, s.mod, s.on) ? 'passed' : 'failed';
  }

  private failed(s: TestState, ld: number): boolean {
    const dice = s.reroll ?? s.dice!;
    return s.kind === 'break' ? breakResult(dice, ld, s.diff, s.on) !== 'giveGround' : !testPassed(s.kind, dice, ld, s.mod, s.on);
  }

  private resultHtml(u: UnitState, s: TestState, ld: number): string {
    const dice = s.reroll ?? s.dice!;
    const kept = keptDice(dice);
    const flees = s.kind === 'break' ? breakResult(dice, ld, s.diff, s.on) === 'flee'
      : this.failed(s, ld) && (s.kind === 'panic' || s.kind === 'terror');
    // Was passiert: nur als Text; bewegt wird von Hand
    const effect = s.kind === 'break' ? {
      flee: `${u.info.name} breaks and flees – turn it away from the enemy and move it by hand.`,
      fallBack: `${u.info.name} falls back in good order – move it back by hand.`,
      giveGround: `${u.info.name} gives ground 2″ – move it back by hand.`,
    }[breakResult(dice, ld, s.diff, s.on)]
      : !this.failed(s, ld) ? (s.kind === 'rally' ? `${u.info.name} rallies.` : 'Test passed.')
      : s.kind === 'rally' ? `${u.info.name} keeps fleeing.` : flees ? `${u.info.name} flees – move it by hand.` : 'Test failed – apply the effect by hand.';
    return `<div class="dice-row">${diceHtml(s.dice!)}</div>
      ${s.reroll ? `<div class="dice-row"><span class="dice-label">Re-roll</span>${diceHtml(s.reroll)}</div>` : ''}
      <p class="prompt-info">Rolled <b>${kept[0] + kept[1]}</b>${dice.length > 2 ? ` (${kept.join(' + ')}, highest discarded)` : ''} vs Ld ${ld} → <b>${esc(this.outcome(s, ld))}</b></p>
      <p class="prompt-info">${esc(effect)}</p>
      ${s.flee ? `<div class="dice-row">${diceHtml(s.flee)}</div><p class="prompt-info"><b>Flees ${s.flee[0] + s.flee[1]}″</b> – move it by hand.</p>` : ''}
      <div class="prompt-actions">
        ${this.failed(s, ld) && s.on.includes('Hold Your Ground') && !s.reroll ? '<button data-reroll>Re-roll (Hold Your Ground)</button>' : ''}
        ${flees && !s.flee ? '<button data-flee>Roll flee distance (2D6)</button>' : ''}
        <button class="primary" data-done>Done</button>
      </div>`;
  }
}
