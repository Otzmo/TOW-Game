import { slotPolygons } from '../model/contact';
import type { History } from '../model/history';
import { newObject, pointInPolygon } from '../model/objects';
import { playerName } from '../model/players';
import { isJoined, type Store } from '../model/store';
import type { LogEntry, PlayerId, Point, UnitState, WarMachineShot } from '../model/types';
import { beyond, cannonShot, distanceToUnit, misfireResult, warMachineWeapons, type WarMachineWeapon } from '../model/warMachines';
import { artilleryDie, artilleryText, scatterDie, scatterHtml } from './dice';
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
    if (!shot || !w || !this.mayAct(w.unit.owner)) return;
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
      this.patch({ dice, ...(v ? { step: 'done' as const, result: [`${v} automatic hits on ${t?.info.name ?? 'the target'} – S ${w.profile.strength}, AP ${w.profile.ap}${hitRules(w).length ? ` · ${hitRules(w).join(', ')}` : ''}`] } : {}) });
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
      lines.push(`The template scatters ${art}″ in the direction of the arrow – move it by hand.`);
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
    this.patch({ dice: { ...shot.dice, bounce: v }, step: 'done', result: lines, hitPolys: r.hits.flatMap((h) => h.models.map((m) => m.poly)) });
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
    this.patch({ dice, step: 'fire', result: null, hitPolys: null });
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
      `<div class="row"><span class="label">${label}</span>${value !== null
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
      rows.push(dice.first === 0 && !dice.scatter ? '<div class="row"><span class="label">Scatter dice</span><span class="meta">–</span></div>'
        : row('Scatter dice', dice.scatter ? scatterHtml(dice.scatter) : null, 'scatter', 'Roll'));
    }
    if (dice.first === 0) {
      rows.push(`<p class="warn"><b>Misfire!</b> Roll on the ${weapon.misfire === 'stone-thrower' ? 'Stone Thrower' : 'Black Powder'} Misfire table.</p>`);
      rows.push(row('Misfire table (D6)', dice.misfire != null ? `<span class="die">${dice.misfire}</span>` : null, 'misfire', 'Roll'));
    }
    $('wm-panel').innerHTML = `<p><span class="dot ${unit.owner}"></span><b>${esc(unit.info.name)}</b> · ${esc(MODE_NAMES[weapon.mode])} (${esc(weapon.name)}, ${range})</p>
      ${(shot.lines ?? []).map((l) => `<p class="${/misfire/i.test(l) ? 'warn' : 'prompt-info'}">${esc(l)}</p>`).join('')}
      ${rows.join('')}
      ${(shot.result ?? []).map((l) => `<p class="${/misfire/i.test(l) ? 'warn' : 'prompt-info'}">${esc(l)}</p>`).join('')}
      <div class="row-btns">${shot.step !== 'done' ? `<button data-wm="retarget" ${dis}>⌖ New target</button>` : ''}
        <button data-wm="close" ${dis}>${shot.step === 'done' ? 'Done – remove lines and marks' : 'Cancel'}</button></div>
      <p class="meta">Remove casualties by hand${weapon.mode === 'bombard' ? ' · the template is removed with Done' : ''}.</p>`;
  }
}

/** "2(6)" → ["2", "6"]; ohne Klammer gilt der Wert für beide */
function split(v: string): [string, string] {
  const m = /^([^()]*)\(([^)]*)\)/.exec(v);
  return m ? [m[1].trim() || '–', m[2].trim()] : [v, v];
}
