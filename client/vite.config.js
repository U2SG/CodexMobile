import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Dependencies change far less often than app code; a separate chunk
        // keeps its hash (and the phone's cached copy) stable across deploys.
        // pdfjs stays in its own lazy chunk.
        manualChunks(id) {
          if (id.includes('node_modules') && !id.includes('pdfjs-dist')) return 'vendor';
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3321',
      '/ws': {
        target: 'ws://127.0.0.1:3321',
        ws: true
      }
    }
  }
});
