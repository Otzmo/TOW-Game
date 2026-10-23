import { defineConfig } from 'vite';

export default defineConfig({
  // Relative Pfade, damit der Build auch unter github.io/<repo>/ läuft
  base: './',
  server: { port: 5173 },
});
