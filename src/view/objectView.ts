import { Circle, Container, Graphics, Text } from 'pixi.js';
import { flameOutline, OBJECT_TYPES } from '../model/objects';
import type { BoardObject } from '../model/types';
import { hashSeed, PPI, seeded } from './theme';

const HANDLE_OFFSET = 1.2; // Zoll

/** Zeichnet Gelände, Marker oder Schablone. Front (Spitze der Flammenschablone) zeigt nach −y. */
export class ObjectView extends Container {
  readonly body = new Graphics();
  readonly caption = new Text({
    text: '',
    style: { fontFamily: 'system-ui', fontSize: 12, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
    resolution: 8,
  });
  /** Drehgriff */
  readonly handle = new Graphics();
  /** Größengriff an der hinteren rechten Ecke */
  readonly sizeHandle = new Graphics();

  constructor(public objectId: string) {
    super();
    this.eventMode = 'static';
    this.cursor = 'grab';
    for (const g of [this.handle, this.sizeHandle]) g.eventMode = 'static';
    this.handle.cursor = 'crosshair';
    this.sizeHandle.cursor = 'nwse-resize';
    this.caption.anchor.set(0.5);
    this.detail.mask = this.detailMask;
    this.addChild(this.body, this.detailMask, this.detail, this.caption, this.handle, this.sizeHandle);
  }

  /** Struktur des Geländes (nur innerhalb der Fläche sichtbar) */
  private readonly detail = new Graphics();
  private readonly detailMask = new Graphics();

  update(o: BoardObject, selected: boolean): void {
    const t = OBJECT_TYPES[o.type];
    if (!t) return;
    this.position.set(o.x * PPI, o.y * PPI);
    this.rotation = o.rotation;
    const W = o.w * PPI;
    const H = o.h * PPI;

    const g = this.body;
    g.clear();
    // Gelände: weicher Schatten unter dem Stück
    if (t.kind === 'terrain') g.roundRect(-W / 2 + 2, -H / 2 + 3, W, H, 4).fill({ color: 0x000000, alpha: 0.25 });
    if (t.shape === 'rect') g.roundRect(-W / 2, -H / 2, W, H, t.kind === 'terrain' ? 4 : 0);
    else if (t.shape === 'flame') g.poly(flameOutline(o.w, o.h).flatMap((p) => [p.x * PPI, p.y * PPI]));
    else g.ellipse(0, 0, W / 2, H / 2);
    g.fill({ color: t.fill, alpha: t.alpha }).stroke({ width: t.kind === 'template' ? 1.5 : 2, color: t.stroke, alpha: 0.9 });
    // Gelände mit Struktur (Bäume, Dach, Höhenlinien …), innerhalb seiner Fläche
    this.detail.clear();
    this.detailMask.clear();
    if (t.kind === 'terrain') {
      this.detailMask.roundRect(-W / 2, -H / 2, W, H, 4).fill(0xffffff);
      drawTerrainDetail(this.detail, o.type, W, H, hashSeed(o.id));
    }
    // Schablonen: Mittelpunkt bzw. Mittellinie zum Ausrichten
    if (t.kind === 'template') {
      if (t.shape === 'flame') g.moveTo(0, -H / 2).lineTo(0, H / 2);
      else g.moveTo(-3, 0).lineTo(3, 0).moveTo(0, -3).lineTo(0, 3);
      g.stroke({ width: 1, color: t.stroke, alpha: 0.9 });
    }

    // Marker: Symbol im Kreis, eigener Text daneben; Gelände: Name in der Mitte
    const style = this.caption.style;
    if (t.kind === 'marker' && !o.label) {
      this.caption.text = t.icon ?? '';
      style.fontSize = Math.max(6, W * 0.55);
      style.fill = 0x111111;
      style.stroke = { color: 0x000000, width: 0 };
      this.caption.position.set(0, 0);
    } else {
      this.caption.text = t.kind === 'marker' ? `${t.icon ?? ''} ${o.label}` : o.label || (t.kind === 'terrain' ? t.name : '');
      style.fontSize = 12;
      style.fill = 0xffffff;
      style.stroke = { color: 0x000000, width: 3 };
      this.caption.position.set(t.kind === 'marker' ? W / 2 + this.caption.width / 2 + 3 : 0, 0);
    }
    this.caption.rotation = -o.rotation;

    this.handle.clear();
    this.sizeHandle.clear();
    this.handle.hitArea = null;
    this.sizeHandle.hitArea = null;
    if (!selected) return;
    g.rect(-W / 2 - 3, -H / 2 - 3, W + 6, H + 6).stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 });

