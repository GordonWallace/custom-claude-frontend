import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = `http://127.0.0.1:${process.env.CCF_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: server, ws: true },
    },
  },
});
