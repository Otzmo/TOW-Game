import { polyDistance } from './contact';
import { contactPoses } from './flow';
import { isJoined, isSkirmish, unitFootprint } from './store';
import type { Point, UnitState } from './types';

/** Bis zu diesem Abstand (oder bei Überlappung) rasten Einheiten an den Gegner (Zoll) */
export const SNAP_DISTANCE = 1;

const norm = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Umriss einer Einheit auf dem Tisch (Rechteck um die Mitte) */
function outline(u: UnitState, w: number, h: number): Point[] {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => ({ x: u.x + x * c - y * s, y: u.y + x * s + y * c }));
}

/**
 * Einheit an eine gegnerische Einheit anlegen: Kommt sie ihr bis auf SNAP_DISTANCE nahe (oder überlappt sie), wird sie
 * – egal wie schräg sie steht – mit ihrer Front zu der Kante gedreht, vor der sie steht (Front, Flanke oder Rücken
 * des Gegners), und bündig angelegt. Eigene Einheiten rasten nicht ein.
 * Wie beim Angriff wird maximiert: so viele Modelle wie möglich in Basekontakt (auch Ecke an Ecke zählt),
 * bei gleicher Zahl mit möglichst wenig seitlicher Verschiebung.
 * Lag sie schon vor dem Ziehen an dieser Einheit an (keep, siehe touchingEnemies), wird nicht erneut maximiert:
 * so lässt sich die Stellung entlang der Kante von Hand korrigieren, ohne dass sie zurückspringt.
 * Ergebnis: neue Lage und die Einheit, an der sie anliegt – oder null.
 */
export function snapTogether(u: UnitState, units: Record<string, UnitState>, keep: ReadonlySet<string> = new Set()):
  { pose: Pick<UnitState, 'x' | 'y' | 'rotation'>; to: UnitState } | null {
  if (isSkirmish(u) || isJoined(u, units)) return null;
  const me = unitFootprint(u, units);
  const mine = outline(u, me.w, me.h);
  let best: { pose: Pick<UnitState, 'x' | 'y' | 'rotation'>; to: UnitState; dist: number } | null = null;
  for (const t of Object.values(units)) {
    if (t.id === u.id || t.owner === u.owner || t.joinedTo === u.id || isJoined(t, units) || isSkirmish(t) || t.ambush
      || t.status === 'destroyed' || t.status === 'fledOff') continue;
    const them = unitFootprint(t, units);
    // Wirklicher Abstand der Umrisse (bei schräger Stellung zählt die nächste Ecke)
    const dist = polyDistance(mine, outline(t, them.w, them.h));
    if (dist > SNAP_DISTANCE || (best && dist >= best.dist)) continue;
    const maximise = !keep.has(t.id);
    // Mitte im Koordinatensystem des Gegners
    const c = Math.cos(-t.rotation);
    const s = Math.sin(-t.rotation);
    const lx = (u.x - t.x) * c - (u.y - t.y) * s;
    const ly = (u.x - t.x) * s + (u.y - t.y) * c;
    // Welche Kante? Zuerst nach der Gasse geradeaus (wohin die Einheit angreifen würde); zielt sie nicht auf den
    // Gegner, die Seite mit dem größten Abstand der Umrisse – dort trennen sie sich (gemessen mit der Ausrichtung,
    // die der jetzigen am nächsten liegt)
    const quarter = Math.round(norm(u.rotation - t.rotation) / (Math.PI / 2));
    const turned = Math.abs(quarter) % 2 === 1;
    const apart = Math.abs(lx) - (turned ? me.h : me.w) / 2 - them.w / 2 > Math.abs(ly) - (turned ? me.w : me.h) / 2 - them.h / 2
      ? (lx < 0 ? 'left flank' : 'right flank') : (ly < 0 ? 'front' : 'rear');
    const side = laneSide(u, me, t, them) ?? apart;
    const byX = side === 'left flank' || side === 'right flank';
    // Immer mit der eigenen Front zum Gegner, wie beim Angriff – nie mit Flanke oder Rücken an ihm kleben
    const rotation = t.rotation + { 'left flank': Math.PI / 2, 'right flank': -Math.PI / 2, front: Math.PI, rear: 0 }[side];
    const hw = (byX ? me.h : me.w) / 2;
    const hh = (byX ? me.w : me.h) / 2;
    const nx = byX ? (side === 'left flank' ? -1 : 1) * (hw + them.w / 2) : Math.max(-them.w / 2 - hw, Math.min(them.w / 2 + hw, lx));
    const ny = byX ? Math.max(-them.h / 2 - hh, Math.min(them.h / 2 + hh, ly)) : (side === 'front' ? -1 : 1) * (hh + them.h / 2);
    const x = t.x + nx * Math.cos(t.rotation) - ny * Math.sin(t.rotation);
    const y = t.y + nx * Math.sin(t.rotation) + ny * Math.cos(t.rotation);
    let pose = { x, y, rotation };
    // Maximierte Stellung an dieser Kante (gleiche Wertung wie beim Angriff)
    const maxed = maximise ? contactPoses({ ...u, ...pose }, t, units).filter((q) => q.side === side)[0] : undefined;
    if (maxed && Math.abs(norm(maxed.rotation - rotation)) < 0.01) pose = { x: maxed.x, y: maxed.y, rotation: maxed.rotation };
    best = { pose, to: t, dist };
  }
  return best ? { pose: best.pose, to: best.to } : null;
}

