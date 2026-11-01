import {
  CHARGE_RULES, chargeInitiative, chargeSetup, fleeSetup, hasChargeRule, reactionChoices, rollTotal, ruleKey,
  type ChargeRule, type RollDice, type RollSetup,
} from '../model/charge';
import { overlappingUnits, placementProblem } from '../model/collision';
import { slotPolygons } from '../model/contact';
import { chargeTravel, contactPose, contactPoses, d6, minChargeDistance, movementOf } from '../model/flow';
import type { History } from '../model/history';
import { OBJECT_TYPES, objectPolygon, segmentHitsPolygon } from '../model/objects';
import { playerName } from '../model/players';
import type { Store } from '../model/store';
import type { ChargeReaction, LogEntry, PlayerId, Prompt, PromptKind, UnitState } from '../model/types';
import { weaponsFor } from './attackFlow';
import { freezeSteps, stepSections } from './steps';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const inch = (n: number) => `${n.toFixed(1)}″`;
const d3 = () => Math.ceil(d6() / 2);
const REACTIONS: Record<ChargeReaction, string> = {
  hold: 'Hold', standShoot: 'Stand & Shoot', flee: 'Flee', fireFlee: 'Fire & Flee', counter: 'Counter Charge',
};

/** Was PromptCenter für den Angriff bereitstellt */
export interface ChargeHost {
  store: Store;
  history: History;
  log(entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>): void;
  create(kind: PromptKind, to: PlayerId, from: PlayerId, title: string, text: string, data: Prompt['data']): void;
  finish(p: Prompt, result: string): void;
  /** Stand & Shoot: Beschussfenster des Ziels auf den Angreifer, „Stand & Shoot“ angehakt */
  standShoot(from: PlayerId, shooterId: string, targetId: string): void;
}

/** Stand im Fenster (liegt im Spielstand, damit beide Spieler ihn sehen) */
interface ChargeState {
  /** angehakte Regeln, Schlüssel wie ruleKey – zu Beginn das Erkannte */
  on: string[];
  reaction?: ChargeReaction;
  /** Fluchtwurf bzw. Angriffswurf, Würfel einzeln */
  flee?: RollDice;
  roll?: RollDice;
  /** schon per Knopf ausgeführt */
  fled?: boolean;
  moved?: 'contact' | 'failed' | 'removed';
  /** Meldung, wenn eine Bewegung per Knopf nicht geht */
  note?: string | null;
}

type Side = 'charger' | 'target';

