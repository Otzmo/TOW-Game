import { Circle, Container, Graphics, Text } from 'pixi.js';
import { flameOutline, OBJECT_TYPES } from '../model/objects';
import type { BoardObject } from '../model/types';
import { PPI } from './theme';

const HANDLE_OFFSET = 1.2; // Zoll

/** Zeichnet Gelände, Marker oder Schablone. Front (Spitze der Flammenschablone) zeigt nach −y. */
export class ObjectView extends Container {
  readonly body = new Graphics();
  readonly caption = new Text({
    text: '',
    style: { fontFamily: 'system-ui', fontSize: 8, fontWeight: '600', fill: 0xffffff, stroke: { color: 0x000000, width: 2 } },
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
    this.addChild(this.body, this.caption, this.handle, this.sizeHandle);
  }

  update(o: BoardObject, selected: boolean): void {
    const t = OBJECT_TYPES[o.type];
    if (!t) return;
    this.position.set(o.x * PPI, o.y * PPI);
    this.rotation = o.rotation;
    const W = o.w * PPI;
    const H = o.h * PPI;

    const g = this.body;
    g.clear();
    if (t.shape === 'rect') g.rect(-W / 2, -H / 2, W, H);
    else if (t.shape === 'flame') g.poly(flameOutline(o.w, o.h).flatMap((p) => [p.x * PPI, p.y * PPI]));
    else g.ellipse(0, 0, W / 2, H / 2);
    g.fill({ color: t.fill, alpha: t.alpha }).stroke({ width: t.kind === 'template' ? 1.5 : 2, color: t.stroke, alpha: 0.9 });
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
      style.fontSize = 8;
      style.fill = 0xffffff;
      style.stroke = { color: 0x000000, width: 2 };
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
