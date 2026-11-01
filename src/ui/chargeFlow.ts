import { CHARGE_RULES, chargeInitiative, reactionChoices, ruleKey, unitHasRule } from '../model/charge';
import { chargeRoll, chargeTravel, contactPoses, fleeRoll, minChargeDistance, movementOf, type RollResult } from '../model/flow';
import { playerName } from '../model/players';
import type { Store } from '../model/store';
import type { ChargeReaction, LogEntry, PlayerId, Prompt, PromptKind, UnitState } from '../model/types';
import { diceHtml } from './dice';
import { freezeSteps, stepSections } from './steps';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const inch = (n: number) => `${n.toFixed(1)}″`;
const REACTIONS: Record<ChargeReaction, string> = {
  hold: 'Hold', standShoot: 'Stand & Shoot', flee: 'Flee', fireFlee: 'Fire & Flee', counter: 'Counter Charge',
};

/** Regeln, die Angreifer bzw. Ziel haben: von Anfang an angehakt */
function chargeRulesOf(a: UnitState, t: UnitState): string[] {
  return CHARGE_RULES.filter((r) => unitHasRule(r.side === 'charger' ? a : t, r.name)).map(ruleKey);
}

/** Was PromptCenter für den Angriff bereitstellt */
export interface ChargeHost {
  store: Store;
  log(entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>): void;
  create(kind: PromptKind, to: PlayerId, from: PlayerId, title: string, text: string, data: Prompt['data']): void;
  finish(p: Prompt, result: string): void;
}

/** Stand im Fenster (liegt im Spielstand, damit beide Spieler ihn sehen) */
interface ChargeState {
  /** angehakte Regeln, Schlüssel wie ruleKey – zu Beginn das Erkannte */
  on: string[];
  reaction?: ChargeReaction;
  flee?: RollResult;
  roll?: RollResult & { range: number };
}

/**
 * Angriff als Fenster für beide Spieler: Ansage mit den Charge-Regeln (Checkboxen, Regeln der Einheiten vorab angehakt),
 * Reaktion des Gegners (mit Fluchtwurf), Angriffswurf und Ergebnis. Bewegt und entfernt wird nichts – das Fenster
 * sagt nur, was passiert; die Einheiten zieht der Spieler selbst.
 */
export class ChargeFlow {
  constructor(private host: ChargeHost) {}

  private get units() {
    return this.host.store.state.units;
  }

  /** Neues Fenster: Ansage durch den Besitzer der angreifenden Einheit */
  start(from: PlayerId, chargerId: string, targetId: string): void {
    const a = this.units[chargerId];
    const t = this.units[targetId];
    if (!a || !t || a.owner === t.owner) return;
    this.host.create('charge', a.owner, from, 'Declare charge', `${a.info.name} → ${t.info.name}`,
      { chargerId, targetId, step: 'declare', state: JSON.stringify({ on: chargeRulesOf(a, t) } satisfies ChargeState) });
  }

  private state(p: Prompt): ChargeState {
    try {
      const s = JSON.parse(String(p.data.state || '{}')) as Partial<ChargeState>;
      return { ...s, on: s.on ?? [] };
    } catch {
      return { on: [] };
    }
  }

  /** Zwischenstand speichern; Schritt, Empfänger und Titel bei Bedarf mit wechseln */
  private commit(p: Prompt, s: ChargeState, next?: { step: string; to: PlayerId; title: string }): void {
    const cur = this.host.store.state.prompts[p.id] ?? p;
    this.host.store.setPrompt(p.id, {
      ...cur, ...(next ? { to: next.to, title: next.title } : {}),
      data: { ...cur.data, ...(next ? { step: next.step } : {}), state: JSON.stringify(s) },
    });
  }

