// Ergänzt public/data/weapons.json um die Kriegsmaschinen-Waffen (Cannon, Great Cannon, Mortar, Bolt Thrower,
// Stone Thrower, Organ Gun, Fire Thrower …) und ihre Regeln (Cannon Fire, Bombardment, Black Powder Misfire
// Table …). Diese stehen auf tow.whfb.app nicht unter "Weapons of War", sondern unter "War Machines".
//
// Aufruf:  node scripts/fetch-warmachines.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { clean, page, richText } from './fetch-faction.mjs';

const BASE = 'https://tow.whfb.app';
const FILE = 'public/data/weapons.json';

/** Eingebettete Waffenprofile einer Seite (wie in fetch-weapons.mjs) */
function profiles(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (node.sys?.contentType?.sys?.id === 'weaponProfile' && node.fields) out.push(node.fields);
  for (const v of Object.values(node)) profiles(v, out, seen);
  return out;
}

/** Texte der Verweise in einem Rich-Text ("Armour Bane (2)", "Cannon Fire" …) */
function linkTexts(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.nodeType === 'entry-hyperlink') out.push((node.content ?? []).map((c) => c.value ?? '').join('').trim());
  for (const c of node.content ?? []) linkTexts(c, out);
  return out;
}

const slugOf = (name) => name.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const data = JSON.parse(await readFile(FILE, 'utf8'));
const index = await page('/war-machines');
let added = 0;
for (const e of index.entries) {
  const slug = e.fields.slug;
  const p = await page(`/war-machines/${slug}`);
  const f = p?.entry?.fields;
  if (!f) continue;
  const text = clean(richText(f.body));
  // Regel der Kriegsmaschinen (Cannon Fire, Bombardment, Misfire-Tabellen …): unter ihrem Namen ablegen
  data.rules[slugOf(f.name)] = { slug: slugOf(f.name), name: f.name, text, url: `${BASE}/war-machines/${slug}` };
  // Waffenprofile auf der Seite (z. B. Cannon und Great Cannon auf "Cannon")
  for (const w of profiles(p.entry)) {
    const name = String(w.name).replace(/\s*\(Profile\)\s*$/, '');
    const rules = linkTexts(w.specialRules).filter(Boolean);
    // "This weapon uses the Black Powder Misfire table": die Tabelle als anklickbare Regel dazu
    for (const table of ['Black Powder Misfire Table', 'Stone Thrower Misfire Table']) {
      if (new RegExp(table, 'i').test(text) && !rules.includes(table)) rules.push(table);
    }
    const notes = clean(richText(w.notes) || '');
    const key = slugOf(name);
    data.weapons[key] = {
      slug: key, name,
      profiles: [{ name, range: w.range ?? '', strength: w.strength ?? '', ap: w.armourPiercing ?? '', rules, notes }],
      text, url: `${BASE}/war-machines/${slug}`,
    };
    added++;
    console.log(`  ${name}: ${w.range} S${w.strength} AP${w.armourPiercing} · ${rules.join(', ')}`);
  }
}
await writeFile(FILE, JSON.stringify(data, null, 1));
console.log(`\nFertig: ${added} Kriegsmaschinen-Waffen ergänzt`);
