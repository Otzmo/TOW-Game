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
  }>;
  rules: Record<string, { key: string; name: string; text: string; url: string }>;
  items: Record<string, { slug: string; name: string; type: string; cost: number | null; text: string; url: string }>;
}

export interface ImportResult {
  listName: string;
  factionName: string;
  units: UnitState[];
  warnings: string[];
}

const lastSegment = (id: string) => id.split('/').pop() ?? id;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const humanize = (slug: string) => slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

const factionCache = new Map<string, FactionData>();

async function loadFaction(slug: string): Promise<FactionData> {
  const cached = factionCache.get(slug);
  if (cached) return cached;
  const res = await fetch(`${import.meta.env.BASE_URL}data/${slug}.json`);
  if (!res.ok) {
    throw new Error(`Für die Fraktion "${slug}" gibt es noch keine Daten. ` +
      `Im Projektordner ausführen: node scripts/fetch-faction.mjs ${slug}`);
  }
  const data = (await res.json()) as FactionData;
  factionCache.set(slug, data);
  return data;
}

function commandCode(optionId: string): string {
  if (optionId === 'musician') return 'M';
  if (optionId === 'standard-bearer') return 'S';
  return 'C';
}

/** Aufstellungsreihe am eigenen Tischrand: Spieler 1 unten, Spieler 2 oben. */
function deploy(units: UnitState[], owner: PlayerId, table: { width: number; height: number }): void {
  const gap = 1.5;
  let x = 4;
  let row = 0;
  for (const u of units) {
    // Platz für den Block oder seine Beschriftung, je nachdem was breiter ist
    const block = (Math.min(u.width, u.models) * u.info.baseWidth) / 25.4;
    const label = (u.info.name.length + 5) * 0.2;
    const w = Math.max(block, label);
    if (x + w > table.width - 4) {
      x = 4;
      row++;
    }
    const y = 6 + row * 8;
    u.x = x + w / 2;
    u.y = owner === 'p1' ? table.height - y : y;
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
    throw new Error('Das sieht nicht nach einer .bb.json-Datei von oldworldrankings aus.');
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
    if (!src) warnings.push(`Einheit "${slug}" nicht in den Daten gefunden – wird als leerer Block angelegt.`);

    // Reittier: Option aus einer "-mount"-Gruppe, die selbst eine Einheit ist
    const mountOpt = entry.selectedOptions.find((o) => o.groupId.endsWith('-mount') && o.optionId !== 'on-foot');
    const mount = mountOpt
      ? data.units[mountOpt.optionId] ?? data.units[`${mountOpt.optionId}-${factionSlug}`]
      : undefined;
    if (mountOpt && !mount) warnings.push(`${src?.name ?? slug}: Reittier "${mountOpt.optionId}" nicht gefunden.`);

    const ruleKeys = new Set<string>([...(src?.specialRules ?? []), ...(mount?.specialRules ?? [])]);
    for (const o of entry.selectedOptions) if (data.rules[o.optionId]) ruleKeys.add(o.optionId);
    const rules = [...ruleKeys].map(rule).filter((r): r is RuleRef => r !== null);

    const items: RuleRef[] = entry.traitIds.map((id) => {
      const it = data.items[norm(lastSegment(id))];
      if (!it) {
        warnings.push(`${src?.name ?? slug}: Gegenstand "${lastSegment(id)}" nicht gefunden.`);
        return { name: humanize(lastSegment(id)), text: '' };
      }
      const note = [it.type, it.cost != null ? `${it.cost} Pkt.` : ''].filter(Boolean).join(' · ');
      return { name: it.name, text: it.text, url: it.url, note };
    });

    const command = entry.selectedOptions
      .filter((o) => o.groupId.endsWith('-command'))
      .map((o) => commandCode(o.optionId))
      .sort((a, b) => 'MSC'.indexOf(a) - 'MSC'.indexOf(b));

    const base = mount?.base ?? src?.base ?? { width: 25, depth: 25 };
    const info: UnitInfo = {
      name: src?.name ?? humanize(slug),
      troopType: mount ? `auf ${mount.name}` : src?.troopType ?? '',
      baseWidth: base.width,
      baseDepth: base.depth,
      profile: [...(src?.profile ?? []), ...(mount?.profile ?? [])],
      equipment: src?.equipment ?? '',
      options: entry.selectedOptions.map((o) => humanize(o.optionId)),
      rules,
      items,
      command,
      url: src?.url,
    };

    const q = Math.max(1, entry.quantity);
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
