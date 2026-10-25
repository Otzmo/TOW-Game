// Ergänzt die Daten um Erklärungen aus dem Grundregelwerk und Profile magischer Waffen (tow.whfb.app):
//  · public/data/core.json: Rüstungsteile (Light/Heavy/Full plate armour, Shield, Barding) und
//    Kommandomodelle (Champion, Standard Bearer, Musician)
//  · public/data/<armee>.json: magische Waffen bekommen ihr Waffenprofil (Range, S, AP, Sonderregeln)
//
// Aufruf:  node scripts/fetch-extras.mjs

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { clean, page, richText } from './fetch-faction.mjs';

const BASE = 'https://tow.whfb.app';

/** Eingebettete Waffenprofile in ein Profil-Format wie in weapons.json umwandeln */
function weaponProfiles(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.sys?.contentType?.sys?.id === 'weaponProfile' && node.fields) {
    const w = node.fields;
    const [rulesPart, notes] = String(w.bodyIndex ?? '').split(/\s*Notes:\s*/);
    out.push({
      name: String(w.name ?? '').replace(/\s*\(Profile\)\s*$/, ''),
      range: w.range ?? '', strength: w.strength ?? '', ap: w.armourPiercing ?? '',
      rules: rulesPart && rulesPart.trim() !== '-' ? rulesPart.split(',').map((r) => r.trim()).filter(Boolean) : [],
      notes: notes?.trim() ?? '',
    });
  }
  for (const v of Object.values(node)) weaponProfiles(v, out);
  return out;
}

// --- Grundregeln ---------------------------------------------------------------
const core = { armour: {}, command: {} };
for (const slug of ['light-armour', 'heavy-armour', 'full-plate-armour', 'shield', 'barding']) {
  const p = await page(`/weapons-of-war/${slug}`);
  const f = p?.entry?.fields;
  if (f) core.armour[slug] = { name: f.name, text: clean(richText(f.body) || richText(f.description)), url: `${BASE}/weapons-of-war/${slug}` };
}
// Kommandomodelle: Abschnitte der Seite "Command Groups", je Modell zusammengefasst
const groups = await page('/command-groups');
const sections = (groups?.entries ?? []).map((e) => e.fields);
const COMMAND = {
  champion: { name: 'Champion', from: 'champions', to: 'standard-bearers' },
  'standard-bearer': { name: 'Standard Bearer', from: 'standard-bearers', to: 'musicians' },
  musician: { name: 'Musician', from: 'musicians', to: null },
};
for (const [key, c] of Object.entries(COMMAND)) {
  const start = sections.findIndex((s) => s.slug === c.from);
  const end = c.to ? sections.findIndex((s) => s.slug === c.to) : sections.length;
  const parts = [];
  for (const s of sections.slice(start, end)) {
    const p = await page(`/command-groups/${s.slug}`);
    const text = clean(richText(p?.entry?.fields?.body));
    if (text) parts.push(s.slug === c.from ? text : `${s.name}\n${text}`);
  }
  core.command[key] = { name: c.name, text: parts.join('\n\n'), url: `${BASE}/command-groups/${c.from}` };
  process.stdout.write(`  ${c.name}: ${parts.length} Abschnitte\n`);
}
writeFileSync('public/data/core.json', JSON.stringify(core, null, 1));

// --- Profile magischer Waffen -----------------------------------------------------
const cache = new Map();
for (const file of readdirSync('public/data').filter((f) => f.endsWith('.json') && !['core.json', 'weapons.json', 'factions.json'].includes(f))) {
  const path = `public/data/${file}`;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  let n = 0;
  for (const it of Object.values(data.items ?? {})) {
    if (!/weapon/i.test(it.type ?? '') || !String(it.url).includes('/magic-item/')) continue;
    if (!cache.has(it.slug)) {
      const p = await page(`/magic-item/${it.slug}`);
      cache.set(it.slug, p?.entry ? weaponProfiles(p.entry) : []);
    }
    const profiles = cache.get(it.slug);
    if (profiles.length) {
      it.profiles = profiles;
      n++;
    }
  }
  writeFileSync(path, JSON.stringify(data, null, 1));
  console.log(`${file}: ${n} magische Waffen mit Profil`);
}
