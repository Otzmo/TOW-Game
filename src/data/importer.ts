import type { PlayerId, RuleRef, UnitInfo, UnitState } from '../model/types';

/** Format der .bb.json-Dateien von oldworldrankings.com (nur die genutzten Felder). */
interface BbList {
  name: string;
  factionId: string;
  pointsLimit?: number;
  units: {
    id: string;
    unitEntryId: string;
    quantity: number;
    selectedOptions: { groupId: string; optionId: string }[];
    traitIds: string[];
  }[];
}

/** Format von public/data/<fraktion>.json, erzeugt von scripts/fetch-faction.mjs. */
interface FactionData {
  faction: string;
  name: string;
  units: Record<string, {
    slug: string;
    name: string;
    url: string;
    base: { width: number; depth: number } | null;
    troopType: string;
    category: string;
    profile: { name: string; values: string[] }[];
    equipment: string;
    specialRules: string[];
    /** Grundkosten pro Modell */
    cost?: number | null;
    options?: OptionCost[];
  }>;
  rules: Record<string, { key: string; name: string; text: string; url: string }>;
  items: Record<string, {
    slug: string; name: string; type: string; cost: number | null; text: string; url: string;
    /** Abweichende Kosten für Charaktere bzw. Einheiten */
    costOverride?: { character?: Cost; unit?: Cost } | null;
  }>;
}

interface Cost {
  cost: number;
  per: 'model' | 'unit';
}

interface OptionCost extends Cost {
  label: string;
}

export interface ImportResult {
  listName: string;
  factionName: string;
  units: UnitState[];
  warnings: string[];
}

/** Optionen, deren Regel auf tow.whfb.app anders heißt */
const OPTION_RULES: Record<string, string> = {
  skirmishers: 'skirmish-formation',
};

const lastSegment = (id: string) => id.split('/').pop() ?? id;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const humanize = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Optionen, deren Kosten nicht auf der Einheitenseite stehen */
const FIXED_OPTION_COSTS: Record<string, number> = {
  'battle-standard-bearer': 25,
};

/** Kern einer Optionszeile, z. B. "Upgrade one model to a champion" → "champion". */
function optionCore(label: string): string {
  return norm(label
    .replace(/^[•\s]+/, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/special rule\s*$/i, '')
    .replace(/^(upgrade one model to an?|the entire unit may take|may take an?|may take|be an?|have the|replace .* with( the)?|the)\s+/i, ''));
}

/** Kosten einer gewählten Option laut tow.whfb.app (null = nicht gefunden). */
function optionCost(options: OptionCost[], optionId: string, groupId: string, models: number): number | null {
  const id = norm(optionId);
  let match = options.find((o) => optionCore(o.label) === id);
  // Champion heißt je Einheit anders (Headman, Horsemaster, Chieftain …)
  if (!match && groupId.endsWith('-command') && !['musician', 'standard-bearer'].includes(optionId)) {
    match = options.find((o) => /champion/i.test(o.label));
  }
  if (match) return match.per === 'model' ? match.cost * models : match.cost;
  return FIXED_OPTION_COSTS[optionId] ?? null;
}

function itemCost(item: FactionData['items'][string], isCharacter: boolean, models: number): number {
  const o = item.costOverride?.[isCharacter ? 'character' : 'unit'];
  if (o) return o.per === 'model' ? o.cost * models : o.cost;
  return item.cost ?? 0;
}

const factionCache = new Map<string, FactionData>();

