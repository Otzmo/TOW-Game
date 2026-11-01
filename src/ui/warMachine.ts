import type { History } from '../model/history';
import { newObject } from '../model/objects';
import { playerName } from '../model/players';
import { isJoined, type Store } from '../model/store';
import type { LogEntry, PlayerId, Point, UnitState, WarMachineShot } from '../model/types';
import { beyond, cannonPath, distanceToUnit, misfireResult, warMachineWeapons, type WarMachineWeapon } from '../model/warMachines';
import { artilleryDie, artilleryText, scatterDie } from './dice';
import { openSheet } from './sheets';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const d6 = () => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * 6);
const inch = (n: number) => `${n.toFixed(1)}″`;

/** Linien des Schusses im Maßband-Speicher (für beide sichtbar) */
const LINES = ['wm-aim', 'wm-shot', 'wm-bounce'] as const;

const MODE_NAMES: Record<WarMachineWeapon['mode'], string> = { cannon: 'Fire cannonball', bombard: 'Bombard', grapeshot: 'Fire grapeshot' };

export interface WarMachineActions {
  pickPoint(hint: string, onPick: (p: Point) => void): void;
  pickUnit(hint: string, accept: (u: UnitState) => boolean, onPick: (unitId: string) => void): void;
  select(unitId: string): void;
}

/**
 * Fenster „War machines“ (Knopf links): Kanonen (Cannon Fire), Mörser und Steinschleudern (Bombardment) und
 * Grapeshot Schritt für Schritt – Ziel wählen, Artillerie- und Abweichungswürfel, Misfire-Tabelle. Linien und
 * Schablone stehen für beide auf dem Tisch; welche Modelle fallen, entscheiden die Spieler.
 */
