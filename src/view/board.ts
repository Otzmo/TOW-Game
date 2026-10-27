import { Application, Container, FederatedPointerEvent, Graphics, Text } from 'pixi.js';
import { BoardTools } from './boardTools';
import { Camera } from './camera';
import { helperOn } from './helpers';
import { drawCharges as paintCharges, drawRanges as paintRanges } from './overlays';
import {
  alignToBases, chargePathCheck, chargeTravel, contactPoses, minChargeDistance, toLocal, toTable,
} from '../model/flow';
import {
  isJoined, isNonUnitChange, isSkirmish, nearestGap, recenter, SKIRMISH_GAP, unitFootprint, unitLayout, type Store,
} from '../model/store';
import { keepApart, overlappingUnits, type Pose } from '../model/collision';
import type { History } from '../model/history';
import { currentPhase } from '../model/phases';
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
  onSelectObject(objectId: string | null): void;
  onAction(unitId: string, description: string): void;
}

/** Abstand, ab dem eine Einheit beim Loslassen an eine gegnerische Kante angelegt wird (Zoll) */
const CHARGE_SNAP = 1;

/** Spielfeld: Tisch, Einheiten, Kamera und Maussteuerung. */
export class Board {
  readonly world = new Container();
  readonly tools: BoardTools;
  readonly camera: Camera;
  private readonly unitLayer = new Container();
  private readonly rangeLayer = new Container();
  /** Angriffspfeile: wer wen angreift, mit Reaktion und Ergebnis */
  private readonly chargeLayer = new Container();
  /** Zielauswahl beim Angriff ansagen: nächster Klick auf eine Einheit */
  private pickTarget: ((unitId: string) => void) | null = null;
  /** Einheit aus dem Hinterhalt, die beim nächsten Klick auf den Tisch aufgestellt wird */
  private placeUnit: string | null = null;
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
  /** Zoll, die eine Einheit in dieser Runde nacheinander zurückgelegt hat (Schwenken + Bewegen) */
  private moveRun: { unitId: string; total: number; round: number } | null = null;
  /** In welchem Spielerzug eine Einheit zuletzt bewegt wurde (für „Moving & Shooting“ beim Beschuss) */
  private readonly moved = new Map<string, string>();
  private turnKey = () => `${this.store.state.meta.round}-${this.store.state.meta.active}`;

  /** Hat sich die Einheit in diesem Spielerzug bewegt (auf diesem Gerät gezogen)? */
  movedThisTurn(unitId: string): boolean {
    return this.moved.get(unitId) === this.turnKey();
  }
  selectedId: string | null = null;

