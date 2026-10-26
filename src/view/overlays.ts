import { Container, Graphics, Text } from 'pixi.js';
import { frontCenter, toLocal, toTable } from '../model/flow';
import { unitFootprint } from '../model/store';
import type { GameState, UnitState } from '../model/types';
import { OK_COLOR, PPI, STRAY_COLOR } from './theme';

/** Bewegungswert der Einheit: erster Zahlenwert in der M-Spalte (bei Reitern der des Reittiers). */
function movement(u: UnitState): number | null {
  for (const row of u.info.profile) {
    const m = Number.parseInt(row.values[0], 10);
    if (Number.isFinite(m)) return m;
  }
  return null;
}

/** „· 7.3–8.1″“: kleinste Charge-Distanz bis zur Distanz mit maximiertem Kontakt */
function chargeRange(c: { distance?: number | null; maxDistance?: number | null }): string {
  if (c.distance == null) return '';
  const max = c.maxDistance != null && c.maxDistance > c.distance + 0.05 ? `–${c.maxDistance.toFixed(1)}` : '';
  return ` · ${c.distance.toFixed(1)}${max}″`;
}

/** Angriffspfeile: wer wen angreift, mit Distanz und Ergebnis (grün gelungen, grau gescheitert) */
export function drawCharges(layer: Container, state: GameState): void {
  layer.removeChildren().forEach((c) => c.destroy());
  const { units, charges } = state;
  for (const c of Object.values(charges)) {
    const charger = units[c.charger];
    const target = units[c.target];
    if (!charger || !target || c.status === 'rolled') continue;
    const a = frontCenter(charger, units);
    // Nächster Punkt auf der Fläche des Ziels
    const { w, h } = unitFootprint(target, units);
    const local = toLocal(target, a);
    const b = toTable(target, Math.max(-w / 2, Math.min(w / 2, local.x)), Math.max(-h / 2, Math.min(h / 2, local.y)));
    const color = c.success === true ? OK_COLOR : c.success === false ? 0x9a9fa4 : STRAY_COLOR;
    const g = new Graphics();
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const head = 1.1;
    g.moveTo(a.x * PPI, a.y * PPI).lineTo(b.x * PPI, b.y * PPI).stroke({ width: 3, color, alpha: 0.95 });
    g.poly([
      b.x * PPI, b.y * PPI,
      (b.x - head * Math.cos(ang - 0.45)) * PPI, (b.y - head * Math.sin(ang - 0.45)) * PPI,
      (b.x - head * Math.cos(ang + 0.45)) * PPI, (b.y - head * Math.sin(ang + 0.45)) * PPI,
    ]).fill(color);
    // Ziel umranden
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sy]) => {
      const p = toTable(target, (sx * w) / 2 + sx * 0.15, (sy * h) / 2 + sy * 0.15);
      return [p.x * PPI, p.y * PPI];
    });
    g.poly(corners).stroke({ width: 2, color, alpha: 0.9 });
    const label = new Text({
      text: `⚔ Charge${chargeRange(c)}`,
      style: { fontFamily: 'system-ui', fontSize: 13, fontWeight: '700', fill: color, stroke: { color: 0x000000, width: 3.5 } },
      resolution: 6,
    });
    label.anchor.set(0.5);
    label.position.set(((a.x + b.x) / 2) * PPI, ((a.y + b.y) / 2) * PPI - 8);
    layer.addChild(g, label);
  }
}

/**
 * Reichweiten einer Einheit als Abstand um ihre Fläche:
 * Bewegung (M), Marsch (2 × M) und größte mögliche Angriffsreichweite (M + 6, Swiftstride +3, Battle Hunger +2).
 * @param unitId ausgewählte Einheit oder ein angeschlossener Charakter (dann zählt seine Einheit); null = nichts zeigen
 */
export function drawRanges(layer: Container, state: GameState, unitId: string | null): void {
  layer.removeChildren().forEach((c) => c.destroy());
  const units = state.units;
  let u = unitId ? units[unitId] : undefined;
  if (u?.joinedTo && units[u.joinedTo]) u = units[u.joinedTo];
  if (!u) return;
  const m = movement(u);
  if (!m) return;
  // Regeln der Einheit, ihres Reittiers und angeschlossener Charaktere
  const all = [u, ...Object.values(units).filter((c) => c.joinedTo === u!.id)];
  const has = (re: RegExp) => all.some((x) => [...x.info.rules, ...x.info.items].some((r) => re.test(r.name)));
  const base = m + 6;
  const extras: [string, number][] = [];
  if (has(/swiftstride/i)) extras.push(['Swiftstride', 3]);
  if (has(/battle hunger/i)) extras.push(['Battle Hunger', 2]);
  const charge = base + extras.reduce((s, [, d]) => s + d, 0);
  const { w, h } = unitFootprint(u, units);
  const c = new Container();
  c.position.set(u.x * PPI, u.y * PPI);
  c.rotation = u.rotation;
  const g = new Graphics();
  c.addChild(g);
  const ranges: [number, string, number][] = [[m, `Move ${m}″`, 0xffffff], [2 * m, `March ${2 * m}″`, 0x9ab4d8],
    [base, `Charge max. ${base}″ (M+6)`, 0xf0a35e]];
  // Swiftstride und Battle Hunger verlängern den Angriff: eigener Ring mit Aufschlüsselung
  if (extras.length) ranges.push([charge, `With ${extras.map(([n, d]) => `${n} +${d}`).join(', ')}: ${charge}″`, STRAY_COLOR]);
  for (const [d, text, color] of ranges) {
    const D = d * PPI;
    g.roundRect((-w / 2) * PPI - D, (-h / 2) * PPI - D, w * PPI + 2 * D, h * PPI + 2 * D, D)
      .stroke({ width: 1.5, color, alpha: 0.7 });
    const t = new Text({ text, style: { fontFamily: 'system-ui', fontSize: 12, fontWeight: '600', fill: color, stroke: { color: 0x000000, width: 3 } }, resolution: 6 });
    t.anchor.set(0.5, 1);
    t.position.set(0, (-h / 2) * PPI - D - 1);
    c.addChild(t);
  }
  layer.addChild(c);
}