export class WarMachinePanel {
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
      // Der Mitspieler beginnt einen Schuss: Fenster auch hier öffnen
      if (c.meta && c.origin === 'remote' && state.meta.warMachine && !this.shownShot) openSheet('warmachine');
      this.shownShot = !!state.meta.warMachine;
    });
    this.render();
  }

  private shownShot = false;

  private mayAct(p: PlayerId): boolean {
    const s = this.seat();
    return s !== 'spectator' && (!s || s === p);
  }

  private get shot(): WarMachineShot | null {
    return this.store.state.meta.warMachine ?? null;
  }

  private setShot(patch: Partial<WarMachineShot> | null): void {
    const cur = this.shot;
    this.store.setMeta({ warMachine: patch && cur ? { ...cur, ...patch } : (patch as WarMachineShot | null) });
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

  private onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-wm]');
    if (!btn) return;
    const act = btn.dataset.wm!;
    if (act === 'select') this.actions.select(btn.dataset.unit!);
    else if (act === 'start') this.start(btn.dataset.unit!, Number(btn.dataset.weapon));
    else if (act === 'aim') this.aim();
    else if (act === 'fire') this.fire();
    else if (act === 'move-template') this.moveTemplate();
    else if (act === 'finish' || act === 'cancel') {
      this.history.record();
      this.clearLines();
      this.setShot(null);
    }
  }

  private start(unitId: string, weapon: number): void {
    const u = this.store.state.units[unitId];
    if (!u || !this.mayAct(u.owner)) return;
    this.history.record();
    this.clearLines();
    this.setShot({ unitId, weapon, step: 'aim', lines: [] });
    this.aim();
  }

  /** Ziel wählen: Kanone einen Punkt, sonst eine gegnerische Einheit in Reichweite */
  private aim(): void {
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    if (!shot || !w) return;
    const { unit, weapon } = w;
    const range = weapon.min ? `${weapon.min}–${weapon.max}″` : `${weapon.max}″`;
    if (weapon.mode === 'cannon') {
      this.actions.pickPoint(`${unit.info.name}: click the target point (within ${range})`, (p) => {
        const dist = Math.hypot(p.x - unit.x, p.y - unit.y);
        if (dist > weapon.max) {
          this.setShot({ lines: [`Target point out of range (${inch(dist)} > ${weapon.max}″) – choose again`] });
          this.aim();
          return;
        }
        this.history.record();
        this.setLine('wm-aim', { x: unit.x, y: unit.y }, p);
        this.setShot({ step: 'fire', target: p, lines: [`Target point marked ${inch(dist)} away`] });
      });
      return;
    }
    this.actions.pickUnit(`${unit.info.name}: click the enemy unit (${range})`, (t) => t.owner !== unit.owner, (id) => {
      const units = this.store.state.units;
      const t = units[id];
      const dist = distanceToUnit(unit, t, units);
      if (dist > weapon.max || dist < weapon.min) {
        this.setShot({ lines: [`${t.info.name} is ${inch(dist)} away – not within ${range}, choose again`] });
        this.aim();
        return;
      }
      this.history.record();
      this.setLine('wm-aim', { x: unit.x, y: unit.y }, { x: t.x, y: t.y });
      let template: string | null = null;
      if (weapon.mode === 'bombard') {
        // Schablone mit dem Mittelloch über die Mitte der Zieleinheit
        const o = newObject(weapon.template === 5 ? 'largeBlast' : 'smallBlast', { x: t.x, y: t.y });
        this.store.setObject(o);
        template = o.id;
      }
      this.setShot({ step: 'fire', targetUnit: id, template, lines: [`Target: ${t.info.name} (${inch(dist)})`] });
    });
  }

  private misfire(w: WarMachineWeapon, unit: UnitState, lines: string[]): void {
    const roll = d6();
    const text = misfireResult(w.misfire, roll);
    const table = w.misfire === 'stone-thrower' ? 'Stone Thrower' : 'Black Powder';
    lines.push(`Misfire! ${table} Misfire table: ${roll} – ${text}`);
    this.log({ kind: 'roll', dice: [[roll]], text: `${unit.info.name} misfires – ${table} Misfire table ${roll}: ${text}` });
  }

  private fire(): void {
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    if (!shot || !w || shot.step !== 'fire' || !this.mayAct(w.unit.owner)) return;
    const { unit, weapon } = w;
    const units = this.store.state.units;
    this.history.record();
    const lines = [...(shot.lines ?? [])];
    let scatter: WarMachineShot['scatter'] = null;

    if (weapon.mode === 'cannon' && shot.target) {
      const from = { x: unit.x, y: unit.y };
      const first = artilleryDie();
      if (!first) {
        lines.push('Artillery dice: Misfire!');
        this.misfire(weapon, unit, lines);
      } else {
        const strike = beyond(from, shot.target, first);
        const second = artilleryDie();
        const bounce = second;
        const end = bounce ? beyond(from, strike, bounce) : strike;
        this.setLine('wm-shot', shot.target, strike);
        if (bounce) this.setLine('wm-bounce', strike, end);
        lines.push(`Strike point ${first}″ beyond the target point`);
        lines.push(bounce ? `Bounce: ${bounce}″ further, directly away from the cannon` : 'Bounce: Misfire – the cannonball buries itself in the ground');
        const hit = cannonPath(strike, end, units, unit.id);
        lines.push(hit.length
          ? `Under the path: ${hit.map((h) => `${h.unit.info.name} (${playerName(h.unit.owner)}, ${h.bases} base${h.bases === 1 ? '' : 's'})`).join(', ')}`
          : 'No models under the strike point or the bounce');
        lines.push(`Each model hit: S ${weapon.profile.strength}, AP ${weapon.profile.ap}${weapon.profile.rules.length ? ` · ${weapon.profile.rules.join(', ')}` : ''}. A formed unit loses at most one model per rank (front/rear arc) or per file (flank arc); monsters, hills and impassable terrain stop the ball.`);
        this.log({ kind: 'roll', dice: [[first, second]], text: `${unit.info.name} fires: strike point +${first}″, bounce ${artilleryText(second)}${hit.length ? ` – hits ${hit.map((h) => h.unit.info.name).join(', ')}` : ''}` });
      }
    } else if (weapon.mode === 'grapeshot') {
      const t = units[shot.targetUnit ?? ''];
      const roll = artilleryDie();
      if (!roll) {
        lines.push('Artillery dice: Misfire!');
        this.misfire(weapon, unit, lines);
      } else {
        lines.push(`${roll} automatic hits on ${t?.info.name ?? 'the target'} – S ${weapon.profile.strength}, AP ${weapon.profile.ap}`);
        this.log({ kind: 'roll', dice: [[roll]], text: `${unit.info.name} fires grapeshot: ${roll} hits on ${t?.info.name ?? 'the target'}` });
      }
    } else if (weapon.mode === 'bombard') {
      const art = artilleryDie();
      const dir = scatterDie();
      const parts = `artillery ${artilleryText(art)}, scatter ${dir.hit ? 'HIT' : `arrow ${dir.angle}°`}`;
      if (!art) {
        lines.push(`Misfire! (${parts})`);
        this.misfire(weapon, unit, lines);
      } else if (dir.hit) {
        lines.push(`Hit! The template stays on target (${parts})`);
        this.log({ kind: 'roll', dice: [[art]], text: `${unit.info.name} bombards: direct hit (${parts})` });
      } else {
        scatter = { angle: dir.angle, dist: art };
        lines.push(`The template scatters ${art}″ (${parts})`);
        this.log({ kind: 'roll', dice: [[art]], text: `${unit.info.name} bombards: scatters ${art}″ (${parts})` });
        const o = shot.template ? this.store.state.objects[shot.template] : undefined;
        if (o) {
          const a = (dir.angle * Math.PI) / 180;
          this.store.setMeta({ scatterFx: { from: { x: o.x, y: o.y }, to: { x: o.x + Math.sin(a) * art, y: o.y - Math.cos(a) * art }, r: o.w / 2, hit: false, ts: Date.now() } });
        }
      }
      if (art) {
        const [s, sHole] = this.split(weapon.profile.strength);
        const [ap, apHole] = this.split(weapon.profile.ap);
        lines.push(`The model under the central hole: S ${sHole}, AP ${apHole}${weapon.profile.rules.some((r) => /multiple wounds/i.test(r)) ? ` (${weapon.profile.rules.find((r) => /multiple wounds/i.test(r))})` : ''} · all other models under the template: S ${s}, AP ${ap}`);
      }
    }
    this.setShot({ step: 'done', lines, scatter });
  }

  /** "2(6)" → ["2", "6"]; ohne Klammer gilt der Wert für beide */
  private split(v: string): [string, string] {
    const m = /^([^()]*)\(([^)]*)\)/.exec(v);
    return m ? [m[1].trim() || '–', m[2].trim()] : [v, v];
  }

  /** Abweichung auf die Schablone anwenden (man kann sie auch von Hand verschieben) */
  private moveTemplate(): void {
    const shot = this.shot;
    const o = shot?.template ? this.store.state.objects[shot.template] : undefined;
    if (!shot?.scatter || !o) return;
    this.history.record();
    const a = (shot.scatter.angle * Math.PI) / 180;
    this.store.updateObject(o.id, { x: o.x + Math.sin(a) * shot.scatter.dist, y: o.y - Math.cos(a) * shot.scatter.dist });
    this.setShot({ scatter: null, lines: [...(shot.lines ?? []), `Template moved ${shot.scatter.dist}″`] });
  }

  private render(): void {
    const units = this.store.state.units;
    const shot = this.shot;
    const w = shot && this.weaponOf(shot);
    if (shot && w) {
      const { unit, weapon } = w;
      const may = this.mayAct(unit.owner);
      const range = weapon.min ? `${weapon.min}–${weapon.max}″` : `${weapon.max}″`;
      const step = shot.step === 'aim'
        ? `<p>${weapon.mode === 'cannon' ? 'Click the target point on the table' : 'Click the enemy unit'} (range ${range}).</p>
          <div class="row-btns"><button data-wm="aim" ${may ? '' : 'disabled'}>⌖ Choose target again</button></div>`
        : shot.step === 'fire'
          ? `<div class="row-btns"><button data-wm="fire" class="primary" ${may ? '' : 'disabled'}>🎲 ${weapon.mode === 'bombard' ? 'Roll Artillery & Scatter dice' : 'Roll Artillery dice'}</button>
            <button data-wm="aim" ${may ? '' : 'disabled'}>⌖ New target</button></div>`
          : shot.scatter
            ? `<div class="row-btns"><button data-wm="move-template" class="primary" ${may ? '' : 'disabled'}>Move the template ${shot.scatter.dist}″ <span class="scatter-arrow" style="transform: rotate(${shot.scatter.angle}deg)">↑</span></button></div>`
            : '';
      $('wm-panel').innerHTML = `<p><span class="dot ${unit.owner}"></span><b>${esc(unit.info.name)}</b> · ${esc(MODE_NAMES[weapon.mode])} (${esc(weapon.name)}, ${range})</p>
        ${(shot.lines ?? []).map((l) => `<p class="${/misfire/i.test(l) ? 'warn' : 'prompt-info'}">${esc(l)}</p>`).join('')}
        ${step}
        <div class="row-btns"><button data-wm="${shot.step === 'done' ? 'finish' : 'cancel'}" ${may ? '' : 'disabled'}>${shot.step === 'done' ? 'Done – remove the lines' : 'Cancel'}</button></div>
        <p class="meta">Remove casualties by hand${weapon.mode === 'bombard' ? ' – the template stays on the table until you delete it' : ''}.</p>`;
      return;
    }
    const machines = Object.values(units).filter((u) => !isJoined(u, units) && !u.ambush && u.status !== 'destroyed'
      && u.status !== 'fledOff' && warMachineWeapons(u).length);
    $('wm-panel').innerHTML = (['p1', 'p2'] as const).map((p) => {
      const mine = machines.filter((u) => u.owner === p);
      return `<section><h4><span class="dot ${p}"></span>${playerName(p)}</h4>${mine.length
        ? mine.map((u) => `<p><button class="rule-link" data-wm="select" data-unit="${u.id}">${esc(u.info.name)}</button></p>
          <div class="row-btns">${warMachineWeapons(u).map((wp, i) => `<button data-wm="start" data-unit="${u.id}" data-weapon="${i}" ${this.mayAct(p) ? '' : 'disabled'}
            title="${esc(`${wp.name}: range ${wp.min ? `${wp.min}–` : ''}${wp.max}″, S ${wp.profile.strength}, AP ${wp.profile.ap}`)}">${esc(MODE_NAMES[wp.mode])}</button>`).join('')}</div>`).join('')
        : '<p class="meta">No war machines.</p>'}</section>`;
    }).join('') + '<p class="meta">Cannons: choose a target point, then roll for the strike point and the bounce. Mortars and stone throwers: choose the target unit – the blast template is placed over its centre – then roll Artillery and Scatter dice.</p>';
  }
}
