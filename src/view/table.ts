import { Container, Graphics, Text } from 'pixi.js';
import { PPI, TABLE_COLOR } from './theme';

/** Spieltisch mit Zoll- und Fuß-Raster und Zoll-Leisten am Rand. */
export function createTable(widthIn: number, heightIn: number): Container {
  const layer = new Container();

  const table = new Graphics().rect(0, 0, widthIn * PPI, heightIn * PPI).fill(TABLE_COLOR);
  layer.addChild(table);

  const grid = new Graphics();
  for (let x = 0; x <= widthIn; x++) grid.moveTo(x * PPI, 0).lineTo(x * PPI, heightIn * PPI);
  for (let y = 0; y <= heightIn; y++) grid.moveTo(0, y * PPI).lineTo(widthIn * PPI, y * PPI);
  grid.stroke({ width: 0.5, color: 0xffffff, alpha: 0.05 });
  for (let x = 0; x <= widthIn; x += 12) grid.moveTo(x * PPI, 0).lineTo(x * PPI, heightIn * PPI);
  for (let y = 0; y <= heightIn; y += 12) grid.moveTo(0, y * PPI).lineTo(widthIn * PPI, y * PPI);
  grid.stroke({ width: 1.5, color: 0xffffff, alpha: 0.14 });
  layer.addChild(grid);

  layer.addChild(createRulers(widthIn, heightIn));
  return layer;
}

const RULER_COLOR = 0xc9c4b8;

/** Zoll-Leisten an allen vier Tischkanten: Striche je Zoll, Zahlen alle 6″. */
function createRulers(widthIn: number, heightIn: number): Container {
  const layer = new Container();
  const ticks = new Graphics();
  const W = widthIn * PPI;
  const H = heightIn * PPI;
  const tick = (i: number) => (i % 12 === 0 ? 9 : i % 6 === 0 ? 6 : 3.5);

  for (let i = 0; i <= widthIn; i++) {
    const x = i * PPI;
    ticks.moveTo(x, 0).lineTo(x, -tick(i)).moveTo(x, H).lineTo(x, H + tick(i));
  }
  for (let i = 0; i <= heightIn; i++) {
    const y = i * PPI;
    ticks.moveTo(0, y).lineTo(-tick(i), y).moveTo(W, y).lineTo(W + tick(i), y);
  }
  ticks.stroke({ width: 1, color: RULER_COLOR, alpha: 0.7 });
  layer.addChild(ticks);

  const label = (text: string, x: number, y: number, ax: number, ay: number) => {
    const t = new Text({ text, style: { fontFamily: 'system-ui', fontSize: 8, fill: RULER_COLOR }, resolution: 6 });
    t.anchor.set(ax, ay);
    t.position.set(x, y);
    layer.addChild(t);
  };
  for (let i = 0; i <= widthIn; i += 6) {
    label(`${i}″`, i * PPI, -11, 0.5, 1);
    label(`${i}″`, i * PPI, H + 11, 0.5, 0);
  }
  for (let i = 0; i <= heightIn; i += 6) {
    label(`${i}″`, -11, i * PPI, 1, 0.5);
    label(`${i}″`, W + 11, i * PPI, 0, 0.5);
  }
  return layer;
}
