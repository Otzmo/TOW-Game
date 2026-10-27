import { isJoined, unitLayout, type Slot } from './store';
import type { Point, UnitState } from './types';

/** Abstand, bis zu dem zwei Bases als berührend gelten (Zoll) */
const TOUCH = 0.03;

/** Bases einer Einheit als Vierecke auf dem Tisch (Zoll), mit ihrem Platz in der Formation */
export function slotPolygons(u: UnitState, units: Record<string, UnitState>): { slot: Slot; poly: Point[] }[] {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  return unitLayout(u, units).slots.map((slot) => ({
    slot,
    poly: [[slot.x, slot.y], [slot.x + slot.w, slot.y], [slot.x + slot.w, slot.y + slot.d], [slot.x, slot.y + slot.d]]
      .map(([lx, ly]) => ({ x: u.x + lx * c - ly * s, y: u.y + lx * s + ly * c })),
  }));
}

function pointSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Kürzester Abstand zweier konvexer Vierecke (0, wenn sie sich überlappen) */
export function polyDistance(a: Point[], b: Point[]): number {
  const inside = (p: Point, poly: Point[]) => poly.every((q, i) => {
    const r = poly[(i + 1) % poly.length];
    return (r.x - q.x) * (p.y - q.y) - (r.y - q.y) * (p.x - q.x) >= -1e-9;
  }) || poly.every((q, i) => {
    const r = poly[(i + 1) % poly.length];
    return (r.x - q.x) * (p.y - q.y) - (r.y - q.y) * (p.x - q.x) <= 1e-9;
  });
  if (a.some((p) => inside(p, b)) || b.some((p) => inside(p, a))) return 0;
  let best = Infinity;
  for (const [from, to] of [[a, b], [b, a]]) {
    for (const p of from) {
      for (let i = 0; i < to.length; i++) best = Math.min(best, pointSegment(p, to[i], to[(i + 1) % to.length]));
    }
  }
  return best;
}

/**
 * Basekontakt im Nahkampf: welche Bases des Angreifers ein Modell des Ziels berühren (auch Ecke an Ecke)
 * und welche im ersten Glied stehen. Ohne jeden Kontakt: null.
 * Schlüssel sind die Plätze der Formation ("m0" … bzw. die id eines angeschlossenen Charakters).
 */
export function combatContacts(u: UnitState, units: Record<string, UnitState>, target: UnitState):
  { contact: Set<string>; front: Set<string>; slots: Slot[] } | null {
  const host = target.joinedTo && units[target.joinedTo] ? units[target.joinedTo] : target;
  if (isJoined(u, units)) return null;
  const mine = slotPolygons(u, units);
  const theirs = slotPolygons(host, units).map((s) => s.poly);
  const contact = new Set(mine.filter((m) => theirs.some((t) => polyDistance(m.poly, t) <= TOUCH)).map((m) => m.slot.key));
  if (!contact.size) return null;
  const top = Math.min(...mine.map((m) => m.slot.y));
  const front = new Set(mine.filter((m) => Math.abs(m.slot.y - top) < 0.01).map((m) => m.slot.key));
  return { contact, front, slots: mine.map((m) => m.slot) };
}
