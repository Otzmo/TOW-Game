// Schreibt public/data/factions.json: Übersicht aller vorhandenen Fraktionsdaten (Kennung und Name).
// Das Spiel nutzt sie, wenn die Fraktionskennung einer Armeeliste nicht genau zu einer Datei passt.
//
// Aufruf:  node scripts/faction-index.mjs   (nach fetch-faction.mjs)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = 'public/data';
const index = readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && f !== 'factions.json')
  .map((f) => {
    const data = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
    return { slug: f.replace(/\.json$/, ''), name: data.name ?? f, units: Object.keys(data.units ?? {}).length };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(`${DIR}/factions.json`, JSON.stringify(index, null, 1));
console.log(index.map((f) => `${f.slug}: ${f.name} (${f.units} units)`).join('\n'));
