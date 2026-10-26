// Holt alle Lores of Magic mit ihren Sprüchen von tow.whfb.app und speichert sie als public/data/spells.json.
//
// Aufruf:  node scripts/fetch-spells.mjs

import { writeFile } from 'node:fs/promises';
import { clean, page, richText } from './fetch-faction.mjs';

const BASE = 'https://tow.whfb.app';
// Seiten unter /the-lores-of-magic, die keine Lore mit Sprüchen sind
const SKIP = new Set(['spells-and-spell-generation', 'spell-categories-lores']);

const index = await page('/the-lores-of-magic');
const lores = [];
for (const e of index.entries) {
  const slug = e.fields.slug;
  if (SKIP.has(slug)) continue;
  // Die Sprüche einer Lore sind auf ihrer Seite verlinkt, in der Reihenfolge der Tabelle
  const html = await (await fetch(`${BASE}/the-lores-of-magic/${slug}`)).text();
  const spellSlugs = [...new Set([...html.matchAll(/href="\/spell\/([^"#]+)"/g)].map((m) => m[1]))];
  const spells = [];
  for (const s of spellSlugs) {
    const p = await page(`/spell/${s}`);
    const f = p?.entry?.fields;
    if (!f) continue;
    spells.push({
      name: f.name,
      slug: f.slug,
      type: f.type ?? '',
      castingValue: f.castingValue ?? null,
      range: f.range ?? '',
      text: clean([richText(f.description), richText(f.body)].join('\n\n')),
    });
  }
  const intro = clean(richText(e.fields.body ?? (await page(`/the-lores-of-magic/${slug}`))?.entry?.fields?.body));
  lores.push({ name: e.fields.name, slug, intro, spells });
  console.log(`${e.fields.name}: ${spells.length} spells`);
}
await writeFile('public/data/spells.json', JSON.stringify(lores, null, 1));
console.log(`Fertig: ${lores.length} Lores`);
