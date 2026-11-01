import type { History } from '../model/history';
import { OBJECT_TYPES } from '../model/objects';
import { playerName } from '../model/players';
import type { Store } from '../model/store';
import { templateHitsByUnit } from '../model/templates';
import type { BoardObject, LogEntry, PlayerId } from '../model/types';
import { artilleryDie, artilleryText, scatterDie, scatterHtml } from './dice';

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const rnd = (sides: number) => 1 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * sides);

/** Regeln aus Battlefield Terrain (tow.whfb.app) je Geländeart bzw. je Regelname im Katalog */
const TERRAIN_PAGES: Record<string, string[]> = {
  woods: ['woods', 'woodland-boundaries', 'arboreal-gloom'],
  hill: ['hills', 'vantage-point', 'beyond-the-crest'],
  building: ['buildings'],
  wall: ['low-linear-obstacles', 'defended-low-linear-obstacles'],
};
const RULE_PAGES: Record<string, string> = {
  'Difficult Terrain': 'difficult-terrain',
  'Dangerous Terrain': 'dangerous-terrain',
  Impassable: 'impassable-terrain',
};

type ScatterKind = 'dir' | 'art' | 'd3' | 'd6' | 'd2';

/** Einzeln gewürfelte Abweichung einer Schablone */
interface ScatterRolls {
  dir?: { hit: boolean; angle: number };
  art?: number;
  d3?: number;
  d6?: number;
  d2?: number[];
  /** Richtung ohne Abweichungswürfel */
  angle?: number;
  /** HIT: doch dem kleinen Pfeil folgen */
  useArrow?: boolean;
  moved?: boolean;
}

/** Fenster rechts für ein ausgewähltes Gelände, einen Marker oder eine Schablone. */
export class ObjectPanel {
  private id: string | null = null;
  private terrain: Record<string, { name: string; text: string }> = {};
  /** Abweichungswürfel je Schablone (einzeln gewürfelt); angle = Richtung, wenn ohne Abweichungswürfel gewürfelt wird */
  private rolls = new Map<string, ScatterRolls>();