  render(p: Prompt, body: HTMLElement): void {
    const a = this.units[String(p.data.chargerId)];
    const t = this.units[String(p.data.targetId)];
    if (!a || !t) {
      if (p.status === 'open') this.host.finish(p, 'A unit of this charge is gone.');
      return;
    }
    const s = this.state(p);
    // Alle Schritte bleiben sichtbar, bis der Angriff fertig ist; nur der aktuelle ist bedienbar
    const now = Math.max(0, ['declare', 'react', 'roll'].indexOf(String(p.data.step)));
    const els = stepSections(body, ['Declare charge', 'Charge reaction', 'Charge roll'], now, p.status === 'open');
    this.renderDeclare(p, els[0], a, t, s);
    if (now >= 1) this.renderReact(p, els[1], a, t, s);
    if (now >= 2) this.renderRoll(p, els[2], a, t, s);
    freezeSteps(body);
  }

  /** Entfernungen: Mindestdistanz für Kontakt, Distanz bis zur maximierten Stellung, angegriffene Seite */
  private distances(a: UnitState, t: UnitState) {
    const units = this.units;
    const min = minChargeDistance(a, t, units);
    const best = contactPoses(a, t, units)[0];
    const max = best ? chargeTravel(a, best, units) : null;
    return { min, max, side: best?.side ?? 'front' };
  }

  private rulesHtml(side: 'charger' | 'target', a: UnitState, t: UnitState, s: ChargeState): string {
    const unit = side === 'charger' ? a : t;
    const rows = CHARGE_RULES.filter((r) => r.side === side).map((r) => {
      const has = unitHasRule(unit, r.name);
      return `<label class="atk-mod"><input type="checkbox" data-crule="${esc(ruleKey(r))}" ${s.on.includes(ruleKey(r)) ? 'checked' : ''}>
        <span class="atk-label">${esc(r.name)} <span class="atk-hint">${esc(r.hint)}${has ? ` · ${esc(unit.info.name)} has this rule` : ''}</span></span></label>`;
    }).join('');
    return `<div class="atk-mods atk-rules-box"><div class="atk-base">Special rules – ${esc(unit.info.name)} <span class="meta">(ticked: the unit has it)</span></div>${rows}</div>`;
  }

  private wireRules(p: Prompt, body: HTMLElement, s: ChargeState): void {
    body.querySelectorAll<HTMLInputElement>('[data-crule]').forEach((box) => {
      box.onchange = () => {
        const key = box.dataset.crule!;
        s.on = box.checked ? [...new Set([...s.on, key])] : s.on.filter((k) => k !== key);
        this.commit(p, s);
      };
    });
  }

  // --- 1. Ansage ------------------------------------------------------------------