/** JSON laden; null, wenn die Datei fehlt (der Entwicklungsserver liefert dann eine HTML-Seite) */
async function fetchJson<T>(file: string): Promise<T | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/${file}`);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Ähnlichste vorhandene Fraktion: die meisten gemeinsamen Wörter der Kennung (z. B. "empire" → "empire-of-man") */
function bestFaction(slug: string, index: { slug: string }[]): string | null {
  const words = slug.split('-').filter((w) => w.length > 2 && !['and', 'the', 'of'].includes(w));
  let best: { slug: string; score: number } | null = null;
  for (const f of index) {
    const score = words.filter((w) => f.slug.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { slug: f.slug, score };
  }
  return best?.slug ?? null;
}

async function loadFaction(slug: string): Promise<FactionData> {
  const cached = factionCache.get(slug);
  if (cached) return cached;
  let data = await fetchJson<FactionData>(`${slug}.json`);
  if (!data) {
    // Kennung der Armeeliste weicht vom Dateinamen ab: in der Übersicht nach der passenden Fraktion suchen
    const match = bestFaction(slug, (await fetchJson<{ slug: string }[]>('factions.json')) ?? []);
    if (match) data = await fetchJson<FactionData>(`${match}.json`);
  }
  if (!data) {
    throw new Error(`There is no data for the faction "${slug}" yet. ` +
      `Run in the project folder: node scripts/fetch-faction.mjs ${slug}`);
  }
  factionCache.set(slug, data);
  return data;
}

function commandCode(optionId: string): string {
  if (optionId === 'musician') return 'M';
  if (optionId === 'standard-bearer') return 'S';
  return 'C';
}

/**
 * Geladene Armee im Niemandsland (Tischmitte) ablegen, damit man sieht, dass sie noch nicht
 * aufgestellt ist: Spieler 1 in Reihen ab der Mitte nach unten, Spieler 2 ab der Mitte nach oben.
 */
export function deploy(units: UnitState[], owner: PlayerId, table: { width: number; height: number }): void {
  const gap = 1;
  let x = 4;
  let row = 0;
  for (const u of units) {
    // Platz für den Block; schmale Einheiten brauchen 3″ für ihre umbrochene Beschriftung (unitView)
    const block = (Math.min(u.width, u.models) * u.info.baseWidth) / 25.4;
    const w = Math.max(block, 3);
    if (x + w > table.width - 4) {
      x = 4;
      row++;
    }
    // Beschriftungen stehen hinter den Einheiten, also zur eigenen Tischkante hin
    const y = 4 + row * 8;
    u.x = x + w / 2;
    u.y = owner === 'p1' ? table.height / 2 + y : table.height / 2 - y;
    u.rotation = owner === 'p1' ? 0 : Math.PI;
    x += w + gap;
  }
}

export async function importBbList(
  json: unknown,
  owner: PlayerId,
  table: { width: number; height: number },
): Promise<ImportResult> {
  const list = json as BbList;
  if (!list || !Array.isArray(list.units) || typeof list.factionId !== 'string') {
    throw new Error('This does not look like a .bb.json file from oldworldrankings.');
  }
  const factionSlug = lastSegment(list.factionId);
  const data = await loadFaction(factionSlug);
  const warnings: string[] = [];
  const rule = (key: string): RuleRef | null => {
    const r = data.rules[key];
    return r ? { name: r.name, text: r.text, url: r.url } : null;
  };

  const units: UnitState[] = list.units.map((entry) => {
    const slug = lastSegment(entry.unitEntryId);
    const src = data.units[slug];
    if (!src) warnings.push(`Unit "${slug}" not found in the data – created as an empty block.`);

    // Reittier: Option aus einer "-mount"-Gruppe, die selbst eine Einheit ist
    const mountOpt = entry.selectedOptions.find((o) => o.groupId.endsWith('-mount') && o.optionId !== 'on-foot');
    const mount = mountOpt
      ? data.units[mountOpt.optionId] ?? data.units[`${mountOpt.optionId}-${factionSlug}`]
      : undefined;
    if (mountOpt && !mount) warnings.push(`${src?.name ?? slug}: mount "${mountOpt.optionId}" not found.`);

    const ruleKeys = new Set<string>([...(src?.specialRules ?? []), ...(mount?.specialRules ?? [])]);
    for (const o of entry.selectedOptions) {
      const key = OPTION_RULES[o.optionId] ?? o.optionId;
      if (data.rules[key]) ruleKeys.add(key);
    }
    const rules = [...ruleKeys].map(rule).filter((r): r is RuleRef => r !== null);

    const q = Math.max(1, entry.quantity);
    const isCharacter = src ? src.category.includes('Character') : entry.quantity === 1;

    // Punkte: Grundkosten × Modelle + Optionen + Gegenstände
    let points = (src?.cost ?? 0) * q;
    for (const o of entry.selectedOptions) points += optionCost(src?.options ?? [], o.optionId, o.groupId, q) ?? 0;
    if (src && src.cost == null) warnings.push(`${src.name}: no points cost found – please enter it in the unit bar.`);

    const items: RuleRef[] = entry.traitIds.map((id) => {
      const it = data.items[norm(lastSegment(id))];
      if (!it) {
        warnings.push(`${src?.name ?? slug}: item "${lastSegment(id)}" not found.`);
        return { name: humanize(lastSegment(id)), text: '' };
      }
      const cost = itemCost(it, isCharacter, q);
      points += cost;
      const note = [it.type, `${cost} pts`].filter(Boolean).join(' · ');
      return { name: it.name, text: it.text, url: it.url, note };
    });

    const command = entry.selectedOptions
      .filter((o) => o.groupId.endsWith('-command'))
      .map((o) => commandCode(o.optionId))
      .sort((a, b) => 'MSC'.indexOf(a) - 'MSC'.indexOf(b));

    const base = mount?.base ?? src?.base ?? { width: 25, depth: 25 };
    const info: UnitInfo = {
      name: src?.name ?? humanize(slug),
      troopType: mount ? `on ${mount.name}` : src?.troopType ?? '',
      baseWidth: base.width,
      baseDepth: base.depth,
      profile: [...(src?.profile ?? []), ...(mount?.profile ?? [])],
      equipment: src?.equipment ?? '',
      options: entry.selectedOptions.map((o) => humanize(o.optionId)),
      rules,
      items,
      command,
      isCharacter,
      points,
      isGeneral: entry.selectedOptions.some((o) => o.optionId === 'general'),
      isBsb: entry.selectedOptions.some((o) => o.optionId === 'battle-standard-bearer'),
      startModels: q,
      woundsPerModel: Number.parseInt(src?.profile[0]?.values[5] ?? '1', 10) || 1,
      url: src?.url,
    };

    return {
      id: `${owner}-${entry.id}`,
      owner,
      info,
      models: q,
      width: q <= 5 ? q : 5,
      x: 0,
      y: 0,
      rotation: 0,
    };
  });

  deploy(units, owner, table);
  return { listName: list.name, factionName: data.name, units, warnings };
}
