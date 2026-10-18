/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// GitHub Pages serves project sites from /<repo-name>/; set VITE_BASE to that.
const base = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      // shared generation logic lives with the Edge Function and is reused here
      '@shared': here('../functions/_shared'),
    },
  },
  server: { port: 5173, fs: { allow: ['..'] } },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes('katex')) return 'katex';
          if (/@neondatabase|@supabase|better-auth|@better-fetch/.test(id)) return 'neon';
          if (id.includes('react')) return 'react';
          return undefined;
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', '../functions/_shared/**/*.test.ts'],
    environment: 'node',
  },
});
