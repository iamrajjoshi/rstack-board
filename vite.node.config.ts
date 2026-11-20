import { defineConfig } from 'vite';

// The CLI and the background server: Node entry points, with dependencies left external.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node24',
    sourcemap: true,
    rollupOptions: {
      input: {
        'cli/index': 'src/cli/index.ts',
        'server/daemon': 'src/server/daemon.ts',
      },
      output: {
        entryFileNames: '[name].js',
        // One level below dist, like the entries, so `../web` and `../server` resolve from both.
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
