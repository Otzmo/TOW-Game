// Holt alle Waffen ("Weapons of War") mit Profil (Range, S, AP, Sonderregeln) von tow.whfb.app
// und die Texte ihrer Sonderregeln. Ergebnis: public/data/weapons.json
//
// Aufruf:  node scripts/fetch-weapons.mjs

import { writeFile } from 'node:fs/promises';
import { clean, page, richText } from './fetch-faction.mjs';

const BASE = 'https://tow.whfb.app';

/** Eingebettete Waffenprofile einer Waffenseite */
function profiles(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.sys?.contentType?.sys?.id === 'weaponProfile' && node.fields) out.push(node.fields);
  for (const v of Object.values(node)) profiles(v, out);
  return out;
}

/** "Armour Bane (1)" → "armour-bane"; "Requires Two Hands" → "requires-two-hands" */
const ruleSlug = (name) => name.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const index = await page('/weapons-of-war');
if (!index?.entries) throw new Error('Weapons of War nicht gefunden');
const weapons = {};
const ruleNames = new Set();
for (const [i, e] of index.entries.entries()) {
  const slug = e.fields.slug;
  process.stdout.write(`  Waffe ${i + 1}/${index.entries.length}: ${slug}\n`);
  const p = await page(`/weapons-of-war/${slug}`);
  const f = p?.entry?.fields;
  if (!f) continue;
  const list = profiles(p.entry).map((w) => {
    // Sonderregeln stehen als kommagetrennte Liste im Index-Text, ggf. mit "Notes: …"
    const [rulesPart, notes] = String(w.bodyIndex ?? '').split(/\s*Notes:\s*/);
    const rules = rulesPart && rulesPart.trim() !== '-' ? rulesPart.split(',').map((r) => r.trim()).filter(Boolean) : [];
    rules.forEach((r) => ruleNames.add(r));
    return {
      name: String(w.name ?? f.name).replace(/\s*\(Profile\)\s*$/, ''),
      range: w.range ?? '', strength: w.strength ?? '', ap: w.armourPiercing ?? '', rules, notes: notes?.trim() ?? '',
    };
  });
  weapons[slug] = { slug, name: f.name, profiles: list, text: clean(richText(f.description) || ''), url: `${BASE}/weapons-of-war/${slug}` };
}

// Texte der Sonderregeln, auf die die Waffen verweisen
const rules = {};
for (const name of ruleNames) {
  const slug = ruleSlug(name);
  if (rules[slug]) continue;
  process.stdout.write(`  Regel: ${slug}\n`);
  const p = await page(`/special-rules/${slug}`);
  const f = p?.entry?.fields;
  rules[slug] = { slug, name: f?.name ?? name, text: f ? clean(richText(f.body) || richText(f.description)) : '', url: `${BASE}/special-rules/${slug}` };
}

await writeFile('public/data/weapons.json', JSON.stringify({ fetchedAt: new Date().toISOString(), weapons, rules }, null, 1));
console.log(`\nFertig: public/data/weapons.json · ${Object.keys(weapons).length} Waffen · ${Object.keys(rules).length} Regeln`);
