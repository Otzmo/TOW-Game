import {
  armourBane, attackWeapon, bareHands, baseToHit, baseToWound, finalNeed, misses, needText, saveMods, shootingOptions,
  successes, type AttackMode, type AttackWeapon, type RollMod,
} from '../model/attack';
import { minChargeDistance, roll, statOf } from '../model/flow';
import { unitSaves, unitWeapons } from '../model/gear';
import type { History } from '../model/history';
import { playerName } from '../model/players';
import type { Store } from '../model/store';
import type { LogEntry, PlayerId, Prompt, PromptKind, UnitState } from '../model/types';
import { diceHtml } from './dice';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
const clampCount = (v: string) => Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
const saveOptions = (def: number | null) => '<option value="">none</option>' +
  [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === def ? 'selected' : ''}>${n}+</option>`).join('');

/** Was PromptCenter für Angriffe bereitstellt */
export interface AttackHost {
  store: Store;
  history: History;
  log(entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>): void;
  create(kind: PromptKind, to: PlayerId, from: PlayerId, title: string, text: string, data: Prompt['data']): void;
  finish(p: Prompt, result: string): void;
  /** Zwischenstand des offenen Popups (wird bei einem neuen Popup geleert) */
  stage(): Record<string, unknown>;
}

/** Eingaben im offenen Popup, bevor gewürfelt wird */
interface Form {
  weapon: number;
  count: number;
  /** angehakte Vorschläge (Labels) */
  checked: string[];
  manual: RollMod[];
  strength: number;
  toughness: number;
}

interface Rolled {
  dice: number[];
  then: number[];
  need: number | null;
  thenNeed: number | null;
  /** BS 6+: wiederholte Fehlschüsse */
  rerolled: number[];
  rerollNeed: number | null;
  success: number;
  /** davon mit natürlicher 6 (Armour Bane beim Verwunden) */
  sixes: number;
}

/** Waffen einer Einheit für die Auswahl: magische Waffen, dann Ausrüstung; passend zur Angriffsart */
export function weaponsFor(u: UnitState, mode: AttackMode): AttackWeapon[] {
  const profiles = [
    ...u.info.items.flatMap((i) => i.profiles ?? []),
    ...unitWeapons(u.info).flatMap((w) => w.profiles),
  ];
  const list = profiles.map((p) => attackWeapon(p, u)).filter((w) => (mode === 'shooting' ? w.range !== null : w.range === null));
  return list.length ? list : mode === 'combat' ? [bareHands(u)] : [];
}

/**
 * Beschuss und Nahkampf als Abfolge von Popups: Der Angreifer würfelt erst Treffer, nach Bestätigung
 * Verwundungen; danach würfelt der Verteidiger Rüstung, Rettung und Regeneration. Vor jedem Wurf stehen
 * Grundwert und alle Modifikatoren da; eigene lassen sich hinzufügen.
 */
export class AttackFlow {
  constructor(private host: AttackHost) {}

  private get units() {
    return this.host.store.state.units;
  }

  /** Angriff beginnen: Popup „Roll To Hit“ für den Besitzer der angreifenden Einheit */
  start(from: PlayerId, attackerId: string, targetId: string, mode: AttackMode): void {
    const a = this.units[attackerId];
    const t = this.units[targetId];
    if (!a || !t || a.owner === t.owner) return;
    const verb = mode === 'shooting' ? 'Shooting' : 'Combat';
    this.host.create('attack', a.owner, from, 'Roll To Hit', `${verb}: ${a.info.name} → ${t.info.name}`,
      { attackerId, targetId, mode, step: 'hit' });
  }

  // --- Angreifer: Treffer und Verwundungen ------------------------------------

  renderAttack(p: Prompt, body: HTMLElement): void {
    const a = this.units[String(p.data.attackerId)];
    const t = this.units[String(p.data.targetId)];
    if (!a || !t) {
      this.host.store.setPrompt(p.id, null);
      return;
    }
    const mode = (p.data.mode === 'shooting' ? 'shooting' : 'combat') as AttackMode;
    const weapons = weaponsFor(a, mode);
    if (!weapons.length) {
      body.innerHTML = `<p class="warn">${esc(a.info.name)} has no missile weapon.</p>
        <div class="prompt-actions"><button data-cancel>Close</button></div>`;
      (body.querySelector('[data-cancel]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
      return;
    }
    const stage = this.host.stage();
    const hitStep = p.data.step !== 'wound';
    const form = (stage.form as Form | undefined) ?? (stage.form = this.newForm(p, a, t, mode, weapons)) as Form;
    const weapon = weapons[Math.min(form.weapon, weapons.length - 1)];
    const rolled = stage.rolled as Rolled | undefined;
    if (rolled) return this.showRolled(p, body, a, t, weapon, rolled, hitStep);

    // Modifikatoren nur zum Anhaken – verrechnet wird nur, was angehakt ist (lange Reichweite mit gemessener Entfernung)
    const distance = minChargeDistance(a, t, this.units);
    const suggested = hitStep && mode === 'shooting' ? shootingOptions(weapon.range, distance) : [];
    const active = [...suggested.filter((m) => form.checked.includes(m.label)), ...form.manual];
    const base = hitStep ? baseToHit(mode, a, t) : baseToWound(form.strength, form.toughness);
    const need = finalNeed(base.need, active, hitStep ? 'hit' : 'wound');
    // BS 6+: Fehlschüsse werden ohne Modifikatoren wiederholt
    const reroll = base.reroll;
    const needLine = `${needText(need)}${reroll && need.need !== null ? `, misses re-rolled on ${reroll}+` : ''}`;
    const outOfRange = hitStep && weapon.range !== null && distance > weapon.range;

    const weaponSelect = hitStep
      ? `<label>Weapon <select id="atk-weapon">${weapons.map((w, i) => `<option value="${i}" ${i === form.weapon ? 'selected' : ''}>
          ${esc(w.name)}${w.range !== null ? ` · ${w.range}″` : ''} · S ${w.strength} · AP ${w.ap || '–'}</option>`).join('')}</select></label>`
      : `<label>Weapon <input value="${esc(`${weapon.name} · AP ${weapon.ap || '–'}`)}" disabled></label>`;
    const counts = hitStep
      ? `<label>Number of ${mode === 'shooting' ? 'shots' : 'attacks'} <input id="atk-count" type="number" min="0" max="200" value="${form.count}"></label>`
      : `<label>Hits <input id="atk-count" type="number" min="0" max="200" value="${form.count}"></label>
         <label>Strength <input id="atk-s" type="number" min="1" max="10" value="${form.strength}"></label>
         <label>Toughness <input id="atk-t" type="number" min="1" max="10" value="${form.toughness}"></label>`;
    body.innerHTML = `<div class="prompt-form">${weaponSelect}${counts}</div>
      ${weapon.rules.length ? `<p class="atk-rules">Weapon rules: ${esc(weapon.rules.join(', '))}</p>` : ''}
      ${outOfRange ? `<p class="warn">Out of range: ${distance.toFixed(1)}″ > ${weapon.range}″</p>` : ''}
      ${this.modsHtml(`${hitStep ? 'To Hit' : 'To Wound'} ${base.need > 6 ? 'impossible' : `${base.need}+`} <span class="meta">(${esc(base.why)})</span>`,
        suggested, form.checked, form.manual, needLine)}
      <div class="prompt-actions">
        <button class="primary" data-roll ${need.need === null || !form.count ? 'disabled' : ''}>${hitStep ? 'Roll To Hit' : 'Roll To Wound'} (${form.count} ${form.count === 1 ? 'die' : 'dice'})</button>
        <button data-cancel>Cancel</button>
      </div>`;

    const redraw = () => this.renderAttack(p, body);
    const num = (id: string) => body.querySelector<HTMLInputElement>(`#${id}`);
    num('atk-count')!.onchange = (e) => { form.count = clampCount((e.target as HTMLInputElement).value); redraw(); };
    if (num('atk-s')) num('atk-s')!.onchange = (e) => { form.strength = clampCount((e.target as HTMLInputElement).value) || 1; redraw(); };
    if (num('atk-t')) num('atk-t')!.onchange = (e) => { form.toughness = clampCount((e.target as HTMLInputElement).value) || 1; redraw(); };
    const sel = body.querySelector<HTMLSelectElement>('#atk-weapon');
    if (sel) sel.onchange = () => { form.weapon = Number(sel.value); redraw(); };
    this.wireMods(body, form.checked, form.manual, redraw);
    (body.querySelector('[data-cancel]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
      const dice = roll(form.count);
      const then = need.then ? roll(dice.filter((d) => d === 6).length) : [];
      const rerolled = reroll && need.need !== null ? roll(misses(dice, need.need, then, need.then)) : [];
      const success = successes(dice, need.need, then, need.then, rerolled, reroll);
      // Armour Bane: Verwundungen mit einer natürlichen 6 bekommen besseren AP
      const sixes = hitStep ? 0 : Math.min(success, dice.filter((d) => d === 6).length);
      stage.rolled = { dice, then, need: need.need, thenNeed: need.then, rerolled, rerollNeed: reroll, success, sixes } satisfies Rolled;
      const mods = active.length ? ` [${active.map((m) => `${m.label} ${signed(m.value)}`).join(', ')}]` : '';
      this.host.log({ kind: 'roll', dice: [dice, then, rerolled].filter((d) => d.length),
        text: `${a.info.name} → ${t.info.name} (${weapon.name}): ${form.count} ${hitStep ? 'to hit' : 'to wound'} ${needLine}${mods} → ${success} ${hitStep ? 'hits' : 'wounds'}` });
      redraw();
    };
  }

  private newForm(p: Prompt, a: UnitState, t: UnitState, mode: AttackMode, weapons: AttackWeapon[]): Form {
    const w = Math.min(Number(p.data.weapon ?? 0) || 0, weapons.length - 1);
    const weapon = weapons[w];
    // Vorschlag: Beschuss ein Schuss je Modell, Nahkampf Modelle × Attacken (anpassbar)
    const count = p.data.step === 'wound' ? Number(p.data.hits) || 0
      : mode === 'shooting' ? a.models : a.models * Math.max(1, statOf(a, 'A'));
    // Nichts ist vorab angehakt: Modifikatoren wählt der Spieler selbst
    return { weapon: w, count, checked: [], manual: [], strength: Number(p.data.strength) || weapon.strength, toughness: statOf(t, 'T') || 3 };
  }

  private showRolled(p: Prompt, body: HTMLElement, a: UnitState, t: UnitState, weapon: AttackWeapon, r: Rolled, hitStep: boolean): void {
    const word = hitStep ? 'hit' : 'wound';
    const bane = armourBane(weapon.rules);
    body.innerHTML = `<div class="dice-row">${diceHtml(r.dice, r.thenNeed ? 7 : r.need ?? 7)}</div>
      ${r.then.length ? `<div class="dice-row"><span class="dice-label">Sixes, then ${r.thenNeed}+</span>${diceHtml(r.then, r.thenNeed ?? 7)}</div>` : ''}
      ${r.rerolled.length ? `<div class="dice-row"><span class="dice-label">Misses re-rolled, ${r.rerollNeed}+</span>${diceHtml(r.rerolled, r.rerollNeed ?? 7)}</div>` : ''}
      <p class="prompt-info"><b>${r.success} ${word}${r.success === 1 ? '' : 's'}</b>
        ${!hitStep && bane && r.sixes ? ` · ${r.sixes} with a natural 6 (Armour Bane ${bane}: AP ${weapon.ap - bane})` : ''}</p>
      <div class="prompt-actions">${r.success
        ? `<button class="primary" data-next>${hitStep ? 'Continue: Roll To Wound ›' : `Send to ${esc(playerName(t.owner))} for saves ›`}</button>`
        : ''}<button data-done>${r.success ? 'Stop here' : 'Done'}</button></div>`;
    const stage = this.host.stage();
    (body.querySelector('[data-done]') as HTMLButtonElement).onclick = () => this.host.store.setPrompt(p.id, null);
    const next = body.querySelector('[data-next]') as HTMLButtonElement | null;
    if (!next) return;
    next.onclick = () => {
      const form = stage.form as Form;
      for (const k of Object.keys(stage)) delete stage[k];
      if (hitStep) {
        // Nächstes Popup: Verwundungswurf mit den erzielten Treffern und der Stärke der gewählten Waffe
        this.host.store.setPrompt(p.id, { ...p, title: 'Roll To Wound',
          data: { ...p.data, step: 'wound', hits: r.success, weapon: form.weapon, strength: weapon.strength } });
        return;
      }
      this.host.store.setPrompt(p.id, null);
      const saves = unitSaves(t.info);
      const sixes = bane ? r.sixes : 0;
      this.host.create('saves', t.owner, a.owner, 'Saves: Armour, Ward, Regeneration',
        `${a.info.name} (${weapon.name}): ${r.success} wound${r.success === 1 ? '' : 's'} against ${t.info.name}.`,
        { targetId: t.id, wounds: r.success, weapon: weapon.name, ap: weapon.ap, bane: sixes, baneAp: bane,
          save: saves.armour ?? '', ward: saves.ward?.value ?? '', regen: saves.regen?.value ?? '' });
    };
  }

  // --- Verteidiger: Rüstung, Rettung, Regeneration ----------------------------

  renderSaves(p: Prompt, body: HTMLElement): void {
    const target = this.units[String(p.data.targetId)];
    if (!target) {
      this.host.finish(p, 'The target is gone.');
      return;
    }
    const stage = this.host.stage();
    const wounds = Number(p.data.wounds);
    const ap = Number(p.data.ap) || 0;
    const bane = Math.min(wounds, Number(p.data.bane) || 0);
    const baneAp = Number(p.data.baneAp) || 0;
    type SaveForm = { armour: number | null; ward: number | null; regen: number | null; checked: string[]; manual: RollMod[] };
    const num = (v: unknown) => (Number(v) >= 1 && Number(v) <= 6 ? Number(v) : null);
    const form = (stage.saveForm as SaveForm | undefined) ?? (stage.saveForm = {
      armour: num(p.data.save), ward: num(p.data.ward), regen: num(p.data.regen), checked: [], manual: [],
    }) as SaveForm;
    const done = stage.saves as SavesRolled | undefined;
    if (done) return this.showSaves(p, body, target, done);

    // AP der Waffe und Armour Bane nur zum Anhaken; eigene Modifikatoren (z. B. Schild nur von vorn) kommen dazu
    const baneMod: RollMod | null = bane && baneAp
      ? { label: `Armour Bane (${baneAp})`, value: -baneAp, hint: `only ${bane} wound${bane === 1 ? '' : 's'} from a natural 6` } : null;
    const options = [...saveMods(ap, String(p.data.weapon ?? 'weapon')), ...(baneMod ? [baneMod] : [])];
    const mods = [...options.filter((m) => m !== baneMod && form.checked.includes(m.label)), ...form.manual];
    const baned = baneMod && form.checked.includes(baneMod.label) ? bane : 0;
    const armourNeed = form.armour ? finalNeed(form.armour, mods, 'save') : { need: null, then: null };
    const baneNeed = form.armour && baneMod ? finalNeed(form.armour, [...mods, baneMod], 'save') : { need: null, then: null };
    const armourLine = !form.armour ? 'no armour save'
      : baned ? `${wounds - baned} at ${needText(armourNeed)}, ${baned} at ${needText(baneNeed)} (Armour Bane)`
      : needText(armourNeed);
    body.innerHTML = `<div class="prompt-form">
        <label>Armour Save <select id="sv-armour">${saveOptions(form.armour)}</select></label>
        <label>Ward Save <select id="sv-ward">${saveOptions(form.ward)}</select></label>
        <label>Regeneration Save <select id="sv-regen">${saveOptions(form.regen)}</select></label>
      </div>
      ${this.modsHtml(`Armour Save ${form.armour ? `${form.armour}+` : '–'}`, options, form.checked, form.manual, armourLine)}
      <p class="prompt-info">Ward and Regeneration saves are not modified by AP.</p>
      <div class="prompt-actions"><button class="primary" data-roll>Roll saves (${wounds} wound${wounds === 1 ? '' : 's'})</button></div>`;
    const redraw = () => this.renderSaves(p, body);
    for (const [id, key] of [['sv-armour', 'armour'], ['sv-ward', 'ward'], ['sv-regen', 'regen']] as const) {
      const s = body.querySelector<HTMLSelectElement>(`#${id}`)!;
      s.onchange = () => { form[key] = num(s.value); redraw(); };
    }
    this.wireMods(body, form.checked, form.manual, redraw);
    (body.querySelector('[data-roll]') as HTMLButtonElement).onclick = () => {
      // Nacheinander: Rüstung, dann Rettung, dann Regeneration – jeweils für die noch übrigen Verwundungen
      const parts = [`${wounds} wound${wounds === 1 ? '' : 's'}`];
      const roll1 = (n: number, need: number | null, name: string): { dice: number[]; saved: number } => {
        if (!n || need === null) return { dice: [], saved: 0 };
        const dice = roll(n);
        const saved = dice.filter((d) => d >= need).length;
        parts.push(`${saved} saved by ${name} (${need}+)`);
        return { dice, saved };
      };
      const normal = roll1(wounds - baned, armourNeed.need, 'armour');
      const baneRoll = roll1(baned, baneNeed.need, 'armour, Armour Bane');
      let left = wounds - normal.saved - baneRoll.saved;
      const ward = roll1(left, form.ward, 'ward');
      left -= ward.saved;
      const regen = roll1(left, form.regen, 'regeneration');
      left -= regen.saved;
      if (parts.length === 1) parts.push('no saves');
      parts.push(`${left} unsaved`);
      const text = parts.join(' → ');
      stage.saves = {
        rows: [
          { label: 'Armour', dice: normal.dice, need: armourNeed.need },
          { label: 'Armour (Armour Bane)', dice: baneRoll.dice, need: baneNeed.need },
          { label: 'Ward', dice: ward.dice, need: form.ward },
          { label: 'Regeneration', dice: regen.dice, need: form.regen },
        ].filter((r) => r.dice.length),
        unsaved: left, text,
      } satisfies SavesRolled;
      this.host.log({ kind: 'roll', text: `${target.info.name}: ${text}`,
        dice: [normal.dice, baneRoll.dice, ward.dice, regen.dice].filter((d) => d.length) });
      redraw();
    };
  }

  private showSaves(p: Prompt, body: HTMLElement, target: UnitState, done: SavesRolled): void {
    const perModel = target.info.woundsPerModel ?? 1;
    const single = (target.info.startModels ?? target.models) === 1;
    const losses = single ? done.unsaved : Math.floor(done.unsaved / perModel);
    body.innerHTML = `${done.rows.map((r) => `<div class="dice-row"><span class="dice-label">${r.label} ${r.need}+</span>${diceHtml(r.dice, r.need ?? 7)}</div>`).join('')}
      <p class="prompt-info"><b>${done.unsaved} unsaved.</b> ${esc(done.text)}</p>
      <div class="prompt-actions">
        ${done.unsaved ? `<button class="primary" data-apply>${single ? `Remove ${losses} Wound${losses === 1 ? '' : 's'}` : `Remove ${losses} model${losses === 1 ? '' : 's'}`}</button>` : ''}
        <button data-ok>${done.unsaved ? 'Apply by hand' : 'Done'}</button>
      </div>`;
    const apply = body.querySelector('[data-apply]') as HTMLButtonElement | null;
    if (apply) apply.onclick = () => {
      this.host.history.record();
      if (single) this.host.store.updateUnit(target.id, { woundsLost: (target.woundsLost ?? 0) + losses });
      // Alle Modelle verloren: Einheit gilt als vernichtet (bleibt für die Siegpunkte sichtbar)
      else if (target.models - losses <= 0) this.host.store.updateUnit(target.id, { status: 'destroyed' });
      else this.host.store.updateUnit(target.id, { models: target.models - losses });
      this.host.finish(p, `${target.info.name}: ${done.text}; ${single ? `${losses} Wounds lost` : `${losses} models removed`}.`);
    };
    (body.querySelector('[data-ok]') as HTMLButtonElement).onclick = () => this.host.finish(p, `${target.info.name}: ${done.text}.`);
  }

  // --- Modifikatoren ----------------------------------------------------------

  /** Grundwert, Modifikatoren zum Anhaken (mit Hinweis), eigene Einträge (mit ×) und eine Zeile zum Hinzufügen; unten der nötige Wurf */
  private modsHtml(base: string, suggested: RollMod[], checked: string[], manual: RollMod[], need: string): string {
    const row = (m: RollMod, control: string) =>
      `<label class="atk-mod${m.value < 0 ? ' minus' : m.value > 0 ? ' plus' : ''}">${control}<span class="atk-label">${esc(m.label)}${m.hint ? ` <span class="atk-hint">${esc(m.hint)}</span>` : ''}</span><b>${signed(m.value)}</b></label>`;
    const values = [-3, -2, -1, 1, 2, 3].map((v) => `<option value="${v}" ${v === -1 ? 'selected' : ''}>${signed(v)}</option>`).join('');
    return `<div class="atk-mods">
      <div class="atk-base">${base}</div>
      ${suggested.map((m) => row(m, `<input type="checkbox" data-opt="${esc(m.label)}" ${checked.includes(m.label) ? 'checked' : ''}>`)).join('')}
      ${manual.map((m, i) => row(m, `<button class="atk-del" data-del="${i}" title="Remove">×</button>`)).join('')}
      <div class="atk-add"><input id="atk-mlabel" placeholder="Add modifier, e.g. Hatred"><select id="atk-mval">${values}</select><button data-add>Add</button></div>
      <div class="atk-need">Roll needed: <b>${esc(need)}</b></div>
    </div>`;
  }

  private wireMods(body: HTMLElement, checked: string[], manual: RollMod[], redraw: () => void): void {
    body.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((box) => {
      box.onchange = () => {
        const i = checked.indexOf(box.dataset.opt!);
        if (box.checked && i < 0) checked.push(box.dataset.opt!);
        if (!box.checked && i >= 0) checked.splice(i, 1);
        redraw();
      };
    });
    body.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.onclick = () => { manual.splice(Number(b.dataset.del), 1); redraw(); };
    });
    const label = body.querySelector<HTMLInputElement>('#atk-mlabel')!;
    const add = () => {
      const value = Number(body.querySelector<HTMLSelectElement>('#atk-mval')!.value);
      manual.push({ label: label.value.trim() || 'Modifier', value });
      redraw();
    };
    (body.querySelector('[data-add]') as HTMLButtonElement).onclick = add;
    label.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  }
}

interface SavesRolled {
  rows: { label: string; dice: number[]; need: number | null }[];
  unsaved: number;
  text: string;
}

