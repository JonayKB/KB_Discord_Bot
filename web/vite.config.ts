import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En desarrollo (npm run dev:web) el panel se sirve en :5173 y reenvía API/WebSocket al bot en :3000.
const target = process.env.BOT_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': target,
      '/auth': target,
      '/ws': { target, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