/**
 * Angriff als Fenster für beide Spieler: Ansage, Reaktion des Gegners (Fluchtwurf), Angriffswurf und Ergebnis.
 * Es erscheinen nur die Regeln, die die Einheiten haben (vorab angehakt). Jeder Würfel wird einzeln geworfen und
 * kann wiederholt werden; dazu die Wiederholungen aus den Regeln. Bewegt wird nur auf Knopfdruck.
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
    const on = [...this.detected('charger', a, t), ...this.detected('target', t, a)];
    this.host.create('charge', a.owner, from, 'Declare charge', `${a.info.name} → ${t.info.name}`,
      { chargerId, targetId, step: 'declare', state: JSON.stringify({ on } satisfies ChargeState) });
  }

  // --- Regeln ---------------------------------------------------------------------

  /** Regeln, die zu dieser Einheit gehören oder gerade gelten können (Zauber der Armee, Gelände auf dem Tisch) */
  private available(side: Side, unit: UnitState): ChargeRule[] {
    const { units, objects } = this.host.store.state;
    const friends = Object.values(units).filter((u) => u.owner === unit.owner);
    return CHARGE_RULES.filter((r) => r.side === side).filter((r) => {
      if (r.from === 'army-spell') return friends.some((u) => (u.spells ?? []).some((s) => r.match?.test(s.replace(/-/g, ' '))));
      if (r.from === 'army-rule') return friends.some((u) => [...u.info.rules, ...u.info.items].some((x) => r.match?.test(x.name)));
      if (r.from === 'terrain') return Object.values(objects).some((o) => (OBJECT_TYPES[o.type]?.rules ?? []).includes('Difficult Terrain'));
      return hasChargeRule(unit, r, units);
    });
  }

  /** Vorab angehakt: Regeln der Einheit (außer freiwilligen Nachteilen); Gelände, wenn die Linie hindurchgeht */
  private detected(side: Side, unit: UnitState, other: UnitState): string[] {
    const objects = this.host.store.state.objects;
    return this.available(side, unit).filter((r) => {
      if (r.from === 'terrain') {
        return Object.values(objects).some((o) => (OBJECT_TYPES[o.type]?.rules ?? []).includes('Difficult Terrain')
          && segmentHitsPolygon(unit, other, objectPolygon(o)));
      }
      return !r.from && !r.optional;
    }).map(ruleKey);
  }

  private ticked(side: Side, s: ChargeState): ChargeRule[] {
    return CHARGE_RULES.filter((r) => r.side === side && s.on.includes(ruleKey(r)));
  }

  private state(p: Prompt): ChargeState {
    try {
      const s = JSON.parse(String(p.data.state || '{}')) as Partial<ChargeState>;
      // Ältere Spielstände: Würfe im alten Format verwerfen
      const ok = (d: unknown) => !!d && Array.isArray((d as RollDice).base);
      return { ...s, on: s.on ?? [], flee: ok(s.flee) ? s.flee : undefined, roll: ok(s.roll) ? s.roll : undefined };
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

  private rulesHtml(side: Side, unit: UnitState, s: ChargeState): string {
    const rules = this.available(side, unit);
    if (!rules.length) return '';
    const rows = rules.map((r) => `<label class="atk-mod"><input type="checkbox" data-crule="${esc(ruleKey(r))}" ${s.on.includes(ruleKey(r)) ? 'checked' : ''}>
        <span class="atk-label">${esc(r.name)} <span class="atk-hint">${esc(r.hint)}</span></span></label>`).join('');
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

  // --- Würfel ---------------------------------------------------------------------

  /**
   * Würfelzeilen eines Wurfs: jeder W6 einzeln (Roll, dann Reroll), +W6/+W3 der Regeln, dazu die Wiederholungen
   * aus den Regeln (ganzen Wurf, 1en). Gestrichene Würfel sind blass.
   */
  private diceHtml(which: 'flee' | 'roll', d: RollDice | undefined, setup: RollSetup, rules: ChargeRule[]): string {
    const dice = d ?? { base: [] };
    const res = rollTotal(dice, setup);
    const row = (label: string, value: number | null | undefined, key: string, dropped = false) =>
      `<div class="dice-step"><span class="label">${esc(label)}</span>${value != null
        ? `<span class="die ${dropped ? 'dropped' : ''}">${value}</span> <button data-cd="re:${which}:${key}" title="Roll this die again">↻ Reroll</button>`
        : `<button data-cd="roll:${which}:${key}" class="primary">🎲 Roll</button>`}</div>`;
    const names = (pick: (r: ChargeRule) => boolean) => rules.filter(pick).map((r) => r.name).join(', ');
    const rows = Array.from({ length: setup.dice }, (_, i) => row(`D6 ${i + 1}`, dice.base[i], String(i), !!res?.dropped.includes(i)));
    if (setup.d6) rows.push(row(`+D6 (${names((r) => !!r.d6)})`, dice.d6, 'd6'));
    if (setup.d3) rows.push(row(`+D3 (${names((r) => !!r.d3)})`, dice.d3, 'd3'));
    const base = dice.base.slice(0, setup.dice);
    const allRolled = base.length === setup.dice && base.every((x) => x != null);
    const extra: string[] = [];
    if (allRolled && setup.rerollAll.length && !dice.usedAll) {
      extra.push(`<button data-cd="all:${which}">↻ Re-roll the whole roll (${esc(setup.rerollAll.map((r) => r.name).join(', '))})</button>`);
    }
    if (allRolled && setup.ones.length && !dice.usedOnes && base.includes(1)) {
      const one = setup.ones.every((r) => r.ones === 'one');
      extra.push(`<button data-cd="ones:${which}">↻ Re-roll ${one ? 'a 1' : '1s'} (${esc(setup.ones.map((r) => r.name).join(', '))})</button>`);
    }
    return rows.join('') + (extra.length ? `<div class="row-btns">${extra.join('')}</div>` : '');
  }

  /** Würfelknöpfe: einzelnen Würfel werfen bzw. neu werfen, ganzen Wurf oder 1en wiederholen */
  private wireDice(p: Prompt, body: HTMLElement, s: ChargeState, setups: Record<'flee' | 'roll', () => RollSetup>, name: (w: 'flee' | 'roll') => string): void {
    body.querySelectorAll<HTMLButtonElement>('[data-cd]').forEach((btn) => {
      btn.onclick = () => {
        const [verb, which, key] = btn.dataset.cd!.split(':') as ['roll' | 're' | 'all' | 'ones', 'flee' | 'roll', string | undefined];
        const setup = setups[which]();
        const d: RollDice = { base: [], ...s[which] };
        d.base = [...d.base];
        const rolled: number[] = [];
        const die = (k: string) => {
          const v = k === 'd3' ? d3() : d6();
          if (k === 'd6') d.d6 = v;
          else if (k === 'd3') d.d3 = v;
          else d.base[Number(k)] = v;
          rolled.push(v);
        };
        let what: string;
        if (verb === 'roll' || verb === 're') {
          die(key!);
          what = `${verb === 're' ? 'Reroll – ' : ''}${key === 'd6' ? '+D6' : key === 'd3' ? '+D3' : `D6 ${Number(key) + 1}`}`;
        } else if (verb === 'all') {
          for (let i = 0; i < setup.dice; i++) die(String(i));
          if (setup.d6) die('d6');
          if (setup.d3) die('d3');
          d.usedAll = true;
          what = `Re-roll of the whole roll (${setup.rerollAll.map((r) => r.name).join(', ')})`;
        } else {
          const one = setup.ones.every((r) => r.ones === 'one');
          const idx = d.base.slice(0, setup.dice).map((x, i) => (x === 1 ? i : -1)).filter((i) => i >= 0);
          for (const i of one ? idx.slice(0, 1) : idx) die(String(i));
          d.usedOnes = true;
          what = `Re-roll ${one ? 'a 1' : '1s'} (${setup.ones.map((r) => r.name).join(', ')})`;
        }
        s[which] = d;
        s.note = null;
        const res = rollTotal(d, setup);
        this.host.log({ kind: 'roll', dice: [rolled], text: `${name(which)}: ${what} ${rolled.join(', ')}${res ? ` → ${res.total}` : ''}` });
        this.commit(p, s);
      };
    });
  }

  // --- 1. Ansage ------------------------------------------------------------------

  private renderDeclare(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, s: ChargeState): void {
    const d = this.distances(a, t);
    const m = movementOf(a);
    const cap = chargeSetup(this.ticked('charger', s)).cap ?? 6;
    body.innerHTML = `<p class="prompt-info">Contact from <b>${inch(d.min)}</b>${d.max !== null ? ` · maximised at <b>${inch(d.max)}</b>` : ''}
        · charges the <b>${esc(d.side)}</b> · Movement ${m}″, so a charge roll of at least ${Math.max(0, Math.ceil(d.min - m))} is needed
        · maximum charge range ${m + cap}″</p>
      ${d.min > m + cap ? `<p class="warn">The target is beyond the maximum charge range (${m + cap}″).</p>` : ''}
      ${this.rulesHtml('charger', a, s)}
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
    const units = this.units;
    const canShoot = [t, ...Object.values(units).filter((c) => c.joinedTo === t.id)]
      .some((u) => weaponsFor(u, 'shooting').some((w) => w.range !== null));
    const choices = reactionChoices(s.on, d.min, movementOf(a), fleeing, canShoot);
    const flees = s.reaction === 'flee' || s.reaction === 'fireFlee';
    const shoots = s.reaction === 'standShoot' || s.reaction === 'fireFlee';
    const fleeRules = this.ticked('target', s);
    const setup = () => fleeSetup(this.ticked('target', s), s.reaction === 'fireFlee');
    const res = flees && s.flee ? rollTotal(s.flee, setup()) : null;
    body.innerHTML = `<p class="prompt-info">${esc(a.info.name)} charges <b>${esc(t.info.name)}</b> in the ${esc(d.side)} – contact from ${inch(d.min)}.</p>
      ${this.rulesHtml('target', t, s)}
      <div class="prompt-options">${choices.map((c) => `<button data-react="${c.key}" class="${s.reaction === c.key ? 'primary' : ''}" ${c.allowed ? '' : 'disabled'}>
        <b>${esc(c.label)}</b><span>${esc(c.hint)}</span></button>`).join('')}</div>
      ${shoots ? `<div class="row-btns"><button data-standshoot>🏹 ${s.reaction === 'fireFlee' ? 'Fire' : 'Stand & Shoot'} at ${esc(a.info.name)} ›</button></div>` : ''}
      ${flees ? `<h4>Flee roll <span class="meta">(${s.reaction === 'fireFlee' ? '2D6, discard the lowest' : '2D6'})</span></h4>${this.diceHtml('flee', s.flee, setup(), fleeRules)}` : ''}
      ${res ? `<p class="prompt-info"><b>Flees ${res.total}″</b> (${esc(res.text)}) – directly away from the charger.</p>
        <div class="row-btns">${s.fled ? `<span class="ok">✓ ${esc(t.info.name)} has fled ${res.total}″</span>`
          : `<button data-flee-move>Move ${esc(t.info.name)} ${res.total}″ away</button>`}</div>` : ''}
      ${s.note ? `<p class="warn">${esc(s.note)}</p>` : ''}
      <div class="prompt-actions"><button class="primary" data-confirm ${!s.reaction || (flees && !res) ? 'disabled' : ''}>Confirm reaction – charge roll ›</button></div>`;
    this.wireRules(p, body, s);
    this.wireDice(p, body, s, { flee: setup, roll: () => chargeSetup(this.ticked('charger', s)) }, () => `${t.info.name} flee roll`);
    body.querySelectorAll<HTMLButtonElement>('[data-react]').forEach((b) => {
      b.onclick = () => {
        s.reaction = b.dataset.react as ChargeReaction;
        if (s.reaction !== 'flee' && s.reaction !== 'fireFlee') delete s.flee;
        s.note = null;
        this.commit(p, s);
      };
    });
    const shoot = body.querySelector<HTMLButtonElement>('[data-standshoot]');
    if (shoot) shoot.onclick = () => this.host.standShoot(t.owner, t.id, a.id);
    const move = body.querySelector<HTMLButtonElement>('[data-flee-move]');
    if (move && res) move.onclick = () => this.fleeMove(p, s, t, a, res.total);
    (body.querySelector('[data-confirm]') as HTMLButtonElement).onclick = () => {
      this.host.log({ kind: 'action', text: `${t.info.name}: ${REACTIONS[s.reaction!]}${res ? ` – flees ${res.total}″` : ''}` });
      s.note = null;
      this.commit(p, s, { step: 'roll', to: a.owner, title: 'Charge roll' });
    };
  }

  // --- 3. Angriffswurf und Ergebnis ---------------------------------------------------

  private renderRoll(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, s: ChargeState): void {
    // Entfernung jetzt: ist das Ziel geflohen, gilt die neue Lage
    const d = this.distances(a, t);
    const m = movementOf(a);
    const fled = s.reaction === 'flee' || s.reaction === 'fireFlee' || t.status === 'fleeing';
    const rules = this.ticked('charger', s);
    const setup = () => chargeSetup(this.ticked('charger', s));
    const res = s.roll ? rollTotal(s.roll, setup()) : null;
    const fleeRes = s.flee ? rollTotal(s.flee, fleeSetup(this.ticked('target', s), s.reaction === 'fireFlee')) : null;
    const summary = `${t.info.name}: ${s.reaction ? REACTIONS[s.reaction] : '–'}${fleeRes ? ` (fled ${fleeRes.total}″)` : ''}`;
    const range = res ? m + res.total : null;
    const outcome = res && range !== null ? this.outcome(a, t, s, d, fled, res.total, range) : [];
    const base = (s.roll?.base ?? []).slice(0, setup().dice);
    const notes = [
      ...(rules.some((r) => r.name === 'Temperamental') && base.includes(1) ? ['Temperamental: a natural 1 was rolled – check the Steam Tank rule.'] : []),
      ...(rules.some((r) => r.name === 'Ogre Kingdoms Charge') && base.includes(6) ? ['Ogre Kingdoms Charge: a natural 6 – Impact Hits (1) if the charge move is 6″ or more.'] : []),
    ];
    body.innerHTML = `<p class="prompt-info">${esc(summary)}</p>
      <p class="prompt-info">Distance now: contact from <b>${inch(d.min)}</b>${d.max !== null ? ` · maximised at ${inch(d.max)}` : ''}
        · charge range = Movement ${m}″ + charge roll (maximum ${m + (setup().cap ?? 6)}″)</p>
      ${d.min > m + (setup().cap ?? 6) ? `<p class="warn">${esc(t.info.name)} is now beyond the maximum charge range (${m + (setup().cap ?? 6)}″) – the charge cannot reach it.</p>` : ''}
      ${this.rulesHtml('charger', a, s)}
      <h4>Charge roll <span class="meta">(2D6, discard the ${setup().keep === 'lowest' ? 'highest' : 'lowest'}${setup().dice === 3 ? ', one extra D6' : ''})</span></h4>
      ${this.diceHtml('roll', s.roll, setup(), rules)}
      ${res && range !== null ? `<p class="prompt-info">Charge roll ${res.total} (${esc(res.text)}) + M ${m} = <b>${range}″</b> · needed ${inch(d.min)}</p>
        ${outcome.map((x) => `<p class="prompt-info">${x}</p>`).join('')}
        ${notes.map((x) => `<p class="prompt-info">${esc(x)}</p>`).join('')}
        ${this.moveButtons(s, t, fled, range >= d.min, res.total)}` : ''}
      ${s.note ? `<p class="warn">${esc(s.note)}</p>` : ''}
      <div class="prompt-actions"><button class="primary" data-done ${res ? '' : 'disabled'}>Done</button></div>`;
    this.wireRules(p, body, s);
    this.wireDice(p, body, s, { roll: setup, flee: () => fleeSetup(this.ticked('target', s), s.reaction === 'fireFlee') }, () => `${a.info.name} charge roll`);
    body.querySelector<HTMLButtonElement>('[data-move]')?.addEventListener('click', (e) => {
      const kind = (e.currentTarget as HTMLButtonElement).dataset.move as 'contact' | 'failed' | 'removed';
      if (res && range !== null) this.chargeMove(p, s, a, t, kind, kind === 'failed' ? res.total : range);
    });
    (body.querySelector('[data-done]') as HTMLButtonElement).onclick = () => {
      if (!res || range === null) return;
      const c = this.host.store.state.charges[`charge-${a.id}`];
      if (c) this.host.store.setCharge(c.id, { ...c, status: 'rolled', success: range >= d.min, reaction: s.reaction ?? null });
      const text = outcome.map((x) => x.replace(/<[^>]+>/g, '')).join(' ');
      this.host.log({ kind: 'action', text: `${a.info.name} → ${t.info.name}: charge range ${range}″ – ${text}` });
      this.host.finish(p, text);
    };
  }

  /** Knöpfe für die Bewegung nach dem Angriffswurf (nur auf Klick) */
  private moveButtons(s: ChargeState, t: UnitState, fled: boolean, success: boolean, roll: number): string {
    if (s.moved) {
      const done = { contact: 'moved into base contact', failed: 'moved', removed: `${t.info.name} removed (destroyed)` }[s.moved];
      return `<div class="row-btns"><span class="ok">✓ ${esc(done)}</span></div>`;
    }
    if (success && fled) return `<div class="row-btns"><button data-move="removed">Remove ${esc(t.info.name)} (caught – destroyed)</button></div>`;
    if (success) return '<div class="row-btns"><button data-move="contact">Move into base contact</button></div>';
    return `<div class="row-btns"><button data-move="failed">Move ${roll}″ towards ${esc(t.info.name)}</button></div>`;
  }

  /** Was passiert – als Text; bewegt wird von Hand oder mit den Knöpfen */
  private outcome(a: UnitState, t: UnitState, s: ChargeState, d: { min: number; max: number | null; side: string }, fled: boolean,
    roll: number, range: number): string[] {
    const out: string[] = [];
    if (range >= d.min) {
      out.push(`<b>Charge succeeds</b> – move ${esc(a.info.name)} into base contact${d.max !== null ? ` (as many models as possible: maximised at ${inch(d.max)}, ${esc(d.side)})` : ''}.`);
      if (fled) out.push(`The fleeing unit is caught and <b>destroyed</b>. The charger may then take a Leadership test to reform.`);
      else out.push(`Initiative <b>+${chargeInitiative(d.min, d.side)}</b> for ${esc(a.info.name)} this turn (+1 per full 1″ moved, at most +${d.side === 'front' ? 3 : 4} in the ${esc(d.side)}).`);
      if (s.on.includes('Impact Hits (charger)')) out.push('Impact Hits are resolved before anything else.');
      if (s.on.includes('Furious Charge (charger)')) out.push('Furious Charge: +1 Attack this turn.');
    } else if (fled) {
      out.push(`<b>Charge does not reach</b> the fleeing unit – ${esc(a.info.name)} moves only its charge roll (${roll}″, without its Movement) towards it.`);
    } else {
      out.push(`<b>Failed charge</b> – ${esc(a.info.name)} moves only its charge roll (${roll}″, without its Movement) directly towards ${esc(t.info.name)}.`);
    }
    if (s.reaction === 'counter') out.push('Counter Charge: resolve the counter charge by hand (see the rule).');
    return out;
  }

  // --- Bewegungen per Knopf ---------------------------------------------------------

  /**
   * Fliehen: umdrehen (Front vom Angreifer weg) und die gewürfelte Weite ziehen, auf der Linie von der Mitte des
   * Angreifers durch die eigene Mitte. Einheiten auf dem Weg werden durchlaufen; endet die Flucht auf einer Einheit,
   * geht es auf derselben Linie weiter, bis sie frei dahinter steht. Verlässt sie den Tisch, ist sie geflohen.
   */
  private fleeMove(p: Prompt, s: ChargeState, t: UnitState, a: UnitState, dist: number): void {
    const units = this.units;
    const dx = t.x - a.x;
    const dy = t.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const at = (go: number) => ({ x: t.x + ux * go, y: t.y + uy * go, rotation: Math.atan2(ux, -uy), status: 'fleeing' as const });
    let go = dist;
    const blockers: string[] = [];
    // In kleinen Schritten weiter, solange sie auf einer anderen Einheit stünde (höchstens einmal über den Tisch)
    for (let i = 0; i < 1000; i++) {
      const hit = overlappingUnits({ ...t, ...at(go) }, units);
      if (!hit.length) break;
      for (const h of hit) if (!blockers.includes(h.info.name)) blockers.push(h.info.name);
      go += 0.1;
    }
    const pose = at(go);
    this.host.history.record();
    // Verlässt die Einheit dabei den Tisch, ist sie vom Schlachtfeld geflohen
    const { width, height } = this.host.store.state.table;
    const off = slotPolygons({ ...t, ...pose }, units).some(({ poly }) => poly.some((q) => q.x < 0 || q.y < 0 || q.x > width || q.y > height));
    this.host.store.updateUnit(t.id, off ? { ...pose, status: 'fledOff' } : pose);
    // Angriffspfeil und gespeicherte Entfernung nach der neuen Lage
    const c = this.host.store.state.charges[`charge-${a.id}`];
    if (c && !off) {
      const d = this.distances(a, this.units[t.id]);
      const round1 = (v: number) => Math.round(v * 10) / 10;
      this.host.store.setCharge(c.id, { ...c, distance: round1(d.min), maxDistance: d.max !== null ? round1(d.max) : null });
    }
    s.fled = true;
    s.note = blockers.length ? `Would have ended on ${blockers.join(', ')} – pushed ${(go - dist).toFixed(1)}″ further behind it.` : null;
    this.host.log({ kind: 'action', text: `${t.info.name} flees ${dist}″ directly away from ${a.info.name}`
      + `${blockers.length ? ` (pushed ${(go - dist).toFixed(1)}″ further, behind ${blockers.join(', ')})` : ''}${off ? ' – and off the battlefield' : ''}` });
    this.commit(p, s);
  }

  /** Nach dem Angriffswurf: in Kontakt ziehen, fehlgeschlagen auf das Ziel zu, oder gefangene Fliehende entfernen */
  private chargeMove(p: Prompt, s: ChargeState, a: UnitState, t: UnitState, kind: 'contact' | 'failed' | 'removed', dist: number): void {
    const units = this.units;
    let patch: Partial<UnitState>;
    let id = a.id;
    let text: string;
    if (kind === 'removed') {
      id = t.id;
      patch = { status: 'destroyed' };
      text = `${t.info.name} is caught and destroyed`;
    } else if (kind === 'contact') {
      // Größtmöglicher Kontakt, soweit die Angriffsweite reicht; sonst die nächste Kontaktstellung
      const pose = contactPoses(a, t, units).find((q) => chargeTravel(a, q, units) <= dist + 1e-6) ?? contactPose(a, t, units);
      patch = { x: pose.x, y: pose.y, rotation: pose.rotation };
      text = `${a.info.name} moves into base contact with ${t.info.name} (${pose.side})`;
    } else {
      const dx = t.x - a.x;
      const dy = t.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // Front zur Zieleinheit drehen (Mitte zu Mitte), dann auf sie zu – nicht bis in den Kontakt (dann wäre der Angriff gelungen)
      const rotation = Math.atan2(dx / len, -dy / len);
      const go = Math.max(0, Math.min(dist, minChargeDistance({ ...a, rotation }, t, units) - 0.05));
      patch = { x: a.x + (dx / len) * go, y: a.y + (dy / len) * go, rotation };
      text = `${a.info.name} turns to face ${t.info.name} and moves ${go.toFixed(1)}″ towards it`;
    }
    if (kind !== 'removed') {
      const problem = placementProblem({ ...units[id], ...patch }, units, false);
      if (problem) {
        s.note = `Cannot move ${a.info.name} there: ${problem} – move it by hand.`;
        this.commit(p, s);
        return;
      }
    }
    this.host.history.record();
    this.host.store.updateUnit(id, patch);
    s.moved = kind;
    s.note = null;
    this.host.log({ kind: 'action', text });
    this.commit(p, s);
  }
}
