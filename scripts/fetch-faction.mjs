// Holt Einheiten, Sonderregeln und magische Gegenstände einer Fraktion von tow.whfb.app
// und speichert sie als public/data/<fraktion>.json.
//
// Aufruf:  node scripts/fetch-faction.mjs warriors-of-chaos

import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BASE = 'https://tow.whfb.app';
const DELAY_MS = 250; // höflicher Abstand zwischen Anfragen
// Allgemeine Gegenstände aus dem Grundregelwerk
const ITEM_CATEGORIES = [
  'magic-weapons', 'magic-armour', 'talismans', 'enchanted-items', 'arcane-items', 'magic-standards',
  'extremely-common-magic-items',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function page(path) {
  await sleep(DELAY_MS);
  const res = await fetch(BASE + path);
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const props = JSON.parse(m[1]).props?.pageProps;
  return props && Object.keys(props).length ? props : null;
}

/** Contentful-Rich-Text in lesbaren Klartext umwandeln. */
export function richText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  switch (node.nodeType) {
    case 'text':
      return node.value ?? '';
    case 'paragraph':
    case 'heading-1': case 'heading-2': case 'heading-3': case 'heading-4': case 'heading-5': case 'heading-6':
      return inner(node).trim() + '\n\n';
    case 'list-item':
      return '• ' + inner(node).trim() + '\n';
    case 'unordered-list':
    case 'ordered-list':
      return inner(node) + '\n';
    case 'table-row':
      return (node.content ?? []).map((c) => inner(c).trim()).join(' | ') + '\n';
    case 'table':
      return inner(node) + '\n';
    case 'embedded-entry-inline':
    case 'embedded-entry-block':
      return node.data?.target?.fields?.name ?? '';
    default:
      return inner(node);
  }
}
const inner = (node) => (node.content ?? []).map(richText).join('');
export const clean = (s) => s.replace(/\n{3,}/g, '\n\n').trim();

/** Alle verlinkten Einträge (Regeln, Gegenstände …) aus einem Rich-Text-Baum sammeln. */
function linkedEntries(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.nodeType === 'entry-hyperlink' && node.data?.target) {
    out.push({ target: node.data.target, label: inner(node).trim() });
  }
  for (const c of node.content ?? []) linkedEntries(c, out);
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function parseBase(text) {
  const m = /(\d+)\s*x\s*(\d+)/i.exec(text ?? '');
  return m ? { width: Number(m[1]), depth: Number(m[2]) } : null;
}

const PROFILE_KEYS = ['M', 'WS', 'BS', 'S', 'T', 'W', 'I', 'A', 'Ld'];

/** "(+2 points per model)", "(+7 points per unit)", "(+35 points)" oder "(Free)" → Kosten */
function parseCost(text) {
  if (/^free$/i.test(text.trim())) return { cost: 0, per: 'unit' };
  const m = /^\+?(\d+)\s*points?(?:\s*per\s*(model|unit))?/i.exec(text.trim());
  return m ? { cost: Number(m[1]), per: m[2]?.toLowerCase() === 'model' ? 'model' : 'unit' } : null;
}

/** Optionszeilen mit Kosten, z. B. "Great weapons (+2 points per model)". */
function parseOptionCosts(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(.*)\(([^()]*)\)\s*$/.exec(line.trim());
    if (!m) continue;
    const cost = parseCost(m[2]);
    if (cost) out.push({ label: m[1].trim(), ...cost });
  }
  return out;
}

/** "Characters (+10 points per model), Units (+20 points per unit)" */
function parseCostOverride(text) {
  if (typeof text !== 'string') return null;
  const result = {};
  for (const m of text.matchAll(/(Characters?|Units?)\s*\(([^)]*)\)/gi)) {
    const cost = parseCost(m[2]);
    if (cost) result[m[1].toLowerCase().startsWith('char') ? 'character' : 'unit'] = cost;
  }
  return Object.keys(result).length ? result : null;
}

function ruleFromTarget(target, label) {
  const f = target.fields;
  if (!f?.slug) return null;
  const type = f.ruleType?.[0]?.fields?.slug ?? 'special-rules';
  const ctype = target.sys?.contentType?.sys?.id;
  return {
    key: f.slug,
    name: f.name ?? label,
    text: clean(richText(f.body) || richText(f.description)),
    url: ctype === 'magicItem' ? `${BASE}/magic-item/${f.slug}` : `${BASE}/${type}/${f.slug}`,
  };
}

