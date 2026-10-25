import { Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { History } from '../model/history';
import { newObject, OBJECT_TYPES, objectPolygon, segmentHitsPolygon } from '../model/objects';
import { CENTRE_CIRCLE, circleBlocksDeployment, deploymentZones, TABLE_H, TABLE_W } from '../model/battlefield';
import { currentPhase } from '../model/phases';
import type { Store } from '../model/store';
import type { BoardObject, Point } from '../model/types';
import { ObjectView } from './objectView';
import { GUIDE_COLOR, OK_COLOR, PLAYER_COLORS, PPI, STRAY_COLOR } from './theme';

/** Auswählen und Ziehen, Messen, Sichtlinie prüfen oder ein neues Objekt setzen. */
export type Tool = 'select' | 'measure' | 'sight' | { place: string };

const DRAG_THRESHOLD = 3;
const ROTATE_SNAP = Math.PI / 12;
const CAUTION_COLOR = 0xe0b44c;

type ObjectDrag =
  | { type: 'move'; id: string; ox: number; oy: number; gx: number; gy: number; moved: boolean }
  | { type: 'rotate' | 'size'; id: string; gx: number; gy: number; moved: boolean }
  | { type: 'measure' | 'sight'; a: Point; b: Point; gx: number; gy: number; moved: boolean };

export interface ToolHost {
  /** Mauszeiger in Tischkoordinaten (Zoll) */
  toInches(e: FederatedPointerEvent): Point;
  worldScale(): number;
  /** Einheiten anklickbar machen oder nicht (beim Messen sollen Klicks durchgehen) */
  setUnitsInteractive(on: boolean): void;
  /** Wird gerufen, wenn ein Objekt ausgewählt wird; die Einheitenauswahl soll dann weg */
  onSelectObject(id: string | null): void;
}

/** Gelände, Marker, Schablonen, Aufstellungszonen sowie Maßband und Sichtlinie. */
export class BoardTools {
  /** Aufstellungszonen, Mittelkreis, Viertel (Domination) und Kontrollradien der Missionsziele */
  readonly zoneLayer = new Container();
  readonly terrainLayer = new Container();
  readonly overlayLayer = new Container();
  readonly toolLayer = new Container();
  private readonly toolGraphics = new Graphics();
  private readonly toolLabel = new Text({
    text: '',
    style: { fontFamily: 'system-ui', fontSize: 18, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
    resolution: 2,
  });
  private readonly views = new Map<string, ObjectView>();
  private drag: ObjectDrag | null = null;
  tool: Tool = 'select';
  /** Zuschauer: nur auswählen und messen */
  readOnly = false;
  selectedId: string | null = null;
  /** Wird gerufen, wenn sich das Werkzeug ändert (für die Knöpfe) */
  onToolChange: (tool: Tool) => void = () => {};

  constructor(private store: Store, private history: History, private host: ToolHost) {
    this.toolLabel.anchor.set(0.5, 1);
    this.toolLayer.addChild(this.toolGraphics, this.toolLabel);
    store.subscribe((state, change) => {
      if (change.objectId) this.syncObject(change.objectId);
      if (change.loaded) this.syncAll();
      if (change.meta || change.loaded || change.objectId) this.drawZones();
      void state;
    });
    this.syncAll();
    this.drawZones();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.clearToolDrawing();
    const free = tool !== 'select';
    this.host.setUnitsInteractive(!free);
    this.terrainLayer.eventMode = free ? 'none' : 'passive';
    this.overlayLayer.eventMode = free ? 'none' : 'passive';
    this.onToolChange(tool);
  }

  select(id: string | null): void {
    const prev = this.selectedId;
    this.selectedId = id;
    if (prev) this.syncObject(prev);
    if (id) this.syncObject(id);
    this.drawZones();
    this.host.onSelectObject(id);
  }

  removeSelected(): void {
    if (!this.selectedId || this.readOnly) return;
    this.history.record();
    this.store.removeObject(this.selectedId);
    this.select(null);
  }

  // --- Ereignisse vom Spielfeld ---------------------------------------------

  /** Klick auf freien Tisch: Messen beginnen oder Objekt setzen. true = erledigt. */
  handleStageDown(e: FederatedPointerEvent): boolean {
    const p = this.host.toInches(e);
    if (this.tool === 'measure' || this.tool === 'sight') {
      this.drag = { type: this.tool, a: p, b: p, gx: e.global.x, gy: e.global.y, moved: false };
      return true;
    }
    if (typeof this.tool === 'object') {
      if (this.readOnly) return true;
      const obj = newObject(this.tool.place, p);
      this.history.record();
      this.store.setObject(obj);
      this.setTool('select');
      this.select(obj.id);
      return true;
    }
    if (this.selectedId) this.select(null);
    return false;
  }

  handleMove(e: FederatedPointerEvent): boolean {
    const d = this.drag;
    if (!d) return false;
    if (!d.moved && Math.hypot(e.global.x - d.gx, e.global.y - d.gy) < DRAG_THRESHOLD) return true;
    d.moved = true;
    const p = this.host.toInches(e);
    if ('a' in d) {
      d.b = p;
      this.drawMeasure(d.type, d.a, d.b);
      return true;
    }
    const o = this.store.state.objects[d.id];
    if (!o) return true;
    if (d.type === 'move') {
      this.store.updateObject(d.id, { x: p.x + d.ox, y: p.y + d.oy });
    } else if (d.type === 'rotate') {
      let a = Math.atan2(p.y - o.y, p.x - o.x) + Math.PI / 2;
      if (e.shiftKey) a = Math.round(a / ROTATE_SNAP) * ROTATE_SNAP;
      this.store.updateObject(d.id, { rotation: a });
    } else {
      // Größe: Abstand des Zeigers zur Mitte in Objektrichtung
      const c = Math.cos(-o.rotation);
      const s = Math.sin(-o.rotation);
      const lx = (p.x - o.x) * c - (p.y - o.y) * s;
      const ly = (p.x - o.x) * s + (p.y - o.y) * c;
      this.store.updateObject(d.id, { w: Math.max(0.5, Math.abs(lx) * 2), h: Math.max(0.5, Math.abs(ly) * 2) });
    }
    return true;
  }

  handleUp(): boolean {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    if (!('a' in d) && !d.moved) this.history.dropIfUnchanged();
    return true;
  }

  // --- Objekte ----------------------------------------------------------------

  private syncAll(): void {
    for (const [id, view] of this.views) {
      if (this.store.state.objects[id]) continue;
      view.destroy({ children: true });
      this.views.delete(id);
    }
    for (const id of Object.keys(this.store.state.objects)) this.syncObject(id);
    if (this.selectedId && !this.store.state.objects[this.selectedId]) this.select(null);
  }

  private syncObject(id: string): void {
    const o = this.store.state.objects[id];
    let view = this.views.get(id);
    if (!o) {
      view?.destroy({ children: true });
      this.views.delete(id);
      if (this.selectedId === id) this.select(null);
      return;
    }
    if (!view) {
      view = new ObjectView(id);
      view.on('pointerdown', (e) => this.startDrag(id, 'move', e));
      view.handle.on('pointerdown', (e) => this.startDrag(id, 'rotate', e));
      view.sizeHandle.on('pointerdown', (e) => this.startDrag(id, 'size', e));
      this.views.set(id, view);
      // Gelände liegt unter den Einheiten, Marker und Schablonen darüber
      (o.kind === 'terrain' ? this.terrainLayer : this.overlayLayer).addChild(view);
    }
    view.update(o, this.selectedId === id);
  }

  private startDrag(id: string, type: 'move' | 'rotate' | 'size', e: FederatedPointerEvent): void {
    if (this.tool !== 'select') return;
    e.stopPropagation();
    if (this.readOnly) {
      this.select(id);
      return;
    }
    const o = this.store.state.objects[id];
    const p = this.host.toInches(e);
    this.history.record();
    this.drag = type === 'move'
      ? { type, id, ox: o.x - p.x, oy: o.y - p.y, gx: e.global.x, gy: e.global.y, moved: false }
      : { type, id, gx: e.global.x, gy: e.global.y, moved: false };
    if (this.selectedId !== id) this.select(id);
  }

  // --- Maßband und Sichtlinie -------------------------------------------------

  private clearToolDrawing(): void {
    this.toolGraphics.clear();
    this.toolLabel.text = '';
  }

  private drawMeasure(type: 'measure' | 'sight', a: Point, b: Point): void {
    const g = this.toolGraphics;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    let color = GUIDE_COLOR;
    let text = `${dist.toFixed(1)}″`;
    if (type === 'sight') {
      // Gelände auf der Linie: blockierend (Gebäude) oder Deckung (Wald, Mauer)
      const crossed = Object.values(this.store.state.objects)
        .filter((o) => o.kind === 'terrain' && OBJECT_TYPES[o.type]?.sight)
        .filter((o) => segmentHitsPolygon(a, b, objectPolygon(o)));
      const blocks = crossed.filter((o) => OBJECT_TYPES[o.type].sight === 'blocks');
      const names = (list: BoardObject[]) => [...new Set(list.map((o) => o.label || OBJECT_TYPES[o.type].name))].join(', ');
      if (blocks.length) {
        color = STRAY_COLOR;
        text += ` · blocked by ${names(blocks)}`;
      } else if (crossed.length) {
        color = CAUTION_COLOR;
        text += ` · through ${names(crossed)} (cover)`;
      } else {
        color = OK_COLOR;
        text += ' · clear line of sight';
      }
    }
    g.clear();
    g.moveTo(a.x * PPI, a.y * PPI).lineTo(b.x * PPI, b.y * PPI).stroke({ width: 2, color, alpha: 0.95 });
    g.circle(a.x * PPI, a.y * PPI, 3).fill(color).circle(b.x * PPI, b.y * PPI, 3).fill(color);
    // Zollmarken entlang des Maßbands
    if (type === 'measure') {
      const ux = (b.x - a.x) / (dist || 1);
      const uy = (b.y - a.y) / (dist || 1);
      for (let i = 1; i < dist; i++) {
        const x = (a.x + ux * i) * PPI;
        const y = (a.y + uy * i) * PPI;
        const t = i % 6 === 0 ? 5 : 2.5;
        g.moveTo(x - uy * t, y + ux * t).lineTo(x + uy * t, y - ux * t);
      }
      g.stroke({ width: 1, color, alpha: 0.9 });
    }
    this.toolLabel.text = text;
    this.toolLabel.style.fill = color;
    this.toolLabel.scale.set(1 / this.host.worldScale());
    this.toolLabel.position.set(b.x * PPI, b.y * PPI - 8 / this.host.worldScale());
  }

  // --- Aufstellungszonen ------------------------------------------------------

  private drawZones(): void {
    this.zoneLayer.removeChildren().forEach((c) => c.destroy());
    const setup = this.store.state.meta.setup;
    const zones = deploymentZones(setup);
    if (!zones) return;
    const g = new Graphics();
    this.zoneLayer.addChild(g);
    const label = (text: string, p: Point, color: number) => {
      const t = new Text({ text, style: { fontFamily: 'system-ui', fontSize: 20, fontWeight: '700', fill: color, stroke: { color: 0x000000, width: 4 } }, resolution: 4 });
      t.anchor.set(0.5);
      t.alpha = 0.85;
      t.position.set(p.x * PPI, p.y * PPI);
      this.zoneLayer.addChild(t);
    };
    // Zonen nach Rolle; sobald Angreifer und Verteidiger feststehen, in Spielerfarben
    const defender = setup?.defender;
    for (const p of ['p1', 'p2'] as const) {
      const pts = zones[p];
      const colors = defender ? PLAYER_COLORS[p] : { fill: 0xb9b2a0, edge: 0xe8e6e3 };
      g.poly(pts.flatMap((pt) => [pt.x * PPI, pt.y * PPI])).fill({ color: colors.fill, alpha: 0.2 }).stroke({ width: 2, color: colors.edge, alpha: 0.55 });
      const c = { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
      const role = (defender ?? 'p2') === p ? 'Defender' : 'Attacker';
      const name = `${role} zone`;
      label(name, c, colors.edge);
    }
    // Mittelkreis nur, wenn er die Aufstellung sperrt (Close Encounter), und nur in der Aufstellung
    if (circleBlocksDeployment(setup) && currentPhase(this.store.state.meta) === 'setup') {
      g.circle((TABLE_W / 2) * PPI, (TABLE_H / 2) * PPI, (CENTRE_CIRCLE / 2) * PPI).stroke({ width: 1.5, color: 0xffffff, alpha: 0.6 });
      label('No deployment', { x: TABLE_W / 2, y: TABLE_H / 2 - CENTRE_CIRCLE / 2 + 1.5 }, 0xffffff);
    }
    // Domination: Tischviertel
    if (setup?.missionTurn === 'domination') {
      g.moveTo((TABLE_W / 2) * PPI, 0).lineTo((TABLE_W / 2) * PPI, TABLE_H * PPI)
        .moveTo(0, (TABLE_H / 2) * PPI).lineTo(TABLE_W * PPI, (TABLE_H / 2) * PPI)
        .stroke({ width: 1.5, color: 0xe0b44c, alpha: 0.45 });
    }
    // 6″ Kontrollradius nur um das angeklickte Missionsziel
    const sel = this.selectedId ? this.store.state.objects[this.selectedId] : undefined;
    if (sel?.type === 'objective') g.circle(sel.x * PPI, sel.y * PPI, 6 * PPI).stroke({ width: 1.5, color: 0xe0b44c, alpha: 0.8 });
  }
}
