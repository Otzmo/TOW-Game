import { attackWeapon, type AttackWeapon } from '../model/attack';
import { slotPolygons } from '../model/contact';
import type { History } from '../model/history';
import { newObject, pointInPolygon } from '../model/objects';
import { playerName } from '../model/players';
import { isJoined, type Store } from '../model/store';
import { templateHitsByUnit } from '../model/templates';
import type { LogEntry, PlayerId, Point, UnitState, WarMachineShot } from '../model/types';
import { beyond, cannonShot, distanceToUnit, misfireResult, warMachineWeapons, type WarMachineWeapon } from '../model/warMachines';
import { artilleryDie, artilleryText, scatterDie, scatterHtml } from './dice';
import type { WoundLine } from './attackFlow';
import { openSheet } from './sheets';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const d6 = () => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * 6);
const inch = (n: number) => `${n.toFixed(1)}″`;
const artHtml = (v: number) => `<span class="die die-art ${v ? '' : 'misfire'}">${v ? v : 'Misfire'}</span>`;

/** Linien des Schusses im Maßband-Speicher (für beide sichtbar) */
const LINES = ['wm-aim', 'wm-shot', 'wm-bounce'] as const;

const MODE_NAMES: Record<WarMachineWeapon['mode'], string> = { cannon: 'Cannonball', bombard: 'Bombardment', grapeshot: 'Grapeshot' };

/** Regeln, die für die Treffer zählen (Cumbersome, Move or Shoot, Misfire-Tabelle … nicht) */
const hitRules = (w: WarMachineWeapon) =>
  w.profile.rules.filter((r) => !/cannon fire|bombardment|cumbersome|move or shoot|misfire table|needs more nails/i.test(r));

export interface WarMachineActions {
  pickPoint(hint: string, onPick: (p: Point) => void): void;
  pickUnit(hint: string, accept: (u: UnitState) => boolean, onPick: (unitId: string) => void): void;
  select(unitId: string): void;
  /** Feste Treffer an das Beschussfenster geben: weiter mit dem Verwundungswurf */
  startWounds(from: PlayerId, attackerId: string, targetId: string, lines: WoundLine[], note: string): void;
}

/**
 * Schießen mit Kriegsmaschinen (über „Shoot“: erst die Maschine, dann das Ziel). Die Schussart folgt aus dem
 * Waffenprofil: Kanone (Cannon Fire, Zielpunkt = Klickpunkt), Bombardment (3″- oder 5″-Schablone über der Mitte der
 * Zieleinheit), Grapeshot. Jeder Würfel wird einzeln per Knopf geworfen und bleibt für beide sichtbar; die Schablone
 * verschieben die Spieler selbst. Bei der Kanone werden die getroffenen Modelle auf dem Tisch markiert.
 */
export class WarMachinePanel {
  private shownShot = false;
  /** „Reroll – “ vor den Protokolleinträgen, während neu gewürfelt wird */
  private prefix = '';

  constructor(
    private store: Store,
    private history: History,
    private seat: () => PlayerId | 'spectator' | null,
    private log: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void,
    private actions: WarMachineActions,
  ) {
    $('wm-panel').onclick = (e) => this.onClick(e);
    store.subscribe((state, c) => {
      if (c.meta || c.unitId || c.loaded || c.replacedOwner || c.objectId) this.render();
      // Ein Schuss beginnt (auch beim Mitspieler): Fenster öffnen
      if (c.meta && state.meta.warMachine && !this.shownShot) openSheet('warmachine');
      this.shownShot = !!state.meta.warMachine;
    });
    this.render();
  }

  private mayAct(p: PlayerId): boolean {
    const s = this.seat();
    return s !== 'spectator' && (!s || s === p);
  }

  private get shot(): WarMachineShot | null {
    return this.store.state.meta.warMachine ?? null;
  }

