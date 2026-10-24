import {
  advanceToward, chargeDistance, chargeRoll, contactPose, fleeFrom, fleeRoll, hasBattleHunger, hasSwiftstride,
  leadershipOf, movementOf, REACTION_NAMES, reactionOptions, roll, wizardLevel,
} from '../model/flow';
import type { History } from '../model/history';
import { currentPhase, currentSub, SUB_CHARGE_MOVES, SUB_DECLARE, subLabel } from '../model/phases';
import { playerName } from '../model/players';
import type { Store } from '../model/store';
import type { Charge, ChargeReaction, LogEntry, PlayerId, Prompt, PromptKind, UnitState } from '../model/types';
import { diceHtml } from './dice';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const other = (p: PlayerId): PlayerId => (p === 'p1' ? 'p2' : 'p1');
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const sel = (id: string) => $(id) as HTMLSelectElement;
const targetOptions = (def = '') => '<option value="">–</option>' +
  [2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${String(n) === def ? 'selected' : ''}>${n}+</option>`).join('');

export const TEST_TYPES: Record<string, string> = {
  break: 'Break test', panic: 'Panic test', fear: 'Fear test', terror: 'Terror test', rally: 'Rally test', ld: 'Leadership test',
};

export interface PromptHost {
  /** Online der eigene Platz, offline null */
  seat(): PlayerId | 'spectator' | null;
  log(entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>): void;
  /** Bewegung außerhalb der eigenen Bewegungsphase erlauben (Flucht, Gegenangriff) */
  allowMove(unitId: string): void;
}

/**
 * Aufforderungen zwischen den Spielern: Der Betroffene bekommt ein Popup (Reaktion wählen,
 * Rüstung würfeln, bannen …), danach sieht der Auslöser das Ergebnis.
 */
export class PromptCenter {
  /** Zwischenergebnis im offenen Popup (z. B. Würfe, bevor Verluste angewendet werden) */
  private stage: Record<string, unknown> = {};
  private shownId: string | null = null;

  constructor(private store: Store, private history: History, private host: PromptHost) {
    store.subscribe((state, c) => {
      if (c.chargeId || c.promptId || c.loaded || c.meta) this.advanceCharges();
      if (c.meta) this.clearOldCharges();
      if (c.chargeId || c.promptId || c.loaded || c.meta) this.render();
      void state;
    });
    this.render();
  }

  // --- Auslösen ---------------------------------------------------------------

  /** Angriff ansagen: Der Besitzer des Ziels muss eine Reaktion wählen. */
  declareCharge(chargerId: string, targetId: string): void {
    const { units, meta } = this.store.state;
    const charger = units[chargerId];
    const target = units[targetId];
    if (!charger || !target || charger.owner === target.owner) return;
    const dist = chargeDistance(charger, target, units);
    const max = movementOf(charger) + 6 + (hasSwiftstride(charger) ? 3 : 0) + (hasBattleHunger(charger) ? 2 : 0);
    const charge: Charge = { id: newId('charge'), charger: chargerId, target: targetId, round: meta.round, status: 'declared' };
    this.store.setCharge(charge.id, charge);
    const far = dist > max ? ` – beyond the maximum charge range (${max}″)!` : '';
    this.host.log({ kind: 'action', text: `${charger.info.name} declares a charge against ${target.info.name} (distance ${dist.toFixed(1)}″${far})` });
  }

  /** Angesagte Angriffe des Spielers am Zug, deren Reaktions-Popup noch nicht verschickt ist. */
  unsentCharges(): Charge[] {
    const { charges, prompts, meta } = this.store.state;
    return Object.values(charges).filter((c) => this.chargerOwner(c) === meta.active && c.status === 'declared' && !prompts[`react-${c.id}`]);
  }

  /** Angriffe, deren Reaktion noch aussteht (Popup verschickt, aber nicht beantwortet). */
  waitingCharges(): Charge[] {
    const { charges, prompts, meta } = this.store.state;
    return Object.values(charges).filter((c) => this.chargerOwner(c) === meta.active && c.status === 'declared' && !!prompts[`react-${c.id}`]);
  }

  /** Ansage abgeschlossen: Jetzt bekommt der Gegner für jeden Angriff das Reaktions-Popup. */
  sendReactionPrompts(): void {
    const list = this.unsentCharges();
    const { units } = this.store.state;
    for (const c of list) {
      const charger = units[c.charger];
      const target = units[c.target];
      if (!charger || !target) continue;
      const dist = chargeDistance(charger, target, units);
      this.create('chargeReaction', target.owner, charger.owner, 'Charge!',
        `${charger.info.name} charges ${target.info.name} (distance ${dist.toFixed(1)}″). Choose a charge reaction:`,
        { chargeId: c.id }, `react-${c.id}`);
    }
    if (list.length) this.host.log({ kind: 'turn', text: `Charges declared: ${list.length} – the opponent chooses charge reactions` });
  }

  /** Angriff zurücknehmen, solange der Gegner noch nicht gefragt wurde. */
  withdrawCharge(id: string): void {
    const c = this.store.state.charges[id];
    if (!c || this.store.state.prompts[`react-${id}`]) return;
    this.store.setCharge(id, null);
  }

  /** Nach Treffern und Verwundungen: Der Verteidiger legt Rüstungs- und Rettungswürfe ab. */
  requestSaves(attacker: PlayerId, targetId: string, wounds: number, save: string, ward: string, note: string): void {
    const target = this.store.state.units[targetId];
    if (!target) return;
    this.create('saves', target.owner, attacker, 'Armour Save',
      `${note ? `${note}: ` : ''}${wounds} Verwundung${wounds === 1 ? '' : 'en'} gegen ${target.info.name}.`,
      { targetId, wounds, save, ward });
  }

  /** Zauber gewirkt: Der Gegner darf bannen. */
  requestDispel(caster: UnitState, spell: string, result: number, castValue: number): void {
    this.create('dispel', other(caster.owner), caster.owner, 'Dispel the spell?',
      `${caster.info.name} casts “${spell}” with ${result} (casting value ${castValue}+). The spell is dispelled if the dispel roll beats ${result}.`,
      { casterId: caster.id, spell, result });
  }

  /** Moral-, Panik-, Aufriebstest usw. verlangen. */
  requestTest(from: PlayerId, unitId: string, type: string, modifier: number): void {
    const u = this.store.state.units[unitId];
    if (!u) return;
    const ld = leadershipOf(u) + modifier;
    this.create('test', u.owner, from, TEST_TYPES[type] ?? 'Test',
      `${u.info.name} must take a ${TEST_TYPES[type] ?? 'Test'}: 2D6 equal to or below ${ld} (Ld ${leadershipOf(u)}${modifier ? ` ${modifier > 0 ? '+' : ''}${modifier}` : ''}).`,
      { unitId, type, ld });
  }

  private create(kind: PromptKind, to: PlayerId, from: PlayerId, title: string, text: string,
    data: Prompt['data'], id = newId(kind)): void {
    if (this.store.state.prompts[id]) return;
    this.store.setPrompt(id, { id, kind, to, from, ts: Date.now(), status: 'open', title, text, data });
  }

  private finish(p: Prompt, result: string): void {
    this.store.setPrompt(p.id, { ...p, status: 'done', result, acknowledged: false });
    this.stage = {};
  }

  // --- Angriffsablauf ---------------------------------------------------------

  /** Sobald alle Angriffe des Spielers am Zug eine Reaktion haben: Angriffswürfe verlangen. */
  private advanceCharges(): void {
    const { charges, meta } = this.store.state;
    const seat = this.host.seat();
    // Nur das Gerät des angreifenden Spielers legt die Folgeaufforderungen an (offline: dieses)
    if (seat && seat !== meta.active) return;
    const current = Object.values(charges).filter((c) => this.chargerOwner(c) === meta.active);
    if (!current.length || current.some((c) => c.status === 'declared')) return;
    if (currentPhase(meta) !== 'movement') return;
    // Alle Reaktionen da: weiter zu den Angriffsbewegungen
    if (currentSub(meta) === SUB_DECLARE) {
      this.store.setMeta({ sub: SUB_CHARGE_MOVES });
      this.host.log({ kind: 'turn', text: `All charge reactions chosen – ${subLabel(this.store.state.meta)}` });
    }
    if (currentSub(this.store.state.meta) !== SUB_CHARGE_MOVES) return;
    for (const c of current) {
      if (c.status !== 'reacted') continue;
      const charger = this.store.state.units[c.charger];
      const target = this.store.state.units[c.target];
      if (!charger || !target) continue;
      this.create('chargeRoll', charger.owner, target.owner, 'Charge roll',
        `${charger.info.name} → ${target.info.name} (${REACTION_NAMES[c.reaction ?? 'hold']}).`,
        { chargeId: c.id }, `roll-${c.id}`);
    }
  }

  private chargerOwner(c: Charge): PlayerId | undefined {
    return this.store.state.units[c.charger]?.owner;
  }

  /** Nach dem Zug sind die Angriffe erledigt. */
  private clearOldCharges(): void {
    const { charges, prompts, meta } = this.store.state;
    const seat = this.host.seat();
    // Aufräumen übernimmt das Gerät des Spielers am Zug (offline: dieses)
    if (currentPhase(meta) !== 'strategy' || (seat && seat !== meta.active)) return;
    for (const c of Object.values(charges)) {
      if (this.chargerOwner(c) !== meta.active || c.round !== meta.round) this.store.setCharge(c.id, null);
    }
    for (const p of Object.values(prompts)) if (p.status === 'done' && p.acknowledged) this.store.setPrompt(p.id, null);
  }

  // --- Anzeige ----------------------------------------------------------------

  /** Offene Aufforderung für mich (offline: jede), sonst ein Ergebnis, das ich noch bestätigen muss. */
  private current(): { prompt: Prompt; mode: 'act' | 'result' } | null {
    const seat = this.host.seat();
    if (seat === 'spectator') return null;
    const list = Object.values(this.store.state.prompts).sort((a, b) => a.ts - b.ts);
    const open = list.find((p) => p.status === 'open' && (!seat || p.to === seat));
    if (open) return { prompt: open, mode: 'act' };
    const result = list.find((p) => p.status === 'done' && !p.acknowledged && (!seat || p.from === seat));
    return result ? { prompt: result, mode: 'result' } : null;
  }

  private render(): void {
    const card = $('prompt-card');
    const cur = this.current();
    const seat = this.host.seat();
    const waiting = Object.values(this.store.state.prompts).filter((p) => p.status === 'open' && seat && p.to !== seat);
    $('prompt-wait').hidden = !waiting.length;
    $('prompt-wait').textContent = waiting.length
      ? `Waiting for ${playerName(waiting[0].to)}: ${waiting.map((p) => p.title).join(', ')}` : '';
    if (!cur) {
      card.hidden = true;
      this.shownId = null;
      return;
    }
    const { prompt: p, mode } = cur;
    if (this.shownId !== `${p.id}-${mode}`) this.stage = {};
    this.shownId = `${p.id}-${mode}`;
    card.hidden = false;
    card.className = `prompt-${p.kind}`;
    const more = Object.values(this.store.state.prompts).filter((x) => x.status === 'open' && (!seat || x.to === seat)).length - 1;
    const who = seat ? '' : `<span class="prompt-who"><span class="dot ${mode === 'act' ? p.to : p.from}"></span>${playerName(mode === 'act' ? p.to : p.from)}</span>`;
    $('prompt-head').innerHTML = `${who}<b>${esc(mode === 'result' ? `Result: ${p.title}` : p.title)}</b>${more > 0 ? `<span class="prompt-more">+${more} more</span>` : ''}`;
    $('prompt-text').textContent = mode === 'result' ? p.result ?? '' : p.text;
    const body = $('prompt-body');
    if (mode === 'result') {
      body.innerHTML = `<div class="prompt-actions"><button class="primary" data-ack>OK</button></div>`;
      (body.querySelector('[data-ack]') as HTMLButtonElement).onclick = () =>
        this.store.setPrompt(p.id, { ...p, acknowledged: true });
      return;
    }
    switch (p.kind) {
      case 'chargeReaction': return this.renderReaction(p, body);
      case 'chargeRoll': return this.renderChargeRoll(p, body);
      case 'saves': return this.renderSaves(p, body);
      case 'dispel': return this.renderDispel(p, body);
      case 'test': return this.renderTest(p, body);
    }
  }

  // --- Popups -----------------------------------------------------------------

  private renderReaction(p: Prompt, body: HTMLElement): void {
    const charge = this.store.state.charges[String(p.data.chargeId)];
    if (!charge) {
      this.finish(p, 'The charge was withdrawn.');
      return;
    }
    const options = reactionOptions(this.store.state, charge);
    body.innerHTML = `<div class="prompt-options">${options.map((o) =>
      `<button data-r="${o.key}"><b>${REACTION_NAMES[o.key]}</b><span>${esc(o.note)}</span></button>`).join('')}</div>`;
    body.querySelectorAll<HTMLButtonElement>('[data-r]').forEach((btn) => {
      btn.onclick = () => this.react(p, charge, btn.dataset.r as ChargeReaction);
    });
  }

  private react(p: Prompt, charge: Charge, reaction: ChargeReaction): void {
    const { units } = this.store.state;
    const target = units[charge.target];
    const charger = units[charge.charger];
    let result = `${target.info.name}: ${REACTION_NAMES[reaction]}.`;
    let dice: number[][] | undefined;
    if (reaction === 'flee' || reaction === 'fireFlee') {
      // Sofort fliehen: vom Angreifer wegdrehen und um den Fluchtwurf bewegen
      const r = fleeRoll(reaction === 'fireFlee', hasSwiftstride(target));
      const pose = fleeFrom(target, charger, r.total);
      this.history.record();
      this.host.allowMove(target.id);
      this.store.updateUnit(target.id, { ...pose, status: 'fleeing' });
      result = `${target.info.name}: ${REACTION_NAMES[reaction]}${reaction === 'fireFlee' ? ' (shoot first)' : ''} – flees ${r.total}″ (${r.text}).`;
      dice = [r.dice];
    } else if (reaction === 'counter') {
      // Dem Angreifer zuwenden
      const rotation = Math.atan2(charger.x - target.x, -(charger.y - target.y));
      this.history.record();
      this.host.allowMove(target.id);
      this.store.updateUnit(target.id, { rotation });
      result += ' The unit has turned to face the charger; both count as charging.';
    } else if (reaction === 'standShoot') {
      result += ' Now roll the shooting; afterwards the unit Holds.';
    }
    this.store.setCharge(charge.id, { ...charge, reaction, status: 'reacted' });
    this.host.log({ kind: 'action', text: result, dice });
    this.finish(p, result);
  }

  private renderChargeRoll(p: Prompt, body: HTMLElement): void {
    const { units, charges } = this.store.state;
    const charge = charges[String(p.data.chargeId)];
    const charger = charge && units[charge.charger];
    const target = charge && units[charge.target];
    if (!charge || !charger || !target) {
      this.finish(p, 'The charge is cancelled.');
      return;
    }
    const done = this.stage.rolled as { success: boolean; range: number; dist: number; total: number; text: string; dice: number[] } | undefined;
    const dist = chargeDistance(charger, target, units);
    const m = movementOf(charger);
    if (!done) {
      body.innerHTML = `<p class="prompt-info">Distance ${dist.toFixed(1)}″ · Movement ${m}″ · Roll: 2D6, discard the lowest.</p>
        <div class="prompt-checks">
          ${hasSwiftstride(charger) ? '<label><input type="checkbox" id="pr-swift" checked> Swiftstride (+D6)</label>' : ''}
          ${hasBattleHunger(charger) ? '<label><input type="checkbox" id="pr-hunger" checked> Battle Hunger (+D3)</label>' : ''}
        </div>
        <div class="prompt-actions"><button class="primary" data-roll>Charge roll</button></div>`;
      (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
        const swift = (document.getElementById('pr-swift') as HTMLInputElement | null)?.checked ?? false;
        const hunger = (document.getElementById('pr-hunger') as HTMLInputElement | null)?.checked ?? false;
        const r = chargeRoll(swift, hunger);
        const range = m + r.total;
        const now = chargeDistance(charger, target, units);
        const success = range >= now;
        this.stage.rolled = { success, range, dist: now, total: r.total, text: r.text, dice: r.dice };
        this.store.setCharge(charge.id, { ...charge, status: 'rolled', dice: r.dice, range, distance: now, success });
        this.host.log({ kind: 'roll', dice: [r.dice],
          text: `Charge roll ${charger.info.name} → ${target.info.name}: ${r.text}, charge range ${range}″ at ${now.toFixed(1)}″ – ${success ? 'charge succeeds' : 'failed charge'}` });
        this.render();
      };
      return;
    }
    body.innerHTML = `<div class="dice-row">${diceHtml(done.dice)}</div>
      <p class="prompt-info"><b>${done.success ? 'Charge succeeds' : 'Failed charge'}</b> – charge range ${done.range}″ (${esc(done.text)}), distance ${done.dist.toFixed(1)}″.</p>
      <div class="prompt-actions">
        <button class="primary" data-move>${done.success ? 'Move into contact' : `${done.total}″ towards the target`}</button>
        <button data-skip>Selbst bewegen</button>
      </div>`;
    (body.querySelector('[data-move]') as HTMLButtonElement).onclick = () => {
      this.history.record();
      this.host.allowMove(charger.id);
      let text: string;
      if (done.success) {
        const pose = contactPose(charger, target, units);
        this.store.updateUnit(charger.id, { x: pose.x, y: pose.y, rotation: pose.rotation });
        text = `${charger.info.name} charges ${target.info.name} in the ${pose.side}.`;
      } else {
        this.store.updateUnit(charger.id, advanceToward(charger, target, units, done.total));
        text = `${charger.info.name}: failed charge, ${done.total}″ towards ${target.info.name}.`;
      }
      this.host.log({ kind: 'action', text });
      this.finish(p, text);
    };
    (body.querySelector('[data-skip]') as HTMLButtonElement).onclick = () => {
      this.host.allowMove(charger.id);
      this.finish(p, `${charger.info.name}: ${done.success ? 'charge succeeds' : `failed charge (${done.total}″)`} – moved by hand.`);
    };
  }

  private renderSaves(p: Prompt, body: HTMLElement): void {
    const target = this.store.state.units[String(p.data.targetId)];
    if (!target) {
      this.finish(p, 'The target is gone.');
      return;
    }
    const wounds = Number(p.data.wounds);
    const done = this.stage.saves as { armour: number[]; ward: number[]; unsaved: number; text: string; save: number } | undefined;
    if (!done) {
      body.innerHTML = `<div class="prompt-form">
          <label>Armour Save <select id="pr-save">${targetOptions(String(p.data.save ?? ''))}</select></label>
          <label>Ward save <select id="pr-ward">${targetOptions(String(p.data.ward ?? ''))}</select></label>
        </div>
        <div class="prompt-actions"><button class="primary" data-roll>Roll ${wounds} dice</button></div>`;
      (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
        const save = Number(sel('pr-save').value) || 0;
        const ward = Number(sel('pr-ward').value) || 0;
        const armour = save ? roll(wounds) : [];
        let left = save ? armour.filter((d) => d < save).length : wounds;
        const wardDice = ward && left ? roll(left) : [];
        if (ward) left = wardDice.filter((d) => d < ward).length;
        const text = `${wounds} wounds` + (save ? ` → ${armour.filter((d) => d >= save).length} saved by armour (${save}+)` : ' → no Armour Save')
          + (ward ? ` → ${wardDice.filter((d) => d >= ward).length} durch Rettung (${ward}+) gehalten` : '') + ` → ${left} ungerettet`;
        this.stage.saves = { armour, ward: wardDice, unsaved: left, text, save };
        this.host.log({ kind: 'roll', text: `${target.info.name}: ${text}`, dice: [armour, wardDice].filter((d) => d.length) });
        this.render();
      };
      return;
    }
    const perModel = target.info.woundsPerModel ?? 1;
    const single = (target.info.startModels ?? target.models) === 1;
    const losses = single ? done.unsaved : Math.floor(done.unsaved / perModel);
    body.innerHTML = `${done.armour.length ? `<div class="dice-row"><span class="dice-label">Armour</span>${diceHtml(done.armour, done.save || 7)}</div>` : ''}
      ${done.ward.length ? `<div class="dice-row"><span class="dice-label">Ward</span>${diceHtml(done.ward)}</div>` : ''}
      <p class="prompt-info"><b>${done.unsaved} ungerettet.</b> ${esc(done.text)}</p>
      <div class="prompt-actions">
        ${done.unsaved ? `<button class="primary" data-apply>${single ? `Remove ${losses} Wound${losses === 1 ? '' : 's'}` : `Remove ${losses} model${losses === 1 ? '' : 's'}`}</button>` : ''}
        <button data-ok>${done.unsaved ? 'Apply by hand' : 'Done'}</button>
      </div>`;
    const apply = body.querySelector('[data-apply]') as HTMLButtonElement | null;
    if (apply) apply.onclick = () => {
      this.history.record();
      if (single) this.store.updateUnit(target.id, { woundsLost: (target.woundsLost ?? 0) + losses });
      // Alle Modelle verloren: Einheit gilt als vernichtet (bleibt für die Siegpunkte sichtbar)
      else if (target.models - losses <= 0) this.store.updateUnit(target.id, { status: 'destroyed' });
      else this.store.updateUnit(target.id, { models: target.models - losses });
      this.finish(p, `${target.info.name}: ${done.text}; ${single ? `${losses} Wounds lost` : `${losses} models removed`}.`);
    };
    (body.querySelector('[data-ok]') as HTMLButtonElement).onclick = () => this.finish(p, `${target.info.name}: ${done.text}.`);
  }

  private renderDispel(p: Prompt, body: HTMLElement): void {
    const wizards = Object.values(this.store.state.units).filter((u) => u.owner === p.to && wizardLevel(u) > 0);
    const castResult = Number(p.data.result);
    body.innerHTML = `<div class="prompt-form">
        <label>Dispel with <select id="pr-wiz">
          ${wizards.map((w) => `<option value="${w.id}">${esc(w.info.name)} (Level ${wizardLevel(w)}, +${Math.ceil(wizardLevel(w) / 2)})</option>`).join('')}
          <option value="">Dispel without a Wizard</option>
        </select></label>
      </div>
      <div class="prompt-actions"><button class="primary" data-roll>Dispel roll (2D6)</button><button data-no>Do not dispel</button></div>`;
    (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
      const wiz = this.store.state.units[sel('pr-wiz').value];
      const bonus = wiz ? Math.ceil(wizardLevel(wiz) / 2) : 0;
      const dice = roll(2);
      const total = dice[0] + dice[1] + bonus;
      const ok = total > castResult;
      const text = `“${p.data.spell}”: dispel roll ${dice.join(' + ')}${bonus ? ` + ${bonus}` : ''} = ${total} vs ${castResult} – ${ok ? 'dispelled' : 'not dispelled'}${wiz ? ` (${wiz.info.name})` : ' (without a Wizard)'}.`;
      this.host.log({ kind: 'roll', text, dice: [dice] });
      this.finish(p, text);
    };
    (body.querySelector('[data-no]') as HTMLButtonElement).onclick = () => {
      const text = `“${p.data.spell}” is not dispelled and takes effect.`;
      this.host.log({ kind: 'action', text });
      this.finish(p, text);
    };
  }

  private renderTest(p: Prompt, body: HTMLElement): void {
    const u = this.store.state.units[String(p.data.unitId)];
    if (!u) {
      this.finish(p, 'The unit is gone.');
      return;
    }
    const ld = Number(p.data.ld);
    const done = this.stage.test as { dice: number[]; pass: boolean; sum: number } | undefined;
    if (!done) {
      body.innerHTML = `<div class="prompt-actions"><button class="primary" data-roll>Roll 2D6</button></div>`;
      (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
        const dice = roll(2);
        const sum = dice[0] + dice[1];
        // Doppel-1 besteht immer (Insane Courage)
        const pass = sum <= ld || (dice[0] === 1 && dice[1] === 1);
        this.stage.test = { dice, pass, sum };
        this.host.log({ kind: 'roll', dice: [dice], text: `${u.info.name}: ${p.title} ${sum} vs ${ld} – ${pass ? 'passed' : 'failed'}` });
        this.render();
      };
      return;
    }
    const canFlee = !done.pass && ['break', 'panic', 'terror'].includes(String(p.data.type));
    const text = `${u.info.name}: ${p.title} ${done.sum} vs ${ld} – ${done.pass ? 'passed' : 'failed'}`;
    body.innerHTML = `<div class="dice-row">${diceHtml(done.dice)}</div>
      <p class="prompt-info"><b>${done.pass ? 'Passed' : 'Failed'}</b> (${done.sum} vs ${ld}).</p>
      <div class="prompt-actions">
        ${canFlee ? '<button class="primary" data-flee>Unit flees</button>' : ''}
        <button data-ok>${canFlee ? 'Resolve by hand' : 'OK'}</button>
      </div>`;
    const flee = body.querySelector('[data-flee]') as HTMLButtonElement | null;
    if (flee) flee.onclick = () => {
      this.history.record();
      this.store.updateUnit(u.id, { status: 'fleeing' });
      this.host.allowMove(u.id);
      this.finish(p, `${text} – the unit flees.`);
    };
    (body.querySelector('[data-ok]') as HTMLButtonElement).onclick = () => this.finish(p, `${text}.`);
  }
}
