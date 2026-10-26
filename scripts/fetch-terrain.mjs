// Holt die Geländeregeln (Battlefield Terrain) von tow.whfb.app und speichert sie als public/data/terrain.json.
//
// Aufruf:  node scripts/fetch-terrain.mjs

import { writeFile } from 'node:fs/promises';
import { clean, page, richText } from './fetch-faction.mjs';

const index = await page('/battlefield-terrain');
const rules = {};
for (const e of index.entries) {
  const f = e.fields;
  const text = clean(richText(f.body ?? (await page(`/battlefield-terrain/${f.slug}`))?.entry?.fields?.body));
  if (text) rules[f.slug] = { name: f.name, text };
}
await writeFile('public/data/terrain.json', JSON.stringify(rules, null, 1));
console.log(`Fertig: ${Object.keys(rules).length} Regeln`);
