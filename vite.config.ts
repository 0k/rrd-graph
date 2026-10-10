import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    target: 'es2020',
    lib: {
      // `api` is a framework-free entry: hosts validating their own rrd-ui
      // responses import it without pulling Vue or the chart library.
      entry: { index: resolve(import.meta.dirname, 'src/index.ts'), api: resolve(import.meta.dirname, 'src/api.ts') },
      formats: ['es'],
    },
    rollupOptions: {
      // Vue is a peer; runtime dependencies are resolved by the host bundler.
      external: id => /^(vue|@0k\/time-chart|@0k\/kal-sse-client)(\/|$)/.test(id),
      output: {
        assetFileNames: asset => asset.name?.endsWith('.css') === true ? 'style.css' : 'assets/[name][extname]',
      },
    },
    sourcemap: true,
  },
})
