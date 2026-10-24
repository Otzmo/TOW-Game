import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import { BoardTools } from './boardTools';
import { frontCenter, REACTION_NAMES } from '../model/flow';
import {
  isJoined, isNonUnitChange, isSkirmish, nearestGap, recenter, SKIRMISH_GAP, unitFootprint, unitLayout, type Store,
} from '../model/store';
import type { History } from '../model/history';
import type { Point, UnitState } from '../model/types';
import { createTable } from './table';
import { GUIDE_COLOR, OK_COLOR, PPI, STRAY_COLOR } from './theme';
import { UnitView } from './unitView';

const DRAG_THRESHOLD = 3; // Pixel, ab denen ein Klick als Ziehen gilt
const ROTATE_SNAP = Math.PI / 12;

/** Schwenken um eine vordere Ecke (alle Werte in Zoll bzw. Radiant). */
interface Swing {
  /** Ecke, um die geschwenkt wird */
  px: number;
  py: number;
  /** Ecke, die sich bewegt, zu Beginn */
  cx: number;
  cy: number;
  /** Winkel des Mauszeigers um die Drehecke zu Beginn */
  startAngle: number;
  /** Frontbreite = Radius der äußeren Ecke */
  front: number;
}

type UnitDragType = 'move' | 'rotate' | 'swing';

type UnitDrag = { type: UnitDragType; unitId: string; ox: number; oy: number; sx: number; sy: number; srot: number;
  gx: number; gy: number; moved: boolean; swing?: Swing };

/** Ein einzelnes Modell einer Plänklereinheit ziehen (Positionen in Einheitskoordinaten). */
type ModelDrag = { type: 'model'; unitId: string; key: string; start: Point; startPointer: Point;
  startPositions: Record<string, Point>; startStray: number; gx: number; gy: number; moved: boolean };

type Drag =
  | { type: 'pan'; gx: number; gy: number; wx: number; wy: number; moved: boolean }
  | UnitDrag
  | ModelDrag;

/** Bewegungswert der Einheit: erster Zahlenwert in der M-Spalte (bei Reitern der des Reittiers). */
function movement(u: UnitState): number | null {
  for (const row of u.info.profile) {
    const m = Number.parseInt(row.values[0], 10);
    if (Number.isFinite(m)) return m;
  }
  return null;
}

/** Winkel auf (−π, π] bringen. */
const normAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface BoardEvents {
  onSelect(unitId: string | null): void;
  onSelectObject(objectId: string | null): void;
  onAction(unitId: string, description: string): void;
}

/** Abstand, ab dem eine Einheit beim Loslassen an eine gegnerische Kante angelegt wird (Zoll) */
const CHARGE_SNAP = 1;

