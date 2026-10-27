import type { History } from '../model/history';
import { OBJECT_TYPES } from '../model/objects';
import type { Store } from '../model/store';
import type { BoardObject, LogEntry } from '../model/types';
import { artilleryDie, artilleryText, scatterDie } from './dice';

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

/** Fenster rechts für ein ausgewähltes Gelände, einen Marker oder eine Schablone. */
export class ObjectPanel {
  private id: string | null = null;
  private terrain: Record<string, { name: string; text: string }> = {};
  private lastScatter = '';

  constructor(private store: Store, private history: History, actions: { close(): void; remove(): void },
    private log: (entry: Pick<LogEntry, 'kind' | 'text' | 'dice'>) => void) {
    $('o-close').onclick = () => actions.close();
    $('o-delete').onclick = () => actions.remove();
    input('o-label').onchange = () => this.change({ label: input('o-label').value.trim() || null });
    input('o-w').onchange = () => this.change({ w: Math.max(0.5, Number(input('o-w').value) || 0.5) });
    input('o-h').onchange = () => this.change({ h: Math.max(0.5, Number(input('o-h').value) || 0.5) });
    input('o-rot').onchange = () => this.change({ rotation: ((Number(input('o-rot').value) || 0) * Math.PI) / 180 });
    $('o-sc-roll').onclick = () => this.scatter();
    // Nach einem HIT: auf Wunsch doch dem kleinen Pfeil folgen (wenn ein Treffer nicht möglich ist)
    $('o-scatter-result').onclick = (e) => {
      if ((e.target as HTMLElement).closest('[data-small-arrow]') && this.pending) this.move(this.pending.angle, this.pending.dist, this.pending.dice);
    };
    fetch(`${import.meta.env.BASE_URL}data/terrain.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
      .then((t) => { this.terrain = t; this.render(); });
    store.subscribe((_, c) => {
      if (c.objectId === this.id || c.loaded) this.render();
    });
  }

  show(id: string | null): void {
    if (id !== this.id) this.lastScatter = '';
    this.id = id;
    this.render();
  }

  private change(patch: Partial<BoardObject>): void {
    if (!this.id) return;
    this.history.record();
    this.store.updateObject(this.id, patch);
  }

  /**
   * Abweichung einer Schablone mit den angehakten Würfeln: Abweichungswürfel für die Richtung (HIT = Volltreffer,
   * die Schablone bleibt liegen), Artilleriewürfel und/oder D6/2D6 für die Entfernung (Misfire = kein Schuss).
   * Danach wird die Schablone verschoben.
   */
  private scatter(): void {
    const o = this.id ? this.store.state.objects[this.id] : undefined;
    if (!o) return;
    const checked = (id: string) => input(id).checked;
    const name = OBJECT_TYPES[o.type]?.name ?? 'Template';
    // Ohne Abweichungswürfel: zufällige Richtung, kein Volltreffer
    const dir = checked('o-sc-dir') ? scatterDie() : { hit: false, angle: rnd(360) - 1 };
    const art = checked('o-sc-art') ? artilleryDie() : null;
    const d6s = [...(checked('o-sc-d6') ? [rnd(6)] : []), ...(checked('o-sc-2d6') ? [rnd(6), rnd(6)] : [])];
    const dist = (art ?? 0) + d6s.reduce((s, d) => s + d, 0);
    const parts = [
      checked('o-sc-dir') ? (dir.hit ? 'HIT' : `arrow ${dir.angle}°`) : `direction ${dir.angle}°`,
      art !== null ? `artillery ${artilleryText(art)}` : '',
      d6s.length ? `${d6s.length === 1 ? 'D6' : `${d6s.length}D6`} ${d6s.join(' + ')}` : '',
    ].filter(Boolean).join(' · ');
    const dice = [...(art !== null ? [art] : []), ...d6s];
    this.pending = null;
    if (art === 0) {
      this.lastScatter = `<p class="warn"><b>Misfire!</b> (${esc(parts)}) – roll on the misfire table.</p>`;
      this.log({ kind: 'roll', dice: d6s.length ? [d6s] : undefined, text: `${name}: misfire (${parts})` });
      this.render();
      return;
    }
    if (dir.hit) {
      // Kleiner Pfeil auf der HIT-Seite: gilt, wenn ein Treffer nicht möglich ist
      this.pending = { angle: dir.angle, dist, dice };
      this.lastScatter = `<p class="ok"><b>Direct hit!</b> (${esc(parts)})</p>
        <p class="meta">${dist ? `<button data-small-arrow class="link">Use the small arrow instead: ${dist}″ <span class="scatter-arrow" style="transform: rotate(${dir.angle}deg)">↑</span></button>` : ''}</p>`;
      this.log({ kind: 'roll', dice: dice.length ? [dice] : undefined, text: `${name}: direct hit (${parts})` });
      this.store.setMeta({ scatterFx: { from: { x: o.x, y: o.y }, to: { x: o.x, y: o.y }, r: Math.max(o.w, o.h) / 2, hit: true, ts: Date.now() } });
      this.render();
      return;
    }
    if (!dist) {
      this.lastScatter = `<p class="warn">No distance dice chosen – tick the Artillery dice, D6 or 2D6.</p>`;
      this.render();
      return;
    }
    this.move(dir.angle, dist, dice, parts);
  }

  /** HIT-Ergebnis, falls doch dem kleinen Pfeil gefolgt wird */
  private pending: { angle: number; dist: number; dice: number[] } | null = null;

  /** Schablone um dist Zoll in Richtung angle (Grad, 0 = nach oben) verschieben */
  private move(angle: number, dist: number, dice: number[], parts = `small arrow ${angle}°`): void {
    const o = this.id ? this.store.state.objects[this.id] : undefined;
    if (!o) return;
    const name = OBJECT_TYPES[o.type]?.name ?? 'Template';
    const a = (angle * Math.PI) / 180;
    this.pending = null;
    this.history.record();
    const from = { x: o.x, y: o.y };
    this.store.updateObject(o.id, { x: o.x + Math.sin(a) * dist, y: o.y - Math.cos(a) * dist });
    this.store.setMeta({ scatterFx: { from, to: { x: o.x, y: o.y }, r: Math.max(o.w, o.h) / 2, hit: false, ts: Date.now() } });
    this.lastScatter = `<p class="warn">Scatters <b>${dist}″</b> <span class="scatter-arrow" style="transform: rotate(${angle}deg)">↑</span> (${esc(parts)})</p>`;
    this.log({ kind: 'roll', dice: dice.length ? [dice] : undefined, text: `${name} scatters ${dist}″ (${parts})` });
    this.render();
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
    $('o-scatter-result').innerHTML = this.lastScatter;
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