  constructor(app: Application, private store: Store, private history: History, private events: BoardEvents) {
    const { table } = store.state;
    app.stage.addChild(this.world);
    // Drehpunkt ist die Tischmitte: so lässt sich die Ansicht für den zweiten Spieler um 180° drehen
    // Zahlen und × der Maßbänder bleiben nach jedem Zoomen auf dem Bildschirm gleich groß
    this.camera = new Camera(app, this.world, table, () => this.tools?.showShared());
    app.ticker.add(() => {
      // Einheiten gleiten zur neuen Stelle, Auswahl und Flucht pulsieren
      const now = performance.now();
      for (const v of this.views.values()) v.tick(now);
    });
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
      // Einheit aus dem Hinterhalt: dort aufstellen, wo geklickt wird
      if (this.placeUnit) {
        const id = this.placeUnit;
        this.placeUnit = null;
        document.getElementById('tool-hint')!.hidden = true;
        this.placeFromAmbush(id, this.toInches(e));
        return;
      }
      if (this.tools.handleStageDown(e)) return;
      this.drag = { type: 'pan', gx: e.global.x, gy: e.global.y, wx: this.world.x, wy: this.world.y, moved: false };
    });
    app.stage.on('globalpointermove', (e) => this.onPointerMove(e));
    app.stage.on('pointerup', () => this.endDrag());
    app.stage.on('pointerupoutside', () => this.endDrag());

    store.subscribe((state, change) => {
      if (change.chargeId || change.loaded || change.meta) this.drawCharges();
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
    const before = this.selectedId;
    this.selectedId = unitId;
    if (unitId && this.tools.selectedId) this.tools.select(null);
    // Nur die alte und die neue Auswahl neu zeichnen; angeschlossene Charaktere zeichnet ihre Einheit
    const units = this.store.state.units;
    const redraw = new Set<string>();
    for (const id of [before, unitId]) {
      const u = id ? units[id] : undefined;
      if (!u) continue;
      redraw.add(u.id);
      if (u.joinedTo && units[u.joinedTo]) redraw.add(u.joinedTo);
    }
    for (const id of redraw) this.syncUnit(units[id]);
    this.drawRanges();
    this.drawCharges();
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
    const p = toTable(host, 0, -h / 2 - depth / 2 - 0.5);
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

  /** Ziel wählen (Angriff, Beschuss, Nahkampf): Hinweis zeigen und den nächsten Klick auf eine gegnerische Einheit abwarten. */
  startChargePick(chargerId: string, onPick: (targetId: string) => void, action = 'Charge'): void {
    const charger = this.store.state.units[chargerId];
    if (!charger) return;
    this.tools.setTool('select');
    this.pickTarget = (id) => {
      const t = this.store.state.units[id];
      if (t && t.owner !== charger.owner) onPick(id);
    };
    const hint = document.getElementById('tool-hint')!;
    hint.textContent = `${action} by ${charger.info.name}: click an enemy unit · Esc to cancel`;
    hint.hidden = false;
  }

  cancelPick(): boolean {
    if (!this.pickTarget && !this.placeUnit) return false;
    this.pickTarget = null;
    this.placeUnit = null;
    document.getElementById('tool-hint')!.hidden = true;
    return true;
  }

  /** Einheit aus dem Hinterhalt aufstellen: der nächste Klick auf den Tisch bestimmt die Stelle */
  startAmbushPlace(unitId: string): void {
    const u = this.store.state.units[unitId];
    if (!u?.ambush || !this.canMove(unitId)) return;
    this.tools.setTool('select');
    this.pickTarget = null;
    this.placeUnit = unitId;
    const hint = document.getElementById('tool-hint')!;
    hint.textContent = `Ambush: click on the table to place ${u.info.name} · Esc to cancel`;
    hint.hidden = false;
  }

  private placeFromAmbush(unitId: string, p: Point): void {
    const u = this.store.state.units[unitId];
    if (!u) return;
    this.history.record();
    this.store.updateUnit(unitId, { ambush: null, x: p.x, y: p.y });
    // Landet sie auf einem Gegner, wird sie angelegt; auf einer eigenen Einheit bleibt der Hinweis im Log
    const apart = this.separate(unitId, { x: p.x, y: p.y, rotation: u.rotation });
    this.select(unitId);
    this.events.onAction(unitId, `arrives from ambush${apart ? ` · ${apart}` : ''}`);
  }

  /**
   * Angriff ansagen: Distanz wird berechnet und als Pfeil für beide Spieler gezeigt; ausgeführt wird er
   * mit chargeMove. Bis zum Ende der Runde bleibt der Pfeil stehen.
   */
  declareCharge(chargerId: string, targetId: string): void {
    const { units } = this.store.state;
    const charger = units[chargerId];
    const target = units[targetId];
    if (!charger || !target) return;
    // Mindestens nötig für Kontakt, und nötig für die Stellung mit maximiertem Kontakt
    const round1 = (v: number) => Math.round(v * 10) / 10;
    const distance = round1(minChargeDistance(charger, target, units));
    const pose = this.maximisedPose(charger, target);
    const maxDistance = pose ? round1(chargeTravel(charger, pose, units)) : null;
    const id = `charge-${chargerId}`;
    this.store.setCharge(id, { id, charger: chargerId, target: targetId, round: this.store.state.meta.round,
      status: 'declared', distance, maxDistance });
    this.events.onAction(chargerId, `declares a charge against ${target.info.name} – contact from ${distance.toFixed(1)}″`
      + (maxDistance != null ? `, maximised at ${maxDistance.toFixed(1)}″` : ''));
  }

  /** Stellung mit maximiertem Kontakt, an der der Angreifer Platz hat (ohne andere Einheiten zu überlappen) */
  private maximisedPose(charger: UnitState, target: UnitState) {
    const { units } = this.store.state;
    const free = contactPoses(charger, target, units)
      .filter((p) => !overlappingUnits({ ...charger, x: p.x, y: p.y, rotation: p.rotation }, units).length);
    if (helperOn('maximise') || !free.length) return free[0];
    // Ohne Maximieren: an der zugewandten Kante so wenig seitlich verschieben wie möglich (gerade hinein)
    return free.filter((p) => p.side === free[0].side).sort((a, b) => a.shift - b.shift)[0];
  }

  /** Angriffsbewegung: an die zugewandte Kante des Ziels, bündig an den Base-Grenzen */
  chargeMove(chargerId: string): void {
    const { units, charges } = this.store.state;
    const c = charges[`charge-${chargerId}`];
    const charger = units[chargerId];
    const target = c ? units[c.target] : undefined;
    if (!c || !charger || !target || !this.canMove(chargerId)) return;
    // Erste Kante, an der der Angreifer Platz hat (ohne andere Einheiten zu überlappen)
    const pose = this.maximisedPose(charger, target);
    if (!pose) {
      this.events.onAction(chargerId, `cannot reach ${target.info.name}: no room at any edge`);
      return;
    }
    // Regel 3: einmal schwenken, sonst gerade – sonst Warnung (die Bewegung wird trotzdem ausgeführt)
    const path = chargePathCheck(charger, pose, units);
    this.history.record();
    this.store.updateUnit(chargerId, { x: pose.x, y: pose.y, rotation: pose.rotation });
    this.store.setCharge(c.id, { ...c, status: 'rolled', success: true });
    const touching = ` – ${pose.chargerContacts} of your front rank and ${pose.targetContacts} enemy models in base contact`;
    this.events.onAction(chargerId, `charges ${target.info.name} in the ${pose.side}${touching} · ${path.note}`);
  }

  cancelCharge(chargerId: string): void {
    this.store.setCharge(`charge-${chargerId}`, null);
  }

  /** Pfeile für angesagte Angriffe; nach der Angriffsbewegung verschwindet der Pfeil. */
  private drawCharges(): void {
    paintCharges(this.chargeLayer, this.store.state);
  }

  /** Bewegungs- und Angriffsreichweiten der ausgewählten Einheit (wenn eingeschaltet) */
  private drawRanges(): void {
    paintRanges(this.rangeLayer, this.store.state, this.showRanges ? this.selectedId : null);
  }

  /**
   * Angriff: Liegt die Frontmitte der Einheit nach dem Loslassen höchstens 1″ vor einer Kante einer
   * gegnerischen Einheit, wird sie an diese Kante angelegt – mit den meisten Modellen in Basekontakt.
   */
  private chargeSnap(unitId: string): string | null {
    if (!helperOn('snap')) return null;
    const units = this.store.state.units;
    const u = units[unitId];
    const me = unitFootprint(u, units);
    const front = toTable(u, 0, -me.h / 2);
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
      const local = toLocal(t, front);
      for (const [side, mid, n, half] of edges) {
        const along = n.x === 0 ? local.x - mid.x : local.y - mid.y;
        const out = (local.x - mid.x) * n.x + (local.y - mid.y) * n.y;
        if (Math.abs(along) > half + 0.5 || out < -0.5 || out > CHARGE_SNAP) continue;
        // Immer an den Base-Grenzen des Ziels anlegen
        const step = (n.x === 0 ? t.info.baseWidth : t.info.baseDepth) / 25.4;
        const clamped = alignToBases(along, half, step, me.w);
        const lp = n.x === 0 ? { x: mid.x + clamped, y: mid.y } : { x: mid.x, y: mid.y + clamped };
        const p = toTable(t, lp.x, lp.y);
        const c = Math.cos(t.rotation);
        const s = Math.sin(t.rotation);
        const wn = { x: n.x * c - n.y * s, y: n.x * s + n.y * c };
        if (!best || Math.abs(out) < best.dist) best = { dist: Math.abs(out), target: t, p, n: wn, side };
      }
    }
    if (!best) return null;
    // Charge-Regel: an dieser Kante so anlegen, dass möglichst viele Modelle beider Seiten Basekontakt haben
    // (gleiche Wertung wie der Knopf „Charge move“); blockierte Lagen fallen weg
    const bestSide = best.side;
    const maxed = contactPoses(u, best.target, units)
      .filter((q) => q.side === bestSide)
      .find((q) => !overlappingUnits({ ...u, x: q.x, y: q.y, rotation: q.rotation }, units).length);
    if (maxed) {
      this.store.updateUnit(unitId, { x: maxed.x, y: maxed.y, rotation: maxed.rotation });
      return `charges ${best.target.info.name} in the ${bestSide} – ${maxed.contacts} models in base contact`;
    }
    // Eigene Front zeigt gegen die Außennormale der Zielkante; Mitte liegt eine halbe Tiefe dahinter
    const rotation = Math.atan2(-best.n.x, best.n.y);
    this.store.updateUnit(unitId, { x: best.p.x + best.n.x * (me.h / 2), y: best.p.y + best.n.y * (me.h / 2), rotation });
    return `charges ${best.target.info.name} in the ${bestSide}`;
  }

  /** Einheiten stehen nie übereinander: an Gegner anlegen oder zurück an den Start (siehe collision.ts). */
  private separate(unitId: string, start: Pose): string | null {
    if (!helperOn('apart')) return null;
    const units = this.store.state.units;
    const u = units[unitId];
    if (!u) return null;
    const fix = keepApart(u, units, start);
    if (!fix) return null;
    this.store.updateUnit(unitId, fix.pose);
    return fix.note;
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
    const p = toTable(u, right, -forward);
    this.store.updateUnit(u.id, { x: p.x, y: p.y });
    const apart = this.separate(u.id, { x: u.x, y: u.y, rotation: u.rotation });
    const dist = Math.hypot(forward, right);
    this.events.onAction(u.id, `${dist.toFixed(1)}″ ${forward > 0 ? 'forward' : forward < 0 ? 'backward' : right > 0 ? 'right' : 'left'}${apart ? ` · ${apart}` : ''}`);
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
    const start = { x: u.x, y: u.y, rotation: u.rotation };
    this.store.updateUnit(u.id, { rotation: u.rotation + rad });
    const apart = this.separate(u.id, start);
    this.events.onAction(u.id, `turned ${Math.abs(deg)}° ${deg > 0 ? 'right' : 'left'}${apart ? ` · ${apart}` : ''}`);
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
    // Angeschlossene Charaktere zeichnet ihre Einheit mit; Einheiten im Hinterhalt stehen nicht auf dem Tisch
    view.visible = !isJoined(u, units) && !u.ambush;
    // Gleiten zur neuen Stelle, außer während man die Einheit selbst zieht
    const dragging = !!this.drag && this.drag.type !== 'pan' && this.drag.unitId === u.id;
    if (view.visible) view.update(u, unitLayout(u, units), units, this.selectedId, !dragging);
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
      this.select(selectId);
      return;
    }
    const units = this.store.state.units;
    const u = units[unitId];
    const p = this.toInches(e);
    let swing: Swing | undefined;
    if (type === 'swing') {
      const { w, h } = unitFootprint(u, units);
      const pivot = toTable(u, (pivotSide * w) / 2, -h / 2);
      const corner = toTable(u, (-pivotSide * w) / 2, -h / 2);
      swing = { px: pivot.x, py: pivot.y, cx: corner.x, cy: corner.y,
        startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x), front: w };
    }
    this.history.record();
    // Neue Einheit oder neue Runde: das Zusammenzählen beginnt von vorn
    if (this.moveRun && (this.moveRun.unitId !== unitId || this.moveRun.round !== this.store.state.meta.round)) this.moveRun = null;
    this.drag = { type, unitId, ox: u.x - p.x, oy: u.y - p.y, sx: u.x, sy: u.y, srot: u.rotation,
      gx: e.global.x, gy: e.global.y, moved: type !== 'move', swing };
    const view = this.views.get(unitId);
    if (view && type === 'move') view.cursor = 'grabbing';
    this.select(selectId);
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
    this.drag = { type: 'model', unitId, key, start: startPositions[key], startPointer: toLocal(u, this.toInches(e)),
      startPositions, startStray: layout.stray.size, gx: e.global.x, gy: e.global.y, moved: false };
    const select = charId ?? unitId;
    this.select(select);
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
      this.camera.moveTo(d.wx + e.global.x - d.gx, d.wy + e.global.y - d.gy);
      return;
    }
    const u = this.store.state.units[d.unitId];
    const p = this.toInches(e);
    if (d.type === 'model') {
      const lp = toLocal(u, p);
      const pos = { x: d.start.x + lp.x - d.startPointer.x, y: d.start.y + lp.y - d.startPointer.y };
      this.store.updateUnit(d.unitId, { positions: { ...d.startPositions, ...u.positions, [d.key]: pos } });
      this.drawModelGuide(d);
      return;
    }
    if (d.type === 'move') {
      let x = p.x + d.ox;
      let y = p.y + d.oy;
      // Nach der Aufstellung geht es gerade: vor/zurück oder seitwärts, je nachdem, wohin mehr gezogen wird
      // (Plänkler frei; Shift = frei)
      if (!isSkirmish(u) && currentPhase(this.store.state.meta) !== 'setup' && !e.shiftKey) {
        const fx = Math.sin(d.srot);
        const fy = -Math.cos(d.srot);
        const along = (x - d.sx) * fx + (y - d.sy) * fy;
        const side = (x - d.sx) * -fy + (y - d.sy) * fx;
        if (Math.abs(along) >= Math.abs(side)) {
          x = d.sx + fx * along;
          y = d.sy + fy * along;
        } else {
          x = d.sx - fy * side;
          y = d.sy + fx * side;
        }
      }
      this.store.updateUnit(d.unitId, { x, y });
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
    // Klick auf freien Tisch schließt nichts: offene Fenster bleiben, bis man sie schließt oder etwas anderes wählt
    if (d.type === 'pan') return;
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
        const positions = { ...this.currentPositions(target), [c.id]: toLocal(target, c) };
        this.store.updateUnit(target.id, recenter(target, { ...units, [c.id]: { ...c, joinedTo: target.id } }, positions));
      }
      this.store.updateUnit(d.unitId, { joinedTo: target.id });
      this.events.onAction(d.unitId, `joined ${target.info.name}`);
      return;
    }
    const text = this.describe(d);
    const charge = d.type === 'move' ? this.chargeSnap(d.unitId) : null;
    const apart = this.separate(d.unitId, { x: d.sx, y: d.sy, rotation: d.srot });
    // Zoll dieser Einheit weiter zusammenzählen (bis eine andere Einheit bewegt wird oder die Runde endet)
    const run = this.moveRun?.unitId === d.unitId ? this.moveRun.total : 0;
    this.moveRun = { unitId: d.unitId, total: run + this.dragInches(d), round: this.store.state.meta.round };
    if (this.dragInches(d) > 0.05) this.moved.set(d.unitId, this.turnKey());
    const all = [text, charge, apart].filter(Boolean).join(' · ');
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
    const a = toTable(u, d.start.x, d.start.y);
    const b = toTable(u, end.x, end.y);
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

  /** Zurückgelegte Zoll dieses Ziehens: beim Schwenken der Weg der äußeren Ecke, sonst die Strecke */
  private dragInches(d: UnitDrag): number {
    const u = this.store.state.units[d.unitId];
    if (!u) return 0;
    if (d.swing) return Math.abs(normAngle(u.rotation - d.srot)) * d.swing.front;
    return Math.hypot(u.x - d.sx, u.y - d.sy);
  }

  /**
   * Beschreibung des Ziehens. Wird dieselbe Einheit mehrmals hintereinander bewegt (z. B. schwenken, dann
   * vorrücken), stehen die Zoll zusammengezählt dabei ("total").
   */
  private describe(d: UnitDrag): string {
    const u = this.store.state.units[d.unitId];
    const turn = normAngle(u.rotation - d.srot);
    const deg = (turn * 180) / Math.PI;
    const before = this.moveRun?.unitId === d.unitId ? this.moveRun.total : 0;
    const total = (s: string) => (s && before > 0 ? `${s} · total ${(before + this.dragInches(d)).toFixed(1)}″` : s);
    if (d.swing) {
      // Gemessen wird der Weg der äußeren Ecke
      const arc = Math.abs(turn) * d.swing.front;
      return total(Math.abs(deg) >= 0.5 ? `wheeled ${arc.toFixed(1)}″ (${Math.round(Math.abs(deg))}°)` : '');
    }
    const dist = Math.hypot(u.x - d.sx, u.y - d.sy);
    const parts: string[] = [];
    if (dist >= 0.05) parts.push(`moved ${dist.toFixed(1)}″`);
    if (Math.abs(deg) >= 0.5) parts.push(`turned ${Math.round(deg)}°`);
    return total(parts.join(' · '));
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

  private toInches(e: FederatedPointerEvent): { x: number; y: number } {
    const p = this.world.toLocal(e.global);
    return { x: p.x / PPI, y: p.y / PPI };
  }
}

