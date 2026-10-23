import { Circle, Container, Graphics, Text } from 'pixi.js';
import { unitFootprint } from '../model/store';
import type { UnitState } from '../model/types';
import { PLAYER_COLORS, PPI } from './theme';

const ARC_LENGTH = 10; // Zoll, Länge der Bogenlinien
const HANDLE_OFFSET = 1.4; // Zoll vor der Front

/** Zeichnet eine Einheit als Regimentsblock. Die Front zeigt in lokaler −y-Richtung. */
export class UnitView extends Container {
  readonly arcs = new Graphics();
  readonly body = new Graphics();
  readonly labels = new Container();
  readonly handle = new Graphics();
  /** Fläche in Pixeln */
  w = 0;
  h = 0;

  constructor(public unitId: string) {
    super();
    this.eventMode = 'static';
    this.cursor = 'grab';
    this.handle.eventMode = 'static';
    this.handle.cursor = 'crosshair';
    this.addChild(this.arcs, this.body, this.labels, this.handle);
  }

  update(u: UnitState, selected: boolean): void {
    this.position.set(u.x * PPI, u.y * PPI);
    this.rotation = u.rotation;

    const colors = PLAYER_COLORS[u.owner];
    const { cols, ranks, w, h } = unitFootprint(u);
    const bw = (u.info.baseWidth / 25.4) * PPI;
    const bd = (u.info.baseDepth / 25.4) * PPI;
    const W = w * PPI;
    const H = h * PPI;
    this.w = W;
    this.h = H;

    this.body.clear();
    if (selected) this.body.rect(-W / 2 - 3, -H / 2 - 3, W + 6, H + 6).stroke({ width: 2, color: 0xffffff, alpha: 0.85 });
    for (let i = 0; i < u.models; i++) {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, u.models - row * cols);
      const offset = ((cols - inRow) * bw) / 2; // unvollständiges letztes Glied mittig
      this.body.rect(-W / 2 + offset + (i % cols) * bw + 0.6, -H / 2 + row * bd + 0.6, bw - 1.2, bd - 1.2);
    }
    this.body.fill(colors.fill).stroke({ width: 0.8, color: colors.dark });
    this.body.moveTo(-W / 2, -H / 2).lineTo(W / 2, -H / 2).stroke({ width: 3, color: colors.edge });

    this.labels.removeChildren().forEach((c) => c.destroy());
    const mid = Math.floor((cols - 1) / 2);
    u.info.command.forEach((ch, k) => {
      const col = mid - 1 + k;
      if (col < 0 || col >= cols || u.models <= k) return;
      const t = new Text({
        text: ch,
        style: { fontFamily: 'system-ui', fontSize: Math.min(bw, bd) * 0.5, fontWeight: '700', fill: colors.edge },
        resolution: 6,
      });
      t.anchor.set(0.5);
      t.position.set(-W / 2 + col * bw + bw / 2, -H / 2 + bd / 2);
      this.labels.addChild(t);
    });
    const name = new Text({
      text: `${u.info.name} (${u.models})`,
      style: { fontFamily: 'system-ui', fontSize: 7, fontWeight: '600', fill: 0xffffff, stroke: { color: 0x000000, width: 2.5 } },
      resolution: 8,
    });
    name.anchor.set(0.5);
    name.position.set(0, ranks > 1 ? bd * 0.5 : 0);
    // Name nie auf dem Kopf anzeigen
    const facing = ((u.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    name.rotation = facing > Math.PI / 2 && facing < (3 * Math.PI) / 2 ? Math.PI : 0;
    this.labels.addChild(name);

    this.arcs.clear();
    this.handle.clear();
    this.handle.hitArea = null;
    if (!selected) return;

    // Bögen: Linien diagonal aus den Ecken, Frontbereich leicht eingefärbt
    const d = ARC_LENGTH * PPI * Math.SQRT1_2;
    const corners: [number, number, number, number][] = [
      [-W / 2, -H / 2, -1, -1], [W / 2, -H / 2, 1, -1], [-W / 2, H / 2, -1, 1], [W / 2, H / 2, 1, 1],
    ];
    for (const [cx, cy, dx, dy] of corners) this.arcs.moveTo(cx, cy).lineTo(cx + dx * d, cy + dy * d);
    this.arcs.stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
    this.arcs.poly([-W / 2, -H / 2, W / 2, -H / 2, W / 2 + d, -H / 2 - d, -W / 2 - d, -H / 2 - d])
      .fill({ color: colors.edge, alpha: 0.08 });

    const hy = -H / 2 - HANDLE_OFFSET * PPI;
    this.handle.moveTo(0, -H / 2).lineTo(0, hy).stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 });
    this.handle.circle(0, hy, 5).fill(0xffffff).stroke({ width: 1.5, color: 0x000000 });
    this.handle.hitArea = new Circle(0, hy, 9);
  }
}
