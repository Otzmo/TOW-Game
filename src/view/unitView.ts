import { Circle, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { isDestroyed } from '../model/score';
import { isSkirmish, type UnitLayout } from '../model/store';
import type { UnitState } from '../model/types';
import { PLAYER_COLORS, PPI, STRAY_COLOR, UPRIGHT } from './theme';

const ARC_LENGTH = 10; // Zoll, Länge der Bogenlinien
const HANDLE_OFFSET = 1.4; // Zoll vor der Front
/** Dauer, in der eine Einheit an ihre neue Stelle gleitet (ms) */
const GLIDE_MS = 180;

/** Kürzel für Charakter-Bases, z. B. "Chaos Lord" → "CL". */
const initials = (name: string) =>
  name.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('').slice(0, 3) || name.slice(0, 2);

/** Truppentyp für das Symbol auf den Bases */
type Kind = 'infantry' | 'cavalry' | 'monstrous' | 'monster' | 'chariot' | 'machine' | 'beast';
function troopKind(u: UnitState): Kind {
  const t = u.info.troopType;
  if (/war\s*machine/i.test(t)) return 'machine';
  if (/chariot/i.test(t)) return 'chariot';
  if (/behemoth|monstrous\s*creature/i.test(t)) return 'monster';
  if (/cavalry|^on /i.test(t)) return 'cavalry';
  if (/monstrous/i.test(t)) return 'monstrous';
  if (/beast|swarm/i.test(t)) return 'beast';
  return 'infantry';
}

/** Kleines Symbol je Truppentyp (Mitte cx/cy, Größe s in Pixeln) */
function drawIcon(g: Graphics, kind: Kind | 'character', cx: number, cy: number, s: number): void {
  const r = s / 2;
  switch (kind) {
    case 'character': // Krone
      g.poly([cx - r, cy + r * 0.6, cx - r, cy - r * 0.3, cx - r * 0.5, cy + r * 0.1, cx, cy - r * 0.6,
        cx + r * 0.5, cy + r * 0.1, cx + r, cy - r * 0.3, cx + r, cy + r * 0.6]);
      break;
    case 'cavalry': // Pfeilspitze (Lanze)
      g.moveTo(cx - r, cy + r * 0.4).lineTo(cx, cy - r * 0.6).lineTo(cx + r, cy + r * 0.4);
      break;
    case 'machine': // Kanonenrohr mit Rad
      g.moveTo(cx - r, cy + r * 0.2).lineTo(cx + r, cy - r * 0.5);
      g.circle(cx - r * 0.3, cy + r * 0.4, r * 0.35);
      break;
    case 'chariot': // Rad
      g.circle(cx, cy, r * 0.8).moveTo(cx - r * 0.8, cy).lineTo(cx + r * 0.8, cy).moveTo(cx, cy - r * 0.8).lineTo(cx, cy + r * 0.8);
      break;
    case 'monster': // Klaue: drei Krallen
      for (const dx of [-0.5, 0, 0.5]) g.moveTo(cx + dx * r, cy + r * 0.6).lineTo(cx + dx * r * 1.4, cy - r * 0.6);
      break;
    case 'beast': // Pfote
      g.circle(cx, cy + r * 0.25, r * 0.35);
      for (const dx of [-0.5, 0, 0.5]) g.circle(cx + dx * r, cy - r * 0.4, r * 0.15);
      break;
    case 'monstrous': // zwei gekreuzte Klingen, kräftiger
    case 'infantry': // gekreuzte Schwerter
      g.moveTo(cx - r * 0.7, cy - r * 0.7).lineTo(cx + r * 0.7, cy + r * 0.7).moveTo(cx + r * 0.7, cy - r * 0.7).lineTo(cx - r * 0.7, cy + r * 0.7);
      break;
  }
}

/** Zeichnet eine Einheit als Regimentsblock. Die Front zeigt in lokaler −y-Richtung. */
export class UnitView extends Container {
  readonly arcs = new Graphics();
  readonly shadow = new Graphics();
  readonly body = new Graphics();
  readonly icons = new Graphics();
  /** Rahmen bei Auswahl bzw. Flucht (pulsiert, siehe tick) */
  readonly pulse = new Graphics();
  readonly labels = new Container();
  readonly handle = new Graphics();
  /** Schwenk-Griffe: links schwenkt um die rechte vordere Ecke und umgekehrt */
  readonly wheelLeft = new Graphics();
  readonly wheelRight = new Graphics();
  /** Fläche in Pixeln */
  w = 0;
  h = 0;
  /** Gleiten zur neuen Stelle: Start, Ziel und Startzeit */
  private glide: { fx: number; fy: number; fr: number; tx: number; ty: number; tr: number; t0: number } | null = null;
  private placed = false;
  private pulsing: 'selected' | 'fleeing' | null = null;

  constructor(public unitId: string) {
    super();
    this.eventMode = 'static';
    this.cursor = 'grab';
    for (const g of [this.handle, this.wheelLeft, this.wheelRight]) g.eventMode = 'static';
    this.handle.cursor = 'crosshair';
    this.wheelLeft.cursor = 'alias';
    this.wheelRight.cursor = 'alias';
    this.addChild(this.arcs, this.shadow, this.body, this.icons, this.pulse, this.labels, this.handle, this.wheelLeft, this.wheelRight);
  }

  /** Alle Bases in Pixeln (lokal) zum Anklicken: Charaktere und einzelne Plänkler */
  slotRects: { key: string; charId?: string; rect: Rectangle }[] = [];

  /**
   * Je Bild: Gleiten zur neuen Stelle und Pulsieren des Rahmens (Auswahl, Flucht).
   * @param now Zeit in ms
   */
  tick(now: number): void {
    if (this.glide) {
      const g = this.glide;
      const k = Math.min(1, (now - g.t0) / GLIDE_MS);
      const e = 1 - (1 - k) ** 3;
      const dr = Math.atan2(Math.sin(g.tr - g.fr), Math.cos(g.tr - g.fr));
      this.position.set(g.fx + (g.tx - g.fx) * e, g.fy + (g.ty - g.fy) * e);
      this.rotation = g.fr + dr * e;
      if (k >= 1) this.glide = null;
    }
    if (this.pulsing) this.pulse.alpha = 0.55 + 0.45 * Math.sin(now / (this.pulsing === 'fleeing' ? 120 : 260));
  }

  /**
   * @param layout Aufstellung inkl. angeschlossener Charaktere
   * @param units alle Einheiten (für Namen der Charaktere)
   * @param selectedId ausgewählte Einheit oder ausgewählter Charakter in dieser Einheit
   * @param animate an die neue Stelle gleiten (nicht beim eigenen Ziehen)
   */
  update(u: UnitState, layout: UnitLayout, units: Record<string, UnitState>, selectedId: string | null, animate = false): void {
    const tx = u.x * PPI;
    const ty = u.y * PPI;
    const jump = Math.hypot(tx - this.x, ty - this.y) > 0.3 * PPI || Math.abs(u.rotation - this.rotation) > 0.02;
    const g = this.glide;
    if (animate && this.placed && g && g.tx === tx && g.ty === ty && g.tr === u.rotation) {
      // Gleitet schon dorthin (z. B. neu gezeichnet wegen Auswahl): nicht von vorn beginnen
    } else if (animate && this.placed && jump) {
      this.glide = { fx: this.x, fy: this.y, fr: this.rotation, tx, ty, tr: u.rotation, t0: performance.now() };
    } else {
      this.glide = null;
      this.position.set(tx, ty);
      this.rotation = u.rotation;
    }
    this.placed = true;

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

    this.slotRects = slots.map((s) => ({
      key: s.key,
      charId: s.charId,
      rect: new Rectangle(s.x * PPI + 0.6, s.y * PPI + 0.6, s.w * PPI - 1.2, s.d * PPI - 1.2),
    }));

    // Schatten unter den Bases (leicht nach rechts unten versetzt)
    this.shadow.clear();
    for (const { rect: r } of this.slotRects) this.shadow.roundRect(r.x + 1.5, r.y + 2.5, r.width, r.height, 2);
    this.shadow.fill({ color: 0x000000, alpha: 0.35 });

    this.body.clear();
    this.icons.clear();
    const kind = troopKind(u);
    const troops = this.slotRects.filter((s) => !s.charId);
    for (const { rect: r } of troops) this.body.roundRect(r.x, r.y, r.width, r.height, 2);
    if (troops.length) this.body.fill(colors.fill).stroke({ width: 0.8, color: colors.dark });
    // Licht von oben: heller Streifen oben, dunkler unten an jeder Base
    for (const { rect: r } of troops) this.body.moveTo(r.x + 1.5, r.y + 1).lineTo(r.x + r.width - 1.5, r.y + 1);
    if (troops.length) this.body.stroke({ width: 1, color: 0xffffff, alpha: 0.22 });
    for (const { rect: r } of troops) this.body.moveTo(r.x + 1.5, r.y + r.height - 1).lineTo(r.x + r.width - 1.5, r.y + r.height - 1);
    if (troops.length) this.body.stroke({ width: 1, color: 0x000000, alpha: 0.3 });

    // Charaktere: dunklere Base mit Rahmen in Akzentfarbe
    for (const { charId, rect: r } of this.slotRects) {
      if (!charId) continue;
      this.body.roundRect(r.x, r.y, r.width, r.height, 2).fill(colors.dark)
        .stroke({ width: charId === selectedId ? 2.5 : 1.5, color: charId === selectedId ? 0xffffff : colors.edge });
    }

    // Symbol des Truppentyps auf jeder Base ohne Kommandokürzel (Charaktere: Krone)
    const labelled = new Set(slots.filter((s) => s.label).map((s) => s.key));
    for (const { key, charId, rect: r } of this.slotRects) {
      if (labelled.has(key) || (charId && units[charId])) continue;
      const iconSize = Math.min(r.width, r.height) * 0.42;
      drawIcon(this.icons, u.info.isCharacter && u.models === 1 ? 'character' : kind, r.x + r.width / 2, r.y + r.height / 2, iconSize);
    }
    this.icons.stroke({ width: 1.2, color: colors.edge, alpha: 0.35 });

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

    // Pulsierender Rahmen: ausgewählt (weiß) oder fliehend (rot)
    this.pulse.clear();
    const fleeing = u.status === 'fleeing';
    this.pulsing = fleeing ? 'fleeing' : selected ? 'selected' : null;
    if (this.pulsing) {
      this.pulse.roundRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6, 3)
        .stroke({ width: fleeing ? 2.5 : skirmish ? 1 : 2, color: fleeing ? STRAY_COLOR : 0xffffff, alpha: skirmish && !fleeing ? 0.6 : 1 });
    }

    this.labels.removeChildren().forEach((c) => c.destroy());
    for (const s of slots) {
      const char = s.charId ? units[s.charId] : undefined;
      const text = char ? initials(char.info.name) : s.label;
      if (!text) continue;
      const size = Math.min(s.w, u.info.baseDepth / 25.4) * PPI;
      const t = new Text({
        text,
        style: { fontFamily: 'Cinzel, Georgia, serif', fontSize: size * (char ? 0.4 : 0.5), fontWeight: '700', fill: colors.edge },
        resolution: 6,
      });
      t.anchor.set(0.5);
      t.position.set((s.x + s.w / 2) * PPI, s.y * PPI + size / 2);
      this.labels.addChild(t);
    }
    // Vernichtete oder geflohene Einheiten blass
    this.alpha = isDestroyed(u) || u.status === 'fledOff' ? 0.3 : 1;
    const plaque = this.namePlaque(u, Math.max(W, 3 * PPI));
    if (!skirmish && W >= plaque.width) {
      plaque.position.set(0, ranks > 1 ? (u.info.baseDepth / 25.4) * PPI * 0.5 : 0);
    } else {
      // Zu schmal für den Namen (z. B. Charaktere) oder Plänkler: Schild hinter die Einheit
      plaque.position.set((x0 + x1) / 2, y1 + plaque.height / 2 + 2);
    }
    // Name nie auf dem Kopf anzeigen
    const facing = ((u.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    plaque.rotation = facing > Math.PI / 2 && facing < (3 * Math.PI) / 2 ? Math.PI : 0;
    this.labels.addChild(plaque);

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

  /**
   * Namensschild: dunkles Schild mit Name, daneben die Modellzahl als Plakette (orange, sobald Modelle fehlen),
   * dazu der Zustand (fliehend, geflohen, vernichtet).
   */
  private namePlaque(u: UnitState, maxWidth: number): Container {
    const plaque = new Container();
    // In der gedrehten Ansicht wird das Schild als Ganzes um seine Mitte gedreht
    plaque.label = UPRIGHT;
    const status = isDestroyed(u) ? 'destroyed' : u.status === 'fledOff' ? 'fled' : u.status === 'fleeing' ? 'FLEEING' : '';
    const name = new Text({
      text: u.info.name,
      style: { fontFamily: 'Cinzel, Georgia, serif', fontSize: 10, fontWeight: '700', fill: 0xf3e6c4,
        wordWrap: true, wordWrapWidth: maxWidth - 30, align: 'center' },
      resolution: 8,
    });
    const start = u.info.startModels ?? u.models;
    const count = new Text({
      text: start > 1 ? `${u.models}/${start}` : status || '1',
      style: { fontFamily: 'system-ui', fontSize: 9, fontWeight: '800', fill: u.models < start || status ? 0x1a1a1a : 0xf3e6c4 },
      resolution: 8,
    });
    const extra = start > 1 && status ? new Text({
      text: status, style: { fontFamily: 'system-ui', fontSize: 9, fontWeight: '800', fill: STRAY_COLOR }, resolution: 8,
    }) : null;
    const pad = 4;
    const bw = count.width + 8;
    const total = name.width + 6 + bw + (extra ? extra.width + 6 : 0);
    const hgt = Math.max(name.height, 12) + 4;
    const bg = new Graphics()
      .roundRect(-total / 2 - pad, -hgt / 2, total + pad * 2, hgt, 4).fill({ color: 0x1b140d, alpha: 0.82 })
      .stroke({ width: 1, color: PLAYER_COLORS[u.owner].edge, alpha: 0.6 });
    name.anchor.set(0, 0.5);
    name.position.set(-total / 2, 0);
    const badgeX = -total / 2 + name.width + 6;
    const badge = new Graphics().roundRect(badgeX, -6.5, bw, 13, 6.5)
      .fill(u.models < start || status ? 0xe8a04a : 0x4a3a26);
    count.anchor.set(0.5);
    count.position.set(badgeX + bw / 2, 0);
    plaque.addChild(bg, name, badge, count);
    if (extra) {
      extra.anchor.set(0, 0.5);
      extra.position.set(badgeX + bw + 6, 0);
      plaque.addChild(extra);
    }
    return plaque;
  }
}
