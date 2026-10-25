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

/** Erklärungen aus dem Grundregelwerk (scripts/fetch-extras.mjs) */
interface CoreData {
  armour: Record<string, { name: string; text: string; url: string }>;
  command: Record<string, { name: string; text: string; url: string }>;
}

let weaponData: WeaponData | null = null;
let coreData: CoreData | null = null;
let loading: Promise<unknown> | null = null;

const loadJson = <T>(file: string): Promise<T | null> =>
  fetch(`${import.meta.env.BASE_URL}data/${file}`).then((r) => (r.ok ? (r.json() as Promise<T>) : null)).catch(() => null);

/** Waffen- und Grundregeldaten einmal laden (fehlt eine Datei, bleibt der Teil leer). */
export function loadWeapons(): Promise<unknown> {
  loading ??= Promise.all([
    loadJson<WeaponData>('weapons.json').then((d) => (weaponData = d)),
    loadJson<CoreData>('core.json').then((d) => (coreData = d)),
  ]);
  return loading;
}

/** Erklärung zu einem Rüstungsteil ("Full plate armour", "Shield" …) */
export function armourInfo(name: string): RuleRef | null {
  const r = coreData?.armour[name.toLowerCase().replace(/[^a-z]+/g, '-')];
  return r ? { name: r.name, text: r.text, url: r.url } : null;
}

/** Erklärung zu einer Option: Kommandomodell, Waffe, Rüstung oder gleichnamige Sonderregel */
export function optionInfo(option: string, info: UnitInfo): RuleRef | null {
  const o = option.trim();
  const command = (key: string) => {
    const c = coreData?.command[key];
    return c ? { name: o, text: c.text, url: c.url } : null;
  };
  if (/standard bearer/i.test(o)) return command('standard-bearer');
  if (/musician/i.test(o)) return command('musician');
  // Champion: heißt oft wie die zweite Profilzeile ("Marauder chieftain", "Clawleader")
  if (/champion/i.test(o) || info.profile.slice(1).some((p) => norm(p.name) === norm(o))) return command('champion');
  const armour = ARMOUR.find((a) => a.re.test(o));
  if (armour) return armourInfo(armour.name);
  const weapon = unitWeapons({ ...info, equipment: '', options: [o] })[0];
  if (weapon) {
    const p = weapon.profiles[0];
    const profile = `Range ${p.range} · S ${p.strength} · AP ${p.ap}${p.rules.length ? ` · ${p.rules.join(', ')}` : ''}`;
    return { name: o, text: [profile, weaponData?.weapons[weapon.slug]?.text].filter(Boolean).join('\n\n'), url: weapon.url };
  }
  const rule = info.rules.find((r) => norm(r.name.replace(/\([^)]*\)/g, '')) === norm(o));
  return rule ? { ...rule, name: o } : null;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** "Armour Bane (1)" → "armour-bane" (wie in fetch-weapons.mjs) */
export const ruleSlug = (name: string) =>
  name.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Waffe mit Profilen und den Texten ihrer Sonderregeln */
export interface UnitWeapon {
  slug: string;
  name: string;
  profiles: WeaponProfile[];
  url: string;
  /** Beschreibung (magische Waffen: Text des Gegenstands) */
  text: string;
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
      if (w.profiles.length) found.push({ slug: w.slug, name: w.name, profiles: w.profiles, url: w.url, text: w.text });
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
  /** Bester Ward save und die Regel bzw. der Gegenstand, von dem er kommt */
  ward: { value: number; from: string; source: RuleRef } | null;
  /** Bester Regenerationswurf und woher er kommt */
  regen: { value: number; from: string; source: RuleRef } | null;
}

/** Wert aus "Chaos Armour (5+)", "… a 5+ Ward save …" oder "… Regeneration (5+) …" */
function saveValue(r: RuleRef, kind: RegExp): number | null {
  const inName = /\((\d)\+\)/.exec(r.name);
  if (inName) return Number(inName[1]);
  const before = new RegExp(`(\\d)\\+\\s*(?:${kind.source})`, 'i').exec(r.text);
  if (before) return Number(before[1]);
  const after = new RegExp(`(?:${kind.source})\\s*\\((\\d)\\+\\)`, 'i').exec(r.text);
  return after ? Number(after[1]) : null;
}

/** Bester Wurf einer Art aus Regeln und Gegenständen (niedrigster Wert gewinnt); ohne erkennbaren Wert: keiner */
function bestSave(sources: RuleRef[], kind: RegExp): { value: number; from: string; source: RuleRef } | null {
  let best: { value: number; from: string; source: RuleRef } | null = null;
  for (const r of sources) {
    if (!kind.test(r.name) && !kind.test(r.text)) continue;
    const value = saveValue(r, kind);
    if (value === null) continue;
    const name = r.name.replace(/\s*\([^)]*\)\s*$/, '');
    if (!best || value < best.value) best = { value, from: name, source: r };
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
  const regen = bestSave(sources, /regeneration/i);
  const ward = bestSave(sources.filter((r) => !/regeneration/i.test(r.name)), /ward save|\bward\b/i);
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