  private patch(p: Partial<WarMachineShot>): void {
    const cur = this.shot;
    if (cur) this.store.setMeta({ warMachine: { ...cur, ...p } });
  }

  private weaponOf(shot: WarMachineShot): { unit: UnitState; weapon: WarMachineWeapon } | null {
    const unit = this.store.state.units[shot.unitId];
    const weapon = unit ? warMachineWeapons(unit)[shot.weapon] : undefined;
    return unit && weapon ? { unit, weapon } : null;
  }

  private setLine(id: (typeof LINES)[number], a: Point, b: Point): void {
    const measures = { ...this.store.state.meta.measures, [id]: { type: 'measure' as const, a, b, by: 'war-machine', ts: Date.now() } };
    this.store.setMeta({ measures });
  }

  private clearLines(): void {
    const measures = { ...this.store.state.meta.measures };
    for (const id of LINES) delete measures[id];
    this.store.setMeta({ measures });
  }

  private hint(text: string): void {
    const el = $('tool-hint');
    el.textContent = text;
    el.hidden = false;
    window.setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 4000);
  }

  // --- Ziel wählen ------------------------------------------------------------

  /** Shoot mit einer Kriegsmaschine: Ziel wählen lassen, je nach Waffe Punkt (Kanone) oder Einheit */
  aim(unitId: string): void {
    const unit = this.store.state.units[unitId];
    if (!unit || !this.mayAct(unit.owner)) return;
    const weapons = warMachineWeapons(unit);
    const cannon = weapons.findIndex((w) => w.mode === 'cannon');
    const grape = weapons.findIndex((w) => w.mode === 'grapeshot');
    if (cannon >= 0) {
      const w = weapons[cannon];
      this.actions.pickPoint(`${unit.info.name}: click the target point (within ${w.max}″)`, (p) => {
        const dist = Math.hypot(p.x - unit.x, p.y - unit.y);
        if (dist > w.max) {
          this.hint(`Out of range: ${inch(dist)} > ${w.max}″ – click again`);
          window.setTimeout(() => this.aim(unitId), 0);
          return;
        }
        const units = this.store.state.units;
        // Steht dort eine gegnerische Einheit in 12″, darf die Kanone stattdessen Grapeshot feuern
        const enemy = Object.values(units).find((t) => t.owner !== unit.owner && !isJoined(t, units) && !t.ambush
          && t.status !== 'destroyed' && t.status !== 'fledOff' && slotPolygons(t, units).some((s) => pointInPolygon(p, s.poly)));
        const grapeOk = grape >= 0 && enemy && distanceToUnit(unit, enemy, units) <= weapons[grape].max;
        this.begin({ unitId, weapon: cannon, step: grapeOk ? 'choose' : 'fire', target: p, targetUnit: grapeOk ? enemy!.id : null,
          lines: [`Target point ${inch(dist)} away${enemy ? ` (on ${enemy.info.name})` : ''}`] });
        this.setLine('wm-aim', { x: unit.x, y: unit.y }, p);
      });
      return;
    }
    const index = weapons.findIndex((w) => w.mode === 'bombard');
    const i = index >= 0 ? index : grape;
    const w = weapons[i];
    const range = w.min ? `${w.min}–${w.max}″` : `${w.max}″`;
    this.actions.pickUnit(`${unit.info.name}: click the enemy unit (${range})`, (t) => t.owner !== unit.owner, (id) => {
      const units = this.store.state.units;
      const t = units[id];
      const dist = distanceToUnit(unit, t, units);
      if (dist > w.max || dist < w.min) {
        this.hint(`${t.info.name} is ${inch(dist)} away – not within ${range}, click again`);
        window.setTimeout(() => this.aim(unitId), 0);
        return;
      }
      this.begin({ unitId, weapon: i, step: 'fire', targetUnit: id, lines: [`Target: ${t.info.name} (${inch(dist)})`] });
      this.setLine('wm-aim', { x: unit.x, y: unit.y }, { x: t.x, y: t.y });
      if (w.mode === 'bombard') this.placeTemplate();
    });
  }

  private begin(shot: WarMachineShot): void {
    this.history.record();
    this.clearLines();
    this.store.setMeta({ warMachine: { dice: {}, hitPolys: null, template: null, ...shot } });
    openSheet('warmachine');
  }

  /** Bombardment: Schablone mit dem Mittelloch über die Mitte der Zieleinheit legen */
  private placeTemplate(): void {
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    const t = shot?.targetUnit ? this.store.state.units[shot.targetUnit] : undefined;
    if (!shot || !w || !t) return;
    const o = newObject(w.weapon.template === 5 ? 'largeBlast' : 'smallBlast', { x: t.x, y: t.y });
    this.store.setObject(o);
    this.patch({ template: o.id, lines: [...(shot.lines ?? []), `${w.weapon.template}″ blast template placed over the centre of ${t.info.name}`] });
  }

  // --- Würfeln ----------------------------------------------------------------

  private onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-wm]');
    if (!btn) return;
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    const act = btn.dataset.wm!;
    if (act === 'select') {
      this.actions.select(btn.dataset.unit!);
      return;
    }
    if (!shot || !w) return;
    if (act === 'partial' || act === 're-partial') {
      // Teilweise bedeckte Modelle: der Gegner würfelt
      const target = this.store.state.units[btn.dataset.unit!];
      if (!target || !this.mayAct(target.owner)) return;
      this.history.record();
      this.rollPartial(shot, target, act === 're-partial');
      return;
    }
    if (!this.mayAct(w.unit.owner)) return;
    this.history.record();
    if (act === 'close' || act === 'retarget') {
      this.clearLines();
      // Die Bombardment-Schablone verschwindet mit dem Schuss
      if (shot.template && this.store.state.objects[shot.template]) this.store.removeObject(shot.template);
      this.store.setMeta({ warMachine: null });
      if (act === 'retarget') this.aim(w.unit.id);
    } else if (act.startsWith('re-')) this.reroll(act.slice(3), w.unit, w.weapon); else if (act === 'choose-cannon') this.patch({ step: 'fire', targetUnit: null });
    else if (act === 'choose-grape') {
      const i = warMachineWeapons(w.unit).findIndex((x) => x.mode === 'grapeshot');
      const t = this.store.state.units[shot.targetUnit ?? ''];
      this.patch({ step: 'fire', weapon: i, lines: [`Grapeshot at ${t?.info.name ?? 'the target'}`] });
    } else if (act === 'first') this.rollFirst(shot, w.unit, w.weapon);
    else if (act === 'bounce') this.rollBounce(shot, w.unit, w.weapon);
    else if (act === 'scatter') this.rollScatter(shot, w.unit, w.weapon);
    else if (act === 'misfire') this.rollMisfire(shot, w.unit, w.weapon);
    else if (act === 'move-template') this.moveTemplate(shot);
    else if (act === 'wound') this.sendWounds(shot, w.unit, w.weapon, btn.dataset.unit!);
  }

  /** Abweichung auf die Schablone anwenden (nur auf Knopfdruck; von Hand verschieben geht weiterhin) */
  private moveTemplate(shot: WarMachineShot): void {
    const o = shot.template ? this.store.state.objects[shot.template] : undefined;
    const art = shot.dice?.first;
    const s = shot.dice?.scatter;
    if (!o || !art || !s || s.hit || shot.moved) return;
    const a = (s.angle * Math.PI) / 180;
    this.store.updateObject(o.id, { x: o.x + Math.sin(a) * art, y: o.y - Math.cos(a) * art });
    // Die Treffer zählen neu: bisherige 4+-Würfe gelten nicht mehr
    this.patch({ moved: true, partial: null });
  }

  /** W6 je teilweise bedecktem Modell, getroffen bei 4+ */
  private rollPartial(shot: WarMachineShot, target: UnitState, again: boolean): void {
    const o = shot.template ? this.store.state.objects[shot.template] : undefined;
    const e = o && templateHitsByUnit(o, this.store.state.units).find((x) => x.unit.id === target.id);
    if (!e?.partial || (!again && shot.partial?.[target.id]?.length === e.partial)) return;
    const dice = Array.from({ length: e.partial }, d6);
    const hit = dice.filter((d) => d >= 4).length;
    this.log({ kind: 'roll', dice: [dice], text: `${again ? 'Reroll – ' : ''}${target.info.name}: ${e.partial} partially covered model${e.partial === 1 ? '' : 's'} – ${hit} hit on 4+` });
    this.patch({ partial: { ...shot.partial, [target.id]: dice } });
  }

  /** Treffer je Einheit: Kanone/Grapeshot fest, Bombardment nach der Schablone (wo sie jetzt liegt) */
  private targetsOf(shot: WarMachineShot, w: WarMachineWeapon):
    { unit: UnitState; hits: number; centre: boolean; partial: number; rolled: number[] | null }[] {
    const units = this.store.state.units;
    if (w.mode !== 'bombard') {
      return (shot.targets ?? []).filter((x) => units[x.unitId])
        .map((x) => ({ unit: units[x.unitId], hits: x.hits, centre: false, partial: 0, rolled: null }));
    }
    const o = shot.template ? this.store.state.objects[shot.template] : undefined;
    if (!o) return [];
    return templateHitsByUnit(o, units).map((e) => {
      const rolled = shot.partial?.[e.unit.id];
      return { unit: e.unit, hits: e.full, centre: e.centre, partial: e.partial, rolled: rolled && rolled.length === e.partial ? rolled : null };
    });
  }

  /** Weiter im Beschussfenster: Verwundungswurf mit den festen Treffern, danach Rettungswürfe des Gegners */
  private sendWounds(shot: WarMachineShot, unit: UnitState, w: WarMachineWeapon, targetId: string): void {
    const t = this.targetsOf(shot, w).find((x) => x.unit.id === targetId);
    if (!t || shot.sent?.includes(targetId)) return;
    const base = attackWeapon(w.profile, unit);
    const line = (label: string, weapon: AttackWeapon, hits: number): WoundLine =>
      ({ label, weapon, hits, poisoned: 0, strength: weapon.strength });
    const lines: WoundLine[] = [];
    let note: string;
    if (w.mode === 'bombard') {
      const [s, sHole] = split(w.profile.strength);
      const [ap, apHole] = split(w.profile.ap);
      const others = t.hits + (t.rolled ?? []).filter((d) => d >= 4).length;
      // Multiple Wounds gilt nur für das Modell unter dem Mittelloch
      const plain = w.profile.rules.filter((r) => !/multiple wounds/i.test(r));
      if (t.centre) {
        lines.push(line('Under the central hole', { ...base, name: `${w.name} (central hole)`, strength: num(sHole, base.strength),
          ap: num(apHole, 0), raw: `S ${sHole} · AP ${apHole}` }, 1));
      }
      lines.push(line('Under the template', { ...base, strength: num(s, base.strength), ap: num(ap, 0), rules: plain, raw: `S ${s} · AP ${ap}` }, others));
      note = `${w.name}: ${t.centre ? '1 model under the central hole' : 'no model under the central hole'}, ${others} other model${others === 1 ? '' : 's'} under the template`
        + (t.partial ? ` (${t.hits} fully covered, ${others - t.hits} of ${t.partial} partially covered hit on 4+)` : '');
    } else {
      lines.push(line(w.mode === 'cannon' ? 'Hit by the cannonball' : 'Grapeshot', base, t.hits));
      note = `${w.name}: ${t.hits} automatic hit${t.hits === 1 ? '' : 's'}${w.mode === 'cannon' ? ' (Cannon Fire)' : ''}`;
    }
    const seat = this.seat();
    this.actions.startWounds(seat && seat !== 'spectator' ? seat : unit.owner, unit.id, targetId, lines, note);
    this.patch({ sent: [...(shot.sent ?? []), targetId] });
  }

  /** Erster Artilleriewürfel: Aufschlagpunkt (Kanone), Treffer (Grapeshot) oder Abweichung (Bombardment) */
  private rollFirst(shot: WarMachineShot, unit: UnitState, w: WarMachineWeapon): void {
    if (shot.dice?.first != null) return;
    const v = artilleryDie();
    const dice = { ...shot.dice, first: v };
    const name = unit.info.name;
    if (w.mode === 'cannon') {
      this.log({ kind: 'roll', dice: [[v]], text: `${this.prefix}${name} – Artillery dice for the strike point: ${artilleryText(v)}` });
      if (v && shot.target) this.setLine('wm-shot', shot.target, beyond({ x: unit.x, y: unit.y }, shot.target, v));
      this.patch({ dice });
    } else if (w.mode === 'grapeshot') {
      const t = this.store.state.units[shot.targetUnit ?? ''];
      this.log({ kind: 'roll', dice: [[v]], text: `${this.prefix}${name} fires grapeshot: ${v ? `${v} hits on ${t?.info.name ?? 'the target'}` : 'Misfire!'}` });
      this.patch({ dice, ...(v ? { step: 'done' as const, targets: t ? [{ unitId: t.id, hits: v }] : [], result: [`${v} automatic hits on ${t?.info.name ?? 'the target'} – S ${w.profile.strength}, AP ${w.profile.ap}${hitRules(w).length ? ` · ${hitRules(w).join(', ')}` : ''}`] } : {}) });
    } else {
      this.log({ kind: 'roll', dice: [[v]], text: `${this.prefix}${name} – Artillery dice: ${artilleryText(v)}` });
      this.patch({ dice });
      this.bombardResult();
    }
  }

  private rollScatter(shot: WarMachineShot, unit: UnitState, w: WarMachineWeapon): void {
    if (shot.dice?.scatter || w.mode !== 'bombard') return;
    const s = scatterDie();
    this.log({ kind: 'roll', text: `${this.prefix}${unit.info.name} – Scatter dice: ${s.hit ? 'HIT' : `arrow ${s.angle}°`}` });
    this.patch({ dice: { ...shot.dice, scatter: s } });
    this.bombardResult();
  }

  /** Beide Würfel des Bombardments liegen: Ergebnis (die Schablone verschieben die Spieler selbst) */
  private bombardResult(): void {
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    const art = shot?.dice?.first;
    const s = shot?.dice?.scatter;
    if (!shot || !w || art == null || art === 0 || !s) return;
    const o = shot.template ? this.store.state.objects[shot.template] : undefined;
    const lines: string[] = [];
    if (s.hit) lines.push('Hit! The template stays where it is.');
    else {
      lines.push(`The template scatters ${art}″ in the direction of the arrow – move it with the button or by hand.`);
      if (o) {
        const a = (s.angle * Math.PI) / 180;
        this.store.setMeta({ scatterFx: { from: { x: o.x, y: o.y }, to: { x: o.x + Math.sin(a) * art, y: o.y - Math.cos(a) * art }, r: o.w / 2, hit: false, ts: Date.now() } });
      }
    }
    const [str, strHole] = split(w.weapon.profile.strength);
    const [ap, apHole] = split(w.weapon.profile.ap);
    const rules = hitRules(w.weapon);
    lines.push(`The model under the central hole: S ${strHole}, AP ${apHole}${rules.length ? ` (${rules.join(', ')})` : ''} · every other model under the template: S ${str}, AP ${ap}`);
    this.patch({ step: 'done', result: lines });
  }

  private rollBounce(shot: WarMachineShot, unit: UnitState, w: WarMachineWeapon): void {
    const first = shot.dice?.first;
    if (w.mode !== 'cannon' || !shot.target || !first || shot.dice?.bounce != null) return;
    const v = artilleryDie();
    const units = this.store.state.units;
    const from = { x: unit.x, y: unit.y };
    const strike = beyond(from, shot.target, first);
    const end = v ? beyond(from, strike, v) : strike;
    const r = cannonShot(from, strike, end, units, this.store.state.objects, unit.id);
    if (v) this.setLine('wm-bounce', strike, r.end);
    const lines: string[] = [];
    const rules = hitRules(w);
    if (!r.hits.length) lines.push('No models hit.');
    for (const h of r.hits) {
      const chars = h.models.filter((m) => m.character).map((m) => m.character!);
      const troops = h.models.length - chars.length;
      const parts = [troops ? `${troops} model${troops === 1 ? '' : 's'}` : '', ...chars];
      lines.push(`${h.unit.info.name} (${playerName(h.unit.owner)}): ${parts.filter(Boolean).join(' + ')} hit`);
    }
    if (r.hits.length) lines.push(`Each hit: S ${w.profile.strength}, AP ${w.profile.ap}${rules.length ? ` · ${rules.join(', ')}` : ''}`);
    if (r.stop) lines.push(`The cannonball is stopped by ${r.stop}.`);
    this.log({ kind: 'roll', dice: [[v]], text: `${this.prefix}${unit.info.name} – Artillery dice for the bounce: ${artilleryText(v)}${r.hits.length ? ` – hits ${r.hits.map((h) => `${h.unit.info.name} ×${h.models.length}`).join(', ')}` : ' – no models hit'}` });
    const targets: { unitId: string; hits: number }[] = [];
    for (const h of r.hits) {
      const troops = h.models.filter((m) => !m.characterId).length;
      if (troops) targets.push({ unitId: h.unit.id, hits: troops });
      for (const m of h.models.filter((x) => x.characterId)) targets.push({ unitId: m.characterId!, hits: 1 });
    }
    this.patch({ dice: { ...shot.dice, bounce: v }, step: 'done', result: lines, targets, hitPolys: r.hits.flatMap((h) => h.models.map((m) => m.poly)) });
  }

  /**
   * Einen Würfel neu werfen: das alte Ergebnis wird ersetzt, alles, was davon abhängt, neu bestimmt
   * (neuer Aufschlagpunkt → Abprall noch einmal würfeln).
   */
  private reroll(which: string, unit: UnitState, w: WarMachineWeapon): void {
    const shot = this.shot;
    if (!shot) return;
    const dice = { ...shot.dice };
    if (which === 'first') Object.assign(dice, { first: null, bounce: null, misfire: null });
    else if (which === 'bounce') dice.bounce = null;
    else if (which === 'scatter') dice.scatter = null;
    else if (which === 'misfire') dice.misfire = null;
    else return;
    const measures = { ...this.store.state.meta.measures };
    if (which === 'first') delete measures['wm-shot'];
    if (which === 'first' || which === 'bounce') delete measures['wm-bounce'];
    this.store.setMeta({ measures, scatterFx: null });
    this.patch({ dice, step: 'fire', result: null, hitPolys: null, targets: null, partial: null, sent: null, moved: false });
    this.prefix = 'Reroll – ';
    try {
      const fresh = this.shot!;
      if (which === 'first') this.rollFirst(fresh, unit, w);
      else if (which === 'bounce') this.rollBounce(fresh, unit, w);
      else if (which === 'scatter') this.rollScatter(fresh, unit, w);
      else this.rollMisfire(fresh, unit, w);
    } finally {
      this.prefix = '';
    }
  }

  private rollMisfire(shot: WarMachineShot, unit: UnitState, w: WarMachineWeapon): void {
    if (shot.dice?.first !== 0 || shot.dice.misfire != null) return;
    const v = d6();
    const text = misfireResult(w.misfire, v);
    const table = w.misfire === 'stone-thrower' ? 'Stone Thrower' : 'Black Powder';
    this.log({ kind: 'roll', dice: [[v]], text: `${this.prefix}${unit.info.name} misfires – ${table} Misfire table ${v}: ${text}` });
    this.patch({ dice: { ...shot.dice, misfire: v }, step: 'done', result: [`${table} Misfire table: ${text}`] });
  }

  // --- Anzeige ----------------------------------------------------------------

  private render(): void {
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    if (!shot || !w) {
      $('wm-panel').innerHTML = '<p class="meta">Use 🏹 Shoot: click your war machine, then the target. Cannons aim at the point you click; mortars and stone throwers at an enemy unit.</p>';
      return;
    }
    const { unit, weapon } = w;
    const may = this.mayAct(unit.owner);
    const dis = may ? '' : 'disabled';
    const dice = shot.dice ?? {};
    const range = weapon.min ? `${weapon.min}–${weapon.max}″` : `${weapon.max}″`;
    /** Zeile mit Würfel: Ergebnis oder Knopf zum Würfeln */
    const row = (label: string, value: string | null, act: string, button: string) =>
      `<div class="dice-step"><span class="label">${label}</span>${value !== null
        ? `${value} <button data-wm="re-${act}" title="Roll this die again" ${dis}>↻ Reroll</button>`
        : `<button data-wm="${act}" class="primary" ${dis}>🎲 ${button}</button>`}</div>`;
    const rows: string[] = [];
    if (shot.step === 'choose') {
      rows.push(`<p>The target is within 12″: fire a cannonball or grapeshot?</p>
        <div class="row-btns"><button data-wm="choose-cannon" class="primary" ${dis}>Cannonball</button><button data-wm="choose-grape" ${dis}>Grapeshot</button></div>`);
    } else if (weapon.mode === 'cannon') {
      rows.push(row('Strike point (Artillery dice)', dice.first != null ? artHtml(dice.first) : null, 'first', 'Roll'));
      if (dice.first) {
        rows.push(`<p class="prompt-info">Strike point ${dice.first}″ beyond the target point, directly away from the cannon</p>`);
        rows.push(row('Bounce (Artillery dice)', dice.bounce != null ? artHtml(dice.bounce) : null, 'bounce', 'Roll'));
        if (dice.bounce === 0) rows.push('<p class="prompt-info">Misfire on the bounce: the cannonball buries itself in the ground – only models under the strike point are hit.</p>');
        else if (dice.bounce) rows.push(`<p class="prompt-info">The cannonball bounces ${dice.bounce}″ further</p>`);
      }
    } else if (weapon.mode === 'grapeshot') {
      rows.push(row('Hits (Artillery dice)', dice.first != null ? artHtml(dice.first) : null, 'first', 'Roll'));
    } else {
      rows.push(row('Artillery dice', dice.first != null ? artHtml(dice.first) : null, 'first', 'Roll'));
      rows.push(dice.first === 0 && !dice.scatter ? '<div class="dice-step"><span class="label">Scatter dice</span><span class="meta">–</span></div>'
        : row('Scatter dice', dice.scatter ? scatterHtml(dice.scatter) : null, 'scatter', 'Roll'));
    }
    if (dice.first === 0) {
      rows.push(`<p class="warn"><b>Misfire!</b> Roll on the ${weapon.misfire === 'stone-thrower' ? 'Stone Thrower' : 'Black Powder'} Misfire table.</p>`);
      rows.push(row('Misfire table (D6)', dice.misfire != null ? `<span class="die">${dice.misfire}</span>` : null, 'misfire', 'Roll'));
    }
    // Abweichung anwenden (nur auf Knopfdruck)
    if (weapon.mode === 'bombard' && shot.step === 'done' && dice.first && dice.scatter && !dice.scatter.hit && !shot.moved) {
      rows.push(`<div class="row-btns"><button data-wm="move-template" ${dis}>Move the template ${dice.first}″ <span class="scatter-arrow" style="transform: rotate(${dice.scatter.angle}deg)">↑</span></button></div>`);
    }
    const wounds = shot.step === 'done' && dice.first !== 0 ? this.woundsHtml(shot, weapon, dis) : '';
    $('wm-panel').innerHTML = `<p><span class="dot ${unit.owner}"></span><b>${esc(unit.info.name)}</b> · ${esc(MODE_NAMES[weapon.mode])} (${esc(weapon.name)}, ${range})</p>
      ${(shot.lines ?? []).map((l) => `<p class="${/misfire/i.test(l) ? 'warn' : 'prompt-info'}">${esc(l)}</p>`).join('')}
      ${rows.join('')}
      ${(shot.result ?? []).map((l) => `<p class="${/misfire/i.test(l) ? 'warn' : 'prompt-info'}">${esc(l)}</p>`).join('')}
      ${wounds}
      <div class="row-btns">${shot.step !== 'done' ? `<button data-wm="retarget" ${dis}>⌖ New target</button>` : ''}
        <button data-wm="close" ${dis}>${shot.step === 'done' ? 'Done – remove lines and marks' : 'Cancel'}</button></div>
      <p class="meta">Lost models are removed automatically after the saves${weapon.mode === 'bombard' ? ' · the template is removed with Done' : ''}.</p>`;
  }

  /** Treffer je Einheit mit den 4+-Würfen des Gegners und dem Knopf zum Verwundungswurf */
  private woundsHtml(shot: WarMachineShot, w: WarMachineWeapon, dis: string): string {
    const list = this.targetsOf(shot, w).filter((x) => x.hits || x.centre || x.partial);
    if (!list.length) return w.mode === 'bombard' ? '<p class="prompt-info">No models under the template.</p>' : '';
    return `<h4>Hits</h4>${list.map((x) => {
      const sent = shot.sent?.includes(x.unit.id);
      const parts = [x.centre ? '1 under the central hole' : '',
        x.hits ? `${x.hits} ${w.mode === 'bombard' ? 'fully covered' : `hit${x.hits === 1 ? '' : 's'}`}` : '',
        x.partial ? `${x.partial} partially covered` : ''].filter(Boolean).join(' · ');
      const mayRoll = this.mayAct(x.unit.owner) ? '' : 'disabled';
      const partial = !x.partial ? '' : `<div class="dice-step"><span class="label">${esc(playerName(x.unit.owner))}: ${x.partial} D6, hit on 4+</span>${x.rolled
        ? `<span class="dice-inline">${x.rolled.map((d) => `<span class="die ${d >= 4 ? 'ok' : ''}">${d}</span>`).join('')}</span> <button data-wm="re-partial" data-unit="${x.unit.id}" title="Roll these dice again" ${mayRoll}>↻ Reroll</button>`
        : `<button data-wm="partial" data-unit="${x.unit.id}" class="primary" ${mayRoll}>🎲 Roll</button>`}</div>`;
      const ready = !x.partial || !!x.rolled;
      return `<p class="prompt-info"><span class="dot ${x.unit.owner}"></span><b>${esc(x.unit.info.name)}</b>: ${parts}</p>${partial}
        <div class="row-btns">${sent ? '<span class="ok">✓ Roll To Wound started</span>'
          : `<button data-wm="wound" data-unit="${x.unit.id}" class="primary" ${ready ? dis : 'disabled'}>Roll To Wound ›</button>`}</div>`;
    }).join('')}`;
  }
}

/** Zahl aus einem Profilwert ("−3", "6"); sonst fallback */
function num(v: string, fallback: number): number {
  const n = Number.parseInt(v.replace('−', '-'), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** "2(6)" → ["2", "6"]; ohne Klammer gilt der Wert für beide */
function split(v: string): [string, string] {
  const m = /^([^()]*)\(([^)]*)\)/.exec(v);
  return m ? [m[1].trim() || '–', m[2].trim()] : [v, v];
}
