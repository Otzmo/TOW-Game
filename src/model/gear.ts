import type { RuleRef, UnitInfo } from './types';

/** Waffenprofil von tow.whfb.app (scripts/fetch-weapons.mjs) */
export interface WeaponProfile {
  name: string;
  range: string;
  strength: string;
  ap: string;
  rules: string[];
  notes: string;
}

export interface WeaponData {
  weapons: Record<string, { slug: string; name: string; profiles: WeaponProfile[]; text: string; url: string }>;
  rules: Record<string, { slug: string; name: string; text: string; url: string }>;
}

let weaponData: WeaponData | null = null;
let loading: Promise<WeaponData | null> | null = null;

/** Waffendaten einmal laden (fehlt die Datei, bleibt die Waffenliste leer). */
export function loadWeapons(): Promise<WeaponData | null> {
  loading ??= fetch(`${import.meta.env.BASE_URL}data/weapons.json`)
    .then((r) => (r.ok ? (r.json() as Promise<WeaponData>) : null))
    .catch(() => null)
    .then((d) => (weaponData = d));
  return loading;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** "Armour Bane (1)" → "armour-bane" (wie in fetch-weapons.mjs) */
export const ruleSlug = (name: string) =>
  name.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Waffe mit Profilen und den Texten ihrer Sonderregeln */
export interface UnitWeapon {
  name: string;
  profiles: WeaponProfile[];
  url: string;
}

/**
 * Waffen einer Einheit aus Ausrüstung und gewählten Optionen: Namen (auch Mehrzahl) aus der
 * Waffenliste werden gesucht, längere Namen zuerst ("Additional hand weapons" vor "Hand weapon").
 */
export function unitWeapons(info: UnitInfo): UnitWeapon[] {
  if (!weaponData) return [];
  let text = norm([info.equipment, ...info.options].join(' · '));
  const list = Object.values(weaponData.weapons).sort((a, b) => b.name.length - a.name.length);
  const found: UnitWeapon[] = [];
  for (const w of list) {
    const n = norm(w.name).trim();
    if (!n) continue;
    for (const variant of [n, `${n}s`, `${n}es`]) {
      const key = ` ${variant} `;
      if (!text.includes(key)) continue;
      // Ohne Profil (z. B. Schild) keine Zeile; der Schild zählt beim Rüstungswurf
      if (w.profiles.length) found.push({ name: w.name, profiles: w.profiles, url: w.url });
      // Gefundenes ausblenden, damit kürzere Namen nicht noch einmal darin treffen
      text = text.split(key).join(' | ');
      break;
    }
  }
  return found;
}

/** Text einer Waffen-Sonderregel (z. B. "Armour Bane (1)") */
export function weaponRule(name: string): { name: string; text: string; url: string } | null {
  const r = weaponData?.rules[ruleSlug(name)];
  return r ? { name, text: r.text, url: r.url } : null;
}

/** Rüstungsteile mit Wert: Grundrüstung setzt den Wurf, Schild und Rossharnisch verbessern ihn um 1. */
const ARMOUR: { re: RegExp; name: string; base?: number; bonus?: number }[] = [
  { re: /full plate armour/i, name: 'Full plate armour', base: 4 },
  { re: /heavy armour/i, name: 'Heavy armour', base: 5 },
  { re: /light armour/i, name: 'Light armour', base: 6 },
  { re: /\bshields?\b/i, name: 'Shield', bonus: 1 },
  { re: /barding/i, name: 'Barding', bonus: 1 },
];

export interface UnitSaves {
  /** z. B. 4 für 4+; null ohne Rüstung */
  armour: number | null;
  parts: string[];
  /** Bester Ward save und woher er kommt (Wert null, wenn er in den Daten fehlt) */
  ward: { value: number | null; from: string } | null;
  /** Bester Regenerationswurf und woher er kommt */
  regen: { value: number | null; from: string } | null;
}

/** Wert aus "Chaos Armour (5+)" bzw. "… a 5+ Ward save …" */
function saveValue(r: RuleRef, kind: RegExp): number | null {
  const inName = /\((\d)\+\)/.exec(r.name);
  if (inName) return Number(inName[1]);
  const inText = new RegExp(`(\\d)\\+\\s*(?:${kind.source})`, 'i').exec(r.text);
  return inText ? Number(inText[1]) : null;
}

/** Bester Wurf einer Art aus Regeln und Gegenständen (niedrigster Wert gewinnt) */
function bestSave(sources: RuleRef[], kind: RegExp): { value: number | null; from: string } | null {
  let best: { value: number | null; from: string } | null = null;
  for (const r of sources) {
    if (!kind.test(r.name) && !kind.test(r.text)) continue;
    const value = saveValue(r, kind);
    const name = r.name.replace(/\s*\([^)]*\)\s*$/, '');
    if (!best || (value !== null && (best.value === null || value < best.value))) best = { value, from: name };
  }
  return best;
}

export function unitSaves(info: UnitInfo): UnitSaves {
  const text = [info.equipment, ...info.options].join(' · ');
  const parts: string[] = [];
  let base: number | null = null;
  let bonus = 0;
  for (const a of ARMOUR) {
    if (!a.re.test(text)) continue;
    if (a.base) {
      // Nur die beste Grundrüstung zählt
      if (base === null) {
        base = a.base;
        parts.push(a.name);
      }
    } else {
      bonus += a.bonus ?? 0;
      parts.push(a.name);
    }
  }
  const armour = base !== null ? Math.max(2, base - bonus) : bonus ? 7 - bonus : null;
  const sources = [...visibleRules(info), ...info.items];
  // Regeneration zuerst, damit ihr Text ("… unlike a Ward save …") nicht als Ward save zählt
  const regen = bestSave(sources, /regeneration/);
  const ward = bestSave(sources.filter((r) => !/regeneration/i.test(r.name)), /ward save|\bward\b/);
  return { armour, parts, ward, regen };
}

/** Götter, deren Mark man wählen kann; ist einer gewählt, gilt kein anderes Mark */
const GODS = ['khorne', 'nurgle', 'slaanesh', 'tzeentch'];

const chosenGods = (info: UnitInfo) =>
  GODS.filter((g) => info.options.some((o) => new RegExp(`mark of ${g}`, 'i').test(o)));

/** Gewählte Optionen ohne das allgemeine "Mark of chaos", sobald ein bestimmtes Mark gewählt ist */
export function visibleOptions(info: UnitInfo): string[] {
  return chosenGods(info).length ? info.options.filter((o) => !/^mark of chaos$/i.test(o.trim())) : info.options;
}

/** Sonderregeln ohne die Marks, die nicht gewählt sind (z. B. Mark of Chaos Undivided bei Mark of Khorne) */
export function visibleRules(info: UnitInfo): RuleRef[] {
  const gods = chosenGods(info);
  if (!gods.length) return info.rules;
  return info.rules.filter((r) => !/^mark of /i.test(r.name) || gods.some((g) => r.name.toLowerCase().includes(g)));
}
