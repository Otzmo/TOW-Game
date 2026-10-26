import { Container, Graphics, Text } from 'pixi.js';
import { PPI, seeded, TABLE_COLOR } from './theme';

/**
 * Spieltisch: Grasfläche mit leichter Struktur (hellere und dunklere Flecken, Grashalme), Schatten am Rand,
 * dezentes Zoll- und Fuß-Raster und Zoll-Leisten. Die Struktur ist für beide Spieler gleich (feste Zufallsfolge).
 */
export function createTable(widthIn: number, heightIn: number): Container {
  const layer = new Container();
  const W = widthIn * PPI;
  const H = heightIn * PPI;

  // Schatten unter dem Tisch: mehrere weiche Ränder nach außen
  const shadow = new Graphics();
  for (let i = 1; i <= 6; i++) shadow.roundRect(-i * 3 + 4, -i * 3 + 6, W + i * 6, H + i * 6, i * 4).fill({ color: 0x000000, alpha: 0.07 });
  layer.addChild(shadow);

  const table = new Graphics().rect(0, 0, W, H).fill(TABLE_COLOR);
  layer.addChild(table);

  // Grasstruktur: große helle und dunkle Flecken, dazu viele kleine Halme
  const rnd = seeded(7);
  const patches = new Graphics();
  for (let i = 0; i < (widthIn * heightIn) / 20; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = (1.5 + rnd() * 4.5) * PPI;
    patches.ellipse(x, y, r, r * (0.5 + rnd() * 0.5)).fill({ color: rnd() < 0.5 ? 0x2f4a26 : 0x557243, alpha: 0.12 + rnd() * 0.1 });
  }
  const blades = new Graphics();
  for (let i = 0; i < widthIn * heightIn * 1.6; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const a = -Math.PI / 2 + (rnd() - 0.5) * 0.9;
    const len = 2 + rnd() * 4;
    blades.moveTo(x, y).lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
  }
  blades.stroke({ width: 0.6, color: 0x6f8f55, alpha: 0.18 });
  patches.mask = table.clone();
  layer.addChild(patches.mask, patches, blades);

  const grid = new Graphics();
  for (let x = 0; x <= widthIn; x++) grid.moveTo(x * PPI, 0).lineTo(x * PPI, H);
  for (let y = 0; y <= heightIn; y++) grid.moveTo(0, y * PPI).lineTo(W, y * PPI);
  grid.stroke({ width: 0.5, color: 0xffffff, alpha: 0.03 });
  for (let x = 0; x <= widthIn; x += 12) grid.moveTo(x * PPI, 0).lineTo(x * PPI, H);
  for (let y = 0; y <= heightIn; y += 12) grid.moveTo(0, y * PPI).lineTo(W, y * PPI);
  grid.stroke({ width: 1.2, color: 0xffffff, alpha: 0.1 });
  layer.addChild(grid);

  // Rahmen um den Tisch
  layer.addChild(new Graphics().rect(0, 0, W, H).stroke({ width: 3, color: 0x2a2116, alpha: 0.9 }));
  layer.addChild(createRulers(widthIn, heightIn));
  return layer;
}

const RULER_COLOR = 0xc9b48a;

/** Zoll-Leisten an allen vier Tischkanten: Striche je Zoll, Zahlen alle 6″. */
function createRulers(widthIn: number, heightIn: number): Container {
  const layer = new Container();
  const ticks = new Graphics();
  const W = widthIn * PPI;
  const H = heightIn * PPI;
  const tick = (i: number) => (i % 12 === 0 ? 9 : i % 6 === 0 ? 6 : 3.5);

  for (let i = 0; i <= widthIn; i++) {
    const x = i * PPI;
    ticks.moveTo(x, -2).lineTo(x, -2 - tick(i)).moveTo(x, H + 2).lineTo(x, H + 2 + tick(i));
  }
  for (let i = 0; i <= heightIn; i++) {
    const y = i * PPI;
    ticks.moveTo(-2, y).lineTo(-2 - tick(i), y).moveTo(W + 2, y).lineTo(W + 2 + tick(i), y);
  }
  ticks.stroke({ width: 1, color: RULER_COLOR, alpha: 0.7 });
  layer.addChild(ticks);

  const label = (text: string, x: number, y: number, ax: number, ay: number) => {
    const t = new Text({ text, style: { fontFamily: 'Cinzel, Georgia, serif', fontSize: 13, fontWeight: '700', fill: RULER_COLOR }, resolution: 6 });
    t.anchor.set(ax, ay);
    t.position.set(x, y);
    layer.addChild(t);
  };
  for (let i = 0; i <= widthIn; i += 6) {
    label(`${i}″`, i * PPI, -14, 0.5, 1);
    label(`${i}″`, i * PPI, H + 14, 0.5, 0);
  }
  for (let i = 0; i <= heightIn; i += 6) {
    label(`${i}″`, -14, i * PPI, 1, 0.5);
    label(`${i}″`, W + 14, i * PPI, 0, 0.5);
  }
  return layer;
}
