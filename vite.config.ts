import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // Relative Pfade, damit der Build auch unter github.io/<repo>/ läuft
  base: './',
  // Polling, weil die Dateiüberwachung in diesem Ordner sonst schnelle Folgeänderungen verpasst
  server: { port: 5173, watch: { usePolling: true, interval: 200 } },
  build: mode === 'artifact'
    ? {
        // Ein einziges Skript, das scripts/build-artifact.mjs in die HTML-Seite einbettet
        outDir: 'dist-artifact',
        rolldownOptions: { output: { codeSplitting: false } },
        chunkSizeWarningLimit: 4000,
      }
    : {},
}));
