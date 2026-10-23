import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { Store } from '../model/store';
import type { UnitState } from '../model/types';
import { createTable } from './table';
import { GUIDE_COLOR, PPI } from './theme';
import { UnitView } from './unitView';

const DRAG_THRESHOLD = 3; // Pixel, ab denen ein Klick als Ziehen gilt
const ROTATE_SNAP = Math.PI / 12;

type Drag =
  | { type: 'pan'; gx: number; gy: number; wx: number; wy: number; moved: boolean }
  | { type: 'move' | 'rotate'; unitId: string; ox: number; oy: number; sx: number; sy: number; srot: number;
      gx: number; gy: number; moved: boolean };

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

    store.subscribe((state, { unitId }) => {
      if (unitId) {
        const u = state.units[unitId];
        if (u) this.syncUnit(u);
      } else {
        for (const [id, view] of this.views) {
          if (state.units[id]) continue;
          view.destroy({ children: true });
          this.views.delete(id);
          if (this.selectedId === id) this.select(null);
        }
        for (const u of Object.values(state.units)) this.syncUnit(u);
      }
    });
    for (const u of Object.values(store.state.units)) this.syncUnit(u);
  }

  select(unitId: string | null): void {
    const prev = this.selectedId;
    this.selectedId = unitId;
    for (const id of [prev, unitId]) {
      const u = id ? this.store.state.units[id] : undefined;
      if (u) this.syncUnit(u);
    }
    this.events.onSelect(unitId);
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
    let view = this.views.get(u.id);
    if (!view) {
      view = new UnitView(u.id);
      view.on('pointerdown', (e) => this.startUnitDrag(u.id, 'move', e));
      view.handle.on('pointerdown', (e) => this.startUnitDrag(u.id, 'rotate', e));
      this.views.set(u.id, view);
      this.unitLayer.addChild(view);
    }
    view.update(u, this.selectedId === u.id);
  }

  private startUnitDrag(unitId: string, type: 'move' | 'rotate', e: FederatedPointerEvent): void {
    e.stopPropagation();
    const u = this.store.state.units[unitId];
    const p = this.toInches(e);
    this.drag = { type, unitId, ox: u.x - p.x, oy: u.y - p.y, sx: u.x, sy: u.y, srot: u.rotation,
      gx: e.global.x, gy: e.global.y, moved: type === 'rotate' };
    const view = this.views.get(unitId);
    if (view && type === 'move') view.cursor = 'grabbing';
    if (this.selectedId !== unitId) this.select(unitId);
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
    if (d.type === 'move') {
      this.store.updateUnit(d.unitId, { x: p.x + d.ox, y: p.y + d.oy });
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
    if (d.moved) {
      const text = this.describe(d);
      if (text) this.events.onAction(d.unitId, text);
    }
    this.guide.clear();
    this.moveLabel.text = '';
  }

  private describe(d: Extract<Drag, { unitId: string }>): string {
    const u = this.store.state.units[d.unitId];
    const dist = Math.hypot(u.x - d.sx, u.y - d.sy);
    let deg = (((u.rotation - d.srot) * 180) / Math.PI) % 360;
    if (deg > 180) deg -= 360;
    if (deg < -180) deg += 360;
    const parts: string[] = [];
    if (dist >= 0.05) parts.push(`${dist.toFixed(1)}″ bewegt`);
    if (Math.abs(deg) >= 0.5) parts.push(`${Math.round(deg)}° gedreht`);
    return parts.join(' · ');
  }

  /** Umriss der Startposition, Linie zur neuen Position und Distanzanzeige. */
  private drawGuide(d: Extract<Drag, { unitId: string }>): void {
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
    this.guide.moveTo(d.sx * PPI, d.sy * PPI).lineTo(u.x * PPI, u.y * PPI).stroke({ width: 1.5, color: GUIDE_COLOR, alpha: 0.9 });
    this.moveLabel.text = this.describe(d);
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

  private toInches(e: FederatedPointerEvent): { x: number; y: number } {
    const p = this.world.toLocal(e.global);
    return { x: p.x / PPI, y: p.y / PPI };
  }
}
