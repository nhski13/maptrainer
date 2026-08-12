import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves from /<repo-name>/ — the deploy workflow sets BASE_PATH.
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
