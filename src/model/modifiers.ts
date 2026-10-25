import type { RuleRef } from './types';

/** Spalten des Profils: M WS BS S T W I A Ld */
const STATS: Record<string, number> = {
  movement: 0, 'weapon skill': 1, 'ballistic skill': 2, strength: 3, toughness: 4, wounds: 5, initiative: 6, attacks: 7, leadership: 8,
};

/** Änderung eines Profilwerts durch eine Regel, einen Gegenstand oder eine Waffe */
export interface StatMod {
  /** Spalte im Profil (0 = M … 8 = Ld) */
  stat: number;
  delta: number;
  /** Nur in bestimmten Situationen, z. B. beim Angriff (Furious Charge) */
  situational: boolean;
  /** Ersetzt eine gleichartige Änderung statt sie zu ergänzen ("+2 … rather than the usual +1") */
  replaces: boolean;
  source: string;
  /** Regeltext der Quelle, um ihn beim Profilwert zu zeigen */
  text: string;
}

const STAT_NAMES = 'Movement|Weapon Skill|Ballistic Skill|Strength|Toughness|Wounds|Initiative|Attacks|Leadership';
/** "+1 modifier to its Attacks", "+1 Strength" */
const MOD_RE = new RegExp(`([+-]\\d+)\\s*(?:modifier\\s*)?(?:to\\s+(?:its|their|the|his|her)\\s+)?(${STAT_NAMES})\\b`, 'gi');
/** "improve their Toughness characteristic by 1", "increases its Strength by 2", "reduce … by 1" */
const BY_RE = new RegExp(`\\b(improves?|increases?|raises?|reduces?|lowers?|decreases?)\\s+(?:its|their|the|his|her)\\s+(${STAT_NAMES})(?:\\s+characteristics?)?\\s+by\\s+(\\d+)`, 'gi');
/** Der Satz betrifft das Modell selbst (nicht Gegner oder andere Einheiten in der Nähe) */
const SELF_RE = /\b(this model|this character|with this (?:special rule|chaotic trait|trait|ability|gift|rune|upgrade)|its bearer|the bearer|bearer|the wielder|wielder|frenzied model|this unit|unit carrying|models in (?:this|the) unit|a model wearing|a model armed)\b/i;
const OTHERS_RE = /\b(enemy|opponent|losing side|winning side|friendly [^.]* within|within \d+["″][^.]* of|other units?|each unit that)\b/i;
/** Bedingungen: dann gilt die Änderung nur in bestimmten Situationen */
const CONDITION_RE = /\b(during|charge|charged|charging|until|whilst|while|when|if|first round|in which|after|against|each time|once per|on a roll|roll of|rolls? a)\b/i;

/**
 * Änderungen an Profilwerten aus Regeltexten und aus Regelnamen wie "Extra Attacks (+1)".
 * @param gear Ausrüstung und Optionen der Einheit, um "Unless they are wearing heavy armour …" zu prüfen
 */
export function statMods(sources: RuleRef[], gear = ''): StatMod[] {
  const mods: StatMod[] = [];
  for (const r of sources) {
    const extra = /^Extra Attacks \(\+(\d+)\)/i.exec(r.name);
    if (extra) mods.push({ stat: 7, delta: Number(extra[1]), situational: true, replaces: false, source: r.name, text: r.text ?? '' });
    // Würfeltabellen (z. B. Gaze of the Gods): Ergebnisse sind zufällig – gehören nicht ins Profil
    if (/\broll (?:a|two|on)\b[^.]*\b(table|D\d)|\bD6\s+Result\b|following table/i.test(r.text ?? '')) continue;
    for (const sentence of (r.text ?? '').split(/(?<=[.!?])\s+|\n+/)) {
      if (!SELF_RE.test(sentence) || OTHERS_RE.test(sentence)) continue;
      // "If they already have this special rule, they suffer …": Folgen mehrfacher Wahl, kein Profilwert
      if (/already have/i.test(sentence)) continue;
      // "Unless they are wearing heavy armour or full plate armour …": trägt die Einheit das, gilt es nicht
      const unless = /\bunless (?:they are|it is|the model is) wearing ([^,.]+)/i.exec(sentence);
      if (unless && unless[1].split(/\s+or\s+|,\s*/).some((a) => a.trim() && new RegExp(a.trim(), 'i').test(gear))) continue;
      const found = [
        ...[...sentence.matchAll(MOD_RE)].map((m) => ({ stat: m[2], delta: Number(m[1]), at: m.index ?? 0 })),
        ...[...sentence.matchAll(BY_RE)].map((m) => ({
          stat: m[2], delta: (/^(reduce|lower|decrease)/i.test(m[1]) ? -1 : 1) * Number(m[3]), at: m.index ?? 0,
        })),
      ];
      for (const f of found) {
        const stat = STATS[f.stat.toLowerCase()];
        if (stat === undefined) continue;
        // Bedingung nur im Teil vor der Änderung zählt ("a model with this special rule gains …" ist keine)
        const before = sentence.slice(0, f.at).replace(SELF_RE, '');
        mods.push({
          stat, delta: f.delta, situational: CONDITION_RE.test(before),
          replaces: /rather than/i.test(sentence), source: r.name, text: r.text ?? '',
        });
      }
    }
  }
  return mods;
}

/** Summe der Änderungen einer Art je Spalte; "rather than"-Änderungen ersetzen statt zu addieren */
function total(mods: StatMod[]): number {
  const replacing = mods.filter((m) => m.replaces);
  if (replacing.length) return Math.max(...replacing.map((m) => m.delta));
  return mods.reduce((s, m) => s + m.delta, 0);
}

export interface ModifiedValue {
  /** Wert mit dauerhaften Änderungen */
  value: string;
  /** Wert in der Situation (z. B. beim Angriff), null wenn gleich */
  situational: string | null;
  changed: boolean;
  /** Woher die Änderungen kommen, für den Tooltip */
  sources: string[];
  /** Die Änderungen selbst (für die Erklärung beim Anklicken) */
  mods: StatMod[];
}

/** Profilwert mit Änderungen; nicht-numerische Werte ("-", "2D6") bleiben unverändert */
export function modifiedValue(base: string, stat: number, mods: StatMod[]): ModifiedValue {
  const own = mods.filter((m) => m.stat === stat);
  const n = Number.parseInt(base, 10);
  if (!own.length || !Number.isFinite(n) || String(n) !== base.trim()) return { value: base, situational: null, changed: false, sources: [], mods: [] };
  const permanent = total(own.filter((m) => !m.situational));
  const situational = total(own.filter((m) => m.situational));
  const sign = (d: number) => `${d > 0 ? '+' : ''}${d}`;
  return {
    value: String(n + permanent),
    situational: situational ? String(n + permanent + situational) : null,
    changed: permanent !== 0,
    sources: own.map((m) => `${m.source}: ${sign(m.delta)}${m.situational ? ' (situational)' : ''}`),
    mods: own,
  };
}
