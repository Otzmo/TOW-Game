// Baut die Demo-Version (offline, mit Beispielarmeen) als eine HTML-Seite mit
// eingebettetem CSS und JS, z. B. zum Veröffentlichen als Claude-Artefakt.
//
// Aufruf:  node scripts/build-artifact.mjs
// Ergebnis: dist-artifact/tow-tabletop.html und dist-artifact/data/*.json

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-artifact';

execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'artifact'], { stdio: 'inherit' });

const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const asset = (re) => {
  const m = re.exec(html);
  if (!m) throw new Error(`Nicht gefunden im Build: ${re}`);
  return readFileSync(join(OUT, m[1]), 'utf8');
};
const js = asset(/<script type="module"[^>]*src="\.\/([^"]+)"/);
const css = asset(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"/);
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1]
  .replace(/<script type="module"[^>]*><\/script>/, '')
  .trim();

// Die Artefakt-Hülle liefert doctype, head und body selbst
const page = `<title>TOW Tabletop</title>
<style>
:root { color-scheme: dark; }
${css}
</style>
${body}
<script type="module">
${js.replace(/<\/script/gi, '<\\/script')}
</script>
`;

writeFileSync(join(OUT, 'tow-tabletop.html'), page);
console.log(`\nFertig: ${OUT}/tow-tabletop.html (${(page.length / 1024).toFixed(0)} KB)`);