  constructor(private store: Store, private history: History, actions: { close(): void; remove(): void },
    private log: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void,
    private seat: () => PlayerId | 'spectator' | null = () => null) {
    $('o-close').onclick = () => actions.close();
    $('o-delete').onclick = () => actions.remove();
    input('o-label').onchange = () => this.change({ label: input('o-label').value.trim() || null });
    input('o-w').onchange = () => this.change({ w: Math.max(0.5, Number(input('o-w').value) || 0.5) });
    input('o-h').onchange = () => this.change({ h: Math.max(0.5, Number(input('o-h').value) || 0.5) });
    input('o-rot').onchange = () => this.change({ rotation: ((Number(input('o-rot').value) || 0) * Math.PI) / 180 });
    // Würfel einzeln werfen bzw. neu werfen, Schablone verschieben
    const onDice = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-sc]');
      if (btn) this.onScatter(btn.dataset.sc!);
    };
    $('o-sc-dice').onclick = onDice;
    $('o-hits-row').onclick = (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-partial]');
      if (btn) this.rollPartial(btn.dataset.partial!);
    };
    $('o-scatter-result').onclick = onDice;
    for (const id of ['o-sc-dir', 'o-sc-art', 'o-sc-d3', 'o-sc-d6', 'o-sc-2d6']) input(id).onchange = () => this.render();
    fetch(`${import.meta.env.BASE_URL}data/terrain.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
      .then((t) => { this.terrain = t; this.render(); });
    store.subscribe((_, c) => {
      // Schablonen zählen neu, wenn sich Einheiten bewegen oder die 4+-Würfe ändern
      const o = this.id ? this.store.state.objects[this.id] : undefined;
      if (c.objectId === this.id || c.loaded || (o?.kind === 'template' && (c.unitId || c.meta || c.replacedOwner))) this.render();
    });
  }

  show(id: string | null): void {
    this.id = id;
    this.render();
  }

  private change(patch: Partial<BoardObject>): void {
    if (!this.id) return;
    this.history.record();
    this.store.updateObject(this.id, patch);
  }

  private mayAct(p: PlayerId): boolean {
    const s = this.seat();
    return s !== 'spectator' && (!s || s === p);
  }

  /** Lage einer Schablone als Schlüssel: hat sie sich bewegt, gelten alte 4+-Würfe nicht mehr */
  private static at(o: BoardObject): string {
    return [o.x, o.y, o.rotation].map((v) => v.toFixed(3)).join(',');
  }

  /** Gültige 4+-Würfe dieser Schablone (je Einheit) */
  private partialDice(o: BoardObject): Record<string, number[]> {
    const r = this.store.state.meta.templateRolls?.[o.id];
    return r && r.at === ObjectPanel.at(o) ? r.dice : {};
  }

  /** Der Gegner würfelt für die teilweise bedeckten Modelle einer Einheit (getroffen bei 4+); erneut = Reroll */
  private rollPartial(unitId: string): void {
    const o = this.id ? this.store.state.objects[this.id] : undefined;
    const e = o && templateHitsByUnit(o, this.store.state.units).find((x) => x.unit.id === unitId);
    if (!o || !e?.partial || !this.mayAct(e.unit.owner)) return;
    const before = this.partialDice(o);
    const again = before[unitId]?.length === e.partial;
    const dice = Array.from({ length: e.partial }, () => rnd(6));
    const hit = dice.filter((d) => d >= 4).length;
    this.history.record();
    this.store.setMeta({ templateRolls: { ...this.store.state.meta.templateRolls,
      [o.id]: { at: ObjectPanel.at(o), dice: { ...before, [unitId]: dice } } } });
    this.log({ kind: 'roll', dice: [dice], text: `${again ? 'Reroll – ' : ''}${OBJECT_TYPES[o.type]?.name ?? 'Template'} on ${e.unit.info.name}: ${e.partial} partially covered – ${hit} hit on 4+` });
  }

  /** Getroffene Modelle je Einheit; teilweise bedeckte würfelt der Gegner (4+), am Ende steht die Zahl der Treffer */
  private renderHits(o: BoardObject): void {
    const list = templateHitsByUnit(o, this.store.state.units);
    const rolls = this.partialDice(o);
    if (!list.length) {
      $('o-hits-row').innerHTML = '<h3>Hits</h3><p class="meta">No models under the template.</p>';
      return;
    }
    $('o-hits-row').innerHTML = '<h3>Hits</h3>' + list.map((e) => {
      // Das Mittelloch zählt hier wie jedes andere Modell: ganz bedeckt
      const full = e.full + (e.centre ? 1 : 0);
      const dice = rolls[e.unit.id]?.length === e.partial ? rolls[e.unit.id] : null;
      const lucky = dice ? dice.filter((d) => d >= 4).length : 0;
      const may = this.mayAct(e.unit.owner) ? '' : 'disabled';
      const partial = !e.partial ? '' : `<div class="dice-step"><span class="label">${esc(playerName(e.unit.owner))}: ${e.partial} D6, hit on 4+</span>${dice
        ? `<span class="dice-inline">${dice.map((d) => `<span class="die ${d >= 4 ? 'ok' : ''}">${d}</span>`).join('')}</span> <button data-partial="${e.unit.id}" title="Roll these dice again" ${may}>↻ Reroll</button>`
        : `<button data-partial="${e.unit.id}" class="primary" ${may}>🎲 Roll</button>`}</div>`;
      const total = !e.partial
        ? `<b>${full} hit${full === 1 ? '' : 's'}</b>`
        : dice
          ? `<b>${full + lucky} hit${full + lucky === 1 ? '' : 's'}</b> (${full} fully covered + ${lucky} of ${e.partial} partially covered on 4+)`
          : `${full} fully covered · ${e.partial} partially covered`;
      return `<p class="prompt-info"><span class="dot ${e.unit.owner}"></span>${esc(e.unit.info.name)}: ${total}</p>${partial}`;
    }).join('');
  }

  private onScatter(act: string): void {
    const o = this.id ? this.store.state.objects[this.id] : undefined;
    if (!o) return;
    const r = this.rolls.get(o.id) ?? {};
    const name = OBJECT_TYPES[o.type]?.name ?? 'Template';
    const [verb, kind] = act.split(':') as [string, ScatterKind | undefined];
    if (verb === 'clear') this.rolls.delete(o.id);
    else if (verb === 'move' || verb === 'small-arrow') this.moveTemplate(o, verb === 'small-arrow');
    else if (kind && (verb === 'roll' || verb === 're')) {
      if (verb === 'roll' && r[kind] !== undefined) return;
      const value = kind === 'dir' ? scatterDie() : kind === 'art' ? artilleryDie() : kind === 'd3' ? Math.ceil(rnd(6) / 2)
        : kind === 'd6' ? rnd(6) : [rnd(6), rnd(6)];
      const next: ScatterRolls = { ...r, [kind]: value, moved: false, useArrow: false };
      this.rolls.set(o.id, next);
      const text = kind === 'dir' ? (value as ScatterRolls['dir'])!.hit ? 'HIT' : `arrow ${(value as ScatterRolls['dir'])!.angle}°`
        : kind === 'art' ? artilleryText(value as number) : Array.isArray(value) ? value.join(' + ') : String(value);
      const label = ({ dir: 'Scatter dice', art: 'Artillery dice', d3: '−D3', d6: 'D6', d2: '2D6' } as const)[kind];
      this.log({ kind: 'roll', dice: typeof value === 'number' ? [[value]] : Array.isArray(value) ? [value] : undefined,
        text: `${verb === 're' ? 'Reroll – ' : ''}${name}: ${label} ${text}` });
      // Liegen alle Würfel: Pfeil auf dem Tisch zeigen, wohin die Schablone gehört
      const res = this.result(next);
      if (res?.kind === 'scatter') {
        const a = (res.angle * Math.PI) / 180;
        this.store.setMeta({ scatterFx: { from: { x: o.x, y: o.y }, to: { x: o.x + Math.sin(a) * res.dist, y: o.y - Math.cos(a) * res.dist }, r: Math.max(o.w, o.h) / 2, hit: false, ts: Date.now() } });
      } else if (res?.kind === 'hit') {
        this.store.setMeta({ scatterFx: { from: { x: o.x, y: o.y }, to: { x: o.x, y: o.y }, r: Math.max(o.w, o.h) / 2, hit: true, ts: Date.now() } });
      }
    }
    this.render();
  }

  /** Angehakte Würfel */
  private kinds(): ScatterKind[] {
    const map: [string, ScatterKind][] = [['o-sc-dir', 'dir'], ['o-sc-art', 'art'], ['o-sc-d3', 'd3'], ['o-sc-d6', 'd6'], ['o-sc-2d6', 'd2']];
    return map.filter(([id]) => input(id).checked).map(([, k]) => k);
  }

  /** Ergebnis, sobald alle angehakten Würfel liegen */
  private result(r: ScatterRolls): { kind: 'misfire' } | { kind: 'hit'; dist: number; angle: number } | { kind: 'none' } | { kind: 'nodice' }
    | { kind: 'scatter'; dist: number; angle: number } | null {
    const kinds = this.kinds();
    if (!kinds.length || kinds.some((k) => r[k] === undefined)) return null;
    if (kinds.includes('art') && r.art === 0) return { kind: 'misfire' };
    const distKinds = kinds.filter((k) => k === 'art' || k === 'd6' || k === 'd2');
    const dist = Math.max(0, (kinds.includes('art') ? r.art ?? 0 : 0) + (kinds.includes('d6') ? r.d6 ?? 0 : 0)
      + (kinds.includes('d2') ? (r.d2 ?? []).reduce((s, d) => s + d, 0) : 0) - (kinds.includes('d3') ? r.d3 ?? 0 : 0));
    // Ohne Abweichungswürfel: feste zufällige Richtung, kein Volltreffer
    r.angle ??= rnd(360) - 1;
    const dir = kinds.includes('dir') ? r.dir! : { hit: false, angle: r.angle };
    if (dir.hit && !r.useArrow) return { kind: 'hit', dist, angle: dir.angle };
    if (!distKinds.length) return { kind: 'nodice' };
    if (!dist) return { kind: 'none' };
    return { kind: 'scatter', dist, angle: dir.angle };
  }

  /** Schablone um die gewürfelte Abweichung verschieben (nur auf Knopfdruck) */
  private moveTemplate(o: BoardObject, smallArrow: boolean): void {
    const r = this.rolls.get(o.id);
    if (!r) return;
    if (smallArrow) {
      r.useArrow = true;
      return;
    }
    const res = this.result(r);
    if (res?.kind !== 'scatter' || r.moved) return;
    const a = (res.angle * Math.PI) / 180;
    this.history.record();
    this.store.updateObject(o.id, { x: o.x + Math.sin(a) * res.dist, y: o.y - Math.cos(a) * res.dist });
    r.moved = true;
    this.log({ kind: 'action', text: `${OBJECT_TYPES[o.type]?.name ?? 'Template'} moved ${res.dist}″` });
  }

  /** Würfelzeilen und Ergebnis der Abweichung */
  private renderScatter(o: BoardObject): void {
    const r = this.rolls.get(o.id) ?? {};
    const labels: Record<ScatterKind, string> = { dir: 'Scatter dice', art: 'Artillery dice', d3: '−D3', d6: 'D6', d2: '2D6' };
    const die = (k: ScatterKind): string => {
      const v = r[k];
      if (k === 'dir') return scatterHtml(v as NonNullable<ScatterRolls['dir']>);
      if (k === 'art') return `<span class="die die-art ${v ? '' : 'misfire'}">${v ? v : 'Misfire'}</span>`;
      return (Array.isArray(v) ? v : [v as number]).map((d) => `<span class="die">${d}</span>`).join('');
    };
    const kinds = this.kinds();
    $('o-sc-dice').innerHTML = kinds.map((k) => `<div class="dice-step"><span class="label">${labels[k]}</span>${r[k] !== undefined
      ? `<span class="dice-inline">${die(k)}</span> <button data-sc="re:${k}" title="Roll this die again">↻ Reroll</button>`
      : `<button data-sc="roll:${k}" class="primary">🎲 Roll</button>`}</div>`).join('')
      + (kinds.some((k) => r[k] !== undefined) ? '<div class="row-btns"><button data-sc="clear">Clear the dice</button></div>' : '');
    const res = this.result(r);
    const arrow = (angle: number) => `<span class="scatter-arrow" style="transform: rotate(${angle}deg)">↑</span>`;
    $('o-scatter-result').innerHTML = !res ? ''
      : res.kind === 'misfire' ? '<p class="warn"><b>Misfire!</b> Roll on the misfire table.</p>'
      : res.kind === 'hit' ? `<p class="ok"><b>Direct hit!</b> The template stays where it is.</p>${res.dist
        ? `<p class="meta"><button data-sc="small-arrow" class="link">Use the small arrow instead: ${res.dist}″ ${arrow(res.angle)}</button></p>` : ''}`
      : res.kind === 'nodice' ? '<p class="warn">No distance dice chosen – tick the Artillery dice, D6 or 2D6.</p>'
      : res.kind === 'none' ? '<p class="ok"><b>No scatter</b> – the −D3 cancels the distance. The template stays where it is.</p>'
      : r.moved ? `<p class="ok">Template moved ${res.dist}″ ${arrow(res.angle)}</p>`
      : `<p class="warn">Scatters <b>${res.dist}″</b> ${arrow(res.angle)}</p>
        <div class="row-btns"><button data-sc="move" class="primary">Move the template ${res.dist}″ ${arrow(res.angle)}</button></div>
        <p class="meta">Or move it by hand.</p>`;
  }

  private render(): void {
    const o = this.id ? this.store.state.objects[this.id] : undefined;
    $('obj-panel').hidden = !o;
    if (!o) return;
    const t = OBJECT_TYPES[o.type];
    $('o-name').textContent = t?.name ?? o.type;
    // Felder nicht überschreiben, während jemand darin tippt
    const set = (id: string, v: string) => { if (document.activeElement !== $(id)) input(id).value = v; };
    set('o-label', o.label ?? '');
    set('o-w', o.w.toFixed(1));
    set('o-h', o.h.toFixed(1));
    set('o-rot', String(Math.round((((o.rotation * 180) / Math.PI) % 360 + 360) % 360)));
    $('o-size-row').hidden = !!t?.fixedSize || o.kind === 'marker';
    $('o-rot-row').hidden = o.kind === 'marker';
    const sight = t?.sight === 'blocks' ? 'Blocks line of sight.' : t?.sight === 'cover' ? 'Line of sight through it grants cover.' : '';
    $('o-meta').textContent = [t?.kind === 'template' ? `Fixed size: ${t.w}″ × ${t.h}″.` : '', sight]
      .filter(Boolean).join(' ');
    // Schablonen: Abweichung auswürfeln
    $('o-scatter-row').hidden = o.kind !== 'template' || o.type === 'flame';
    if (o.kind === 'template' && o.type !== 'flame') this.renderScatter(o);
    $('o-hits-row').hidden = o.kind !== 'template';
    if (o.kind === 'template') this.renderHits(o);
    // Gelände: Regeln mit Volltext zum Aufklappen
    $('o-rules-row').hidden = o.kind !== 'terrain';
    if (o.kind === 'terrain') {
      const pages = [...(TERRAIN_PAGES[o.type] ?? []), ...(t?.rules ?? []).map((r) => RULE_PAGES[r]).filter(Boolean)];
      const plain = (t?.rules ?? []).filter((r) => !RULE_PAGES[r]);
      $('o-rules-row').innerHTML = `<h3>Terrain rules</h3>` +
        (plain.length ? `<p class="opt-plain">${plain.map(esc).join(' · ')}</p>` : '') +
        pages.map((slug) => this.terrain[slug]).filter(Boolean)
          .map((r) => `<details><summary>${esc(r!.name)}</summary><p>${esc(r!.text)}</p></details>`).join('');
    }
  }
}
