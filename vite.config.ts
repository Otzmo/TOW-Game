import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade, damit der Build auch unter github.io/<repo>/ läuft
  base: './',
  // Polling, weil die Dateiüberwachung in diesem Ordner sonst schnelle Folgeänderungen verpasst
  server: { port: 5173, watch: { usePolling: true, interval: 200 } },
});
