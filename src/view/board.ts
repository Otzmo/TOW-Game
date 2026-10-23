import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import {
  isJoined, isSkirmish, nearestGap, recenter, SKIRMISH_GAP, unitFootprint, unitLayout, type Store,
} from '../model/store';
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

/** Winkel auf (−π, π] bringen. */
const normAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface BoardEvents {
  onSelect(unitId: string | null): void;
  onAction(unitId: string, description: string): void;
}

/** Spielfeld: Tisch, Einheiten, Kamera und Maussteuerung. */
export class Board {
  readonly world = new Container();
  private readonly unitLayer = new Container();
  private readonly guide = new Graphics();
  private readonly moveLabel = new Text({
    text: '',
    style: { fontFamily: 'system-ui', fontSize: 14, fontWeight: '600', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
    resolution: 2,
  });
  private readonly views = new Map<string, UnitView>();
  private drag: Drag | null = null;
  selectedId: string | null = null;

  constructor(private app: Application, private store: Store, private events: BoardEvents) {
    const { table } = store.state;
    app.stage.addChild(this.world);
    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;

    this.moveLabel.anchor.set(0.5, 1);
    this.world.addChild(createTable(table.width, table.height), this.guide, this.unitLayer, this.moveLabel);

    app.stage.on('pointerdown', (e) => {
      this.drag = { type: 'pan', gx: e.global.x, gy: e.global.y, wx: this.world.x, wy: this.world.y, moved: false };
    });
    app.stage.on('globalpointermove', (e) => this.onPointerMove(e));
    app.stage.on('pointerup', () => this.endDrag());
    app.stage.on('pointerupoutside', () => this.endDrag());
    app.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    store.subscribe((state, { unitId, patch }) => {
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
    this.syncAll();
    this.events.onSelect(unitId);
  }

  /** Charakter aus seiner Einheit lösen und vor deren Front stellen. */
  detachCharacter(charId: string): void {
    const units = this.store.state.units;
    const c = units[charId];
    const host = c?.joinedTo ? units[c.joinedTo] : undefined;
    if (!c || !host) return;
    const { h } = unitFootprint(host, units);
    const depth = c.info.baseDepth / 25.4;
    const p = this.unitPoint(host, 0, -h / 2 - depth / 2 - 0.5);
    this.store.updateUnit(charId, { joinedTo: null, x: p.x, y: p.y, rotation: host.rotation });
    if (host.positions?.[charId]) {
      const { [charId]: _, ...rest } = host.positions;
      this.store.updateUnit(host.id, recenter(host, this.store.state.units, rest));
    }
    this.events.onAction(charId, `hat ${host.info.name} verlassen`);
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
  }

  /** Kamera auf einen Punkt (in Zoll) zentrieren. */
  focus(x: number, y: number, scale: number, screenFraction = 0.5): void {
    this.world.scale.set(scale);
    this.world.position.set(
      this.app.screen.width * screenFraction - x * PPI * scale,
      this.app.screen.height / 2 - y * PPI * scale,
    );
  }

  private syncUnit(u: UnitState): void {
    const units = this.store.state.units;
    let view = this.views.get(u.id);
    if (!view) {
      const v = new UnitView(u.id);
      view = v;
      v.on('pointerdown', (e) => {
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
  }

  /**
   * pivotSide: 1 = um die rechte vordere Ecke schwenken, −1 = um die linke.
   * selectId: was ausgewählt wird (z. B. ein angeschlossener Charakter), sonst die Einheit selbst.
   */
  private startUnitDrag(unitId: string, type: UnitDragType, e: FederatedPointerEvent, pivotSide = 1,
    selectId = unitId): void {
    e.stopPropagation();
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
    this.drag = { type, unitId, ox: u.x - p.x, oy: u.y - p.y, sx: u.x, sy: u.y, srot: u.rotation,
      gx: e.global.x, gy: e.global.y, moved: type !== 'move', swing };
    const view = this.views.get(unitId);
    if (view && type === 'move') view.cursor = 'grabbing';
    if (this.selectedId !== selectId) this.select(selectId);
  }

  private startModelDrag(unitId: string, key: string, e: FederatedPointerEvent, charId?: string): void {
    e.stopPropagation();
    const units = this.store.state.units;
    const u = units[unitId];
    const layout = unitLayout(u, units);
    // Alle aktuellen Positionen festhalten, auch gerade erst erzeugte
    const startPositions: Record<string, Point> = {};
    for (const s of layout.slots) startPositions[s.key] = { x: s.x + s.w / 2, y: s.y + s.d / 2 };
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
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.global.x - d.gx, e.global.y - d.gy) < DRAG_THRESHOLD) return;
    d.moved = true;

    if (d.type === 'pan') {
      this.world.position.set(d.wx + e.global.x - d.gx, d.wy + e.global.y - d.gy);
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
    if (!d.moved) return;
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
      this.events.onAction(d.unitId, `hat sich ${target.info.name} angeschlossen`);
      return;
    }
    const text = this.describe(d);
    if (text) this.events.onAction(d.unitId, text);
  }

  /** Plänkler loslassen: nur erlaubt, wenn dadurch kein Modell mehr als 1″ vom Rest entfernt ist. */
  private endModelDrag(d: ModelDrag): void {
    const units = this.store.state.units;
    const u = units[d.unitId];
    const layout = unitLayout(u, units);
    // Bei einem angeschlossenen Charakter steht die Meldung in dessen Panel
    const actor = units[d.key] ? d.key : d.unitId;
    if (layout.stray.size > d.startStray) {
      this.store.updateUnit(d.unitId, { positions: d.startPositions });
      this.events.onAction(actor, `zurückgesetzt: mehr als ${SKIRMISH_GAP}″ vom Rest der Einheit`);
      return;
    }
    const end = u.positions?.[d.key] ?? d.start;
    const dist = Math.hypot(end.x - d.start.x, end.y - d.start.y);
    this.store.updateUnit(d.unitId, recenter(u, units, u.positions ?? d.startPositions));
    this.events.onAction(actor, `Modell ${dist.toFixed(1)}″ bewegt`);
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
      `${near.toFixed(1)}″ zum nächsten Modell${tooFar ? ' – zu weit!' : ''}`;
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
      return Math.abs(deg) >= 0.5 ? `${arc.toFixed(1)}″ geschwenkt (${Math.round(Math.abs(deg))}°)` : '';
    }
    const dist = Math.hypot(u.x - d.sx, u.y - d.sy);
    const parts: string[] = [];
    if (dist >= 0.05) parts.push(`${dist.toFixed(1)}″ bewegt`);
    if (Math.abs(deg) >= 0.5) parts.push(`${Math.round(deg)}° gedreht`);
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
      this.moveLabel.text = `Loslassen: ${target.info.name} anschließen`;
    }
    this.moveLabel.scale.set(1 / this.world.scale.x);
    this.moveLabel.position.set(u.x * PPI, u.y * PPI - Math.max(view.w, view.h) / 2 - 2 * PPI);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(8, Math.max(0.3, this.world.scale.x * f));
    const r = this.app.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const wx = (mx - this.world.x) / this.world.scale.x;
    const wy = (my - this.world.y) / this.world.scale.y;
    this.world.scale.set(ns);
    this.world.position.set(mx - wx * ns, my - wy * ns);
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