  private renderDeclare(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, s: ChargeState): void {
    const d = this.distances(a, t);
    const m = movementOf(a);
    body.innerHTML = `<p class="prompt-info">Contact from <b>${inch(d.min)}</b>${d.max !== null ? ` · maximised at <b>${inch(d.max)}</b>` : ''}
        · charges the <b>${esc(d.side)}</b> · Movement ${m}″, so a charge roll of at least ${Math.max(0, Math.ceil(d.min - m))} is needed</p>
      ${this.rulesHtml('charger', a, t, s)}
      <p class="meta">Check line of sight; units already in combat or fleeing cannot declare a charge.</p>
      <div class="prompt-actions"><button class="primary" data-declare>Declare charge – ${esc(playerName(t.owner))} chooses a reaction ›</button>
        <button data-cancel>Cancel</button></div>`;
    this.wireRules(p, body, s);
    (body.querySelector('[data-cancel]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    (body.querySelector('[data-declare]') as HTMLButtonElement).onclick = () => {
      // Pfeil für beide Spieler, bis der Angriff gewürfelt ist
      const id = `charge-${a.id}`;
      const round1 = (v: number) => Math.round(v * 10) / 10;
      this.host.store.setCharge(id, { id, charger: a.id, target: t.id, round: this.host.store.state.meta.round,
        status: 'declared', distance: round1(d.min), maxDistance: d.max !== null ? round1(d.max) : null });
      this.host.log({ kind: 'action', text: `${a.info.name} declares a charge against ${t.info.name} (contact from ${inch(d.min)})` });
      this.commit(p, s, { step: 'react', to: t.owner, title: 'Charge reaction' });
    };
  }

  // --- 2. Reaktion ------------------------------------------------------------------

  private renderReact(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, s: ChargeState): void {
    const d = this.distances(a, t);
    const fleeing = t.status === 'fleeing';
    const choices = reactionChoices(s.on, d.min, movementOf(a), fleeing);
    const flees = s.reaction === 'flee' || s.reaction === 'fireFlee';
    const swift = s.on.includes('Swiftstride (target)');
    body.innerHTML = `<p class="prompt-info">${esc(a.info.name)} charges <b>${esc(t.info.name)}</b> in the ${esc(d.side)} – contact from ${inch(d.min)}.</p>
      ${this.rulesHtml('target', a, t, s)}
      <div class="prompt-options">${choices.map((c) => `<button data-react="${c.key}" class="${s.reaction === c.key ? 'primary' : ''}" ${c.allowed ? '' : 'disabled'}>
        <b>${esc(c.label)}</b><span>${esc(c.hint)}</span></button>`).join('')}</div>
      ${flees ? this.fleeHtml(s, swift) : ''}
      ${s.reaction === 'standShoot' || s.reaction === 'fireFlee' ? '<p class="meta">Shoot with 🏹 Shoot (tick Stand & Shoot) before the charge roll.</p>' : ''}
      <div class="prompt-actions"><button class="primary" data-confirm ${!s.reaction || (flees && !s.flee) ? 'disabled' : ''}>Confirm reaction – charge roll ›</button></div>`;
    this.wireRules(p, body, s);
    body.querySelectorAll<HTMLButtonElement>('[data-react]').forEach((b) => {
      b.onclick = () => {
        s.reaction = b.dataset.react as ChargeReaction;
        if (s.reaction !== 'flee' && s.reaction !== 'fireFlee') delete s.flee;
        this.commit(p, s);
      };
    });
    const rollFlee = body.querySelector<HTMLButtonElement>('[data-flee]');
    if (rollFlee) rollFlee.onclick = () => {
      s.flee = fleeRoll(s.reaction === 'fireFlee', swift);
      this.host.log({ kind: 'roll', dice: [s.flee.dice], text: `${t.info.name} flees ${s.flee.total}″ (${s.flee.text})` });
      this.commit(p, s);
    };
    (body.querySelector('[data-confirm]') as HTMLButtonElement).onclick = () => {
      this.host.log({ kind: 'action', text: `${t.info.name}: ${REACTIONS[s.reaction!]}${s.flee ? ` – flees ${s.flee.total}″` : ''}` });
      this.commit(p, s, { step: 'roll', to: a.owner, title: 'Charge roll' });
    };
  }

  private fleeHtml(s: ChargeState, swift: boolean): string {
    if (!s.flee) return `<div class="prompt-actions"><button data-flee>Roll flee (${s.reaction === 'fireFlee' ? '2D6, discard the lowest' : '2D6'}${swift ? ' + D6 Swiftstride' : ''})</button></div>`;
    return `<div class="dice-row">${diceHtml(s.flee.dice)}</div>
      <p class="prompt-info"><b>Flees ${s.flee.total}″</b> (${esc(s.flee.text)}) – turn directly away from the charger and move it by hand.</p>`;
  }

  // --- 3. Angriffswurf und Ergebnis ---------------------------------------------------

  private renderRoll(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, s: ChargeState): void {
    // Entfernung jetzt: ist das Ziel geflohen und von Hand gezogen, gilt die neue Lage
    const d = this.distances(a, t);
    const m = movementOf(a);
    const fled = s.reaction === 'flee' || s.reaction === 'fireFlee' || t.status === 'fleeing';
    const swift = s.on.includes('Swiftstride (charger)');
    const hunger = s.on.includes('Battle Hunger (charger)');
    const summary = `${t.info.name}: ${s.reaction ? REACTIONS[s.reaction] : '–'}${s.flee ? ` (fled ${s.flee.total}″)` : ''}`;
    if (!s.roll) {
      body.innerHTML = `<p class="prompt-info">${esc(summary)}</p>
        <p class="prompt-info">Distance now: contact from <b>${inch(d.min)}</b>${d.max !== null ? ` · maximised at ${inch(d.max)}` : ''}</p>
        <p class="meta">Charge range = Movement ${m}″ + 2D6, discard the lowest${swift ? ', + D6 (Swiftstride)' : ''}${hunger ? ', + D3 (Battle Hunger)' : ''}.</p>
        <div class="prompt-actions"><button class="primary" data-roll>Roll charge</button></div>`;
      (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
        const r = chargeRoll(swift, hunger);
        s.roll = { ...r, range: m + r.total };
        this.host.log({ kind: 'roll', dice: [r.dice], text: `${a.info.name} charge roll: ${r.text} + M ${m} = ${s.roll.range}″ (needs ${inch(d.min)})` });
        this.commit(p, s);
      };
      return;
    }
    const result = this.outcome(a, t, s, d, fled);
    body.innerHTML = `<p class="prompt-info">${esc(summary)}</p>
      <div class="dice-row">${diceHtml(s.roll.dice)}</div>
      <p class="prompt-info">Charge range <b>${s.roll.range}″</b> (${esc(s.roll.text)} + M ${m}) · needed ${inch(d.min)}</p>
      ${result.map((x) => `<p class="prompt-info">${x}</p>`).join('')}
      <div class="prompt-actions"><button class="primary" data-done>Done</button></div>`;
    (body.querySelector('[data-done]') as HTMLButtonElement).onclick = () => {
      const c = this.host.store.state.charges[`charge-${a.id}`];
      if (c) this.host.store.setCharge(c.id, { ...c, status: 'rolled', success: s.roll!.range >= d.min, reaction: s.reaction ?? null });
      const text = result.map((x) => x.replace(/<[^>]+>/g, '')).join(' ');
      this.host.log({ kind: 'action', text: `${a.info.name} → ${t.info.name}: ${text}` });
      this.host.finish(p, text);
    };
  }

  /** Was passiert – nur als Text; bewegt und entfernt wird von Hand */
  private outcome(a: UnitState, t: UnitState, s: ChargeState, d: { min: number; max: number | null; side: string }, fled: boolean): string[] {
    const range = s.roll!.range;
    const out: string[] = [];
    if (range >= d.min) {
      out.push(`<b>Charge succeeds</b> – move ${esc(a.info.name)} into base contact by hand${d.max !== null ? ` (as many models as possible: maximised at ${inch(d.max)}, ${esc(d.side)})` : ''}.`);
      if (fled) out.push(`The fleeing unit is caught and <b>destroyed</b> – remove ${esc(t.info.name)} by hand. The charger may then take a Leadership test to reform.`);
      else out.push(`Initiative <b>+${chargeInitiative(d.min, d.side)}</b> for ${esc(a.info.name)} this turn (+1 per full 1″ moved, at most +${d.side === 'front' ? 3 : 4} in the ${esc(d.side)}).`);
      if (s.on.includes('Impact Hits (charger)')) out.push('Impact Hits are resolved before anything else.');
      if (s.on.includes('Furious Charge (charger)')) out.push('Furious Charge: +1 Attack this turn.');
    } else if (fled) {
      out.push(`<b>Charge does not reach</b> the fleeing unit – move ${esc(a.info.name)} its full charge range (${range}″) towards it by hand.`);
    } else {
      out.push(`<b>Failed charge</b> – move ${esc(a.info.name)} ${s.roll!.total}″ (the charge roll) directly towards ${esc(t.info.name)} by hand.`);
    }
    if (s.reaction === 'counter') out.push('Counter Charge: resolve the counter charge by hand (see the rule).');
    return out;
  }
}