async function main(faction) {
  console.log(`Lade Armeeseite ${faction} …`);
  const army = await page(`/army/${faction}`);
  if (!army) throw new Error(`Fraktion "${faction}" nicht gefunden.`);

  const data = {
    faction,
    name: army.entry.fields.name,
    source: `${BASE}/army/${faction}`,
    fetchedAt: new Date().toISOString(),
    units: {},
    rules: {},
    items: {},
  };

  // Fraktionsregeln (Marks, Chaos Armour …)
  for (const type of army.rulesByType ?? []) {
    if (type.fields.slug !== 'special-rules') continue;
    for (const r of type.rules) data.rules[r.fields.slug] = { key: r.fields.slug, name: r.fields.name, text: '', url: `${BASE}/special-rules/${r.fields.slug}` };
  }

  // Einheiten
  const unitSlugs = army.units.map((u) => u.fields.slug);
  for (const [i, slug] of unitSlugs.entries()) {
    process.stdout.write(`  Einheit ${i + 1}/${unitSlugs.length}: ${slug}\n`);
    const p = await page(`/unit/${slug}`);
    if (!p) { console.warn(`    ⚠ nicht gefunden`); continue; }
    const f = p.entry.fields;
    const ruleKeys = [];
    // Beschriftung an der Einheit, oft mit Wert, z. B. "Chaos Armour (6+)" oder "Regeneration (5+)"
    const ruleLabels = {};
    for (const field of [f.specialRules, f.optionalRules]) {
      for (const { target, label } of linkedEntries(field)) {
        const rule = ruleFromTarget(target, label);
        if (!rule) continue;
        if (!data.rules[rule.key]?.text) data.rules[rule.key] = rule;
        if (field === f.specialRules) ruleKeys.push(rule.key);
        if (/\(.+\)/.test(label) && !ruleLabels[rule.key]) ruleLabels[rule.key] = label;
      }
    }
    data.units[slug] = {
      slug,
      name: f.name,
      url: `${BASE}/unit/${slug}`,
      base: parseBase(f.baseSize),
      unitSize: f.unitSize ?? '',
      troopType: f.troopType?.[0]?.fields?.name ?? '',
      category: f.unitCategory?.[0]?.fields?.name ?? '',
      profile: (f.unitProfile ?? []).map((row) => ({ name: row.Name, values: PROFILE_KEYS.map((k) => String(row[k] ?? '-')) })),
      equipment: clean(richText(f.equipment)),
      specialRules: ruleKeys,
      ruleLabels,
      cost: typeof f.cost === 'number' ? f.cost : null,
      options: parseOptionCosts(richText(f.options)),
    };
  }

  // Regeln ohne Text nachladen (z. B. Fraktionsregeln, die keine Einheit verlinkt)
  const missing = Object.values(data.rules).filter((r) => !r.text);
  for (const [i, r] of missing.entries()) {
    process.stdout.write(`  Regel ${i + 1}/${missing.length}: ${r.key}\n`);
    const p = await page(`/special-rules/${r.key}`);
    if (p?.entry?.fields) r.text = clean(richText(p.entry.fields.body) || richText(p.entry.fields.description));
  }

  // Magische Gegenstände: Kategorien der Fraktion + allgemeine Gegenstände
  const categories = [
    ...(army.rulesByType ?? []).filter((t) => t.fields.slug === 'magic-items').flatMap((t) => t.rules.map((r) => r.fields.slug)),
    ...ITEM_CATEGORIES,
  ];
  const toItem = (f) => ({
    slug: f.slug,
    name: f.name,
    type: f.magicItemType?.[0]?.fields?.name ?? (typeof f.type === 'string' ? f.type : ''),
    cost: f.cost ?? null,
    costOverride: parseCostOverride(f.costOverride),
    text: clean(richText(f.body) || richText(f.description)),
    url: `${BASE}/magic-item/${f.slug}`,
  });
  // Die Kategorieseiten enthalten die Gegenstände als eingebettete Einträge mit Kosten
  const collectItems = (node) => {
    if (!node || typeof node !== 'object') return;
    const f = node.fields;
    if (f?.slug && f.name && 'cost' in f && (f.description || f.body) && !data.items[norm(f.slug)]) {
      data.items[norm(f.slug)] = toItem(f);
    }
    for (const v of Object.values(node)) collectItems(v);
  };
  for (const cat of categories) {
    process.stdout.write(`  Gegenstandsliste: ${cat}\n`);
    const p = await page(`/magic-items/${cat}`);
    if (!p) { console.warn(`    ⚠ nicht gefunden`); continue; }
    collectItems(p);
  }
  const withoutText = Object.values(data.items).filter((it) => !it.text);
  for (const it of withoutText) {
    const p = await page(`/magic-item/${it.slug}`);
    if (p?.entry?.fields) Object.assign(it, toItem(p.entry.fields));
  }

  await mkdir('public/data', { recursive: true });
  const file = `public/data/${faction}.json`;
  await writeFile(file, JSON.stringify(data, null, 1));
  console.log(`\nFertig: ${file} · ${Object.keys(data.units).length} Einheiten · ${Object.keys(data.rules).length} Regeln · ${Object.keys(data.items).length} Gegenstände`);
}

// Nur bei direktem Aufruf laden; als Modul liefert die Datei Hilfsfunktionen (z. B. für fetch-weapons.mjs)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const faction = process.argv[2];
  if (!faction) {
    console.error('Bitte Fraktion angeben, z. B.: node scripts/fetch-faction.mjs warriors-of-chaos');
    process.exit(1);
  }
  main(faction).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