type Side = 'front' | 'rear' | 'left flank' | 'right flank';

/** Anteil der Gasse, der in der Front des Gegners liegen muss, damit in die Front eingerastet wird */
export const FRONT_SHARE = 0.5;

/**
 * Kante des Gegners nach der Gasse geradeaus: Strahlen über die ganze Frontbreite der Einheit in ihre Blickrichtung
 * (ab ihrem Rücken, damit auch ein schon überlappender Teil zählt); jeder trifft zuerst Front, Flanke oder Rücken.
 * Trifft mehr als FRONT_SHARE der treffenden Strahlen die Front, ist es die Front, sonst die am meisten getroffene
 * andere Kante. Zielt die Einheit am Gegner vorbei: null.
 */
function laneSide(u: UnitState, me: { w: number; h: number }, t: UnitState, them: { w: number; h: number }): Side | null {
  const c = Math.cos(-t.rotation);
  const s = Math.sin(-t.rotation);
  const local = (x: number, y: number) => ({ x: (x - t.x) * c - (y - t.y) * s, y: (x - t.x) * s + (y - t.y) * c });
  const fwd = { x: Math.sin(u.rotation), y: -Math.cos(u.rotation) };
  const d = { x: fwd.x * c - fwd.y * s, y: fwd.x * s + fwd.y * c };
  const right = { x: Math.cos(u.rotation), y: Math.sin(u.rotation) };
  const W = them.w / 2;
  const H = them.h / 2;
  const hits: Record<Side, number> = { front: 0, rear: 0, 'left flank': 0, 'right flank': 0 };
  const N = 40;
  for (let i = 0; i < N; i++) {
    const k = ((i + 0.5) / N - 0.5) * me.w;
    // Startpunkt am Rücken der Einheit, auf Höhe dieses Strahls
    const p = local(u.x + right.x * k - fwd.x * (me.h / 2), u.y + right.y * k - fwd.y * (me.h / 2));
    // Strahl gegen das Rechteck des Gegners: Eintritt über die zuletzt betretene Ebene
    let tIn = -Infinity;
    let tOut = Infinity;
    let face: Side | null = null;
    for (const [pos, dir, lo, hi, fLo, fHi] of [
      [p.x, d.x, -W, W, 'left flank', 'right flank'], [p.y, d.y, -H, H, 'front', 'rear'],
    ] as const) {
      if (Math.abs(dir) < 1e-9) {
        if (pos < lo || pos > hi) tIn = Infinity;
        continue;
      }
      const a = (lo - pos) / dir;
      const b = (hi - pos) / dir;
      const enter = Math.min(a, b);
      if (enter > tIn) {
        tIn = enter;
        face = dir > 0 ? fLo : fHi;
      }
      tOut = Math.min(tOut, Math.max(a, b));
    }
    if (face && tIn <= tOut && tIn >= 0) hits[face]++;
  }
  const total = hits.front + hits.rear + hits['left flank'] + hits['right flank'];
  if (!total) return null;
  if (hits.front / total > FRONT_SHARE) return 'front';
  const others = (['left flank', 'right flank', 'rear'] as const).filter((x) => hits[x] > 0);
  return others.sort((a, b) => hits[b] - hits[a])[0] ?? 'front';
}

/** Gegnerische Einheiten, an denen die Einheit gerade anliegt (Umrisse berühren sich) */
export function touchingEnemies(u: UnitState, units: Record<string, UnitState>): Set<string> {
  const me = unitFootprint(u, units);
  const mine = outline(u, me.w, me.h);
  const ids = new Set<string>();
  for (const t of Object.values(units)) {
    if (t.id === u.id || t.owner === u.owner || t.status === 'destroyed' || t.status === 'fledOff') continue;
    const them = unitFootprint(t, units);
    if (polyDistance(mine, outline(t, them.w, them.h)) < 0.02) ids.add(t.id);
  }
  return ids;
}
