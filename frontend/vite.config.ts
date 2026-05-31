import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  // camillagui-backend serves the build under /gui/ (see setup_static_routes
  // in backend/routes.py). Without this, Vite emits absolute asset paths
  // like /assets/index-XXX.js that 404 against the backend's /gui/assets/...
  base: '/gui/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // Tras la consolidación, todo el backend Python corre en el puerto 5005:
    // /api/*, /api/rc/* (Room Correction), /api/limiter/* (proxy al sidecar).
    // Ya no hay servidor separado en 5006.
    proxy: { '/api': 'http://localhost:5005' },
  },
})
