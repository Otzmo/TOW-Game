import { Circle, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { isDestroyed } from '../model/score';
import { isSkirmish, type UnitLayout } from '../model/store';
import type { UnitState } from '../model/types';
import { PLAYER_COLORS, PPI, STRAY_COLOR } from './theme';

const ARC_LENGTH = 10; // Zoll, Länge der Bogenlinien
const HANDLE_OFFSET = 1.4; // Zoll vor der Front

/** Kürzel für Charakter-Bases, z. B. "Chaos Lord" → "CL". */
const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('').slice(0, 3) || name.slice(0, 2);

/** Zeichnet eine Einheit als Regimentsblock. Die Front zeigt in lokaler −y-Richtung. */
export class UnitView extends Container {
  readonly arcs = new Graphics();
  readonly body = new Graphics();
  readonly labels = new Container();
  readonly handle = new Graphics();
  /** Schwenk-Griffe: links schwenkt um die rechte vordere Ecke und umgekehrt */
  readonly wheelLeft = new Graphics();
  readonly wheelRight = new Graphics();
  /** Fläche in Pixeln */
  w = 0;
  h = 0;

  constructor(public unitId: string) {
    super();
    this.eventMode = 'static';
    this.cursor = 'grab';
    for (const g of [this.handle, this.wheelLeft, this.wheelRight]) g.eventMode = 'static';
    this.handle.cursor = 'crosshair';
    this.wheelLeft.cursor = 'alias';
    this.wheelRight.cursor = 'alias';
    this.addChild(this.arcs, this.body, this.labels, this.handle, this.wheelLeft, this.wheelRight);
  }

  /** Alle Bases in Pixeln (lokal) zum Anklicken: Charaktere und einzelne Plänkler */
  slotRects: { key: string; charId?: string; rect: Rectangle }[] = [];

  /**
   * @param layout Aufstellung inkl. angeschlossener Charaktere
   * @param units alle Einheiten (für Namen der Charaktere)
   * @param selectedId ausgewählte Einheit oder ausgewählter Charakter in dieser Einheit
   */
  update(u: UnitState, layout: UnitLayout, units: Record<string, UnitState>, selectedId: string | null): void {
    this.position.set(u.x * PPI, u.y * PPI);
    this.rotation = u.rotation;

    const colors = PLAYER_COLORS[u.owner];
    const { ranks, w, h, slots, stray } = layout;
    const skirmish = isSkirmish(u);
    const W = w * PPI;
    const H = h * PPI;
    this.w = W;
    this.h = H;
    // Umschließendes Rechteck in Pixeln (bei Plänklern während des Ziehens nicht ganz mittig)
    const x0 = Math.min(...slots.map((s) => s.x)) * PPI;
    const y0 = Math.min(...slots.map((s) => s.y)) * PPI;
    const x1 = Math.max(...slots.map((s) => s.x + s.w)) * PPI;
    const y1 = Math.max(...slots.map((s) => s.y + s.d)) * PPI;
    const selected = selectedId === u.id || slots.some((s) => s.charId === selectedId);

    this.body.clear();
    if (selected) {
      this.body.rect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6)
        .stroke({ width: skirmish ? 1 : 2, color: 0xffffff, alpha: skirmish ? 0.45 : 0.85 });
    }
    this.slotRects = slots.map((s) => ({
      key: s.key,
      charId: s.charId,
      rect: new Rectangle(s.x * PPI + 0.6, s.y * PPI + 0.6, s.w * PPI - 1.2, s.d * PPI - 1.2),
    }));
    const troops = this.slotRects.filter((s) => !s.charId);
    for (const { rect: r } of troops) this.body.rect(r.x, r.y, r.width, r.height);
    if (troops.length) this.body.fill(colors.fill).stroke({ width: 0.8, color: colors.dark });

    // Charaktere: dunklere Base mit Rahmen in Akzentfarbe
    for (const { charId, rect: r } of this.slotRects) {
      if (!charId) continue;
      this.body.rect(r.x, r.y, r.width, r.height).fill(colors.dark)
        .stroke({ width: charId === selectedId ? 2.5 : 1.5, color: charId === selectedId ? 0xffffff : colors.edge });
    }

    if (skirmish) {
      // Jedes Modell zeigt seine Front; Modelle außerhalb von 1″ rot umranden
      for (const { rect: r } of this.slotRects) this.body.moveTo(r.x, r.y).lineTo(r.x + r.width, r.y);
      this.body.stroke({ width: 2, color: colors.edge });
      for (const { key, rect: r } of this.slotRects) {
        if (stray.has(key)) this.body.rect(r.x - 1.5, r.y - 1.5, r.width + 3, r.height + 3).stroke({ width: 2, color: STRAY_COLOR });
      }
    } else {
      this.body.moveTo(-W / 2, -H / 2).lineTo(W / 2, -H / 2).stroke({ width: 3, color: colors.edge });
    }

    this.labels.removeChildren().forEach((c) => c.destroy());
    for (const s of slots) {
      const char = s.charId ? units[s.charId] : undefined;
      const text = char ? initials(char.info.name) : s.label;
      if (!text) continue;
      const size = Math.min(s.w, u.info.baseDepth / 25.4) * PPI;
      const t = new Text({
        text,
        style: { fontFamily: 'system-ui', fontSize: size * (char ? 0.4 : 0.5), fontWeight: '700', fill: colors.edge },
        resolution: 6,
      });
      t.anchor.set(0.5);
      t.position.set((s.x + s.w / 2) * PPI, s.y * PPI + size / 2);
      this.labels.addChild(t);
    }
    // Vernichtete oder geflohene Einheiten blass, fliehende markiert
    this.alpha = isDestroyed(u) || u.status === 'fledOff' ? 0.3 : 1;
    const status = isDestroyed(u) ? ' · destroyed' : u.status === 'fledOff' ? ' · fled'
      : u.status === 'fleeing' ? ' · FLEEING' : '';
    const name = new Text({
      text: `${u.info.name} (${u.models})${status}`,
      style: { fontFamily: 'system-ui', fontSize: 11, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 3.5 } },
      resolution: 8,
    });
    name.anchor.set(0.5);
    if (!skirmish && W >= name.width) {
      name.position.set(0, ranks > 1 ? (u.info.baseDepth / 25.4) * PPI * 0.5 : 0);
    } else {
      // Zu schmal für den Namen (z. B. Charaktere) oder Plänkler: Beschriftung hinter die Einheit
      name.position.set((x0 + x1) / 2, y1 + name.height / 2 + 1);
    }
    // Name nie auf dem Kopf anzeigen
    const facing = ((u.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    name.rotation = facing > Math.PI / 2 && facing < (3 * Math.PI) / 2 ? Math.PI : 0;
    this.labels.addChild(name);

    this.arcs.clear();
    this.handle.clear();
    this.handle.hitArea = null;
    for (const g of [this.wheelLeft, this.wheelRight]) {
      g.clear();
      g.hitArea = null;
    }
    if (!selected) return;

    // Drehgriff vor der Front
    const hx = (x0 + x1) / 2;
    const hy = y0 - HANDLE_OFFSET * PPI;
    this.handle.moveTo(hx, y0).lineTo(hx, hy).stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 });
    this.handle.circle(hx, hy, 5).fill(0xffffff).stroke({ width: 1.5, color: 0x000000 });
    this.handle.hitArea = new Circle(hx, hy, 9);

    // Plänkler schwenken nicht und haben keine Blockfront
    if (skirmish) return;

    // Schwenk-Griffe an den vorderen Ecken
    const s = 4;
    for (const [g, cx] of [[this.wheelLeft, -W / 2], [this.wheelRight, W / 2]] as const) {
      g.rect(cx - s, -H / 2 - s, 2 * s, 2 * s).fill(colors.edge).stroke({ width: 1.5, color: 0x000000 });
      g.hitArea = new Circle(cx, -H / 2, 9);
    }

    // Bögen: Linien diagonal aus den Ecken, Frontbereich leicht eingefärbt
    const d = ARC_LENGTH * PPI * Math.SQRT1_2;
    const corners: [number, number, number, number][] = [
      [-W / 2, -H / 2, -1, -1], [W / 2, -H / 2, 1, -1], [-W / 2, H / 2, -1, 1], [W / 2, H / 2, 1, 1],
    ];
    for (const [cx, cy, dx, dy] of corners) this.arcs.moveTo(cx, cy).lineTo(cx + dx * d, cy + dy * d);
    this.arcs.stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    this.arcs.poly([-W / 2, -H / 2, W / 2, -H / 2, W / 2 + d, -H / 2 - d, -W / 2 - d, -H / 2 - d])
      .fill({ color: colors.edge, alpha: 0.08 });
  }
}
