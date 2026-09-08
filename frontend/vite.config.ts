import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Required inside Docker: the dev server must bind 0.0.0.0, not localhost,
    // or nothing outside the container can reach it.
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * Split the vendor code out of the application bundle.
         *
         * Recharts alone is roughly half the total, and it is only needed on the
         * dashboard. Separating it means the login page no longer downloads a
         * charting library, and — because these files change far less often than
         * application code — a deploy does not invalidate the browser's cache of
         * React and the router as well.
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          data: ['@tanstack/react-query', 'axios'],
          forms: ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
  },
});
