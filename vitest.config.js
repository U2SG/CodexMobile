// Dedicated vitest config for the JSX-aware client smoke tests.
// node --test still owns server + pure-JS client tests; vitest only handles
// the *.smoke.test.jsx files that need jsdom + JSX transpilation.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['client/src/**/*.smoke.test.jsx'],
    globals: false,
    // Cold-mount of any one smoke pulls a large module graph (pdfjs +
    // remark + viewers barrel + jsdom). Under parallel load this can
    // sit right at the vitest default 5s timeout. Headroom prevents
    // flakey CI runs.
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