    if (t.kind !== 'marker') {
      const hy = -H / 2 - HANDLE_OFFSET * PPI;
      this.handle.moveTo(0, -H / 2).lineTo(0, hy).stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 });
      this.handle.circle(0, hy, 5).fill(0xffffff).stroke({ width: 1.5, color: 0x000000 });
      this.handle.hitArea = new Circle(0, hy, 9);
    }
    if (!t.fixedSize && t.kind === 'terrain') {
      this.sizeHandle.rect(W / 2 - 4, H / 2 - 4, 8, 8).fill(0xffffff).stroke({ width: 1.5, color: 0x000000 });
      this.sizeHandle.hitArea = new Circle(W / 2, H / 2, 9);
    }
  }
}

/**
 * Struktur je Geländeart, gezeichnet mit festem Zufall je Stück (bei beiden Spielern gleich).
 * W, H: Größe in Pixeln; die Mitte des Stücks ist der Nullpunkt.
 */
function drawTerrainDetail(g: Graphics, type: string, W: number, H: number, seed: number): void {
  const rnd = seeded(seed);
  const inX = () => (rnd() - 0.5) * W;
  const inY = () => (rnd() - 0.5) * H;
  switch (type) {
    case 'woods': {
      // Baumkronen: dunkler Schatten, Krone, heller Lichtpunkt
      const n = Math.max(4, Math.round((W * H) / (PPI * PPI * 2.2)));
      for (let i = 0; i < n; i++) {
        const x = inX();
        const y = inY();
        const r = (0.7 + rnd() * 0.6) * PPI;
        g.circle(x + 2, y + 3, r).fill({ color: 0x0f2a0c, alpha: 0.45 });
        g.circle(x, y, r).fill({ color: rnd() < 0.5 ? 0x2e5a22 : 0x3a6b2a, alpha: 0.95 });
        g.circle(x - r * 0.3, y - r * 0.3, r * 0.35).fill({ color: 0x6d9a4a, alpha: 0.55 });
      }
      break;
    }
    case 'building': {
      // Dach von oben: First in der Mitte, Grate zu den Ecken, Dachziegel als Linien
      const ridge = Math.max(0, (Math.max(W, H) - Math.min(W, H)) / 2);
      const along = W >= H;
      for (let k = -Math.max(W, H) / 2; k < Math.max(W, H) / 2; k += 5) {
        if (along) g.moveTo(k, -H / 2).lineTo(k, H / 2); else g.moveTo(-W / 2, k).lineTo(W / 2, k);
      }
      g.stroke({ width: 0.6, color: 0x3a1e0a, alpha: 0.35 });
      if (along) g.moveTo(-ridge, 0).lineTo(ridge, 0).moveTo(-W / 2, -H / 2).lineTo(-ridge, 0).lineTo(-W / 2, H / 2).moveTo(W / 2, -H / 2).lineTo(ridge, 0).lineTo(W / 2, H / 2);
      else g.moveTo(0, -ridge).lineTo(0, ridge).moveTo(-W / 2, -H / 2).lineTo(0, -ridge).lineTo(W / 2, -H / 2).moveTo(-W / 2, H / 2).lineTo(0, ridge).lineTo(W / 2, H / 2);
      g.stroke({ width: 2, color: 0x2a1406, alpha: 0.8 });
      // eine Dachseite etwas heller (Licht von links oben)
      if (along) g.poly([-W / 2, -H / 2, W / 2, -H / 2, ridge, 0, -ridge, 0]).fill({ color: 0xffffff, alpha: 0.08 });
      else g.poly([-W / 2, -H / 2, 0, -ridge, 0, ridge, -W / 2, H / 2]).fill({ color: 0xffffff, alpha: 0.08 });
      break;
    }
    case 'hill': {
      // Höhenlinien nach innen, jede Stufe etwas heller
      for (let i = 1; i <= 4; i++) {
        const f = 1 - i * 0.2;
        g.roundRect((-W / 2) * f, (-H / 2) * f, W * f, H * f, Math.min(W, H) * f * 0.45)
          .fill({ color: 0xd8c08a, alpha: 0.07 }).stroke({ width: 1, color: 0x5a4524, alpha: 0.45 });
      }
      break;
    }
    case 'lake': {
      // Wellen und ein heller Uferrand
      g.roundRect(-W / 2 + 3, -H / 2 + 3, W - 6, H - 6, 6).stroke({ width: 3, color: 0x9fc4dc, alpha: 0.25 });
      for (let i = 0; i < Math.max(6, (W * H) / (PPI * PPI * 1.5)); i++) {
        const x = inX() * 0.85;
        const y = inY() * 0.85;
        const l = (0.4 + rnd() * 0.6) * PPI;
        g.moveTo(x - l, y).quadraticCurveTo(x - l / 2, y - 3, x, y).quadraticCurveTo(x + l / 2, y + 3, x + l, y);
      }
      g.stroke({ width: 1, color: 0xcfe4f2, alpha: 0.45 });
      break;
    }
    case 'ruins': {
      // Mauerreste an den Kanten mit Lücken, dazu Schutt
      const wall = (x0: number, y0: number, x1: number, y1: number) => {
        const steps = 6;
        for (let i = 0; i < steps; i++) {
          if (rnd() < 0.35) continue;
          const a = i / steps;
          const b = (i + 0.8) / steps;
          g.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a).lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
        }
      };
      const m = 0.18 * PPI;
      wall(-W / 2 + m, -H / 2 + m, W / 2 - m, -H / 2 + m);
      wall(W / 2 - m, -H / 2 + m, W / 2 - m, H / 2 - m);
      wall(W / 2 - m, H / 2 - m, -W / 2 + m, H / 2 - m);
      wall(-W / 2 + m, H / 2 - m, -W / 2 + m, -H / 2 + m);
      g.stroke({ width: 0.35 * PPI, color: 0x9a9184, alpha: 0.9 });
      for (let i = 0; i < (W * H) / (PPI * PPI); i++) g.rect(inX() * 0.8, inY() * 0.8, 2 + rnd() * 4, 2 + rnd() * 3);
      g.fill({ color: 0x4a443c, alpha: 0.7 });
      break;
    }
    case 'field': {
      // Ackerfurchen
      for (let y = -H / 2 + 4; y < H / 2; y += 6) g.moveTo(-W / 2, y).lineTo(W / 2, y);
      g.stroke({ width: 1.2, color: 0x7d6629, alpha: 0.5 });
      for (let i = 0; i < (W * H) / 40; i++) g.circle(inX(), inY(), 0.8).fill({ color: 0xe8d38a, alpha: 0.5 });
      break;
    }
    case 'wall': {
      // Steine einer Mauer bzw. Hecke
      for (let x = -W / 2; x < W / 2; x += 6) g.rect(x + 0.5, -H / 2 + 1, 5, H - 2);
      g.fill({ color: 0xb4b3a8, alpha: 0.6 }).stroke({ width: 0.6, color: 0x3a3a34, alpha: 0.7 });
      break;
    }
  }
}