/** Spielfeld: Tisch, Einheiten, Kamera und Maussteuerung. */
export class Board {
  readonly world = new Container();
  readonly tools: BoardTools;
  private readonly unitLayer = new Container();
  private readonly rangeLayer = new Container();
  /** Angriffspfeile: wer wen angreift, mit Reaktion und Ergebnis */
  private readonly chargeLayer = new Container();
  /** Zielauswahl beim Angriff ansagen: nächster Klick auf eine Einheit */
  private pickTarget: ((unitId: string) => void) | null = null;
  /** Bewegungs- und Angriffsreichweiten der ausgewählten Einheit anzeigen */
  showRanges = false;
  private viewOnly = false;
  /** Phasenregeln: darf diese Einheit jetzt bewegt werden? (zeigt sonst selbst einen Hinweis) */
  canMove: (unitId: string) => boolean = () => true;
  private readonly guide = new Graphics();
  private readonly moveLabel = new Text({
    text: '',
    style: { fontFamily: 'system-ui', fontSize: 18, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
    resolution: 2,
  });
  private readonly views = new Map<string, UnitView>();
  private drag: Drag | null = null;
  selectedId: string | null = null;

  constructor(private app: Application, private store: Store, private history: History, private events: BoardEvents) {
    const { table } = store.state;
    app.stage.addChild(this.world);
    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;

    this.moveLabel.anchor.set(0.5, 1);
    this.tools = new BoardTools(store, history, {
      toInches: (e) => this.toInches(e),
      worldScale: () => this.world.scale.x,
      setUnitsInteractive: (on) => { this.unitLayer.eventMode = on ? 'passive' : 'none'; },
      onSelectObject: (id) => {
        if (id && this.selectedId) this.select(null);
        this.events.onSelectObject(id);
      },
    });
    const t = this.tools;
    this.world.addChild(createTable(table.width, table.height), t.zoneLayer, t.terrainLayer, this.guide,
      this.rangeLayer, this.unitLayer, this.chargeLayer, t.overlayLayer, t.toolLayer, this.moveLabel);

    app.stage.on('pointerdown', (e) => {
      if (this.tools.handleStageDown(e)) return;
      this.drag = { type: 'pan', gx: e.global.x, gy: e.global.y, wx: this.world.x, wy: this.world.y, moved: false };
    });
    app.stage.on('globalpointermove', (e) => this.onPointerMove(e));
    app.stage.on('pointerup', () => this.endDrag());
    app.stage.on('pointerupoutside', () => this.endDrag());
    app.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    store.subscribe((state, change) => {
      if (change.chargeId || change.loaded) this.drawCharges();
      if (isNonUnitChange(change)) return;
      const { unitId, patch } = change;
      const u = unitId ? state.units[unitId] : undefined;
      // Anschließen/Verlassen ändert zwei Einheiten, Löschen/Import beliebig viele
      if (!u || (patch && 'joinedTo' in patch) || !patch) {
        this.syncAll();
        return;
      }
      this.syncUnit(u);
    });
    this.syncAll();
  }

  select(unitId: string | null): void {
    this.selectedId = unitId;
    if (unitId && this.tools.selectedId) this.tools.select(null);
    this.syncAll();
    this.events.onSelect(unitId);
  }

  /** Zuschauer: nur ansehen und auswählen, nichts bewegen */
  get readOnly(): boolean {
    return this.viewOnly;
  }

  set readOnly(on: boolean) {
    this.viewOnly = on;
    this.tools.readOnly = on;
  }

  setShowRanges(on: boolean): void {
    this.showRanges = on;
    this.drawRanges();
  }

  /** Charakter aus seiner Einheit lösen und vor deren Front stellen. */
  detachCharacter(charId: string): void {
    const units = this.store.state.units;
    const c = units[charId];
    const host = c?.joinedTo ? units[c.joinedTo] : undefined;
    if (!c || !host || !this.canMove(charId)) return;
    const { h } = unitFootprint(host, units);
    const depth = c.info.baseDepth / 25.4;
    const p = this.unitPoint(host, 0, -h / 2 - depth / 2 - 0.5);
    this.history.record();
    this.store.updateUnit(charId, { joinedTo: null, x: p.x, y: p.y, rotation: host.rotation });
    if (host.positions?.[charId]) {
      const { [charId]: _, ...rest } = host.positions;
      this.store.updateUnit(host.id, recenter(host, this.store.state.units, rest));
    }
    this.events.onAction(charId, `left ${host.info.name}`);
  }

  private syncAll(): void {
    const units = this.store.state.units;
    for (const [id, view] of this.views) {
      if (units[id]) continue;
      view.destroy({ children: true });
      this.views.delete(id);
      if (this.selectedId === id) {
        this.selectedId = null;
        this.events.onSelect(null);
      }
    }
    for (const u of Object.values(units)) this.syncUnit(u);
    this.drawRanges();
    this.drawCharges();
  }

  /** Angriff ansagen: Hinweis zeigen und den nächsten Klick auf eine gegnerische Einheit abwarten. */
  startChargePick(chargerId: string, onPick: (targetId: string) => void): void {
    const charger = this.store.state.units[chargerId];
    if (!charger) return;
    this.tools.setTool('select');
    this.pickTarget = (id) => {
      const t = this.store.state.units[id];
      if (t && t.owner !== charger.owner) onPick(id);
    };
    const hint = document.getElementById('tool-hint')!;
    hint.textContent = `Charge by ${charger.info.name}: click an enemy unit · Esc to cancel`;
    hint.hidden = false;
  }

  cancelPick(): boolean {
    if (!this.pickTarget) return false;
    this.pickTarget = null;
    document.getElementById('tool-hint')!.hidden = true;
    return true;
  }

  /** Pfeile für alle Angriffe: rot = angesagt, grün = gelungen, grau = gescheitert. */
  private drawCharges(): void {
    this.chargeLayer.removeChildren().forEach((c) => c.destroy());
    const { units, charges } = this.store.state;
    for (const c of Object.values(charges)) {
      const charger = units[c.charger];
      const target = units[c.target];
      if (!charger || !target) continue;
      const a = frontCenter(charger, units);
      // Nächster Punkt auf der Fläche des Ziels
      const { w, h } = unitFootprint(target, units);
      const local = this.toUnitLocal(target, a);
      const b = this.unitPoint(target, Math.max(-w / 2, Math.min(w / 2, local.x)), Math.max(-h / 2, Math.min(h / 2, local.y)));
      const color = c.success === true ? OK_COLOR : c.success === false ? 0x9a9fa4 : STRAY_COLOR;
      const g = new Graphics();
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = 1.1;
      g.moveTo(a.x * PPI, a.y * PPI).lineTo(b.x * PPI, b.y * PPI).stroke({ width: 3, color, alpha: 0.95 });
      g.poly([
        b.x * PPI, b.y * PPI,
        (b.x - head * Math.cos(ang - 0.45)) * PPI, (b.y - head * Math.sin(ang - 0.45)) * PPI,
        (b.x - head * Math.cos(ang + 0.45)) * PPI, (b.y - head * Math.sin(ang + 0.45)) * PPI,
      ]).fill(color);
      // Ziel umranden
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sy]) => {
        const p = this.unitPoint(target, (sx * w) / 2 + sx * 0.15, (sy * h) / 2 + sy * 0.15);
        return [p.x * PPI, p.y * PPI];
      });
      g.poly(corners).stroke({ width: 2, color, alpha: 0.9 });
      const status = c.status === 'declared' ? 'awaiting reaction' : REACTION_NAMES[c.reaction ?? 'hold'];
      const result = c.status === 'rolled' ? ` · ${c.range}″ ${c.success ? 'succeeds' : 'fails'}` : '';
      const label = new Text({
        text: `⚔ Charge · ${status}${result}`,
        style: { fontFamily: 'system-ui', fontSize: 13, fontWeight: '700', fill: color, stroke: { color: 0x000000, width: 3.5 } },
        resolution: 6,
      });
      label.anchor.set(0.5);
      label.position.set(((a.x + b.x) / 2) * PPI, ((a.y + b.y) / 2) * PPI - 8);
      this.chargeLayer.addChild(g, label);
    }
  }

  /**
   * Reichweiten der ausgewählten Einheit als Abstand um ihre Fläche:
   * Bewegung (M), Marsch (2 × M) und größte mögliche Angriffsreichweite (M + 6, Swiftstride +3, Battle Hunger +2).
   */
  private drawRanges(): void {
    this.rangeLayer.removeChildren().forEach((c) => c.destroy());
    const units = this.store.state.units;
    let u = this.selectedId ? units[this.selectedId] : undefined;
    if (u?.joinedTo && units[u.joinedTo]) u = units[u.joinedTo];
    if (!this.showRanges || !u) return;
    const m = movement(u);
    if (!m) return;
    const has = (re: RegExp) => [...u.info.rules, ...u.info.items].some((r) => re.test(r.name));
    const charge = m + 6 + (has(/swiftstride/i) ? 3 : 0) + (has(/battle hunger/i) ? 2 : 0);
    const { w, h } = unitFootprint(u, units);
    const c = new Container();
    c.position.set(u.x * PPI, u.y * PPI);
    c.rotation = u.rotation;
    const g = new Graphics();
    c.addChild(g);
    const ranges: [number, string, number][] = [[m, `Move ${m}″`, 0xffffff], [2 * m, `March ${2 * m}″`, 0x9ab4d8],
      [charge, `Charge max. ${charge}″`, STRAY_COLOR]];
    for (const [d, text, color] of ranges) {
      const D = d * PPI;
      g.roundRect((-w / 2) * PPI - D, (-h / 2) * PPI - D, w * PPI + 2 * D, h * PPI + 2 * D, D)
        .stroke({ width: 1.5, color, alpha: 0.7 });
      const t = new Text({ text, style: { fontFamily: 'system-ui', fontSize: 12, fontWeight: '600', fill: color, stroke: { color: 0x000000, width: 3 } }, resolution: 6 });
      t.anchor.set(0.5, 1);
      t.position.set(0, (-h / 2) * PPI - D - 1);
      c.addChild(t);
    }
    this.rangeLayer.addChild(c);
  }

  /**
   * Angriff: Liegt die Frontmitte der Einheit nach dem Loslassen höchstens 1″ vor einer Kante einer
   * gegnerischen Einheit, wird sie bündig und mittig an diese Kante angelegt.
   */
  private chargeSnap(unitId: string): string | null {
    const units = this.store.state.units;
    const u = units[unitId];
    const me = unitFootprint(u, units);
    const front = this.unitPoint(u, 0, -me.h / 2);
    let best: { dist: number; target: UnitState; p: Point; n: Point; side: string } | null = null;
    for (const t of Object.values(units)) {
      if (t.owner === u.owner || isJoined(t, units) || t.status === 'destroyed' || t.status === 'fledOff') continue;
      const { w, h } = unitFootprint(t, units);
      // Kanten des Ziels: Mittelpunkt, Richtung entlang der Kante, Außennormale, halbe Länge
      const edges: [string, Point, Point, number][] = [
        ['front', { x: 0, y: -h / 2 }, { x: 0, y: -1 }, w / 2],
        ['rear', { x: 0, y: h / 2 }, { x: 0, y: 1 }, w / 2],
        ['left flank', { x: -w / 2, y: 0 }, { x: -1, y: 0 }, h / 2],
        ['right flank', { x: w / 2, y: 0 }, { x: 1, y: 0 }, h / 2],
      ];
      const local = this.toUnitLocal(t, front);
      for (const [side, mid, n, half] of edges) {
        const along = n.x === 0 ? local.x - mid.x : local.y - mid.y;
        const out = (local.x - mid.x) * n.x + (local.y - mid.y) * n.y;
        if (Math.abs(along) > half + 0.5 || out < -0.5 || out > CHARGE_SNAP) continue;
        const clamped = Math.max(-half, Math.min(half, along));
        const lp = n.x === 0 ? { x: mid.x + clamped, y: mid.y } : { x: mid.x, y: mid.y + clamped };
        const p = this.unitPoint(t, lp.x, lp.y);
        const c = Math.cos(t.rotation);
        const s = Math.sin(t.rotation);
        const wn = { x: n.x * c - n.y * s, y: n.x * s + n.y * c };
        if (!best || Math.abs(out) < best.dist) best = { dist: Math.abs(out), target: t, p, n: wn, side };
      }
    }
    if (!best) return null;
    // Eigene Front zeigt gegen die Außennormale der Zielkante; Mitte liegt eine halbe Tiefe dahinter
    const rotation = Math.atan2(-best.n.x, best.n.y);
    this.store.updateUnit(unitId, { x: best.p.x + best.n.x * (me.h / 2), y: best.p.y + best.n.y * (me.h / 2), rotation });
    return `charges ${best.target.info.name} in the ${best.side}`;
  }

  /**
   * Freier Bereich für den Tisch in Bildschirmpixeln (zwischen Hilfsmittel-Spalte links und
   * Einheitenleiste unten, abzüglich Platz für die Zoll-Leisten). Kommt aus main.ts.
   */
  viewArea: () => { left: number; top: number; right: number; bottom: number } = () =>
    ({ left: 0, top: 0, right: this.app.screen.width, bottom: this.app.screen.height });

  /** Kleinster Zoom: der ganze Tisch passt in den freien Bereich. */
  private minScale(): number {
    const a = this.viewArea();
    const { width, height } = this.store.state.table;
    return Math.min((a.right - a.left) / (width * PPI), (a.bottom - a.top) / (height * PPI));
  }

  // --- Aktionen für Tastenkürzel -----------------------------------------------

  /** Ausgewählte Einheit (ein angeschlossener Charakter bewegt seine Einheit) */
  private movableUnit(): UnitState | undefined {
    const units = this.store.state.units;
    const u = this.selectedId ? units[this.selectedId] : undefined;
    return u?.joinedTo && units[u.joinedTo] ? units[u.joinedTo] : u;
  }

  /**
   * Auswahl verschieben: Einheiten in ihrer Blickrichtung (vor/zurück, seitlich),
   * Objekte entlang des Tisches. Werte in Zoll.
   */
  nudgeSelected(forward: number, right: number): void {
    if (this.viewOnly) return;
    const obj = this.tools.selectedId ? this.store.state.objects[this.tools.selectedId] : undefined;
    if (obj) {
      this.history.record();
      this.store.updateObject(obj.id, { x: obj.x + right, y: obj.y - forward });
      return;
    }
    const u = this.movableUnit();
    if (!u || !this.canMove(u.id)) return;
    this.history.record();
    const p = this.unitPoint(u, right, -forward);
    this.store.updateUnit(u.id, { x: p.x, y: p.y });
    const dist = Math.hypot(forward, right);
    this.events.onAction(u.id, `${dist.toFixed(1)}″ ${forward > 0 ? 'forward' : forward < 0 ? 'backward' : right > 0 ? 'right' : 'left'}`);
  }

  /** Auswahl um ihre Mitte drehen (Grad, im Uhrzeigersinn positiv). */
  rotateSelected(deg: number): void {
    if (this.viewOnly) return;
    const rad = (deg * Math.PI) / 180;
    const obj = this.tools.selectedId ? this.store.state.objects[this.tools.selectedId] : undefined;
    if (obj) {
      this.history.record();
      this.store.updateObject(obj.id, { rotation: obj.rotation + rad });
      return;
    }
    const u = this.movableUnit();
    if (!u || !this.canMove(u.id)) return;
    this.history.record();
    this.store.updateUnit(u.id, { rotation: u.rotation + rad });
    this.events.onAction(u.id, `${Math.abs(deg)}° ${deg > 0 ? 'rechts' : 'links'} gedreht`);
  }

  /** Nächste bzw. vorige Einheit auswählen (bevorzugt die des Spielers am Zug). */
  selectNext(dir: 1 | -1): void {
    const units = this.store.state.units;
    const active = this.store.state.meta.active;
    const list = Object.values(units).filter((u) => !isJoined(u, units))
      .sort((a, b) => Number(b.owner === active) - Number(a.owner === active) || a.x - b.x);
    if (!list.length) return;
    const i = list.findIndex((u) => u.id === this.selectedId);
    const next = list[(i + dir + list.length) % list.length] ?? list[0];
    this.select(next.id);
  }

  /** Um die Mitte des freien Bereichs zoomen. */
  zoomBy(factor: number): void {
    const a = this.viewArea();
    const mx = (a.left + a.right) / 2;
    const my = (a.top + a.bottom) / 2;
    const s = this.world.scale.x;
    const ns = Math.min(8, Math.max(this.minScale(), s * factor));
    const wx = (mx - this.world.x) / s;
    const wy = (my - this.world.y) / s;
    this.world.scale.set(ns);
    this.world.position.set(mx - wx * ns, my - wy * ns);
    this.clampView();
  }

  /** Ansicht verschieben (Bildschirmpixel), bleibt an den Leisten. */
  panBy(dx: number, dy: number): void {
    this.world.position.set(this.world.x + dx, this.world.y + dy);
    this.clampView();
  }

  /** Ganzen Tisch zeigen, unten links an Spalte und Leiste angelegt. */
  fitView(): void {
    this.world.scale.set(this.minScale());
    this.clampView();
  }

  /**
   * Tisch bleibt an Spalte und Leiste: Passt er in eine Richtung ganz hinein, liegt er links bzw. unten an;
   * ist er größer (hineingezoomt), lässt er sich nur so weit verschieben, dass keine Lücke zu den Leisten entsteht.
   */
  private clampView(): void {
    const a = this.viewArea();
    const s = Math.max(this.world.scale.x, this.minScale());
    this.world.scale.set(s);
    const { width, height } = this.store.state.table;
    const w = width * PPI * s;
    const h = height * PPI * s;
    const x = w <= a.right - a.left ? a.left : Math.min(a.left, Math.max(a.right - w, this.world.x));
    const y = h <= a.bottom - a.top ? a.bottom - h : Math.min(a.top, Math.max(a.bottom - h, this.world.y));
    this.world.position.set(x, y);
  }

  private syncUnit(u: UnitState): void {
    const units = this.store.state.units;
    let view = this.views.get(u.id);
    if (!view) {
      const v = new UnitView(u.id);
      view = v;
      v.on('pointerdown', (e) => {
        // Zielauswahl für einen Angriff
        if (this.pickTarget) {
          e.stopPropagation();
          const pick = this.pickTarget;
          this.cancelPick();
          pick(u.id);
          return;
        }
        const local = v.toLocal(e.global);
        const hit = v.slotRects.find((s) => s.rect.contains(local.x, local.y));
        const unit = this.store.state.units[u.id];
        // Plänkler: ein Modell ziehen bewegt nur dieses Modell, mit Shift die ganze Einheit
        if (hit && isSkirmish(unit) && !e.shiftKey) {
          this.startModelDrag(u.id, hit.key, e, hit.charId);
          return;
        }
        // Klick auf einen angeschlossenen Charakter wählt ihn aus, gezogen wird die ganze Einheit
        this.startUnitDrag(u.id, 'move', e, 1, hit?.charId);
      });
      view.handle.on('pointerdown', (e) => this.startUnitDrag(u.id, 'rotate', e));
      // Linker Griff schwenkt um die rechte Ecke, rechter Griff um die linke
      view.wheelLeft.on('pointerdown', (e) => this.startUnitDrag(u.id, 'swing', e, 1));
      view.wheelRight.on('pointerdown', (e) => this.startUnitDrag(u.id, 'swing', e, -1));
      this.views.set(u.id, view);
      this.unitLayer.addChild(view);
    }
    // Angeschlossene Charaktere zeichnet ihre Einheit mit
    view.visible = !isJoined(u, units);
    if (view.visible) view.update(u, unitLayout(u, units), units, this.selectedId);
    if (this.showRanges && this.selectedId === u.id) this.drawRanges();
    // Angriffspfeile folgen bewegten Einheiten
    if (Object.values(this.store.state.charges).some((c) => c.charger === u.id || c.target === u.id)) this.drawCharges();
  }

  /**
   * pivotSide: 1 = um die rechte vordere Ecke schwenken, −1 = um die linke.
   * selectId: was ausgewählt wird (z. B. ein angeschlossener Charakter), sonst die Einheit selbst.
   */
  private startUnitDrag(unitId: string, type: UnitDragType, e: FederatedPointerEvent, pivotSide = 1,
    selectId = unitId): void {
    e.stopPropagation();
    // Drehen und Schwenken sofort prüfen; Ziehen erst, wenn sich die Maus wirklich bewegt (Klick = nur ansehen)
    if (this.viewOnly || (type !== 'move' && !this.canMove(unitId))) {
      if (this.selectedId !== selectId) this.select(selectId);
      return;
    }
    const units = this.store.state.units;
    const u = units[unitId];
    const p = this.toInches(e);
    let swing: Swing | undefined;
    if (type === 'swing') {
      const { w, h } = unitFootprint(u, units);
      const pivot = this.unitPoint(u, (pivotSide * w) / 2, -h / 2);
      const corner = this.unitPoint(u, (-pivotSide * w) / 2, -h / 2);
      swing = { px: pivot.x, py: pivot.y, cx: corner.x, cy: corner.y,
        startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x), front: w };
    }
    this.history.record();
    this.drag = { type, unitId, ox: u.x - p.x, oy: u.y - p.y, sx: u.x, sy: u.y, srot: u.rotation,
      gx: e.global.x, gy: e.global.y, moved: type !== 'move', swing };
    const view = this.views.get(unitId);
    if (view && type === 'move') view.cursor = 'grabbing';
    if (this.selectedId !== selectId) this.select(selectId);
  }

  private startModelDrag(unitId: string, key: string, e: FederatedPointerEvent, charId?: string): void {
    e.stopPropagation();
    if (this.viewOnly) {
      this.select(charId ?? unitId);
      return;
    }
    const units = this.store.state.units;
    const u = units[unitId];
    const layout = unitLayout(u, units);
    // Alle aktuellen Positionen festhalten, auch gerade erst erzeugte
    const startPositions: Record<string, Point> = {};
    for (const s of layout.slots) startPositions[s.key] = { x: s.x + s.w / 2, y: s.y + s.d / 2 };
    this.history.record();
    this.drag = { type: 'model', unitId, key, start: startPositions[key], startPointer: this.toUnitLocal(u, this.toInches(e)),
      startPositions, startStray: layout.stray.size, gx: e.global.x, gy: e.global.y, moved: false };
    const select = charId ?? unitId;
    if (this.selectedId !== select) this.select(select);
  }

  /** Eigene Einheit unter dem Mittelpunkt eines frei bewegten Charakters, der er beitreten kann. */
  private findJoinTarget(c: UnitState): UnitState | null {
    if (!c.info.isCharacter || isJoined(c, this.store.state.units)) return null;
    const units = this.store.state.units;
    for (const u of Object.values(units)) {
      if (u.id === c.id || u.owner !== c.owner || u.info.isCharacter || isJoined(u, units)) continue;
      const { w, h } = unitFootprint(u, units);
      const dx = c.x - u.x;
      const dy = c.y - u.y;
      const cos = Math.cos(-u.rotation);
      const sin = Math.sin(-u.rotation);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return u;
    }
    return null;
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    if (this.tools.handleMove(e)) return;
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.global.x - d.gx, e.global.y - d.gy) < DRAG_THRESHOLD) return;
    const starting = !d.moved;
    d.moved = true;
    if (starting && (d.type === 'move' || d.type === 'model') && !this.canMove(d.unitId)) {
      this.drag = null;
      this.history.dropIfUnchanged();
      return;
    }

    if (d.type === 'pan') {
      this.world.position.set(d.wx + e.global.x - d.gx, d.wy + e.global.y - d.gy);
      this.clampView();
      return;
    }
    const u = this.store.state.units[d.unitId];
    const p = this.toInches(e);
    if (d.type === 'model') {
      const lp = this.toUnitLocal(u, p);
      const pos = { x: d.start.x + lp.x - d.startPointer.x, y: d.start.y + lp.y - d.startPointer.y };
      this.store.updateUnit(d.unitId, { positions: { ...d.startPositions, ...u.positions, [d.key]: pos } });
      this.drawModelGuide(d);
      return;
    }
    if (d.type === 'move') {
      this.store.updateUnit(d.unitId, { x: p.x + d.ox, y: p.y + d.oy });
    } else if (d.swing) {
      // Ganze Einheit um die feste Ecke drehen
      const sw = d.swing;
      let delta = normAngle(Math.atan2(p.y - sw.py, p.x - sw.px) - sw.startAngle);
      if (e.shiftKey) delta = Math.round(delta / ROTATE_SNAP) * ROTATE_SNAP;
      const c = Math.cos(delta);
      const s = Math.sin(delta);
      const rx = d.sx - sw.px;
      const ry = d.sy - sw.py;
      this.store.updateUnit(d.unitId, {
        x: sw.px + rx * c - ry * s,
        y: sw.py + rx * s + ry * c,
        rotation: d.srot + delta,
      });
    } else {
      let a = Math.atan2(p.y - u.y, p.x - u.x) + Math.PI / 2;
      if (e.shiftKey) a = Math.round(a / ROTATE_SNAP) * ROTATE_SNAP;
      this.store.updateUnit(d.unitId, { rotation: a });
    }
    this.drawGuide(d);
  }

  private endDrag(): void {
    if (this.tools.handleUp()) return;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.type === 'pan') {
      if (!d.moved) this.select(null);
      return;
    }
    const view = this.views.get(d.unitId);
    if (view) view.cursor = 'grab';
    this.guide.clear();
    this.moveLabel.text = '';
    this.moveLabel.style.fill = 0xffffff;
    if (!d.moved) {
      this.history.dropIfUnchanged();
      return;
    }
    if (d.type === 'model') {
      this.endModelDrag(d);
      return;
    }
    const units = this.store.state.units;
    const target = d.type === 'move' ? this.findJoinTarget(units[d.unitId]) : null;
    if (target) {
      const c = units[d.unitId];
      if (isSkirmish(target)) {
        // Bei Plänklern steht der Charakter dort, wo er losgelassen wurde
        const positions = { ...this.currentPositions(target), [c.id]: this.toUnitLocal(target, c) };
        this.store.updateUnit(target.id, recenter(target, { ...units, [c.id]: { ...c, joinedTo: target.id } }, positions));
      }
      this.store.updateUnit(d.unitId, { joinedTo: target.id });
      this.events.onAction(d.unitId, `joined ${target.info.name}`);
      return;
    }
    const text = this.describe(d);
    const charge = d.type === 'move' ? this.chargeSnap(d.unitId) : null;
    const all = [text, charge].filter(Boolean).join(' · ');
    if (all) this.events.onAction(d.unitId, all);
  }

  /**
   * Plänkler loslassen. Während des Zuges darf ein Modell auch mehr als 1″ entfernt stehen –
   * es wird rot markiert, geprüft wird beim Zugende.
   */
  private endModelDrag(d: ModelDrag): void {
    const units = this.store.state.units;
    const u = units[d.unitId];
    const layout = unitLayout(u, units);
    // Bei einem angeschlossenen Charakter steht die Meldung in dessen Panel
    const actor = units[d.key] ? d.key : d.unitId;
    const end = u.positions?.[d.key] ?? d.start;
    const dist = Math.hypot(end.x - d.start.x, end.y - d.start.y);
    this.store.updateUnit(d.unitId, recenter(u, units, u.positions ?? d.startPositions));
    const warn = layout.stray.size ? ` – ${layout.stray.size} model(s) more than ${SKIRMISH_GAP}″ away, fix before the end of the phase` : '';
    this.events.onAction(actor, `model moved ${dist.toFixed(1)}″${warn}`);
  }

  /** Linie vom Start zum Modell, Strecke und Abstand zum nächsten Modell (rot über 1″). */
  private drawModelGuide(d: ModelDrag): void {
    const units = this.store.state.units;
    const u = units[d.unitId];
    const layout = unitLayout(u, units);
    const end = u.positions?.[d.key] ?? d.start;
    const a = this.unitPoint(u, d.start.x, d.start.y);
    const b = this.unitPoint(u, end.x, end.y);
    const near = nearestGap(layout.slots, d.key);
    const tooFar = layout.stray.size > d.startStray;
    this.guide.clear();
    this.guide.circle(a.x * PPI, a.y * PPI, 2.5).fill(0xffffff);
    this.guide.moveTo(a.x * PPI, a.y * PPI).lineTo(b.x * PPI, b.y * PPI).stroke({ width: 1.5, color: GUIDE_COLOR, alpha: 0.9 });
    this.moveLabel.text = `${Math.hypot(end.x - d.start.x, end.y - d.start.y).toFixed(1)}″ · ` +
      `${near.toFixed(1)}″ to the nearest model${tooFar ? ' – more than 1″!' : ''}`;
    this.moveLabel.style.fill = tooFar ? STRAY_COLOR : near <= SKIRMISH_GAP ? OK_COLOR : 0xffffff;
    this.moveLabel.scale.set(1 / this.world.scale.x);
    this.moveLabel.position.set(b.x * PPI, b.y * PPI - 1.5 * PPI);
  }

  /** Positionen aller Modelle einer Plänklereinheit, auch der noch nicht gespeicherten. */
  private currentPositions(u: UnitState): Record<string, Point> {
    const positions: Record<string, Point> = {};
    for (const s of unitLayout(u, this.store.state.units).slots) positions[s.key] = { x: s.x + s.w / 2, y: s.y + s.d / 2 };
    return positions;
  }

  private describe(d: UnitDrag): string {
    const u = this.store.state.units[d.unitId];
    const turn = normAngle(u.rotation - d.srot);
    const deg = (turn * 180) / Math.PI;
    if (d.swing) {
      // Gemessen wird der Weg der äußeren Ecke
      const arc = Math.abs(turn) * d.swing.front;
      return Math.abs(deg) >= 0.5 ? `wheeled ${arc.toFixed(1)}″ (${Math.round(Math.abs(deg))}°)` : '';
    }
    const dist = Math.hypot(u.x - d.sx, u.y - d.sy);
    const parts: string[] = [];
    if (dist >= 0.05) parts.push(`moved ${dist.toFixed(1)}″`);
    if (Math.abs(deg) >= 0.5) parts.push(`turned ${Math.round(deg)}°`);
    return parts.join(' · ');
  }

  /** Umriss der Startposition, Linie zur neuen Position und Distanzanzeige. */
  private drawGuide(d: UnitDrag): void {
    const u = this.store.state.units[d.unitId];
    const view = this.views.get(d.unitId);
    if (!view) return;
    const c = Math.cos(d.srot);
    const s = Math.sin(d.srot);
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sy]) => {
      const lx = (sx * view.w) / 2;
      const ly = (sy * view.h) / 2;
      return [d.sx * PPI + lx * c - ly * s, d.sy * PPI + lx * s + ly * c];
    });
    this.guide.clear();
    this.guide.poly(pts).fill({ color: 0xffffff, alpha: 0.06 }).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
    if (d.swing) {
      // Drehpunkt und Bogen, den die äußere Ecke beschreibt
      const sw = d.swing;
      const r = sw.front * PPI;
      const a0 = Math.atan2(sw.cy - sw.py, sw.cx - sw.px);
      const turn = normAngle(u.rotation - d.srot);
      this.guide.arc(sw.px * PPI, sw.py * PPI, r, a0, a0 + turn, turn < 0).stroke({ width: 2, color: GUIDE_COLOR, alpha: 0.9 });
      this.guide.circle(sw.px * PPI, sw.py * PPI, 3).fill(GUIDE_COLOR);
    } else {
      this.guide.moveTo(d.sx * PPI, d.sy * PPI).lineTo(u.x * PPI, u.y * PPI).stroke({ width: 1.5, color: GUIDE_COLOR, alpha: 0.9 });
    }
    this.moveLabel.text = this.describe(d);
    // Charakter über einer eigenen Einheit: Einheit hervorheben
    const target = d.type === 'move' ? this.findJoinTarget(u) : null;
    const targetView = target ? this.views.get(target.id) : undefined;
    if (target && targetView) {
      const c = Math.cos(target.rotation);
      const s = Math.sin(target.rotation);
      const box = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sy]) => {
        const lx = (sx * targetView.w) / 2 + sx * 3;
        const ly = (sy * targetView.h) / 2 + sy * 3;
        return [target.x * PPI + lx * c - ly * s, target.y * PPI + lx * s + ly * c];
      });
      this.guide.poly(box).fill({ color: GUIDE_COLOR, alpha: 0.18 }).stroke({ width: 2, color: GUIDE_COLOR });
      this.moveLabel.text = `Release: join ${target.info.name}`;
    }
    this.moveLabel.scale.set(1 / this.world.scale.x);
    this.moveLabel.position.set(u.x * PPI, u.y * PPI - Math.max(view.w, view.h) / 2 - 2 * PPI);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(8, Math.max(this.minScale(), this.world.scale.x * f));
    const r = this.app.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const wx = (mx - this.world.x) / this.world.scale.x;
    const wy = (my - this.world.y) / this.world.scale.y;
    this.world.scale.set(ns);
    this.world.position.set(mx - wx * ns, my - wy * ns);
    this.clampView();
  }

  /** Tischpunkt (Zoll) in Einheitskoordinaten umrechnen (Front = −y). */
  private toUnitLocal(u: UnitState, p: Point): Point {
    const c = Math.cos(-u.rotation);
    const s = Math.sin(-u.rotation);
    const dx = p.x - u.x;
    const dy = p.y - u.y;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  /** Punkt in Einheitskoordinaten (Zoll, Front = −y) auf den Tisch umrechnen. */
  private unitPoint(u: UnitState, lx: number, ly: number): { x: number; y: number } {
    const c = Math.cos(u.rotation);
    const s = Math.sin(u.rotation);
    return { x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c };
  }

  private toInches(e: FederatedPointerEvent): { x: number; y: number } {
    const p = this.world.toLocal(e.global);
    return { x: p.x / PPI, y: p.y / PPI };
  }
}
