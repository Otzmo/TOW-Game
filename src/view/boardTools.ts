import { Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import type { History } from '../model/history';
import { newObject, OBJECT_TYPES, objectPolygon, segmentHitsPolygon } from '../model/objects';
import { CENTRE_CIRCLE, circleBlocksDeployment, deploymentZones, TABLE_H, TABLE_W } from '../model/battlefield';
import { currentPhase } from '../model/phases';
import type { Store } from '../model/store';
import type { BoardObject, Point } from '../model/types';
import { ObjectView } from './objectView';
import { GUIDE_COLOR, OK_COLOR, PLAYER_COLORS, PPI, STRAY_COLOR } from './theme';

/** Auswählen und Ziehen, Messen, Sichtlinie prüfen, einen Punkt markieren (Ping) oder ein neues Objekt setzen. */
export type Tool = 'select' | 'measure' | 'sight' | 'ping' | { place: string };

/** Kennung dieses Geräts: eigenes Maßband nicht doppelt zeichnen */
const DEVICE = Math.random().toString(36).slice(2, 10);
/** So lange bleibt ein Ping sichtbar (ms) */
const PING_TIME = 5000;

const DRAG_THRESHOLD = 3;
const ROTATE_SNAP = Math.PI / 12;
const CAUTION_COLOR = 0xe0b44c;

type ObjectDrag =
  | { type: 'move'; id: string; ox: number; oy: number; gx: number; gy: number; moved: boolean }
  | { type: 'rotate' | 'size'; id: string; gx: number; gy: number; moved: boolean }
  | { type: 'measure' | 'sight'; id: string; a: Point; b: Point; gx: number; gy: number; moved: boolean;
    /** Liegendes Maßband anfassen: ein Ende oder die ganze Linie (from = Startpunkt des Zeigers) */
    grab?: 'a' | 'line'; from?: Point; a0?: Point; b0?: Point };

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
  /** Liegende Maßbänder beider Spieler (je Linie, Zahl und ×) und Pings */
  private readonly measureLayer = new Container();
  private readonly pingGraphics = new Graphics();
  private shownMeasures = '';
  private shownPing = 0;
  private lastSent = 0;
  private drag: ObjectDrag | null = null;
  tool: Tool = 'select';
  /** Zuschauer: nur auswählen und messen */
  readOnly = false;
  selectedId: string | null = null;
  /** Wird gerufen, wenn sich das Werkzeug ändert (für die Knöpfe) */
  onToolChange: (tool: Tool) => void = () => {};

  constructor(private store: Store, private history: History, private host: ToolHost) {
    this.toolLabel.anchor.set(0.5, 1);
    this.toolLayer.addChild(this.measureLayer, this.pingGraphics, this.toolGraphics, this.toolLabel);
    store.subscribe((state, change) => {
      if (change.objectId) this.syncObject(change.objectId);
      if (change.loaded) this.syncAll();
      if (change.meta || change.loaded || change.objectId) this.drawZones();
      if (change.meta) this.showShared();
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
    // Ping: mit dem Werkzeug oder Alt + Klick einen Punkt markieren, den beide sehen
    if (this.tool === 'ping' || e.altKey) {
      if (!this.readOnly) this.store.setMeta({ ping: { x: p.x, y: p.y, by: DEVICE, ts: Date.now() } });
      if (this.tool === 'ping') this.setTool('select');
      return true;
    }
    if (this.tool === 'measure' || this.tool === 'sight') {
      // Jedes neue Maßband kommt dazu; die alten bleiben liegen
      const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      this.drag = { type: this.tool, id, a: p, b: p, gx: e.global.x, gy: e.global.y, moved: false };
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
    // Liegende Maßbänder: × löscht, Ende anfassen = dieses Ende ziehen, Linie = ganzes Maßband verschieben
    if (!this.readOnly) {
      const near = 14 / (PPI * this.host.worldScale());
      for (const [id, m] of Object.entries(this.store.state.meta.measures ?? {}).reverse()) {
        const x = this.deletePoint(m);
        if (Math.hypot(p.x - x.x, p.y - x.y) <= near) {
          this.removeMeasure(id);
          return true;
        }
        const base = { type: m.type, id, a: m.a, b: m.b, gx: e.global.x, gy: e.global.y, moved: false };
        if (Math.hypot(p.x - m.b.x, p.y - m.b.y) <= near) this.drag = { ...base };
        else if (Math.hypot(p.x - m.a.x, p.y - m.a.y) <= near) this.drag = { ...base, grab: 'a' };
        else if (distToSegment(p, m.a, m.b) <= near * 0.7) this.drag = { ...base, grab: 'line', from: p, a0: m.a, b0: m.b };
        if (this.drag) {
          this.showShared();
          this.drawMeasure(m.type, m.a, m.b);
          return true;
        }
      }
    }
    return false;
  }

  /** Stelle des ×-Knopfs eines Maßbands: kurz hinter dem Endpunkt, in Bildschirmgröße gleich */
  private deletePoint(m: { a: Point; b: Point }): Point {
    const len = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) || 1;
    const off = 16 / (PPI * this.host.worldScale());
    return { x: m.b.x + ((m.b.x - m.a.x) / len) * off, y: m.b.y + ((m.b.y - m.a.y) / len) * off };
  }

  handleMove(e: FederatedPointerEvent): boolean {
    const d = this.drag;
    if (!d) return false;
    if (!d.moved && Math.hypot(e.global.x - d.gx, e.global.y - d.gy) < DRAG_THRESHOLD) return true;
    d.moved = true;
    const p = this.host.toInches(e);
    if ('a' in d) {
      if (d.grab === 'line' && d.from && d.a0 && d.b0) {
        const dx = p.x - d.from.x;
        const dy = p.y - d.from.y;
        d.a = { x: d.a0.x + dx, y: d.a0.y + dy };
        d.b = { x: d.b0.x + dx, y: d.b0.y + dy };
      } else if (d.grab === 'a') d.a = p;
      else d.b = p;
      this.drawMeasure(d.type, d.a, d.b);
      // Für den Mitspieler: höchstens alle 150 ms senden
      if (Date.now() - this.lastSent > 150) this.sendMeasure(d.id, d.type, d.a, d.b);
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
    if ('a' in d) {
      // Das Maßband bleibt als Markierung auf dem Tisch liegen (für beide), bis es über sein × gelöscht wird
      if (d.moved) this.sendMeasure(d.id, d.type, d.a, d.b);
      this.setTool('select');
      this.showShared(true);
    }
    return true;
  }

  private sendMeasure(id: string, type: 'measure' | 'sight', a: Point, b: Point): void {
    if (this.readOnly) return;
    this.lastSent = Date.now();
    this.store.setMeta({ measures: { ...this.store.state.meta.measures, [id]: { type, a, b, by: DEVICE, ts: this.lastSent } } });
  }

  private removeMeasure(id: string): void {
    const { [id]: _, ...rest } = this.store.state.meta.measures ?? {};
    this.store.setMeta({ measures: rest });
  }

  /** Alle Maßbänder entfernen (für beide). true = es lag mindestens eins */
  clearMeasure(): boolean {
    if (!Object.keys(this.store.state.meta.measures ?? {}).length) return false;
    this.store.setMeta({ measures: {} });
    return true;
  }

  /**
   * Liegende Maßbänder (mit ×) und Pings zeigen. Das Maßband, das man gerade selbst zieht, zeichnet
   * drawMeasure direkt; es fehlt deshalb hier.
   */
  showShared(force = false): void {
    const { measures, ping } = this.store.state.meta;
    const dragging = this.drag && 'a' in this.drag ? this.drag.id : null;
    const key = `${JSON.stringify(measures ?? {})}|${dragging}|${this.host.worldScale().toFixed(3)}`;
    if (force || key !== this.shownMeasures) {
      this.shownMeasures = key;
      this.measureLayer.removeChildren().forEach((c) => c.destroy());
      for (const [id, m] of Object.entries(measures ?? {})) {
        if (id === dragging) continue;
        const g = new Graphics();
        const label = new Text({ text: '', style: this.toolLabel.style.clone(), resolution: 2 });
        label.anchor.set(0.5, 1);
        this.drawMeasure(m.type, m.a, m.b, g, label);
        // × zum Löschen hinter dem Endpunkt
        const x = this.deletePoint(m);
        const s = 1 / this.host.worldScale();
        g.circle(x.x * PPI, x.y * PPI, 8 * s).fill({ color: 0x2a2e32 }).stroke({ width: 1.5 * s, color: 0xf0603e });
        g.moveTo(x.x * PPI - 3.5 * s, x.y * PPI - 3.5 * s).lineTo(x.x * PPI + 3.5 * s, x.y * PPI + 3.5 * s)
          .moveTo(x.x * PPI + 3.5 * s, x.y * PPI - 3.5 * s).lineTo(x.x * PPI - 3.5 * s, x.y * PPI + 3.5 * s)
          .stroke({ width: 2 * s, color: 0xf0603e });
        this.measureLayer.addChild(g, label);
      }
    }
    if (ping && ping.ts !== this.shownPing && Date.now() - ping.ts < PING_TIME) {
      this.shownPing = ping.ts;
      this.animatePing(ping.x, ping.y, ping.ts);
    }
  }

  /** Ping: pulsierende Ringe an der Stelle, einige Sekunden lang */
  private animatePing(x: number, y: number, ts: number): void {
    const g = this.pingGraphics;
    const frame = () => {
      if (this.shownPing !== ts) return;
      const t = Date.now() - ts;
      g.clear();
      if (t > PING_TIME) return;
      const s = 1 / this.host.worldScale();
      for (let k = 0; k < 3; k++) {
        const phase = ((t / 900) + k / 3) % 1;
        g.circle(x * PPI, y * PPI, (6 + phase * 30) * s).stroke({ width: 3 * s, color: 0x4fd1ff, alpha: 1 - phase });
      }
      g.circle(x * PPI, y * PPI, 4 * s).fill(0x4fd1ff);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
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
    this.select(id);
  }

  // --- Maßband und Sichtlinie -------------------------------------------------

  private clearToolDrawing(): void {
    this.toolGraphics.clear();
    this.toolLabel.text = '';
  }

  private drawMeasure(type: 'measure' | 'sight', a: Point, b: Point, g = this.toolGraphics, label = this.toolLabel): void {
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
    label.text = text;
    label.style.fill = color;
    label.scale.set(1 / this.host.worldScale());
    label.position.set(b.x * PPI, b.y * PPI - 8 / this.host.worldScale());
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

/** Abstand eines Punktes zur Strecke a–b (Zoll) */
function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
